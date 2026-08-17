// Pi-faithful filesystem tools: Read, Write, Edit, MultiEdit.
// Registered under Pi's PascalCase names with Pi-style schemas; the
// implementation reuses the host fs service exactly like the lean-evolve
// coding-fs row, with Pi's expected_replacements contract added.

export const name = 'pi-fs'
export const inject = ['tools', 'fs', 'systemPrompt']

const DEFAULT_READ_LIMIT = 2_000
const DEFAULT_READ_MAX_BYTES = 256 * 1024
const DEFAULT_READ_MAX_LINE_CHARS = 4_000
const DEFAULT_MAX_EDITS = 64
const DEFAULT_EDIT_MAX_BYTES = 10 * 1024 * 1024
const MAX_REPLACEMENTS = 4_096

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function sessionCwd(exec) {
  return exec?.agent?.session?.header?.cwd
}

function standingPolicy(ctx, exec) {
  if (ctx.fs.sandboxMode === undefined) return undefined
  const service = ctx.get('sandboxPolicy')
  if (service === undefined) throw new Error('pi-fs requires sandboxPolicy with a confining filesystem')
  return service.resolve(exec?.agent === undefined ? {} : { session: exec.agent.session })
}

async function resolveTarget(ctx, filePath, exec, policy) {
  const cwd = policy?.workspaceRoot ?? sessionCwd(exec)
  return await ctx.fs.resolve(filePath, {
    ...(cwd === undefined ? {} : { cwd }),
    signal: exec.signal,
  })
}

function linesOf(content) {
  return content.split('\n').map((line) => line.endsWith('\r') ? line.slice(0, -1) : line)
}

function readWindow(content, offset, limit, maxLineChars, maxBytes) {
  const all = linesOf(content)
  const selected = []
  let retainedBytes = 0
  for (let index = offset - 1; index < all.length && selected.length < limit; index += 1) {
    const raw = all[index]
    const text = raw.length <= maxLineChars ? raw : `${raw.slice(0, maxLineChars)}… [line truncated]`
    const nextBytes = Buffer.byteLength(text, 'utf8') + 16
    if (selected.length > 0 && retainedBytes + nextBytes > maxBytes) break
    retainedBytes += nextBytes
    selected.push({ number: index + 1, text })
  }
  return { lines: selected, totalLines: all.length }
}

function renderRead(value) {
  const width = String(value.lines.at(-1)?.number ?? value.offset).length
  const body = value.lines.map((line) => `${String(line.number).padStart(width, ' ')}: ${line.text}`).join('\n')
  const end = value.lines.at(-1)?.number ?? value.offset - 1
  const continuation = end < value.totalLines ? `\n\n[More lines available: read again with offset ${String(end + 1)}.]` : ''
  return `<path>${value.path}</path>\n<type>file</type>\n<content>\n${body}${continuation}\n</content>`
}

function occurrences(content, search) {
  const matches = []
  let cursor = 0
  while (cursor <= content.length - search.length) {
    const index = content.indexOf(search, cursor)
    if (index < 0) break
    matches.push(index)
    cursor = index + search.length
  }
  return matches
}

