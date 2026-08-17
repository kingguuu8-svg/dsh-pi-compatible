// Pi-faithful web tools: WebFetch, WebSearch.
// Both ride the host web service (search/fetch providers), with Pi's
// parameter surface and output formatting.

export const name = 'pi-web'
export const inject = ['tools', 'web']

const DEFAULT_MAX_SEARCH_RESULTS = 10
const DEFAULT_MAX_FETCH_CHARS = 50_000

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function textOutput() {
  return {
    schema: {
      type: 'object', additionalProperties: false,
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  }
}

function formatSearch(value) {
  const parts = []
  if (typeof value.content === 'string' && value.content.length > 0) parts.push(value.content)
  if (Array.isArray(value.sources) && value.sources.length > 0) {
    const body = value.sources.map((source, index) => {
      const title = typeof source.title === 'string' && source.title.length > 0 ? source.title : source.url
      const lines = [`${String(index + 1)}. ${title}`, `   ${source.url}`]
      if (typeof source.snippet === 'string' && source.snippet.length > 0) lines.push(`   ${source.snippet}`)
      return lines.join('\n')
    }).join('\n\n')
    parts.push(`Sources:\n\n${body}`)
  }
  if (value.truncated === true) parts.push('[result list truncated]')
  return parts.join('\n\n')
}

export function apply(ctx, config = {}) {
  const maxSearchResults = positiveInteger(config.maxSearchResults, DEFAULT_MAX_SEARCH_RESULTS)
  const maxFetchChars = positiveInteger(config.maxFetchChars, DEFAULT_MAX_FETCH_CHARS)

  ctx.tools.register({
    name: 'WebFetch',
    description: 'Fetch content from a URL and return it as markdown text. Use it to read documentation, issue pages, or any web resource. Only http(s) URLs are allowed. A prompt focuses the result: it is included above the fetched content so the answer can address it directly.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'The URL to fetch.' },
        prompt: { type: 'string', description: 'Optional question or instruction about the page content.' },
      },
      required: ['url'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          url: { type: 'string' },
          statusCode: { type: 'integer' },
          content: { type: 'string' },
          truncated: { type: 'boolean' },
        },
        required: ['url', 'statusCode', 'content', 'truncated'],
      },
      render: (_args, value) => {
        const head = value.statusCode >= 400 ? `[HTTP ${String(value.statusCode)}] ${value.url}\n\n` : ''
        return [{ type: 'text', text: head + value.content }]
      },
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    presentCall(args) {
      if (typeof args.url !== 'string') return undefined
      return { card: 'generic', title: `WebFetch ${args.url}`, kind: 'fetch' }
    },
    async execute(args, exec) {
      if (typeof args.url !== 'string' || args.url.trim().length === 0) throw new Error('url must be a non-empty string')
      let parsed
      try {
        parsed = new URL(args.url.trim())
      } catch {
        throw new Error(`invalid url: ${args.url}`)
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`unsupported url protocol ${parsed.protocol}; only http(s) is allowed`)
      const result = await ctx.web.fetch({ url: parsed.href }, exec.signal)
      const content = result.body.kind === 'text' ? result.body.content : ''
      const clipped = content.length > maxFetchChars ? `${content.slice(0, maxFetchChars)}\n\n[further content truncated]` : content
      return { url: result.url, statusCode: result.statusCode, content: clipped, truncated: result.truncated || content.length > maxFetchChars }
    },
  })

  ctx.tools.register({
    name: 'WebSearch',
    description: 'Search the web for current information. Returns an optional summary answer and a list of sources with titles, URLs, and snippets. Use it to verify facts, look up current versions, or research unfamiliar topics before editing.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'The search query.' },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          content: { type: 'string' },
          sources: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                url: { type: 'string' },
                title: { type: 'string' },
                snippet: { type: 'string' },
                publishedAt: { type: 'string' },
              },
              required: ['url'],
            },
          },
          truncated: { type: 'boolean' },
        },
        required: ['sources', 'truncated'],
      },
      render: (_args, value) => [{ type: 'text', text: formatSearch(value) }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    presentCall(args) {
      if (typeof args.query !== 'string') return undefined
      return { card: 'generic', title: `WebSearch ${args.query}`, kind: 'search' }
    },
    async execute(args, exec) {
      if (typeof args.query !== 'string' || args.query.trim().length === 0) throw new Error('query must be a non-empty string')
      const result = await ctx.web.search({ query: args.query, maxResults: maxSearchResults }, exec.signal)
      return {
        ...result.content !== undefined ? { content: result.content } : {},
        sources: result.sources.map((source) => ({
          url: source.url,
          ...source.title !== undefined ? { title: source.title } : {},
          ...source.snippet !== undefined ? { snippet: source.snippet } : {},
          ...source.publishedAt !== undefined ? { publishedAt: source.publishedAt } : {},
        })),
        truncated: result.truncated,
      }
    },
  })
}
