// Pi 0.84.2-compatible non-persistent bash over DSH's subprocess seam.

import { randomBytes } from 'node:crypto'
import { openSync, closeSync, unlinkSync, writeSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  MAX_TIMER_DELAY_MS,
  formatSize,
  positiveInteger,
  resolveDshHome,
  sessionCwd,
  textOutput,
  truncateTail,
} from './pi-core-common.mjs'

export const name = 'pi-compatible-core-shell'
export const inject = ['tools', 'subprocess', 'systemPrompt']

const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024
const DEFAULT_GRACE_MS = 3_000

function configuredShellPath(config) {
  const value = process.env.PI_COMPAT_BASH_PATH?.trim() || config.bashPath?.trim()
  return value || undefined
}

function windowsGitBashCandidates() {
  return [
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
  ].filter(Boolean)
}

function isLegacyWindowsBash(path) {
  return /[\\/]Windows[\\/](?:System32|Sysnative)[\\/]bash\.exe$/iu.test(path)
}

async function firstExecutable(ctx, candidates, signal) {
  let lastError
  for (const candidate of candidates) {
    try {
      return await ctx.subprocess.resolveExecutable(candidate, undefined, signal)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('bash executable was not found')
}

async function resolveBash(ctx, config, signal) {
  const explicit = configuredShellPath(config)
  if (explicit !== undefined) {
    const path = await ctx.subprocess.resolveExecutable(explicit, undefined, signal)
    return { path, commandTransport: isLegacyWindowsBash(path) ? 'stdin' : 'argv' }
  }
  if (process.platform === 'win32') {
    const path = await firstExecutable(ctx, [...windowsGitBashCandidates(), 'bash.exe', 'bash'], signal)
    return { path, commandTransport: isLegacyWindowsBash(path) ? 'stdin' : 'argv' }
  }
  const path = await firstExecutable(ctx, ['/bin/bash', 'bash', 'sh'], signal)
  return { path, commandTransport: 'argv' }
}

export class BashOutputAccumulator {
  constructor(maxLines, maxBytes, maxSpillBytes) {
    this.maxLines = maxLines
    this.maxBytes = maxBytes
    this.maxSpillBytes = maxSpillBytes
    this.totalBytes = 0
    this.totalNewlines = 0
    this.endsWithNewline = false
    this.rolling = Buffer.alloc(0)
    this.beforeSpill = []
    this.spillPath = undefined
    this.spillFd = undefined
    this.spillDisabled = false
  }

  append(chunk) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (data.length === 0) return
    this.totalBytes += data.length
    for (const byte of data) if (byte === 0x0a) this.totalNewlines += 1
    this.endsWithNewline = data.at(-1) === 0x0a
    const rollingCap = Math.max(this.maxBytes * 2, 1)
    this.rolling = Buffer.concat([this.rolling, data])
    if (this.rolling.length > rollingCap) {
      this.rolling = this.rolling.subarray(this.rolling.length - rollingCap)
      while (this.rolling.length > 0 && (this.rolling[0] & 0xc0) === 0x80) this.rolling = this.rolling.subarray(1)
    }

    if (this.spillDisabled) return
    if (this.spillFd !== undefined) {
      if (this.totalBytes > this.maxSpillBytes) {
        this.discardSpill()
      } else {
        try { writeSync(this.spillFd, data) } catch { this.discardSpill() }
      }
      return
    }
    this.beforeSpill.push(data)
    if (this.totalBytes > this.maxBytes || this.totalLines() > this.maxLines) this.ensureSpill()
  }

  totalLines() {
    if (this.totalBytes === 0) return 0
    return this.totalNewlines + (this.endsWithNewline ? 0 : 1)
  }

  ensureSpill() {
    if (this.spillFd !== undefined || this.spillPath !== undefined || this.spillDisabled) return
    if (this.totalBytes > this.maxSpillBytes) {
      this.spillDisabled = true
      this.beforeSpill = []
      return
    }
    this.spillPath = join(tmpdir(), `pi-bash-${randomBytes(8).toString('hex')}.log`)
    try {
      this.spillFd = openSync(this.spillPath, 'wx', 0o600)
      for (const chunk of this.beforeSpill) writeSync(this.spillFd, chunk)
      this.beforeSpill = []
    } catch {
      this.discardSpill()
    }
  }

  discardSpill() {
    const path = this.spillPath
    if (this.spillFd !== undefined) {
      try { closeSync(this.spillFd) } catch {}
    }
    this.spillFd = undefined
    this.spillDisabled = true
    this.spillPath = undefined
    this.beforeSpill = []
    if (path !== undefined) {
      try { unlinkSync(path) } catch {}
    }
  }

  finish() {
    if (this.spillFd !== undefined) {
      try { closeSync(this.spillFd) } catch { this.spillPath = undefined }
      this.spillFd = undefined
    }
    const retained = this.rolling.toString('utf8')
    const truncation = truncateTail(retained, { maxLines: this.maxLines, maxBytes: this.maxBytes })
    const globallyTruncated = this.totalBytes > this.maxBytes || this.totalLines() > this.maxLines
    if (globallyTruncated) this.ensureSpill()
    return {
      content: truncation.content,
      truncation: {
        ...truncation,
        truncated: globallyTruncated,
        totalBytes: this.totalBytes,
        totalLines: this.totalLines(),
      },
      fullOutputPath: globallyTruncated ? this.spillPath : undefined,
    }
  }
}

function appendStatus(text, status) {
  return `${text ? `${text}\n\n` : ''}${status}`
}

function formatSnapshot(snapshot, emptyText = '(no output)') {
  const truncation = snapshot.truncation
  let text = snapshot.content || emptyText
  if (truncation.truncated) {
    const path = snapshot.fullOutputPath ?? '(full output exceeded spill cap)'
    const startLine = Math.max(1, truncation.totalLines - truncation.outputLines + 1)
    const endLine = truncation.totalLines
    if (truncation.lastLinePartial) {
      text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${String(endLine)}. Full output: ${path}]`
    } else if (truncation.truncatedBy === 'lines') {
      text += `\n\n[Showing lines ${String(startLine)}-${String(endLine)} of ${String(truncation.totalLines)}. Full output: ${path}]`
    } else {
      text += `\n\n[Showing lines ${String(startLine)}-${String(endLine)} of ${String(truncation.totalLines)} (${formatSize(truncation.maxBytes)} limit). Full output: ${path}]`
    }
  }
  return text
}

function childEnvironment(exec) {
  const session = exec.agent?.session
  const route = session?.requestHeader?.()?.config
  const model = route?.model ?? exec.agent?.options?.model
  const provider = route?.provider ?? exec.agent?.options?.provider
  const binDir = join(resolveDshHome(), 'pi-compatible', 'bin')
  return {
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
    ...(session?.id === undefined ? {} : { PI_SESSION_ID: String(session.id) }),
    ...(provider === undefined ? {} : { PI_PROVIDER: String(provider) }),
    ...(model === undefined ? {} : { PI_MODEL: String(model) }),
  }
}

export function apply(ctx, config = {}) {
  const maxLines = positiveInteger(config.maxLines, DEFAULT_MAX_LINES)
  const maxBytes = positiveInteger(config.maxBytes, DEFAULT_MAX_BYTES)
  const maxSpillBytes = positiveInteger(config.maxSpillBytes, DEFAULT_MAX_SPILL_BYTES)
  const graceMs = positiveInteger(config.graceMs, DEFAULT_GRACE_MS)
  let shellPromise

  const getShell = (signal) => {
    shellPromise ??= resolveBash(ctx, config, signal).catch((error) => {
      shellPromise = undefined
      throw error
    })
    return shellPromise
  }

  ctx.systemPrompt.section({
    name: 'tool:pi-compatible-core-shell',
    order: 102,
    text: [
      'Use bash for terminal work such as git, builds, tests, and package managers.',
      'Each call starts a new real Bash process; shell state does not persist between calls.',
      'This preset is designed and tested for danger-full-access. Do not request sandbox escalation; if the current DSH policy is narrower, report the limitation directly.',
    ].join(' '),
  })

  ctx.tools.register({
    name: 'bash',
    description: `Execute a Bash command in the current working directory. Each call is non-persistent. Output keeps the last ${String(maxLines)} lines or ${String(maxBytes / 1024)}KB; truncated full output is written to a private temp file. timeout is optional and expressed in seconds, with no default timeout.`,
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        command: { type: 'string', description: 'Bash command to execute.' },
        timeout: { type: 'number', description: 'Timeout in seconds (optional, no default timeout).' },
      },
      required: ['command'],
    },
    output: textOutput(),
    presentCall(args) {
      return typeof args.command === 'string'
        ? { card: 'terminal', title: args.command, description: 'Run a Bash command', cwd: '.' }
        : undefined
    },
    async execute(args, exec) {
      if (typeof args.command !== 'string' || args.command.trim().length === 0) throw new Error('command must be a non-empty string')
      let timeoutMs
      if (args.timeout !== undefined) {
        if (typeof args.timeout !== 'number' || !Number.isFinite(args.timeout) || args.timeout <= 0) throw new Error('Invalid timeout: must be a finite number of seconds')
        timeoutMs = args.timeout * 1000
        if (timeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`Invalid timeout: maximum is ${String(MAX_TIMER_DELAY_MS / 1000)} seconds`)
      }
      const shell = await getShell(exec.signal)
      const cwd = sessionCwd(exec)
      const controller = new AbortController()
      let timedOut = false
      const onAbort = () => controller.abort(exec.signal.reason ?? new Error('Operation aborted'))
      if (exec.signal.aborted) onAbort()
      else exec.signal.addEventListener('abort', onAbort, { once: true })
      let timer
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          timedOut = true
          controller.abort(new Error(`Command timed out after ${String(args.timeout)} seconds`))
        }, timeoutMs)
      }
      const accumulator = new BashOutputAccumulator(maxLines, maxBytes, maxSpillBytes)
      let handle
      try {
        const fromStdin = shell.commandTransport === 'stdin' || (process.platform === 'win32' && args.command.length > 8_000)
        handle = ctx.subprocess.spawn({
          argv: fromStdin ? [shell.path, '-s'] : [shell.path, '-c', args.command],
          cwd,
          stdio: {
            stdin: fromStdin ? { data: args.command } : 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
          },
          graceMs,
          signal: controller.signal,
          env: childEnvironment(exec),
        })
        handle.stdout?.on('data', (chunk) => { accumulator.append(chunk) })
        handle.stderr?.on('data', (chunk) => { accumulator.append(chunk) })
        const outcome = await handle.done
        const snapshot = accumulator.finish()
        const output = formatSnapshot(snapshot)
        if (timedOut || exec.signal.aborted) throw new Error('command interrupted')
        if (outcome.exitCode !== 0) throw new Error(appendStatus(output === '(no output)' ? '' : output, `Command exited with code ${String(outcome.exitCode)}`))
        return { text: output }
      } catch (error) {
        if (timedOut) {
          const snapshot = accumulator.finish()
          throw new Error(appendStatus(formatSnapshot(snapshot, ''), `Command timed out after ${String(args.timeout)} seconds`))
        }
        if (exec.signal.aborted) {
          const snapshot = accumulator.finish()
          throw new Error(appendStatus(formatSnapshot(snapshot, ''), 'Command aborted'))
        }
        throw error
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        exec.signal.removeEventListener('abort', onAbort)
      }
    },
  })
}
