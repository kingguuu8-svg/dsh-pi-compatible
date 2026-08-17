// Pi coding-agent core filesystem tools for the pi-compatible preset.
// Contract baseline: @earendil-works/pi-coding-agent 0.84.2.
// The implementation uses DSH's ctx.fs and ctx.attachments seams and never
// touches the shipped pi preset.

import { basename, extname } from 'node:path'

export const name = 'pi-compatible-core-fs'
export const inject = ['tools', 'fs', 'systemPrompt']

const DEFAULT_MAX_LINES = 2_000
const DEFAULT_MAX_BYTES = 50 * 1024
const DEFAULT_MAX_EDITS = 64
const DEFAULT_EDIT_MAX_BYTES = 10 * 1024 * 1024
const IMAGE_MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function sessionCwd(exec) {
  return exec?.agent?.session?.header?.cwd
}

function standingPolicy(ctx, exec) {
  if (ctx.fs.sandboxMode === undefined) return undefined
  const service = ctx.get('sandboxPolicy')
  if (service === undefined) throw new Error('pi-compatible-core-fs requires sandboxPolicy with a confining filesystem')
  return service.resolve(exec?.agent === undefined ? {} : { session: exec.agent.session })
}

async function resolveTarget(ctx, filePath, exec, policy) {
  const cwd = policy?.workspaceRoot ?? sessionCwd(exec)
  return await ctx.fs.resolve(filePath, {
    ...(cwd === undefined ? {} : { cwd }),
    signal: exec.signal,
  })
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

function imageMediaTypeForPath(filePath) {
  return IMAGE_MEDIA_TYPES[extname(filePath).toLowerCase()]
}

async function assertImageCapableRoute(ctx, exec, requestedPath) {
  const routed = exec.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec.agent?.options?.provider
  const model = routed?.model ?? exec.agent?.options?.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error(`cannot read "${requestedPath}" as an image: the current model route could not be resolved`)
  }
  const active = await llm.resolveModelInfo(provider, model, exec.signal)
  if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
    throw new Error(`cannot read "${requestedPath}" as an image: model "${model}" does not declare image input; switch to an image-capable model to read images`)
  }
}