/** Validate one edit item and select its replacement ranges against the ORIGINAL content. */
function selectRanges(content, edit, editIndex) {
  if (edit === null || typeof edit !== 'object' || Array.isArray(edit)) {
    throw new Error(`edit at index ${String(editIndex)} must be an object`)
  }
  const oldString = edit.old_string
  const newString = edit.new_string
  if (typeof oldString !== 'string' || oldString.length === 0) {
    throw new Error(`edit at index ${String(editIndex)}: old_string must be a non-empty string`)
  }
  if (typeof newString !== 'string') {
    throw new Error(`edit at index ${String(editIndex)}: new_string must be a string`)
  }
  if (oldString === newString) {
    throw new Error(`edit at index ${String(editIndex)} is a no-op`)
  }
  const matches = occurrences(content, oldString)
  if (matches.length === 0) {
    throw new Error(`edit at index ${String(editIndex)}: old_string was not found in the file`)
  }
  const expected = edit.expected_replacements
  if (expected !== undefined) {
    if (!Number.isSafeInteger(expected) || expected < 0) {
      throw new Error(`edit at index ${String(editIndex)}: expected_replacements must be a non-negative integer`)
    }
    if (matches.length !== expected) {
      throw new Error(`edit at index ${String(editIndex)}: old_string matched ${String(matches.length)} time(s) but expected_replacements was ${String(expected)}`)
    }
  }
  const selected = edit.replace_all === true ? matches : [matches[0]]
  if (edit.replace_all !== true && matches.length !== 1) {
    throw new Error(`edit at index ${String(editIndex)}: old_string matched ${String(matches.length)} times; make it unique or set replace_all to true`)
  }
  return selected.map((start) => ({ start, end: start + oldString.length, newString, editIndex }))
}

/** Atomically apply a validated batch against the ORIGINAL content; overlapping edits fail. */
function applyBatchEdits(content, edits, maxEdits) {
  if (!Array.isArray(edits) || edits.length === 0) throw new Error('edits must contain at least one replacement')
  if (edits.length > maxEdits) throw new Error(`edits may contain at most ${String(maxEdits)} replacements`)

  const ranges = []
  for (const [editIndex, edit] of edits.entries()) {
    for (const range of selectRanges(content, edit, editIndex)) {
      ranges.push(range)
      if (ranges.length > MAX_REPLACEMENTS) {
        throw new Error(`batch edit expands to more than ${String(MAX_REPLACEMENTS)} replacements`)
      }
    }
  }

  ranges.sort((left, right) => left.start - right.start || left.end - right.end)
  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1]
    const current = ranges[index]
    if (current.start < previous.end) {
      throw new Error(`edits[${String(previous.editIndex)}] overlaps edits[${String(current.editIndex)}] in the original file`)
    }
  }

  const parts = []
  let cursor = 0
  for (const range of ranges) {
    parts.push(content.slice(cursor, range.start), range.newString)
    cursor = range.end
  }
  parts.push(content.slice(cursor))
  return { content: parts.join(''), replacements: ranges.length }
}

function outputSchema(properties) {
  return { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) }
}

const EDIT_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    old_string: { type: 'string', description: 'Exact original text to replace, including surrounding whitespace and indentation.' },
    new_string: { type: 'string', description: 'Replacement text; an empty string deletes the match.' },
    replace_all: { type: 'boolean', description: 'Replace every occurrence of old_string. Defaults to false (exactly one occurrence required).' },
    expected_replacements: { type: 'integer', description: 'Assert the exact number of occurrences of old_string; the edit fails if the file disagrees.' },
  },
  required: ['old_string', 'new_string'],
}

async function readFileForEdit(ctx, args, exec) {
  const policy = standingPolicy(ctx, exec)
  const target = await resolveTarget(ctx, args.file_path, exec, policy)
  const expected = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) throw new Error(`cannot edit "${target.displayPath}": not found`)
  if (info.type !== 'file') throw new Error(`cannot edit "${target.displayPath}": expected a regular file`)
  return { policy, target, info, expected }
}

