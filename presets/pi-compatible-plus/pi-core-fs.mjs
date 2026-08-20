// Pi 0.84.2-compatible read/write/edit tools over DSH's filesystem and attachment seams.

import { basename, extname } from 'node:path'
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  positiveInteger,
  sessionCwd,
  splitLinesForCounting,
  textOutput,
  throwIfAborted,
  truncateHead,
  withMutationQueue,
} from './pi-core-common.mjs'

export const name = 'pi-compatible-core-fs'
export const inject = ['tools', 'fs', 'systemPrompt']

const DEFAULT_MAX_EDITS = 64
const DEFAULT_READ_MAX_BYTES = 64 * 1024 * 1024
const DEFAULT_EDIT_MAX_BYTES = 10 * 1024 * 1024
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const DSH_MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

function standingPolicy(ctx, exec) {
  if (ctx.fs.sandboxMode === undefined) return undefined
  const service = ctx.get('sandboxPolicy')
  if (service === undefined) throw new Error('pi-compatible-core-fs requires sandboxPolicy with a confining filesystem')
  return service.resolve(exec?.agent === undefined ? {} : { session: exec.agent.session })
}

async function resolveTarget(ctx, filePath, exec, policy) {
  const cwd = policy?.workspaceRoot ?? sessionCwd(exec)
  return await ctx.fs.resolve(filePath, { cwd, signal: exec.signal })
}

function imageReadOutput() {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        image: {
          type: 'object',
          additionalProperties: false,
          properties: {
            attachmentId: { type: 'string' },
            mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
            bytes: { type: 'integer' },
            width: { type: 'integer' },
            height: { type: 'integer' },
            name: { type: 'string' },
          },
          required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
        },
      },
      required: ['text'],
    },
    render: (_args, value) => [
      { type: 'text', text: value.text },
      ...(value.image === undefined ? [] : [{ type: 'image', attachment: value.image }]),
    ],
  }
}

async function routeSupportsImages(ctx, exec) {
  const routed = exec.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec.agent?.options?.provider
  const model = routed?.model ?? exec.agent?.options?.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) return false
  try {
    const active = await llm.resolveModelInfo(provider, model, exec.signal)
    return active.inputModalities?.includes('image') === true
  } catch {
    return false
  }
}

