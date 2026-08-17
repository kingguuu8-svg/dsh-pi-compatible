import assert from 'node:assert/strict'
import test from 'node:test'
import { apply as applyFs } from '../pi-core-fs.mjs'
import { apply as applySearch } from '../pi-core-search.mjs'
import { apply as applyShell } from '../pi-core-shell.mjs'

function baseContext() {
  const tools = new Map()
  const sections = []
  return {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
    },
    systemPrompt: { section(section) { sections.push(section) } },
    get() { return undefined },
    waterfall(_name, _target, _exec, fallback) { return fallback() },
    emit() {},
    toolsCollected: tools,
    sections,
  }
}

function fsContext(content = 'alpha\nbeta\ngamma') {
  const ctx = baseContext()
  let written
  ctx.fs = {
    sandboxMode: undefined,
    async resolve(path) { return { displayPath: path, targetKey: path } },
    async stat() { return { type: 'file', version: 'v1', size: Buffer.byteLength(content) } },
    async readText() { return content },
    async writeText(_target, next) {
      written = next
      return { operation: 'update', version: 'v2' }
    },
  }
  ctx.getWritten = () => written
  return ctx
}

test('filesystem core registers Pi-compatible lower-case tools', () => {
  const ctx = fsContext()
  applyFs(ctx)
  assert.deepEqual([...ctx.toolsCollected.keys()], ['read', 'write', 'edit'])
  assert.deepEqual(Object.keys(ctx.toolsCollected.get('read').parameters.properties), ['path', 'offset', 'limit'])
  assert.deepEqual(Object.keys(ctx.toolsCollected.get('write').parameters.properties), ['path', 'content'])
  assert.deepEqual(Object.keys(ctx.toolsCollected.get('edit').parameters.properties), ['path', 'edits'])
})

test('filesystem edit applies disjoint replacements atomically', async () => {
  const ctx = fsContext('alpha\nbeta\ngamma')
  applyFs(ctx)
  const result = await ctx.toolsCollected.get('edit').execute({
    path: 'sample.txt',
    edits: [
      { oldText: 'alpha', newText: 'ALPHA' },
      { oldText: 'gamma', newText: 'GAMMA' },
    ],
  }, { signal: new AbortController().signal })
  assert.match(result.text, /2 replacements committed atomically/)
  assert.equal(ctx.getWritten(), 'ALPHA\nbeta\nGAMMA')
})

test('search core registers find, grep, and ls', () => {
  const ctx = baseContext()
  ctx.fs = {
    async resolve(path) { return { displayPath: path, targetKey: path } },
    async stat() { return { type: 'directory', version: 'v1' } },
    async listDir() { return [{ name: '.env', type: 'file' }, { name: 'src', type: 'directory' }] },
  }
  ctx.subprocess = {
    async resolveExecutable() { return 'rg.exe' },
    spawn() {
      return {
        collected: {
          stdout: { readFrom() { return { text: 'src/a.ts\nsrc/b.ts\n' } } },
          stderr: { readFrom() { return { text: '' } } },
        },
        done: Promise.resolve({ exitCode: 0 }),
      }
    },
  }
  applySearch(ctx, { findLimit: 10, grepLimit: 10 })
  assert.deepEqual([...ctx.toolsCollected.keys()], ['find', 'grep', 'ls'])
})

test('shell converts timeout seconds to DSH milliseconds', async () => {
  const ctx = baseContext()
  let spec
  ctx.shell = {
    sandboxMode: undefined,
    resolve(next) { spec = next; return next },
    async run() { return { stdout: { text: 'ok' }, stderr: { text: '' }, exitCode: 0, timedOut: false, aborted: false } },
  }
  applyShell(ctx)
  const result = await ctx.toolsCollected.get('bash').execute({ command: 'echo ok', timeout: 2.5 }, { signal: new AbortController().signal })
  assert.equal(spec.timeoutMs, 2500)
  assert.equal(result.text, 'ok')
})