async function readImage(ctx, args, exec, target, info, mediaType) {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error(`cannot read "${args.path}" as an image: no attachment service is mounted`)
  if (!attachments.imageLimits?.mediaTypes?.includes(mediaType)) {
    throw new Error(`cannot read "${args.path}": ${mediaType} images are not accepted by this deployment`)
  }
  await assertImageCapableRoute(ctx, exec, args.path)
  if (typeof ctx.fs.readBytes !== 'function') throw new Error(`cannot read "${args.path}" as an image: filesystem byte reads are unavailable`)
  const byteCap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
  const data = await ctx.fs.readBytes(target, exec.signal, byteCap)
  let ref
  try {
    ref = await attachments.saveImage({ data, mediaType, name: basename(target.displayPath) })
  } catch (error) {
    if (error?.code !== 'IMAGE_TYPE_MISMATCH') throw error
    const extension = extname(target.displayPath).toLowerCase()
    throw new Error(`cannot read "${target.displayPath}": the ${extension} extension declares ${mediaType}, but the bytes use a different image format; rename the file to match its actual format or convert it to a supported image format`)
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
  return {
    text: `<path>${target.displayPath}</path>\n<type>image</type>\n<content>\n${image.mediaType} image, ${String(image.width)}x${String(image.height)} px, ${String(image.bytes)} bytes\n</content>`,
    image,
  }
}

function splitLines(content) {
  if (content.length === 0) return []
  const lines = content.replaceAll('\r\n', '\n').split('\n')
  if (content.endsWith('\n')) lines.pop()
  return lines
}

function truncateHead(content, maxLines, maxBytes) {
  const lines = splitLines(content)
  const totalLines = lines.length
  const totalBytes = Buffer.byteLength(content, 'utf8')
  const selected = []
  let bytes = 0
  for (const line of lines) {
    if (selected.length >= maxLines) break
    const lineBytes = Buffer.byteLength(line, 'utf8') + (selected.length === 0 ? 0 : 1)
    if (selected.length > 0 && bytes + lineBytes > maxBytes) break
    if (selected.length === 0 && lineBytes > maxBytes) {
      return { text: '', totalLines, totalBytes, shown: 0, truncated: true, by: 'bytes', firstLineTooLong: true }
    }
    selected.push(line)
    bytes += lineBytes
  }
  const text = selected.join('\n')
  const truncated = selected.length < lines.length
  return {
    text,
    totalLines,
    totalBytes,
    shown: selected.length,
    truncated,
    by: selected.length >= maxLines ? 'lines' : 'bytes',
    firstLineTooLong: false,
  }
}

function renderRead(text, startLine, requestedLimit, totalFileLines, maxLines, maxBytes) {
  const truncated = truncateHead(text, maxLines, maxBytes)
  const consumedLines = truncated.shown
  const nextOffset = startLine + consumedLines
  if (truncated.firstLineTooLong) {
    return `[Line ${String(startLine)} exceeds ${String(maxBytes)} bytes. Use bash to read this line in chunks.]`
  }
  if (truncated.truncated) {
    const endLine = startLine + consumedLines - 1
    const suffix = truncated.by === 'lines'
      ? `[Showing lines ${String(startLine)}-${String(endLine)} of ${String(totalFileLines)}. Use offset=${String(nextOffset)} to continue.]`
      : `[Showing lines ${String(startLine)}-${String(endLine)} of ${String(totalFileLines)} (${String(maxBytes)} byte limit). Use offset=${String(nextOffset)} to continue.]`
    return `${truncated.text}\n\n${suffix}`
  }
  if (startLine - 1 + truncated.totalLines < totalFileLines) {
    return `${truncated.text}\n\n[${String(totalFileLines - (startLine - 1 + truncated.totalLines))} more lines in file. Use offset=${String(nextOffset)} to continue.]`
  }
  return truncated.text
}

function occurrences(content, needle) {
  const matches = []
  let cursor = 0
  while (cursor <= content.length - needle.length) {
    const index = content.indexOf(needle, cursor)
    if (index < 0) break
    matches.push(index)
    cursor = index + needle.length
  }
  return matches
}

function applyEdits(content, edits, maxEdits) {
  if (!Array.isArray(edits) || edits.length === 0) throw new Error('edits must contain at least one edit')
  if (edits.length > maxEdits) throw new Error(`edits cannot contain more than ${String(maxEdits)} items`)
  const ranges = []
  for (let index = 0; index < edits.length; index += 1) {
    const edit = edits[index]
    if (edit === null || typeof edit !== 'object' || Array.isArray(edit)) throw new Error(`edits[${String(index)}] must be an object`)
    if (typeof edit.oldText !== 'string' || edit.oldText.length === 0) throw new Error(`edits[${String(index)}].oldText must be a non-empty string`)
    if (typeof edit.newText !== 'string') throw new Error(`edits[${String(index)}].newText must be a string`)
    const matches = occurrences(content, edit.oldText)
    if (matches.length !== 1) throw new Error(`edits[${String(index)}].oldText must match exactly once; found ${String(matches.length)}`)
    const start = matches[0]
    const end = start + edit.oldText.length
    ranges.push({ start, end, newText: edit.newText, index })
  }
  ranges.sort((a, b) => a.start - b.start)
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].start < ranges[index - 1].end) {
      throw new Error(`edits[${String(ranges[index].index)}] overlaps edits[${String(ranges[index - 1].index)}]`)
    }
  }
  let output = content
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const range = ranges[index]
    output = output.slice(0, range.start) + range.newText + output.slice(range.end)
  }
  return { content: output, replacements: ranges.length }
}

async function readFileForMutation(ctx, args, exec) {
  const policy = standingPolicy(ctx, exec)
  const target = await resolveTarget(ctx, args.path, exec, policy)
  const expected = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) throw new Error(`cannot edit "${target.displayPath}": not found`)
  if (info.type !== 'file') throw new Error(`cannot edit "${target.displayPath}": expected a regular file`)
  return { policy, target, info, expected }
}