function bmpDimensions(bytes) {
  if (bytes.length < 26 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = Math.abs(view.getInt32(18, true))
  const height = Math.abs(view.getInt32(22, true))
  return width > 0 && height > 0 ? { width, height } : undefined
}

async function readImage(ctx, args, exec, target, info, extension) {
  if (typeof ctx.fs.readBytes !== 'function') {
    throw new Error(`cannot read "${args.path}" as an image: filesystem byte reads are unavailable`)
  }
  const attachments = ctx.get('attachments')
  if (attachments === undefined) {
    throw new Error(`cannot read "${args.path}" as an image: no DSH attachment service is mounted`)
  }
  const byteCap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
  const data = await ctx.fs.readBytes(target, exec.signal, byteCap)
  if (extension === '.bmp') {
    const dimensions = bmpDimensions(data)
    ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
    return {
      text: [
        `Read image file [image/bmp]: ${target.displayPath}`,
        dimensions === undefined ? '' : `[Image: ${String(dimensions.width)}x${String(dimensions.height)}.]`,
        '[Image omitted: Pi 0.84.2 accepts BMP, but this DSH attachment deployment does not. Convert it to PNG, JPEG, WebP, or GIF.]',
      ].filter(Boolean).join('\n'),
    }
  }
  const mediaType = DSH_MEDIA_TYPES[extension]
  if (!attachments.imageLimits.mediaTypes.includes(mediaType)) {
    throw new Error(`cannot read "${args.path}": this deployment does not accept ${mediaType}`)
  }
  let ref
  try {
    ref = await attachments.saveImage({ data, mediaType, name: basename(target.displayPath) })
  } catch (error) {
    if (error?.code !== 'IMAGE_TYPE_MISMATCH') throw error
    throw new Error(`cannot read "${target.displayPath}": the extension declares ${mediaType}, but the bytes use a different image format`)
  }
  ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
  const image = {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
  }
  const capable = await routeSupportsImages(ctx, exec)
  const dimensionNotice = ref.width > 2000 || ref.height > 2000
    ? `[Image is ${String(ref.width)}x${String(ref.height)}. Pi normally resizes to 2000x2000; DSH stored the original because its attachment seam has no resize operation.]`
    : `[Image: ${String(ref.width)}x${String(ref.height)}.]`
  return {
    text: [
      `Read image file [${ref.mediaType}]: ${target.displayPath}`,
      dimensionNotice,
      ...(capable ? [] : ['[Current model does not support image input; the image attachment was omitted from model content.]']),
    ].join('\n'),
    ...(capable ? { image } : {}),
  }
}

function renderReadWindow(content, offset, limit, maxLines, maxBytes, path) {
  const normalized = content.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  const allLines = splitLinesForCounting(normalized)
  if (allLines.length === 0) return ''
  const startIndex = Math.floor(offset) - 1
  if (startIndex >= allLines.length) throw new Error(`Offset ${String(offset)} is beyond end of file (${String(allLines.length)} lines total)`)
  const requested = limit === undefined
    ? allLines.slice(startIndex)
    : allLines.slice(startIndex, startIndex + Math.floor(limit))
  const truncated = truncateHead(requested.join('\n'), { maxLines, maxBytes })
  if (truncated.firstLineExceedsLimit) {
    return `[Line ${String(offset)} exceeds ${String(maxBytes)} bytes. Use bash: sed -n '${String(offset)}p' ${JSON.stringify(path)} | head -c ${String(maxBytes)}]`
  }
  const nextOffset = startIndex + truncated.outputLines + 1
  if (truncated.truncated) {
    const endLine = startIndex + truncated.outputLines
    const byteNotice = truncated.truncatedBy === 'bytes' ? ` (${String(maxBytes)} byte limit)` : ''
    return `${truncated.content}\n\n[Showing lines ${String(offset)}-${String(endLine)} of ${String(allLines.length)}${byteNotice}. Use offset=${String(nextOffset)} to continue.]`
  }
  const consumed = requested.length
  if (startIndex + consumed < allLines.length) {
    return `${truncated.content}\n\n[${String(allLines.length - startIndex - consumed)} more lines in file. Use offset=${String(startIndex + consumed + 1)} to continue.]`
  }
  return truncated.content
}

export function detectLineEnding(content) {
  const crlf = content.indexOf('\r\n')
  const lf = content.indexOf('\n')
  if (lf === -1 || crlf === -1) return '\n'
  return crlf < lf ? '\r\n' : '\n'
}

export function normalizeToLF(text) {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
}

export function restoreLineEndings(text, ending) {
  return ending === '\r\n' ? text.replaceAll('\n', '\r\n') : text
}

export function stripBom(content) {
  return content.startsWith('\uFEFF') ? { bom: '\uFEFF', text: content.slice(1) } : { bom: '', text: content }
}

export function normalizeForFuzzyMatch(text) {
  return text.normalize('NFKC')
    .split('\n').map((line) => line.trimEnd()).join('\n')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ')
}

function fuzzyFindText(content, oldText) {
  const exact = content.indexOf(oldText)
  if (exact !== -1) return { found: true, index: exact, length: oldText.length, fuzzy: false }
  const fuzzyContent = normalizeForFuzzyMatch(content)
  const fuzzyOldText = normalizeForFuzzyMatch(oldText)
  const index = fuzzyContent.indexOf(fuzzyOldText)
  return index === -1
    ? { found: false, index: -1, length: 0, fuzzy: false }
    : { found: true, index, length: fuzzyOldText.length, fuzzy: true }
}

function countOccurrences(content, oldText) {
  const haystack = normalizeForFuzzyMatch(content)
  const needle = normalizeForFuzzyMatch(oldText)
  if (needle.length === 0) return 0
  return haystack.split(needle).length - 1
}

function splitLinesWithEndings(content) {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? []
}

function lineSpans(content) {
  let offset = 0
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length }
    offset = span.end
    return span
  })
}

function replacementLineRange(lines, replacement) {
  const start = replacement.matchIndex
  const end = replacement.matchIndex + replacement.matchLength
  let startLine = lines.findIndex((line) => start >= line.start && start < line.end)
  if (startLine < 0) throw new Error('Replacement range is outside the base content')
  let endLine = startLine
  while (endLine < lines.length && lines[endLine].end < end) endLine += 1
  if (endLine >= lines.length) throw new Error('Replacement range is outside the base content')
  return { startLine, endLine: endLine + 1 }
}

function applyReplacements(content, replacements, offset = 0) {
  let output = content
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const item = replacements[index]
    const at = item.matchIndex - offset
    output = output.slice(0, at) + item.newText + output.slice(at + item.matchLength)
  }
  return output
}

function applyReplacementsPreservingLines(original, base, replacements) {
  const originalLines = splitLinesWithEndings(original)
  const baseLines = lineSpans(base)
  if (originalLines.length !== baseLines.length) throw new Error('Cannot preserve unchanged lines after fuzzy matching')
  const groups = []
  for (const replacement of [...replacements].sort((a, b) => a.matchIndex - b.matchIndex)) {
    const range = replacementLineRange(baseLines, replacement)
    const current = groups.at(-1)
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine)
      current.replacements.push(replacement)
    } else {
      groups.push({ ...range, replacements: [replacement] })
    }
  }
  let lineIndex = 0
  let output = ''
  for (const group of groups) {
    output += originalLines.slice(lineIndex, group.startLine).join('')
    const start = baseLines[group.startLine].start
    const end = baseLines[group.endLine - 1].end
    output += applyReplacements(base.slice(start, end), group.replacements, start)
    lineIndex = group.endLine
  }
  return output + originalLines.slice(lineIndex).join('')
}

