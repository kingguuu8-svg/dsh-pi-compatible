// Pi-faithful Task tool over the host subagent seam. subagent_type selects
// the provider through a configurable map; the deployment default (spawn)
// serves any type, exactly one provider per run.

export const name = 'pi-task'
export const inject = ['tools', 'subagents']

export function apply(ctx, config = {}) {
  const providerByType = config.providerByType ?? {}
  const defaultProvider = typeof config.provider === 'string' && config.provider.length > 0 ? config.provider : 'spawn'

  ctx.tools.register({
    name: 'Task',
    description: 'Launch a new subagent to handle complex, self-contained tasks autonomously. The subagent works independently and returns only its final result. subagent_type picks the provider: "general-purpose" (the default) for open-ended work, any other type when a matching provider is configured; unconfigured types fall back to the deployment default. Give it a complete standalone prompt: it does not see this conversation.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        subagent_type: { type: 'string', description: 'The type of subagent to use; defaults to "general-purpose".' },
        description: { type: 'string', description: 'A short (3-5 word) description of the task, for display.' },
        prompt: { type: 'string', description: 'The complete, self-contained task for the subagent. Include everything it needs.' },
        model: { type: 'string', description: 'Accepted for compatibility; the deployment default model serves the subagent.' },
      },
      required: ['subagent_type', 'description', 'prompt'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          success: { type: 'boolean' },
          text: { type: 'string' },
        },
        required: ['success', 'text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: 600_000,
    presentCall(args) {
      if (typeof args.description !== 'string') return undefined
      return { card: 'generic', title: `Task: ${args.description}`, kind: 'other' }
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('Task requires an owning agent session')
      if (typeof args.subagent_type !== 'string' || args.subagent_type.trim().length === 0) throw new Error('subagent_type must be a non-empty string')
      if (typeof args.prompt !== 'string' || args.prompt.trim().length === 0) throw new Error('prompt must be a non-empty string')
      const label = typeof args.description === 'string' && args.description.length > 0 ? args.description : args.subagent_type
      const provider = providerByType[args.subagent_type] ?? defaultProvider
      const run = await ctx.subagents.start(provider, {
        ...label.length > 0 ? { label } : {},
        prompt: [{ type: 'text', text: args.prompt }],
        parent: agent,
        signal: exec.signal,
      })
      try {
        const result = await run.result
        const text = result.output
          .map((block) => block.type === 'text' ? block.text : `[${block.type}]`)
          .join('\n')
          .trim()
        if (result.stopReason !== 'completed') {
          throw new Error(`Task subagent ended with stop reason "${result.stopReason}"${text.length > 0 ? `: ${text}` : ''}`)
        }
        return { success: true, text }
      } finally {
        await run.dispose()
      }
    },
  })
}
