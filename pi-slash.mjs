// Pi-faithful SlashCommand tool over the host command registry. The command
// set is deployment-defined (typically /compact and /plan); unknown commands
// fail the call.

export const name = 'pi-slash'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register({
    name: 'SlashCommand',
    description: 'Execute a slash command within the main conversation. Available commands depend on the deployment — typically /compact (summarize the conversation) and /plan (enter or leave plan mode). Use a command only for its registered purpose; unknown commands fail.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        command: { type: 'string', description: 'The slash command to run, with its leading slash (for example "/compact" or "/plan off").' },
      },
      required: ['command'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['success', 'error'] },
          text: { type: 'string' },
        },
        required: ['kind', 'text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text.length > 0 ? value.text : `(${value.kind})` }],
    },
    async execute(args, exec) {
      if (typeof args.command !== 'string' || args.command.trim().length === 0) throw new Error('command must be a non-empty string')
      const agent = exec.agent
      if (agent === undefined) throw new Error('SlashCommand requires a calling agent')
      const commands = ctx.get('commands')
      if (commands === undefined) throw new Error('no command registry is available in this deployment')
      const execution = await commands.execute(agent, args.command.trim(), exec.signal)
      if (execution === undefined) throw new Error(`unknown slash command "${args.command.trim()}"`)
      return { kind: execution.result.kind, text: execution.result.text ?? '' }
    },
  })
}
