// Pi-faithful shell tools: Bash, BgShell, KillShell.
// Bash forwards to the host shell service (the same seam the lean-evolve
// coding-pwsh row uses). BgShell/KillShell ride the host jobs registry:
// a background command returns a job id immediately and its output is
// injected into the session when the job settles — Pi's behavior.

import { isAbsolute, resolve } from 'node:path'

export const name = 'pi-shell'
export const inject = ['shell', 'tools', 'jobs', 'systemPrompt']

const DEFAULT_BASH_TIMEOUT_MS = 120_000
const DEFAULT_BASH_MAX_TIMEOUT_MS = 600_000
const DEFAULT_BG_OUTPUT_LIMIT_BYTES = 64 * 1024

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function commandWorkdir(args, exec, workspaceRoot) {
  const base = workspaceRoot ?? exec?.agent?.session?.header?.cwd
  if (typeof args.workdir !== 'string' || args.workdir.length === 0) return base
  if (isAbsolute(args.workdir)) return args.workdir
  return base === undefined ? args.workdir : resolve(base, args.workdir)
}

function standingPolicy(ctx, exec) {
  if (ctx.shell.sandboxMode === undefined) return undefined
  const service = ctx.get('sandboxPolicy')
  if (service === undefined) throw new Error('pi-shell requires sandboxPolicy with a confining shell executor')
  return service.resolve(exec?.agent === undefined ? {} : { session: exec.agent.session })
}

