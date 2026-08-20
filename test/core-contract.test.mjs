import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { apply as applyCatalog } from '../pi-catalog.mjs'
import { apply as applyFs } from '../pi-core-fs.mjs'
import { apply as applySearch } from '../pi-core-search.mjs'
import { BashOutputAccumulator, apply as applyShell } from '../pi-core-shell.mjs'
import { apply as installBundle } from '../lib/index.js'

function baseContext() {
  const tools = new Map()
  const sections = []
  const contexts = []
  const denied = []
  const services = new Map()
  return {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
      schemas() { return [...tools.values()].map(({ name }) => ({ name })) },
      restrict(rule) { denied.push(rule) },
    },
    systemPrompt: {
      section(section) { sections.push(section) },
      context(context) { contexts.push(context) },
    },
    get(name) { return services.get(name) },
    setService(name, value) { services.set(name, value) },
    waterfall(_name, _target, _exec, fallback) { return fallback() },
    emit() {},
    inject(_names, callback) { callback({ commands: { register() {} } }) },
    toolsCollected: tools,
    sections,
    contexts,
    denied,
  }
}

function fsContext(content = 'alpha\nbeta\ngamma') {
  const ctx = baseContext()
  let written
  let writeIntent
  ctx.fs = {
    sandboxMode: undefined,
    async resolve(path) { return { displayPath: path, targetKey: `key:${path}` } },
    processPath(target) { return target.displayPath },
    async stat() { return { type: 'file', version: 'v1', size: Buffer.byteLength(content) } },
    async readText() { return content },
    async writeText(_target, next, expected) {
      written = next
      writeIntent = expected
      return { operation: 'update', version: 'v2', before: content, after: next }
    },
    async listDir() { return [] },
  }
  ctx.getWritten = () => written
  ctx.getWriteIntent = () => writeIntent
  return ctx
}

function execution(cwd = 'C:/workspace') {
  return {
    signal: new AbortController().signal,
    agent: { session: { id: 'session-1', header: { cwd } }, options: { provider: 'test', model: 'model' } },
  }
}

test('core registers exactly the seven Pi 0.84.2 tools with lower-case names', () => {
  const ctx = fsContext()
  ctx.subprocess = {
    async resolveExecutable(name) { return name },
    spawn() { throw new Error('not used') },
  }
  applyFs(ctx)
  applySearch(ctx)
  applyShell(ctx, { bashPath: '/bin/bash' })
  assert.deepEqual([...ctx.toolsCollected.keys()].sort(), ['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write'])
  assert.equal(ctx.toolsCollected.get('bash').parameters.properties.timeout.type, 'number')
  assert.equal(ctx.toolsCollected.get('read').parameters.properties.offset.type, 'number')
  assert.deepEqual(Object.keys(ctx.toolsCollected.get('edit').parameters.properties), ['path', 'edits'])
})

test('catalog masks inherited host tools and shadows redundant DSH policy contexts', () => {
  const ctx = baseContext()
  ctx.tools.register({ name: 'host_tool' })
  ctx.tools.register({ name: 'run_code' })
  applyCatalog(ctx)
  assert.deepEqual(ctx.denied, [{ deny: ['host_tool'] }])
  assert.deepEqual(ctx.contexts, [
    { name: 'sandbox:policy', order: 110, text: '' },
    { name: 'approval:policy', order: 115, text: '' },
  ])
})

test('edit preserves BOM and CRLF, accepts Pi fuzzy punctuation, and guards the atomic write', async () => {
  const original = '\uFEFFalpha\r\n“beta”  \r\ngamma\r\n'
  const ctx = fsContext(original)
  applyFs(ctx)
  const result = await ctx.toolsCollected.get('edit').execute({
    path: 'sample.txt',
    edits: [{ oldText: '"beta"', newText: '"BETA"' }],
  }, execution())
  assert.match(result.text, /Successfully replaced 1 block/)
  assert.equal(ctx.getWritten(), '\uFEFFalpha\r\n"BETA"\r\ngamma\r\n')
  assert.deepEqual(ctx.getWriteIntent(), { kind: 'replaceIfVersion', version: 'v1' })
})

test('edit rejects duplicate and overlapping replacements before writing', async () => {
  const duplicate = fsContext('one one')
  applyFs(duplicate)
  await assert.rejects(
    duplicate.toolsCollected.get('edit').execute({ path: 'x.txt', edits: [{ oldText: 'one', newText: 'two' }] }, execution()),
    /Found 2 occurrences/,
  )
  assert.equal(duplicate.getWritten(), undefined)

  const overlap = fsContext('abcdef')
  applyFs(overlap)
  await assert.rejects(
    overlap.toolsCollected.get('edit').execute({
      path: 'x.txt',
      edits: [
        { oldText: 'abcd', newText: 'A' },
        { oldText: 'cdef', newText: 'B' },
      ],
    }, execution()),
    /overlap/,
  )
  assert.equal(overlap.getWritten(), undefined)
})

test('read uses Pi head truncation and provides an offset continuation', async () => {
  const ctx = fsContext('one\ntwo\nthree\nfour')
  applyFs(ctx, { maxLines: 2, maxBytes: 51200 })
  const result = await ctx.toolsCollected.get('read').execute({ path: 'sample.txt' }, execution())
  assert.equal(result.text, 'one\ntwo\n\n[Showing lines 1-2 of 4. Use offset=3 to continue.]')
})

