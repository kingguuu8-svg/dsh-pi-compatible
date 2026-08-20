// Pi 0.84.2-compatible find/grep/ls over fd, ripgrep, DSH subprocess, and DSH fs.

import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import path from 'node:path'
import {
  DEFAULT_MAX_BYTES,
  GREP_MAX_LINE_LENGTH,
  formatSize,
  positiveInteger,
  sessionCwd,
  textOutput,
  truncateHead,
  truncateLine,
} from './pi-core-common.mjs'
import { ensureBinary } from './pi-core-binaries.mjs'

export const name = 'pi-compatible-core-search'
export const inject = ['subprocess', 'tools', 'fs', 'systemPrompt']

const DEFAULT_FIND_LIMIT = 1_000
const DEFAULT_GREP_LIMIT = 100
const DEFAULT_LS_LIMIT = 500
const DEFAULT_CONTEXT_FILE_MAX_BYTES = 10 * 1024 * 1024

async function resolveSearchPath(ctx, requested, exec, expectedType) {
  const target = await ctx.fs.resolve(requested ?? '.', { cwd: sessionCwd(exec), signal: exec.signal })
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) throw new Error(`Path not found: ${target.displayPath}`)
  if (expectedType !== undefined && info.type !== expectedType) {
    throw new Error(expectedType === 'directory' ? `Not a directory: ${target.displayPath}` : `Not a regular file: ${target.displayPath}`)
  }
  return { target, info, processPath: ctx.fs.processPath(target) }
}

function relativeResult(resultPath, searchPath) {
  const trailing = resultPath.endsWith(path.sep) || (path.sep === '\\' && resultPath.endsWith('/'))
  const relative = path.isAbsolute(resultPath) ? path.relative(searchPath, resultPath) : resultPath
  const normalized = relative.split(path.sep).join('/')
  return trailing && !normalized.endsWith('/') ? `${normalized}/` : normalized
}

function insideGitRepository(searchPath) {
  let current = searchPath
  while (true) {
    if (existsSync(path.join(current, '.git'))) return true
    const parent = path.dirname(current)
    if (parent === current) return false
    current = parent
  }
}

async function collectLines(ctx, spec, signal, onLine) {
  const handle = ctx.subprocess.spawn({
    ...spec,
    stdio: {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: { maxBytes: 64 * 1024 },
    },
    graceMs: 3_000,
    signal,
  })
  const reader = createInterface({ input: handle.stdout, crlfDelay: Infinity })
  reader.on('line', onLine)
  try {
    const outcome = await handle.done
    return {
      outcome,
      stderr: handle.collected.stderr?.readFrom(0).text ?? '',
      terminate: () => handle.terminate(),
    }
  } finally {
    reader.close()
  }
}

async function readContextFile(ctx, filePath, exec, maxBytes) {
  const target = await ctx.fs.resolve(filePath, { cwd: sessionCwd(exec), signal: exec.signal })
  try {
    const info = await ctx.fs.stat(target, exec.signal)
    if (info === undefined || info.type !== 'file' || (info.size !== undefined && info.size > maxBytes)) return []
    return (await ctx.fs.readText(target, exec.signal)).replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
  } catch {
    return []
  }
}

function searchOutput(raw, notices, maxBytes) {
  const truncation = truncateHead(raw, { maxLines: Number.MAX_SAFE_INTEGER, maxBytes })
  const allNotices = [...notices]
  if (truncation.truncated) allNotices.push(`${formatSize(maxBytes)} limit reached`)
  return truncation.content + (allNotices.length > 0 ? `\n\n[${allNotices.join('. ')}]` : '')
}