function renderResult(result) {
  const parts = []
  if (result.stdout.text.length > 0) parts.push(result.stdout.text)
  if (result.stderr.text.length > 0) parts.push(`[stderr]\n${result.stderr.text}`)
  if (result.timedOut) parts.push(`[timed out after ${String(result.timeoutMs)}ms]`)
  else if (result.aborted) parts.push('[aborted]')
  else if (result.exitCode !== 0) parts.push(result.exitCode === null ? '[process exited]' : `[exit code: ${String(result.exitCode)}]`)
  if (result.sandbox?.denied === true) parts.push(`[sandbox: file access denied under ${result.sandbox.mode} mode]`)
  if (result.sandbox?.runnerFailed === true) parts.push('[sandbox runner failed]')
  if (result.stdout.truncated && result.stdout.spillPath) parts.push(`[full stdout: ${result.stdout.spillPath}]`)
  if (result.stderr.truncated && result.stderr.spillPath) parts.push(`[full stderr: ${result.stderr.spillPath}]`)
  return parts.length > 0 ? parts.join('\n') : '(no output)'
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

function noticeText(ctx, snapshot, owner) {
  const head = `[Background shell ${snapshot.id}] ${snapshot.label} ${snapshot.status}${snapshot.detail === undefined ? '' : ` (${snapshot.detail})`}`
  let body = ''
  try {
    const read = ctx.jobs.read(snapshot.id, owner)
    if (read.text.length > 0) body = `\n\n${read.text}`
  } catch {
    // The record may already be reported or gone; the status line is enough.
  }
  return head + body
}

export function apply(ctx, config = {}) {
  const bashTimeoutMs = positiveInteger(config.bashTimeoutMs, DEFAULT_BASH_TIMEOUT_MS)
  const bashMaxTimeoutMs = positiveInteger(config.bashMaxTimeoutMs, DEFAULT_BASH_MAX_TIMEOUT_MS)
  const bgOutputLimitBytes = positiveInteger(config.bgOutputLimitBytes, DEFAULT_BG_OUTPUT_LIMIT_BYTES)

  // Producers may start work only while a controller is attached, and this
  // preset owns delivery of its own background-shell notices.
  ctx.jobs.attachController('pi-shell')
  ctx.jobs.onJobDone((snapshot, owner) => {
    if (snapshot.reported || owner === undefined) return
    owner.inject({
      content: [{ type: 'text', text: noticeText(ctx, snapshot, owner) }],
      source: { kind: 'plugin', plugin: 'pi-shell', form: 'notice', summary: 'background shell finished' },
    })
  })

  ctx.systemPrompt.section({
    name: 'tool:pi-shell',
    order: 102,
    text: 'Use Bash for terminal work such as git, builds, tests, and package managers. File operations belong to Read/Write/Edit/MultiEdit. Run long-lived or parallel work in BgShell and never poll it: you are notified in-session when it settles. Kill background jobs with KillShell when they stop mattering.',
  })

  ctx.tools.register({
    name: 'Bash',
    description: 'Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures. IMPORTANT: This tool is for terminal operations such as git, npm, docker, and so on. DO NOT use it for file operations — use Read, Write, Edit, or MultiEdit for those.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        command: { type: 'string', description: 'The bash command to execute.' },
        workdir: { type: 'string', description: 'Working directory, relative to the session workspace unless absolute. Defaults to the session workspace.' },
        timeout: { type: 'integer', description: `Optional timeout in milliseconds. Defaults to ${String(bashTimeoutMs)}; maximum ${String(bashMaxTimeoutMs)}.` },
      },
      required: ['command'],
    },
    output: textOutput(),
    presentCall(args) {
      if (typeof args.command !== 'string') return undefined
      return {
        card: 'terminal',
        title: args.command,
        description: 'Run a shell command',
        ...typeof args.workdir === 'string' ? { cwd: args.workdir } : {},
      }
    },
    async execute(args, exec) {
      if (typeof args.command !== 'string' || args.command.trim().length === 0) throw new Error('command must be a non-empty string')
      const timeout = args.timeout === undefined ? bashTimeoutMs : args.timeout
      if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > bashMaxTimeoutMs) {
        throw new Error(`timeout must be an integer between 1 and ${String(bashMaxTimeoutMs)} ms`)
      }
      const policy = standingPolicy(ctx, exec)
      const workdir = commandWorkdir(args, exec, policy?.workspaceRoot)
      const spec = ctx.shell.resolve({
        command: args.command,
        ...(workdir === undefined ? {} : { workdir }),
        timeoutMs: timeout,
        signal: exec.signal,
        sandboxPolicy: policy,
      })
      const result = await ctx.shell.run(spec)
      return { text: renderResult(result) }
    },
  })

  ctx.tools.register({
    name: 'BgShell',
    description: 'Run a shell command in the background. Returns a job id immediately; the command keeps running while you continue working. You are notified in-session with the output when the job settles — do not poll or sleep on it. Kill a still-running job with KillShell.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        command: { type: 'string', description: 'The bash command to execute in the background.' },
        workdir: { type: 'string', description: 'Working directory, relative to the session workspace unless absolute. Defaults to the session workspace.' },
        timeout: { type: 'integer', description: `Optional timeout in milliseconds. Defaults to ${String(bashTimeoutMs)}; maximum ${String(bashMaxTimeoutMs)}.` },
      },
      required: ['command'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { job_id: { type: 'string' } },
        required: ['job_id'],
      },
      render: (_args, value) => [{ type: 'text', text: `Background job started: ${value.job_id}` }],
    },
    presentCall(args) {
      if (typeof args.command !== 'string') return undefined
      const title = args.command.length > 80 ? `${args.command.slice(0, 80)}…` : args.command
      return { card: 'generic', title: `BgShell ${title}`, kind: 'execute' }
    },
    async execute(args, exec) {
      if (typeof args.command !== 'string' || args.command.trim().length === 0) throw new Error('command must be a non-empty string')
      const agent = exec.agent
      if (agent === undefined) throw new Error('BgShell requires an owning agent session')
      const timeout = args.timeout === undefined ? bashTimeoutMs : args.timeout
      if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > bashMaxTimeoutMs) {
        throw new Error(`timeout must be an integer between 1 and ${String(bashMaxTimeoutMs)} ms`)
      }
      const policy = standingPolicy(ctx, exec)
      const workdir = commandWorkdir(args, exec, policy?.workspaceRoot)
      const jobId = ctx.jobs.start({
        kind: 'bash',
        label: args.command,
        owner: agent,
        outputLimitBytes: bgOutputLimitBytes,
        run() {
          const controller = new AbortController()
          const spec = ctx.shell.resolve({
            command: args.command,
            ...(workdir === undefined ? {} : { workdir }),
            timeoutMs: timeout,
            signal: controller.signal,
            sandboxPolicy: policy,
          })
          const done = ctx.shell.run(spec).then(
            (result) => result.aborted
              ? { status: 'killed', output: renderResult(result) }
              : { status: 'completed', detail: result.exitCode === 0 ? undefined : `exit code: ${String(result.exitCode)}`, output: renderResult(result) },
            (error) => ({ status: 'failed', detail: error instanceof Error ? error.message : String(error), output: '' }),
          )
          return { cancel: (reason) => controller.abort(reason), done }
        },
      })
      return { job_id: jobId }
    },
  })

  ctx.tools.register({
    name: 'job_output',
    description: 'Read a background job started by BgShell. Final-output jobs return their result after settlement. Every response ends with a [status: ...] line. Reads are non-blocking unless wait is true, which waits up to the configured cap.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        job_id: { type: 'string', description: 'Job id returned by BgShell.' },
        wait: { type: 'boolean', description: 'Block until the job reaches a terminal status or the timeout expires. A timed-out wait returns [status: running] and leaves the job alive.' },
        timeout_ms: { type: 'integer', description: 'Max wait in milliseconds (only meaningful with wait: true). Defaults to 30000; capped at 300000.' },
      },
      required: ['job_id'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          text: { type: 'string' },
          status: { type: 'string' },
        },
        required: ['text', 'status'],
      },
      render: (_args, value) => {
        const body = value.text.length > 0 ? value.text : '(no new output)'
        return [{ type: 'text', text: `${body}\n[status: ${value.status}]` }]
      },
    },
    async execute(args, exec) {
      if (typeof args.job_id !== 'string' || args.job_id.trim().length === 0) throw new Error('job_id must be a non-empty string')
      if (!/^[A-Za-z][A-Za-z0-9-]*(-[0-9]+)$/.test(args.job_id)) throw new Error(`job_id "${args.job_id}" is not a valid job id`)
      if (args.wait === true) {
        const timeout = Math.min(args.timeout_ms ?? 30_000, 300_000)
        await ctx.jobs.wait(args.job_id, timeout, exec.agent, exec.signal)
      }
      const read = ctx.jobs.read(args.job_id, exec.agent)
      return { text: read.text, status: read.snapshot.status }
    },
  })

  ctx.tools.register({
    name: 'KillShell',
    description: 'Kill a running background shell by its job id (the id BgShell returned). An already-settled job reports already-finished.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        shell_id: { type: 'string', description: 'The job id returned by BgShell.' },
      },
      required: ['shell_id'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          shell_id: { type: 'string' },
          outcome: { type: 'string' },
        },
        required: ['shell_id', 'outcome'],
      },
      render: (_args, value) => [{ type: 'text', text: `KillShell ${value.shell_id}: ${value.outcome}` }],
    },
    async execute(args, exec) {
      if (typeof args.shell_id !== 'string' || args.shell_id.trim().length === 0) throw new Error('shell_id must be a non-empty string')
      if (!/^[A-Za-z][A-Za-z0-9-]*(-[0-9]+)$/.test(args.shell_id)) throw new Error(`shell_id "${args.shell_id}" is not a valid job id`)
      const outcome = ctx.jobs.kill(args.shell_id, exec.agent, 'KillShell')
      return { shell_id: args.shell_id, outcome }
    },
  })
}