export function applyCompatibleEdits(normalizedContent, edits, path) {
  const normalizedEdits = edits.map((edit, index) => {
    if (edit === null || typeof edit !== 'object' || Array.isArray(edit)) throw new Error(`edits[${String(index)}] must be an object`)
    if (typeof edit.oldText !== 'string' || edit.oldText.length === 0) throw new Error(`edits[${String(index)}].oldText must be a non-empty string`)
    if (typeof edit.newText !== 'string') throw new Error(`edits[${String(index)}].newText must be a string`)
    return { oldText: normalizeToLF(edit.oldText), newText: normalizeToLF(edit.newText) }
  })
  const fuzzy = normalizedEdits.some((edit) => fuzzyFindText(normalizedContent, edit.oldText).fuzzy)
  const base = fuzzy ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent
  const matched = normalizedEdits.map((edit, index) => {
    const match = fuzzyFindText(base, edit.oldText)
    if (!match.found) throw new Error(`Could not find edits[${String(index)}] in ${path}; oldText must match exactly including whitespace and newlines`)
    const occurrences = countOccurrences(base, edit.oldText)
    if (occurrences > 1) throw new Error(`Found ${String(occurrences)} occurrences of edits[${String(index)}] in ${path}; oldText must be unique`)
    return { editIndex: index, matchIndex: match.index, matchLength: match.length, newText: edit.newText }
  }).sort((a, b) => a.matchIndex - b.matchIndex)
  for (let index = 1; index < matched.length; index += 1) {
    const previous = matched[index - 1]
    const current = matched[index]
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(`edits[${String(previous.editIndex)}] and edits[${String(current.editIndex)}] overlap in ${path}`)
    }
  }
  const output = fuzzy
    ? applyReplacementsPreservingLines(normalizedContent, base, matched)
    : applyReplacements(base, matched)
  if (output === normalizedContent) throw new Error(`No changes made to ${path}; replacements produced identical content`)
  return output
}