export function apply(ctx, config = {}) {
  const readLimit = positiveInteger(config.readLimit, DEFAULT_READ_LIMIT)
  const readMaxBytes = positiveInteger(config.readMaxBytes, DEFAULT_READ_MAX_BYTES)
  const readMaxLineChars = positiveInteger(config.readMaxLineChars, DEFAULT_READ_MAX_LINE_CHARS)
  const maxEdits = positiveInteger(config.maxEdits, DEFAULT_MAX_EDITS)
  const editMaxBytes = positiveInteger(config.editMaxBytes, DEFAULT_EDIT_MAX_BYTES)

  ctx.systemPrompt.section({
    name: 'tool:pi-fs',
    order: 100,
    text: 'Use Read for text files. Use Write only for creation or complete replacement. For targeted changes, put every independent replacement for the same file into one MultiEdit call; all edits match the original file and the whole batch commits atomically.',
  })

  ctx.tools.register({
    name: 'Read',
    description: 'Read a UTF-8 text file as a line-numbered window. Use it for text files only. Returns the requested lines with 1-based numbers and a continuation marker when more content remains; read again with offset to continue.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        file_path: { type: 'string', description: 'File path, relative to the session workspace by default.' },
        offset: { type: 'integer', description: 'First line, 1-based. Defaults to 1.' },
        limit: { type: 'integer', description: `Maximum lines. Defaults to ${String(readLimit)}.` },
      },
      required: ['file_path'],
    },
    output: {
      schema: outputSchema({
        path: { type: 'string' },
        offset: { type: 'integer' },
        lines: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            properties: { number: { type: 'integer' }, text: { type: 'string' } },
            required: ['number', 'text'],
          },
        },
        totalLines: { type: 'integer' },
      }),
      render: (_args, value) => [{ type: 'text', text: renderRead(value) }],
    },
    isConcurrencySafe: () => true,
    presentCall(args) {
      return { card: 'generic', title: `Read ${args.file_path}`, kind: 'read', locations: [{ path: args.file_path }] }
    },
    async execute(args, exec) {
      if (typeof args.file_path !== 'string' || args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
      const offset = args.offset === undefined ? 1 : args.offset
      const limit = args.limit === undefined ? readLimit : args.limit
      if (!Number.isSafeInteger(offset) || offset < 1) throw new Error('offset must be a positive integer')
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > readLimit) throw new Error(`limit must be between 1 and ${String(readLimit)}`)
      const target = await resolveTarget(ctx, args.file_path, exec)
      const info = await ctx.fs.stat(target, exec.signal)
      if (info === undefined) {
        ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
        throw new Error(`cannot read "${target.displayPath}": not found`)
      }
      if (info.type !== 'file') throw new Error(`cannot read "${target.displayPath}": expected a regular file`)
      const content = await ctx.fs.readText(target, exec.signal)
      const window = readWindow(content, offset, limit, readMaxLineChars, readMaxBytes)
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      return { path: target.displayPath, offset, lines: window.lines, totalLines: window.totalLines }
    },
  })

  ctx.tools.register({
    name: 'Write',
    description: 'Create a new UTF-8 text file or replace the complete contents of an existing one. Use Write for whole-file content only; for targeted changes use Edit or MultiEdit.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        file_path: { type: 'string', description: 'File path, relative to the session workspace by default.' },
        content: { type: 'string', description: 'Complete new file content.' },
      },
      required: ['file_path', 'content'],
    },
    output: {
      schema: outputSchema({ path: { type: 'string' }, operation: { type: 'string' } }),
      render: (_args, value) => [{ type: 'text', text: `${value.operation === 'create' ? 'Created' : 'Updated'} ${value.path}` }],
    },
    presentCall(args) {
      if (typeof args.file_path !== 'string' || typeof args.content !== 'string') return undefined
      return {
        card: 'diff',
        title: `Write ${args.file_path}`,
        diffs: [{ path: args.file_path, oldText: null, newText: args.content }],
        locations: [{ path: args.file_path }],
      }
    },
    async execute(args, exec) {
      if (typeof args.file_path !== 'string' || args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
      if (typeof args.content !== 'string') throw new Error('content must be a string')
      const policy = standingPolicy(ctx, exec)
      const target = await resolveTarget(ctx, args.file_path, exec, policy)
      const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
      const outcome = await ctx.fs.writeText(target, args.content, intent, exec.signal, policy)
      ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
      return { path: target.displayPath, operation: outcome.operation }
    },
  })

  ctx.tools.register({
    name: 'Edit',
    description: 'Replace one exact literal string in a UTF-8 file. old_string must match the file byte-for-byte (whitespace and indentation included) and appear exactly once, unless replace_all is set; expected_replacements asserts the match count and fails the edit when the file disagrees.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        file_path: { type: 'string', description: 'File path, relative to the session workspace by default.' },
        old_string: { type: 'string', description: 'Exact original text to replace.' },
        new_string: { type: 'string', description: 'Replacement text; an empty string deletes the match.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence of old_string. Defaults to false.' },
        expected_replacements: { type: 'integer', description: 'Assert the exact number of occurrences of old_string.' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
    output: {
      schema: outputSchema({ path: { type: 'string' }, replacements: { type: 'integer' } }),
      render: (_args, value) => [{ type: 'text', text: `Edited ${value.path}: ${String(value.replacements)} replacement${value.replacements === 1 ? '' : 's'}.` }],
    },
    presentCall(args) {
      if (typeof args.file_path !== 'string' || typeof args.old_string !== 'string' || typeof args.new_string !== 'string') return undefined
      return {
        card: 'diff',
        title: `Edit ${args.file_path}`,
        diffs: [{ path: args.file_path, oldText: args.old_string, newText: args.new_string }],
        locations: [{ path: args.file_path }],
      }
    },
    async execute(args, exec) {
      const { policy, target, info, expected } = await readFileForEdit(ctx, args, exec)
      if (info.size !== undefined && info.size > editMaxBytes) throw new Error(`cannot edit "${target.displayPath}": file exceeds ${String(editMaxBytes)} bytes`)
      const before = await ctx.fs.readText(target, exec.signal)
      const applied = applyBatchEdits(before, [args], 1)
      const intent = expected === undefined ? undefined : { kind: 'replaceIfVersion', version: expected.version }
      const outcome = await ctx.fs.writeText(target, applied.content, intent, exec.signal, policy)
      ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
      return { path: target.displayPath, replacements: applied.replacements }
    },
  })

  ctx.tools.register({
    name: 'MultiEdit',
    description: 'Atomically apply several independent literal replacements to one UTF-8 file. Every old_string matches the ORIGINAL file; overlapping edits are rejected and the whole batch commits as one write or fails as one error.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        file_path: { type: 'string', description: 'File path, relative to the session workspace by default.' },
        edits: {
          type: 'array',
          description: 'Independent replacements matched against the original file. Merge nearby or overlapping changes into one item.',
          items: EDIT_ITEM_SCHEMA,
        },
      },
      required: ['file_path', 'edits'],
    },
    output: {
      schema: outputSchema({ path: { type: 'string' }, replacements: { type: 'integer' } }),
      render: (_args, value) => [{ type: 'text', text: `Edited ${value.path}: ${String(value.replacements)} replacement${value.replacements === 1 ? '' : 's'} committed atomically.` }],
    },
    presentCall(args) {
      if (typeof args.file_path !== 'string' || !Array.isArray(args.edits)) return undefined
      const diffs = args.edits
        .filter((edit) => edit !== null && typeof edit === 'object' && typeof edit.old_string === 'string' && typeof edit.new_string === 'string')
        .map((edit) => ({ path: args.file_path, oldText: edit.old_string, newText: edit.new_string }))
      return { card: 'diff', title: `MultiEdit ${args.file_path}`, diffs, locations: [{ path: args.file_path }] }
    },
    async execute(args, exec) {
      const { policy, target, info, expected } = await readFileForEdit(ctx, args, exec)
      if (info.size !== undefined && info.size > editMaxBytes) throw new Error(`cannot edit "${target.displayPath}": file exceeds ${String(editMaxBytes)} bytes`)
      const before = await ctx.fs.readText(target, exec.signal)
      const applied = applyBatchEdits(before, args.edits, maxEdits)
      const intent = expected === undefined ? undefined : { kind: 'replaceIfVersion', version: expected.version }
      const outcome = await ctx.fs.writeText(target, applied.content, intent, exec.signal, policy)
      ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
      return { path: target.displayPath, replacements: applied.replacements }
    },
  })
}
