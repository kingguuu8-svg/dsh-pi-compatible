// Pi-faithful Think tool: logs a thought, changes nothing, returns ok.

export const name = 'pi-think'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register({
    name: 'Think',
    description: 'Use the tool to think about something. It will not obtain new information or make any changes to the repository, instead it just logs the thought. Use it when complex reasoning or brainstorming is needed.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        thought: { type: 'string', description: 'Your thoughts.' },
      },
      required: ['thought'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean', const: true } },
        required: ['ok'],
      },
      render: () => [{ type: 'text', text: 'Thought recorded.' }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      if (typeof args.thought !== 'string' || args.thought.trim().length === 0) throw new Error('thought must be a non-empty string')
      return { ok: true }
    },
  })
}
