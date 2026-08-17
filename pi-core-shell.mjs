// Pi coding-agent bash tool for the pi-compatible preset.
// The external contract uses command + timeout(seconds); DSH owns execution and policy.

export const name = 'pi-compatible-core-shell'
export const inject = ['tools', 'shell', 'systemPrompt']

const MAX_TIMEOUT_MS = 2_147_483_647
const DEFAULT_TIMEOUT_MS = 120_000

function sessionCwd(exec) {
  return exec?.agent?.session?.header?.cwd
}

function standingPolicy(ctx, exec) {
  if (ctx.shell.sandboxMode === undefined) return undefined
  const service = ctx.get('sandboxPolicy')
  if (service === undefined) throw new Error('pi-compatible-core-shell requires a confining shell executor')
  return service.resolve(exec?.agent === undefined ? {} : { session: exec.agent.session })
}

function renderResult(result) {
  const parts = []
  if (result.stdout?.text?.length > 0) parts.push(result.stdout.text)
  if (result.stderr?.text?.length > 0) parts.push(`[stderr]\n${result.stderr.text}`)
  if (result.timedOut) parts.push(`[timed out after ${String(result.timeoutMs)}ms]`)
  else if (result.aborted) parts.push('[aborted]')
  else if (result.exitCode !== 0) parts.push(result.exitCode === null ? '[process exited]' : `[exit code: ${String(result.exitCode)}]`)
  if (result.sandbox?.denied === true) parts.push(`[sandbox: file access denied under ${result.sandbox.mode} mode]`)
  if (result.sandbox?.runnerFailed === true) parts.push('[sandbox runner failed]')
  return parts.length > 0 ? parts.join('\n') : '(no output)'
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

export function apply(ctx, config = {}) {
  const defaultTimeoutMs = Number.isSafeInteger(config.defaultTimeoutMs) && config.defaultTimeoutMs > 0 ? config.defaultTimeoutMs : DEFAULT_TIMEOUT_MS

  ctx.systemPrompt.section({
    name: 'tool:pi-compatible-core-shell',
    order: 102,
    text: 'Use bash for terminal work such as git, builds, tests, and package managers. The command runs in the current session working directory. The optional timeout is expressed in seconds.',
  })

  ctx.tools.register({
    name: 'bash',
    description: 'Execute a bash command in the current working directory. Returns stdout and stderr. Optionally provide a timeout in seconds.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: { type: 'string', description: 'Bash command to execute.' },
        timeout: { type: 'number', description: 'Timeout in seconds; omitted uses the deployment default.' },
      },
      required: ['command'],
    },
    output: textOutput(),
    presentCall(args) {
      return typeof args.command === 'string' ? { card: 'terminal', title: args.command, description: 'Run a shell command' } : undefined
    },
    async execute(args, exec) {
      if (typeof args.command !== 'string' || args.command.trim().length === 0) throw new Error('command must be a non-empty string')
      let timeoutMs = defaultTimeoutMs
      if (args.timeout !== undefined) {
        if (typeof args.timeout !== 'number' || !Number.isFinite(args.timeout) || args.timeout <= 0) throw new Error('timeout must be a finite positive number of seconds')
        timeoutMs = Math.ceil(args.timeout * 1000)
      }
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) throw new Error(`timeout must be at most ${String(MAX_TIMEOUT_MS / 1000)} seconds`)
      const policy = standingPolicy(ctx, exec)
      const spec = ctx.shell.resolve({
        command: args.command,
        ...(sessionCwd(exec) === undefined ? {} : { workdir: sessionCwd(exec) }),
        timeoutMs,
        signal: exec.signal,
        sandboxPolicy: policy,
      })
      const result = await ctx.shell.run(spec)
      return { text: renderResult(result) }
    },
  })
}