export function apply(ctx, config = {}) {
  const maxBytes = positiveInteger(config.maxBytes, DEFAULT_MAX_BYTES)
  const findLimit = positiveInteger(config.findLimit, DEFAULT_FIND_LIMIT)
  const grepLimit = positiveInteger(config.grepLimit, DEFAULT_GREP_LIMIT)
  const lsLimit = positiveInteger(config.lsLimit, DEFAULT_LS_LIMIT)
  const contextFileMaxBytes = positiveInteger(config.contextFileMaxBytes, DEFAULT_CONTEXT_FILE_MAX_BYTES)

  ctx.systemPrompt.section({
    name: 'tool:pi-compatible-core-search',
    order: 101,
    text: 'Use find for glob-based file discovery, grep for content search, and ls for one-directory inspection. find uses fd and grep uses ripgrep; both respect repository ignore rules.',
  })

  ctx.tools.register({
    name: 'find',
    description: `Search for files by glob pattern using fd. Results are relative to the search directory and respect .gitignore. The default result limit is ${String(findLimit)}; final output is truncated to ${String(maxBytes / 1024)}KB.`,
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        pattern: { type: 'string', description: "Glob pattern such as '*.ts', '**/*.json', or 'src/**/*.spec.ts'." },
        path: { type: 'string', description: 'Directory to search in (default: current directory).' },
        limit: { type: 'number', description: `Maximum number of results (default: ${String(findLimit)}).` },
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
      const effectiveLimit = args.limit ?? findLimit
      if (typeof effectiveLimit !== 'number' || !Number.isFinite(effectiveLimit) || effectiveLimit < 1) throw new Error('limit must be a finite positive number')
      const limit = Math.floor(effectiveLimit)
      const { processPath } = await resolveSearchPath(ctx, typeof args.path === 'string' && args.path.length > 0 ? args.path : '.', exec, 'directory')
      const fd = await ensureBinary(ctx, 'fd', exec.signal)
      if (fd === undefined) throw new Error('fd is not available and could not be downloaded')
      const argv = [fd, '--glob', '--color=never', '--hidden']
      if (!insideGitRepository(processPath)) argv.push('--no-require-git')
      argv.push('--max-results', String(limit))
      let pattern = args.pattern
      if (pattern.includes('/')) {
        argv.push('--full-path')
        if (!pattern.startsWith('/') && !pattern.startsWith('**/') && pattern !== '**') pattern = `**/${pattern}`
        if (process.platform === 'win32') pattern = pattern.replaceAll('/', String.raw`[/\\]`)
      }
      argv.push('--', pattern, processPath)
      const results = []
      const run = await collectLines(ctx, { argv, cwd: sessionCwd(exec) }, exec.signal, (line) => {
        const value = line.replace(/\r$/u, '').trim()
        if (value.length > 0 && results.length < limit) results.push(relativeResult(value, processPath))
      })
      if (run.outcome.exitCode !== 0 && run.outcome.exitCode !== 1) throw new Error(run.stderr.trim() || `fd exited with code ${String(run.outcome.exitCode)}`)
      if (results.length === 0) return { text: 'No files found matching pattern' }
      const notices = results.length >= limit
        ? [`${String(limit)} results limit reached. Use limit=${String(limit * 2)} for more, or refine pattern`]
        : []
      return { text: searchOutput(results.join('\n'), notices, maxBytes) }
    },
  })

  ctx.tools.register({
    name: 'grep',
    description: `Search file contents with ripgrep. Returns paths, line numbers, and optional context. Respects .gitignore. The default match limit is ${String(grepLimit)}; final output is truncated to ${String(maxBytes / 1024)}KB and long lines to ${String(GREP_MAX_LINE_LENGTH)} characters.`,
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        pattern: { type: 'string', description: 'Search pattern (regular expression or literal string).' },
        path: { type: 'string', description: 'Directory or file to search (default: current directory).' },
        glob: { type: 'string', description: "Filter files by glob pattern, for example '*.ts'." },
        ignoreCase: { type: 'boolean', description: 'Case-insensitive search (default: false).' },
        literal: { type: 'boolean', description: 'Treat pattern as a literal string (default: false).' },
        context: { type: 'number', description: 'Lines before and after each match (default: 0).' },
        limit: { type: 'number', description: `Maximum number of matches (default: ${String(grepLimit)}).` },
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
      const effectiveLimit = args.limit ?? grepLimit
      if (typeof effectiveLimit !== 'number' || !Number.isFinite(effectiveLimit) || effectiveLimit < 1) throw new Error('limit must be a finite positive number')
      const limit = Math.floor(effectiveLimit)
      const context = args.context ?? 0
      if (typeof context !== 'number' || !Number.isFinite(context) || context < 0) throw new Error('context must be a finite non-negative number')
      const contextLines = Math.floor(context)
      const { info, processPath } = await resolveSearchPath(ctx, typeof args.path === 'string' && args.path.length > 0 ? args.path : '.', exec)
      const rg = await ensureBinary(ctx, 'rg', exec.signal)
      if (rg === undefined) throw new Error('ripgrep (rg) is not available and could not be downloaded')
      const argv = [rg, '--json', '--line-number', '--color=never', '--hidden']
      if (args.ignoreCase === true) argv.push('--ignore-case')
      if (args.literal === true) argv.push('--fixed-strings')
      if (typeof args.glob === 'string' && args.glob.length > 0) argv.push('--glob', args.glob)
      argv.push('--', args.pattern, processPath)
      const matches = []
      let reachedLimit = false
      let handle
      const run = await new Promise((resolve, reject) => {
        handle = ctx.subprocess.spawn({
          argv,
          cwd: sessionCwd(exec),
          stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 64 * 1024 } },
          graceMs: 3_000,
          signal: exec.signal,
        })
        const reader = createInterface({ input: handle.stdout, crlfDelay: Infinity })
        reader.on('line', (line) => {
          if (matches.length >= limit) return
          try {
            const event = JSON.parse(line)
            if (event.type !== 'match') return
            const filePath = event.data?.path?.text
            const lineNumber = event.data?.line_number
            const lineText = event.data?.lines?.text
            if (typeof filePath !== 'string' || typeof lineNumber !== 'number') return
            matches.push({ filePath, lineNumber, lineText })
            if (matches.length >= limit) {
              reachedLimit = true
              handle.terminate()
            }
          } catch {}
        })
        handle.done.then((outcome) => {
          reader.close()
          resolve({ outcome, stderr: handle.collected.stderr?.readFrom(0).text ?? '' })
        }, reject)
      })
      if (!reachedLimit && run.outcome.exitCode !== 0 && run.outcome.exitCode !== 1) throw new Error(run.stderr.trim() || `ripgrep exited with code ${String(run.outcome.exitCode)}`)
      if (matches.length === 0) return { text: 'No matches found' }

      const root = info.type === 'directory' ? processPath : path.dirname(processPath)
      const cache = new Map()
      let linesTruncated = false
      const output = []
      for (const match of matches) {
        const relative = info.type === 'directory'
          ? relativeResult(match.filePath, root)
          : path.basename(match.filePath).replaceAll('\\', '/')
        if (contextLines === 0 && typeof match.lineText === 'string') {
          const raw = match.lineText.replaceAll('\r\n', '\n').replaceAll('\r', '').replace(/\n$/u, '')
          const clipped = truncateLine(raw)
          if (clipped.wasTruncated) linesTruncated = true
          output.push(`${relative}:${String(match.lineNumber)}: ${clipped.text}`)
          continue
        }
        let fileLines = cache.get(match.filePath)
        if (fileLines === undefined) {
          fileLines = await readContextFile(ctx, match.filePath, exec, contextFileMaxBytes)
          cache.set(match.filePath, fileLines)
        }
        if (fileLines.length === 0) {
          output.push(`${relative}:${String(match.lineNumber)}: (unable to read file)`)
          continue
        }
        const start = Math.max(1, match.lineNumber - contextLines)
        const end = Math.min(fileLines.length, match.lineNumber + contextLines)
        for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
          const clipped = truncateLine((fileLines[lineNumber - 1] ?? '').replaceAll('\r', ''))
          if (clipped.wasTruncated) linesTruncated = true
          output.push(lineNumber === match.lineNumber
            ? `${relative}:${String(lineNumber)}: ${clipped.text}`
            : `${relative}-${String(lineNumber)}- ${clipped.text}`)
        }
      }
      const notices = []
      if (reachedLimit) notices.push(`${String(limit)} matches limit reached. Use limit=${String(limit * 2)} for more, or refine pattern`)
      if (linesTruncated) notices.push(`Some lines truncated to ${String(GREP_MAX_LINE_LENGTH)} chars. Use read to see full lines`)
      return { text: searchOutput(output.join('\n'), notices, maxBytes) }
    },
  })

  ctx.tools.register({
    name: 'ls',
    description: `List one directory alphabetically, including dotfiles, with '/' after directories. The default entry limit is ${String(lsLimit)}; final output is truncated to ${String(maxBytes / 1024)}KB.`,
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Directory to list (default: current directory).' },
        limit: { type: 'number', description: `Maximum number of entries (default: ${String(lsLimit)}).` },
      },
      required: [],
    },
    output: textOutput(),
    isConcurrencySafe: () => true,
    presentCall(args) {
      return { card: 'generic', title: `ls ${typeof args.path === 'string' ? args.path : '.'}`, kind: 'read', locations: typeof args.path === 'string' ? [{ path: args.path }] : undefined }
    },
    async execute(args, exec) {
      const effectiveLimit = args.limit ?? lsLimit
      if (typeof effectiveLimit !== 'number' || !Number.isFinite(effectiveLimit) || effectiveLimit < 1) throw new Error('limit must be a finite positive number')
      const limit = Math.floor(effectiveLimit)
      const { target } = await resolveSearchPath(ctx, typeof args.path === 'string' && args.path.length > 0 ? args.path : '.', exec, 'directory')
      const entries = (await ctx.fs.listDir(target, exec.signal))
        .filter((entry) => entry.type === 'file' || entry.type === 'directory')
        .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
      if (entries.length === 0) return { text: '(empty directory)' }
      const visible = entries.slice(0, limit).map((entry) => `${entry.name}${entry.type === 'directory' ? '/' : ''}`)
      const notices = entries.length > visible.length
        ? [`${String(limit)} entries limit reached. Use limit=${String(limit * 2)} for more`]
        : []
      return { text: searchOutput(visible.join('\n'), notices, maxBytes) }
    },
  })
}