test('read rejects files above its bounded safety limit before decoding', async () => {
  const ctx = fsContext('12345')
  applyFs(ctx, { readMaxBytes: 4 })
  await assert.rejects(
    ctx.toolsCollected.get('read').execute({ path: 'large.txt' }, execution()),
    /safety limit/,
  )
})

test('write uses DSH atomic write seam and Pi success shape', async () => {
  const ctx = fsContext('old')
  applyFs(ctx)
  const result = await ctx.toolsCollected.get('write').execute({ path: 'nested/new.txt', content: 'hello' }, execution())
  assert.equal(result.text, 'Successfully wrote 5 bytes to nested/new.txt')
  assert.equal(ctx.getWritten(), 'hello')
})

test('bash resolves an explicit real Bash and has no default timeout', async () => {
  const ctx = baseContext()
  let spec
  ctx.subprocess = {
    async resolveExecutable(name) { return name },
    spawn(next) {
      spec = next
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      let settle
      const done = new Promise((resolve) => { settle = resolve })
      queueMicrotask(() => {
        stdout.write('out\n')
        stderr.write('err\n')
        stdout.end()
        stderr.end()
        settle({ exitCode: 0, signal: null })
      })
      return { stdout, stderr, collected: {}, done, terminate() {}, waitForExit: async () => true }
    },
  }
  applyShell(ctx, { bashPath: '/bin/bash' })
  const result = await ctx.toolsCollected.get('bash').execute({ command: 'echo ok' }, execution('/workspace'))
  assert.equal(spec.argv[0], '/bin/bash')
  assert.deepEqual(spec.argv.slice(1), ['-c', 'echo ok'])
  assert.equal(spec.cwd, '/workspace')
  assert.equal(result.text, 'out\nerr\n')
})

test('bash spill disables safely after its cap without retaining later output in memory', () => {
  const accumulator = new BashOutputAccumulator(2, 10, 20)
  accumulator.append(Buffer.from('123456789012345'))
  const spillPath = accumulator.spillPath
  assert.equal(typeof spillPath, 'string')
  assert.equal(existsSync(spillPath), true)
  accumulator.append(Buffer.from('abcdefghij'))
  assert.equal(accumulator.spillDisabled, true)
  assert.equal(accumulator.beforeSpill.length, 0)
  assert.equal(existsSync(spillPath), false)
  accumulator.append(Buffer.alloc(100, 0x78))
  assert.equal(accumulator.beforeSpill.length, 0)
  assert.equal(accumulator.finish().fullOutputPath, undefined)
})

test('ls is case-insensitively sorted, includes dotfiles, and marks directories', async () => {
  const ctx = baseContext()
  ctx.fs = {
    async resolve(path) { return { displayPath: path, targetKey: path } },
    processPath(target) { return target.displayPath },
    async stat() { return { type: 'directory', version: 'v1' } },
    async listDir() {
      return [
        { name: 'z.txt', type: 'file' },
        { name: 'Alpha', type: 'directory' },
        { name: '.env', type: 'file' },
      ]
    },
  }
  ctx.subprocess = { async resolveExecutable(name) { return name }, spawn() { throw new Error('not used') } }
  applySearch(ctx)
  const result = await ctx.toolsCollected.get('ls').execute({}, execution())
  assert.equal(result.text, '.env\nAlpha/\nz.txt')
})

test('bundle installer installs Core and Plus idempotently into DSH_HOME', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pi-compatible-test-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const messages = []
  const originalLog = console.log
  console.log = (message) => { messages.push(String(message)) }
  try {
    installBundle({}, {})
    const presetRoot = join(root, '.agent-presets')
    assert.match(await readFile(join(presetRoot, 'pi-compatible', 'agent.cordis.yml'), 'utf8'), /seven tools frozen|seven Pi|Pi-compatible Core/u)
    assert.match(await readFile(join(presetRoot, 'pi-compatible-plus', 'agent.cordis.yml'), 'utf8'), /Pi-compatible Plus/u)
    installBundle({}, {})
    assert.equal(messages.filter((line) => line.includes('already exists')).length, 2)
    const legacy = join(presetRoot, 'pi-compatible', 'pi-web.mjs')
    await writeFile(legacy, 'legacy package file')
    installBundle({}, { force: true })
    assert.equal(existsSync(legacy), false)
  } finally {
    console.log = originalLog
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('Core and Plus compositions expose the intended product boundary', async () => {
  const root = join(import.meta.dirname, '..')
  const core = await readFile(join(root, 'agent.cordis.yml'), 'utf8')
  const plus = await readFile(join(root, 'presets', 'pi-compatible-plus', 'agent.cordis.yml'), 'utf8')
  assert.doesNotMatch(core, /pi-web|pi-task|pi-plan|pi-todo|pi-think|pi-slash/u)
  for (const row of ['pi-web', 'pi-task', 'pi-plan', 'pi-todo', 'pi-think', 'pi-slash']) assert.match(plus, new RegExp(row, 'u'))
})