export function apply(ctx, config = {}) {
  const maxLines = positiveInteger(config.maxLines, DEFAULT_MAX_LINES)
  const maxBytes = positiveInteger(config.maxBytes, DEFAULT_MAX_BYTES)
  const maxEdits = positiveInteger(config.maxEdits, DEFAULT_MAX_EDITS)
  const editMaxBytes = positiveInteger(config.editMaxBytes, DEFAULT_EDIT_MAX_BYTES)

  ctx.systemPrompt.section({
    name: 'tool:pi-compatible-core-fs',
    order: 100,
    text: 'Use read for text files. Use write only for new files or complete rewrites. Use one edit call with multiple edits[] entries for precise disjoint replacements; every oldText matches the original file and the batch commits atomically.',
  })

  ctx.tools.register({
    name: 'read',
    description: `Read a text file or a PNG/JPEG/WebP/GIF image. Text output is truncated to ${String(maxLines)} lines or ${String(maxBytes)} bytes; images are committed to the DSH attachment seam when the current model accepts image input.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Path to the file to read (relative or absolute).' },
        offset: { type: 'integer', description: '1-indexed line to start reading from.' },
        limit: { type: 'integer', description: 'Maximum number of lines to read.' },
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
      const offset = args.offset === undefined ? 1 : args.offset
      const limit = args.limit
      if (!Number.isSafeInteger(offset) || offset < 1) throw new Error('offset must be a positive integer')
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('limit must be a positive integer')
      const target = await resolveTarget(ctx, args.path, exec)
      const info = await ctx.fs.stat(target, exec.signal)
      if (info === undefined) throw new Error(`cannot read "${target.displayPath}": not found`)
      if (info.type !== 'file') throw new Error(`cannot read "${target.displayPath}": expected a regular file`)
      const mediaType = imageMediaTypeForPath(args.path)
      if (mediaType !== undefined) return await readImage(ctx, args, exec, target, info, mediaType)
      const content = await ctx.fs.readText(target, exec.signal)
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      const allLines = splitLines(content)
      if (allLines.length === 0) return { text: '' }
      const startIndex = offset - 1
      if (startIndex >= allLines.length) throw new Error(`offset ${String(offset)} is beyond end of file (${String(allLines.length)} lines total)`)
      const selected = limit === undefined ? allLines.slice(startIndex) : allLines.slice(startIndex, startIndex + limit)
      return { text: renderRead(selected.join('\n'), offset, limit, allLines.length, maxLines, maxBytes) }
    },
  })

  ctx.tools.register({
    name: 'write',
    description: 'Create a new UTF-8 text file or replace the complete contents of an existing file. Use edit for targeted changes.',
    parameters: {
      type: 'object',
      additionalProperties: false,
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
      const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
      const outcome = await ctx.fs.writeText(target, args.content, intent, exec.signal, policy)
      ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
      return { text: `${outcome.operation === 'create' ? 'Created' : 'Updated'} ${target.displayPath}` }
    },
  })

  ctx.tools.register({
    name: 'edit',
    description: 'Make precise file edits with exact text replacement. Each edits[].oldText must be unique in the original file; all edits commit atomically.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Path to the file to edit (relative or absolute).' },
        edits: {
          type: 'array',
          description: 'One or more disjoint replacements matched against the original file.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              oldText: { type: 'string' },
              newText: { type: 'string' },
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
      const diffs = args.edits.filter((edit) => edit && typeof edit.oldText === 'string' && typeof edit.newText === 'string').map((edit) => ({ path: args.path, oldText: edit.oldText, newText: edit.newText }))
      return { card: 'diff', title: `edit ${args.path}`, diffs, locations: [{ path: args.path }] }
    },
    async execute(args, exec) {
      const { policy, target, info, expected } = await readFileForMutation(ctx, args, exec)
      if (info.size !== undefined && info.size > editMaxBytes) throw new Error(`cannot edit "${target.displayPath}": file exceeds ${String(editMaxBytes)} bytes`)
      const before = await ctx.fs.readText(target, exec.signal)
      const applied = applyEdits(before, args.edits, maxEdits)
      const intent = expected === undefined ? undefined : { kind: 'replaceIfVersion', version: expected.version }
      const outcome = await ctx.fs.writeText(target, applied.content, intent, exec.signal, policy)
      ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
      return { text: `Edited ${target.displayPath}: ${String(applied.replacements)} replacement${applied.replacements === 1 ? '' : 's'} committed atomically.` }
    },
  })
}
