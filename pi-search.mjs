// Pi-faithful search tools: Glob, Grep.
// Same ripgrep-over-subprocess implementation as the lean-evolve
// coding-search row, with Pi's output_mode contract added.

import { access, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export const name = 'pi-search'
export const inject = ['subprocess', 'tools', 'systemPrompt']

const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024
const DEFAULT_MAX_GLOB_RESULTS = 100
const DEFAULT_MAX_GREP_LINES = 500

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

async function usable(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function packagedRipgrep(root) {
  const pnpmRoot = join(root, 'node_modules', '.pnpm')
  let entries
  try {
    entries = await readdir(pnpmRoot)
  } catch {
    return undefined
  }
  const prefixes = process.platform === 'win32'
    ? ['@vscode+ripgrep-win32-x64@', '@vscode+ripgrep-win32-arm64@']
    : process.platform === 'darwin'
      ? ['@vscode+ripgrep-darwin-arm64@', '@vscode+ripgrep-darwin-x64@']
      : ['@vscode+ripgrep-linux-x64@', '@vscode+ripgrep-linux-arm64@']
  const executable = process.platform === 'win32' ? 'rg.exe' : 'rg'
  for (const prefix of prefixes) {
    const entry = entries.find((name) => name.startsWith(prefix))
    if (entry === undefined) continue
    const packageName = entry.slice(0, entry.indexOf('@', 1)).replaceAll('+', '/')
    const candidate = join(pnpmRoot, entry, 'node_modules', packageName, 'bin', executable)
    if (await usable(candidate)) return candidate
  }
  return undefined
}

function sessionCwd(exec) {
  return exec?.agent?.session?.header?.cwd ?? process.cwd()
}

function collected(handle, stream) {
  try {
    return handle.collected[stream].readFrom(0).text
  } catch {
    return ''
  }
}

async function run(ctx, executable, argv, cwd, signal, maxOutputBytes) {
  const handle = ctx.subprocess.spawn({
    argv: [executable, ...argv],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: maxOutputBytes },
      stderr: { maxBytes: 64 * 1024 },
    },
    signal,
    graceMs: 3_000,
  })
  const outcome = await handle.done
  const stdout = collected(handle, 'stdout')
  const stderr = collected(handle, 'stderr')
  if (outcome.exitCode !== 0 && outcome.exitCode !== 1) {
    throw new Error(stderr || stdout || `ripgrep exited with code ${String(outcome.exitCode)}`)
  }
  return { stdout, noMatches: outcome.exitCode === 1 }
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

export function apply(ctx, config = {}) {
  const maxOutputBytes = positiveInteger(config.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES)
  const maxGlobResults = positiveInteger(config.maxGlobResults, DEFAULT_MAX_GLOB_RESULTS)
  const maxGrepLines = positiveInteger(config.maxGrepLines, DEFAULT_MAX_GREP_LINES)
  let executablePromise

  const executable = async (signal) => {
    if (executablePromise === undefined) {
      executablePromise = (async () => {
        if (typeof config.rgPath === 'string' && config.rgPath.length > 0 && await usable(config.rgPath)) return config.rgPath
        try {
          return await ctx.subprocess.resolveExecutable('rg', undefined, signal)
        } catch {}
        const root = typeof config.harnessRoot === 'string' && config.harnessRoot.length > 0 ? config.harnessRoot : process.cwd()
        const packaged = await packagedRipgrep(root)
        if (packaged !== undefined) return packaged
        throw new Error('ripgrep executable not found; configure pi-search.rgPath or harnessRoot')
      })()
    }
    try {
      return await executablePromise
    } catch (error) {
      executablePromise = undefined
      throw error
    }
  }

  ctx.systemPrompt.section({
    name: 'tool:pi-search',
    order: 104,
    text: 'Use Glob to discover paths and Grep to inspect matching code. Grep returns surrounding context directly; prefer a wider Grep over a follow-up Read when the returned block already answers the question.',
  })

  ctx.tools.register({
    name: 'Glob',
    description: 'Fast file pattern matching. Returns a sorted list of files matching one glob pattern such as **/*.ts. Also lists hidden files.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        pattern: { type: 'string', description: 'Glob pattern such as "**/*.ts".' },
        path: { type: 'string', description: 'Directory to search, relative to the session workspace by default.' },
      },
      required: ['pattern'],
    },
    output: textOutput(),
    isConcurrencySafe: () => true,
    presentCall(args) {
      if (typeof args.pattern !== 'string') return undefined
      return { card: 'generic', title: `Glob ${args.pattern}`, kind: 'search' }
    },
    async execute(args, exec) {
      if (typeof args.pattern !== 'string' || args.pattern.trim().length === 0) throw new Error('pattern must be a non-empty string')
      if (args.path !== undefined && (typeof args.path !== 'string' || args.path.trim().length === 0)) throw new Error('path must be a non-empty string when provided')
      const rg = await executable(exec.signal)
      const argv = ['--files', '--hidden', '--no-ignore', '--glob', '!.git/**', '--glob', args.pattern]
      if (args.path !== undefined) argv.push(args.path)
      const result = await run(ctx, rg, argv, sessionCwd(exec), exec.signal, maxOutputBytes)
      if (result.noMatches || result.stdout.trim().length === 0) return { text: 'No files found.' }
      const all = [...new Set(result.stdout.split(/\r?\n/u).map((line) => line.trim().replaceAll('\\', '/')).filter(Boolean))].sort()
      const visible = all.slice(0, maxGlobResults)
      const suffix = all.length > visible.length ? `\n\n[Showing ${String(visible.length)} of ${String(all.length)} files.]` : ''
      return { text: visible.join('\n') + suffix }
    },
  })

  ctx.tools.register({
    name: 'Grep',
    description: 'Search text with ripgrep and return matching lines with file names, line numbers, and two lines of surrounding context. output_mode selects content (default), files_with_matches, or count.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        pattern: { type: 'string', description: 'Ripgrep regular expression to search for.' },
        path: { type: 'string', description: 'File or directory to search, relative to the session workspace by default.' },
        glob: { type: 'string', description: 'Optional positive glob filter such as "*.ts" or "*.{js,jsx}".' },
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'content: matching lines with context (default); files_with_matches: file paths only; count: match counts per file.' },
      },
      required: ['pattern'],
    },
    output: textOutput(),
    isConcurrencySafe: () => true,
    presentCall(args) {
      if (typeof args.pattern !== 'string') return undefined
      return { card: 'generic', title: `Grep ${args.pattern}`, kind: 'search' }
    },
    async execute(args, exec) {
      if (typeof args.pattern !== 'string' || args.pattern.length === 0) throw new Error('pattern must be a non-empty string')
      if (args.path !== undefined && (typeof args.path !== 'string' || args.path.trim().length === 0)) throw new Error('path must be a non-empty string when provided')
      if (args.glob !== undefined && (typeof args.glob !== 'string' || args.glob.trim().length === 0 || args.glob.startsWith('!'))) {
        throw new Error('glob must be one non-empty positive glob')
      }
      const mode = args.output_mode === undefined ? 'content' : args.output_mode
      const rg = await executable(exec.signal)
      const base = ['--color', 'never', '--hidden', '--no-ignore', '--glob', '!.git/**']
      if (mode === 'files_with_matches') base.push('--files-with-matches')
      else if (mode === 'count') base.push('--count')
      else base.push('--line-number', '--no-heading', '--with-filename', '--context', '2')
      if (args.glob !== undefined) base.push('--glob', args.glob)
      base.push('--', args.pattern, args.path ?? '.')
      const result = await run(ctx, rg, base, sessionCwd(exec), exec.signal, maxOutputBytes)
      if (result.noMatches || result.stdout.trim().length === 0) return { text: 'No matches found.' }
      const all = result.stdout.replace(/\r\n/gu, '\n').split('\n')
      const visible = all.slice(0, maxGrepLines)
      const suffix = all.length > visible.length ? `\n\n[Showing ${String(visible.length)} of ${String(all.length)} output lines.]` : ''
      return { text: visible.join('\n') + suffix }
    },
  })
}
