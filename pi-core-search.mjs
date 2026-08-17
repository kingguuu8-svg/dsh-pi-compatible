// Pi coding-agent discovery tools for the pi-compatible preset.
// Contract baseline: find, grep, and ls from @earendil-works/pi-coding-agent 0.84.2.

export const name = 'pi-compatible-core-search'
export const inject = ['subprocess', 'tools', 'fs', 'systemPrompt']

const DEFAULT_MAX_BYTES = 50 * 1024
const DEFAULT_FIND_LIMIT = 1_000
const DEFAULT_GREP_LIMIT = 100
const DEFAULT_LS_LIMIT = 500
const DEFAULT_GREP_LINE_CHARS = 500

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function sessionCwd(exec) {
  return exec?.agent?.session?.header?.cwd ?? process.cwd()
}

function textOutput() {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  }
}

async function executable(ctx, config, signal) {
  if (typeof config.rgPath === 'string' && config.rgPath.length > 0) return config.rgPath
  return await ctx.subprocess.resolveExecutable('rg', undefined, signal)
}

function collected(handle, stream) {
  try {
    return handle.collected[stream].readFrom(0).text
  } catch {
    return ''
  }
}

async function runRg(ctx, rg, argv, cwd, signal, maxBytes) {
  const handle = ctx.subprocess.spawn({
    argv: [rg, ...argv],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes },
      stderr: { maxBytes: 64 * 1024 },
    },
    signal,
    graceMs: 3_000,
  })
  const outcome = await handle.done
  const stdout = collected(handle, 'stdout')
  const stderr = collected(handle, 'stderr')
  if (outcome.exitCode !== 0 && outcome.exitCode !== 1) throw new Error(stderr || stdout || `ripgrep exited with code ${String(outcome.exitCode)}`)
  return { stdout, noMatches: outcome.exitCode === 1 }
}

async function resolveDirectory(ctx, path, exec) {
  const cwd = sessionCwd(exec)
  const target = await ctx.fs.resolve(path ?? '.', { cwd, signal: exec.signal })
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) throw new Error(`directory "${target.displayPath}" not found`)
  if (info.type !== 'directory') throw new Error(`path "${target.displayPath}" is not a directory`)
  return target
}

function normalizeLines(stdout) {
  return stdout.replaceAll('\r\n', '\n').split('\n').filter((line) => line.length > 0)
}

function normalizeFindPath(line, searchPath) {
  const normalized = line.replaceAll('\\', '/')
  const base = (searchPath ?? '.').replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '')
  if (base !== '' && base !== '.') {
    const prefix = `${base}/`
    if (normalized.startsWith(prefix)) return normalized.slice(prefix.length)
  }
  return normalized
}