export function apply(ctx, config = {}) {
  const maxLines = positiveInteger(config.maxLines, DEFAULT_MAX_LINES)
  const maxBytes = positiveInteger(config.maxBytes, DEFAULT_MAX_BYTES)
  const maxEdits = positiveInteger(config.maxEdits, DEFAULT_MAX_EDITS)
  const readMaxBytes = positiveInteger(config.readMaxBytes, DEFAULT_READ_MAX_BYTES)
  const editMaxBytes = positiveInteger(config.editMaxBytes, DEFAULT_EDIT_MAX_BYTES)

  ctx.systemPrompt.section({
    name: 'tool:pi-compatible-core-fs',
    order: 100,
    text: 'Use read for text and image files. Use write for new files or complete rewrites. Use one edit call with multiple disjoint edits[] entries for precise changes; each oldText is matched against the original file and the batch commits atomically.',
  })

  ctx.tools.register({
    name: 'read',
    description: `Read a text or image file. Text output is truncated to ${String(maxLines)} lines or ${String(maxBytes / 1024)}KB; use offset to continue. Images support PNG, JPEG, GIF, WebP, and BMP subject to DSH attachment capabilities.`,
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Path to the file to read (relative or absolute).' },
        offset: { type: 'number', description: '1-indexed line to start reading from.' },
        limit: { type: 'number', description: 'Maximum number of lines to read.' },
      },
      required: ['path'],
    },
    output: imageReadOutput(),
    isConcurrencySafe: () => true,
    presentCall(args) {
      return typeof args.path === 'string' ? { card: 'generic', title: `read ${args.path}`, kind: 'read', locations: [{ path: args.path }] } : undefined
    },
    async execute(args, exec) {
      if (typeof args.path !== 'string' || args.path.trim().length === 0) throw new Error('path must be a non-empty string')
      const offset = args.offset ?? 1
      if (typeof offset !== 'number' || !Number.isFinite(offset) || offset < 1) throw new Error('offset must be a finite positive number')
      if (args.limit !== undefined && (typeof args.limit !== 'number' || !Number.isFinite(args.limit) || args.limit < 1)) throw new Error('limit must be a finite positive number')
      const target = await resolveTarget(ctx, args.path, exec)
      const info = await ctx.fs.stat(target, exec.signal)
      if (info === undefined) throw new Error(`Path not found: ${target.displayPath}`)
      if (info.type !== 'file') throw new Error(`Not a regular file: ${target.displayPath}`)
      const extension = extname(args.path).toLowerCase()
      if (IMAGE_EXTENSIONS.has(extension)) return await readImage(ctx, args, exec, target, info, extension)
      if (info.size !== undefined && info.size > readMaxBytes) {
        throw new Error(`Cannot read ${target.displayPath}: file exceeds the ${String(readMaxBytes)} byte safety limit. Use bash to inspect it in bounded chunks.`)
      }
      const content = await ctx.fs.readText(target, exec.signal)
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      return { text: renderReadWindow(content, offset, args.limit, maxLines, maxBytes, target.displayPath) }
    },
  })

  ctx.tools.register({
    name: 'write',
    description: 'Write a UTF-8 text file, creating parent directories when needed. Replaces the complete file when it already exists.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Path to the file to write (relative or absolute).' },
        content: { type: 'string', description: 'Complete file content.' },
      },
      required: ['path', 'content'],
    },
    output: textOutput(),
    presentCall(args) {
      return typeof args.path === 'string' && typeof args.content === 'string'
        ? { card: 'diff', title: `write ${args.path}`, diffs: [{ path: args.path, oldText: null, newText: args.content }], locations: [{ path: args.path }] }
        : undefined
    },
    async execute(args, exec) {
      if (typeof args.path !== 'string' || args.path.trim().length === 0) throw new Error('path must be a non-empty string')
      if (typeof args.content !== 'string') throw new Error('content must be a string')
      const policy = standingPolicy(ctx, exec)
      const target = await resolveTarget(ctx, args.path, exec, policy)
      return await withMutationQueue(String(target.targetKey), async () => {
        throwIfAborted(exec.signal)
        const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
        const outcome = await ctx.fs.writeText(target, args.content, intent, exec.signal, policy)
        throwIfAborted(exec.signal)
        ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
        return { text: `Successfully wrote ${String(args.content.length)} bytes to ${target.displayPath}` }
      })
    },
  })

  ctx.tools.register({
    name: 'edit',
    description: 'Edit one file using exact text replacement. Every edits[].oldText must identify a unique, non-overlapping region of the original file.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Path to the file to edit (relative or absolute).' },
        edits: {
          type: 'array',
          description: 'One or more targeted replacements matched against the original file.',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              oldText: { type: 'string', description: 'Exact unique text to replace.' },
              newText: { type: 'string', description: 'Replacement text.' },
            },
            required: ['oldText', 'newText'],
          },
        },
      },
      required: ['path', 'edits'],
    },
    output: textOutput(),
    presentCall(args) {
      if (typeof args.path !== 'string' || !Array.isArray(args.edits)) return undefined
      return {
        card: 'diff', title: `edit ${args.path}`, locations: [{ path: args.path }],
        diffs: args.edits.filter((edit) => edit && typeof edit.oldText === 'string' && typeof edit.newText === 'string')
          .map((edit) => ({ path: args.path, oldText: edit.oldText, newText: edit.newText })),
      }
    },
    async execute(args, exec) {
      if (typeof args.path !== 'string' || args.path.trim().length === 0) throw new Error('path must be a non-empty string')
      if (!Array.isArray(args.edits) || args.edits.length === 0) throw new Error('edits must contain at least one replacement')
      if (args.edits.length > maxEdits) throw new Error(`edits cannot contain more than ${String(maxEdits)} items`)
      const policy = standingPolicy(ctx, exec)
      const target = await resolveTarget(ctx, args.path, exec, policy)
      return await withMutationQueue(String(target.targetKey), async () => {
        throwIfAborted(exec.signal)
        const expected = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
        const info = await ctx.fs.stat(target, exec.signal)
        if (info === undefined) throw new Error(`Could not edit file: ${target.displayPath}. Error code: ENOENT.`)
        if (info.type !== 'file') throw new Error(`Could not edit file: ${target.displayPath}. Not a regular file.`)
        if (info.size !== undefined && info.size > editMaxBytes) throw new Error(`Could not edit file: ${target.displayPath}. File exceeds ${String(editMaxBytes)} bytes.`)
        const raw = await ctx.fs.readText(target, exec.signal)
        throwIfAborted(exec.signal)
        const { bom, text } = stripBom(raw)
        const ending = detectLineEnding(text)
        const normalized = normalizeToLF(text)
        const updated = applyCompatibleEdits(normalized, args.edits, target.displayPath)
        const finalContent = bom + restoreLineEndings(updated, ending)
        const version = expected?.version ?? info.version
        const outcome = await ctx.fs.writeText(target, finalContent, { kind: 'replaceIfVersion', version }, exec.signal, policy)
        throwIfAborted(exec.signal)
        ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
        return { text: `Successfully replaced ${String(args.edits.length)} block(s) in ${target.displayPath}.` }
      })
    },
  })
}
