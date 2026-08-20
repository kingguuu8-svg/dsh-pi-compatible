// Shared Pi 0.84.2 compatibility primitives.
// Algorithms are independently adapted from the MIT-licensed
// @earendil-works/pi-coding-agent 0.84.2 tool behavior.

import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_MAX_LINES = 2_000
export const DEFAULT_MAX_BYTES = 50 * 1024
export const GREP_MAX_LINE_LENGTH = 500
export const MAX_TIMER_DELAY_MS = 2_147_483_647

export function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

export function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

export function sessionCwd(exec) {
  return exec?.agent?.session?.header?.cwd ?? process.cwd()
}

export function resolveDshHome() {
  const configured = process.env.DSH_HOME?.trim()
  return configured ? configured : join(homedir(), '.dsh')
}

export function textOutput() {
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

export function splitLinesForCounting(content) {
  if (content.length === 0) return []
  const lines = content.split('\n')
  if (content.endsWith('\n')) lines.pop()
  return lines
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${String(bytes)}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

export function truncateHead(content, options = {}) {
  const maxLines = positiveInteger(options.maxLines, DEFAULT_MAX_LINES)
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES)
  const totalBytes = Buffer.byteLength(content, 'utf8')
  const lines = splitLinesForCounting(content)
  const totalLines = lines.length
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content, truncated: false, truncatedBy: null, totalLines, totalBytes,
      outputLines: totalLines, outputBytes: totalBytes, lastLinePartial: false,
      firstLineExceedsLimit: false, maxLines, maxBytes,
    }
  }
  const firstLineBytes = Buffer.byteLength(lines[0] ?? '', 'utf8')
  if (firstLineBytes > maxBytes) {
    return {
      content: '', truncated: true, truncatedBy: 'bytes', totalLines, totalBytes,
      outputLines: 0, outputBytes: 0, lastLinePartial: false,
      firstLineExceedsLimit: true, maxLines, maxBytes,
    }
  }
  const output = []
  let bytes = 0
  let truncatedBy = 'lines'
  for (let index = 0; index < lines.length && index < maxLines; index += 1) {
    const line = lines[index]
    const lineBytes = Buffer.byteLength(line, 'utf8') + (index > 0 ? 1 : 0)
    if (bytes + lineBytes > maxBytes) {
      truncatedBy = 'bytes'
      break
    }
    output.push(line)
    bytes += lineBytes
  }
  if (output.length >= maxLines && bytes <= maxBytes) truncatedBy = 'lines'
  const outputContent = output.join('\n')
  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: output.length,
    outputBytes: Buffer.byteLength(outputContent, 'utf8'),
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  }
}

function truncateStringToBytesFromEnd(text, maxBytes) {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return text
  let start = bytes.length - maxBytes
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1
  return bytes.subarray(start).toString('utf8')
}

export function truncateTail(content, options = {}) {
  const maxLines = positiveInteger(options.maxLines, DEFAULT_MAX_LINES)
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES)
  const totalBytes = Buffer.byteLength(content, 'utf8')
  const lines = splitLinesForCounting(content)
  const totalLines = lines.length
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content, truncated: false, truncatedBy: null, totalLines, totalBytes,
      outputLines: totalLines, outputBytes: totalBytes, lastLinePartial: false,
      firstLineExceedsLimit: false, maxLines, maxBytes,
    }
  }
  const output = []
  let bytes = 0
  let truncatedBy = 'lines'
  let lastLinePartial = false
  for (let index = lines.length - 1; index >= 0 && output.length < maxLines; index -= 1) {
    const line = lines[index]
    const lineBytes = Buffer.byteLength(line, 'utf8') + (output.length > 0 ? 1 : 0)
    if (bytes + lineBytes > maxBytes) {
      truncatedBy = 'bytes'
      if (output.length === 0) {
        const partial = truncateStringToBytesFromEnd(line, maxBytes)
        output.unshift(partial)
        bytes = Buffer.byteLength(partial, 'utf8')
        lastLinePartial = true
      }
      break
    }
    output.unshift(line)
    bytes += lineBytes
  }
  if (output.length >= maxLines && bytes <= maxBytes) truncatedBy = 'lines'
  const outputContent = output.join('\n')
  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: output.length,
    outputBytes: Buffer.byteLength(outputContent, 'utf8'),
    lastLinePartial,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  }
}

export function truncateLine(line, maxChars = GREP_MAX_LINE_LENGTH) {
  if (line.length <= maxChars) return { text: line, wasTruncated: false }
  return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true }
}

const mutationQueues = new Map()
let registrationQueue = Promise.resolve()

export async function withMutationQueue(key, operation) {
  const registration = registrationQueue.then(() => {
    const current = mutationQueues.get(key) ?? Promise.resolve()
    let release
    const next = new Promise((resolve) => { release = resolve })
    const chained = current.then(() => next)
    mutationQueues.set(key, chained)
    return { current, next: chained, release }
  })
  registrationQueue = registration.then(() => undefined, () => undefined)
  const entry = await registration
  await entry.current
  try {
    return await operation()
  } finally {
    entry.release()
    if (mutationQueues.get(key) === entry.next) mutationQueues.delete(key)
  }
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error('Operation aborted')
}