export function apply(ctx, config = {}) {
  const maxBytes = positiveInteger(config.maxBytes, DEFAULT_MAX_BYTES)
  const findLimit = positiveInteger(config.findLimit, DEFAULT_FIND_LIMIT)
  const grepLimit = positiveInteger(config.grepLimit, DEFAULT_GREP_LIMIT)
  const lsLimit = positiveInteger(config.lsLimit, DEFAULT_LS_LIMIT)
  const grepLineChars = positiveInteger(config.grepLineChars, DEFAULT_GREP_LINE_CHARS)
  let rgPromise

  const getRg = (signal) => {
    if (rgPromise === undefined) rgPromise = executable(ctx, config, signal)
    return rgPromise
  }

  ctx.systemPrompt.section({
    name: 'tool:pi-compatible-core-search',
    order: 101,
    text: 'Use find to locate files by glob pattern, grep to search file contents, and ls to inspect one directory. Search follows repository ignore rules and returns paths relative to the search directory where applicable.',
  })

  ctx.tools.register({
    name: 'find',
    description: `Search for files by glob pattern. Respects .gitignore and returns at most ${String(findLimit)} results.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pattern: { type: 'string', description: "Glob pattern such as '*.ts' or '**/*.json'." },
        path: { type: 'string', description: 'Directory to search in; defaults to the current directory.' },
        limit: { type: 'integer', description: 'Maximum number of results.' },
      },
      required: ['pattern'],
    },
    output: textOutput(),
    isConcurrencySafe: () => true,
    presentCall(args) {
      return typeof args.pattern === 'string' ? { card: 'generic', title: `find ${args.pattern}`, kind: 'read', locations: args.path ? [{ path: args.path }] : undefined } : undefined
    },
    async execute(args, exec) {
      if (typeof args.pattern !== 'string' || args.pattern.length === 0) throw new Error('pattern must be a non-empty string')
      const limit = args.limit === undefined ? findLimit : args.limit
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive integer')
      const rg = await getRg(exec.signal)
      const searchPath = typeof args.path === 'string' && args.path.length > 0 ? args.path : '.'
      const argv = ['--color', 'never', '--files', '--hidden', '--glob', '!.git/**', '--glob', args.pattern, '--', searchPath]
      const result = await runRg(ctx, rg, argv, sessionCwd(exec), exec.signal, maxBytes)
      if (result.noMatches) return { text: 'No files found.' }
      const all = normalizeLines(result.stdout)
      const visible = all.slice(0, limit).map((line) => normalizeFindPath(line, searchPath))
      const suffix = all.length > visible.length ? `\n\n[Showing ${String(visible.length)} of ${String(all.length)} results.]` : ''
      return { text: visible.join('\n') + suffix }
    },
  })

  ctx.tools.register({
    name: 'grep',
    description: `Search file contents for a pattern. Respects .gitignore and returns at most ${String(grepLimit)} matching lines.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pattern: { type: 'string', description: 'Text or regular expression to search for.' },
        path: { type: 'string', description: 'File or directory to search; defaults to the current directory.' },
        glob: { type: 'string', description: 'Optional file glob filter.' },
        ignoreCase: { type: 'boolean', description: 'Search case-insensitively.' },
        literal: { type: 'boolean', description: 'Treat pattern as a literal string instead of a regular expression.' },
        context: { type: 'integer', description: 'Number of context lines before and after each match.' },
        limit: { type: 'integer', description: 'Maximum number of matching output lines.' },
      },
      required: ['pattern'],
    },
    output: textOutput(),
    isConcurrencySafe: () => true,
    presentCall(args) {
      return typeof args.pattern === 'string' ? { card: 'generic', title: `grep ${args.pattern}`, kind: 'read', locations: args.path ? [{ path: args.path }] : undefined } : undefined
    },
    async execute(args, exec) {
      if (typeof args.pattern !== 'string' || args.pattern.length === 0) throw new Error('pattern must be a non-empty string')
      const limit = args.limit === undefined ? grepLimit : args.limit
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive integer')
      if (args.context !== undefined && (!Number.isSafeInteger(args.context) || args.context < 0)) throw new Error('context must be a non-negative integer')
      const rg = await getRg(exec.signal)
      const argv = ['--color', 'never', '--hidden', '--glob', '!.git/**', '--line-number', '--no-heading', '--with-filename']
      if (args.ignoreCase === true) argv.push('--ignore-case')
      if (args.literal === true) argv.push('--fixed-strings')
      if (args.context !== undefined) argv.push('--context', String(args.context))
      if (typeof args.glob === 'string' && args.glob.length > 0) argv.push('--glob', args.glob)
      argv.push('--', args.pattern, typeof args.path === 'string' && args.path.length > 0 ? args.path : '.')
      const result = await runRg(ctx, rg, argv, sessionCwd(exec), exec.signal, maxBytes)
      if (result.noMatches) return { text: 'No matches found.' }
      const all = normalizeLines(result.stdout)
      const visible = all.slice(0, limit).map((line) => line.length > grepLineChars ? `${line.slice(0, grepLineChars)}... [truncated]` : line)
      const suffix = all.length > visible.length ? `\n\n[Showing ${String(visible.length)} of ${String(all.length)} output lines.]` : ''
      return { text: visible.join('\n') + suffix }
    },
  })

  ctx.tools.register({
    name: 'ls',
    description: `List directory contents alphabetically, including dotfiles, with '/' after directories. Output is limited to ${String(lsLimit)} entries.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Directory to list; defaults to the current directory.' },
        limit: { type: 'integer', description: 'Maximum number of entries.' },
      },
      required: [],
    },
    output: textOutput(),
    isConcurrencySafe: () => true,
    presentCall(args) {
      return { card: 'generic', title: `ls ${typeof args.path === 'string' ? args.path : '.'}`, kind: 'read', locations: typeof args.path === 'string' ? [{ path: args.path }] : undefined }
    },
    async execute(args, exec) {
      const limit = args.limit === undefined ? lsLimit : args.limit
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive integer')
      const target = await resolveDirectory(ctx, typeof args.path === 'string' && args.path.length > 0 ? args.path : '.', exec)
      const entries = await ctx.fs.listDir(target, exec.signal)
      const visible = entries.slice(0, limit).map((entry) => `${entry.name}${entry.type === 'directory' ? '/' : ''}`)
      const suffix = entries.length > visible.length ? `\n\n[Showing ${String(visible.length)} of ${String(entries.length)} entries.]` : ''
      return { text: visible.join('\n') + suffix }
    },
  })
}
