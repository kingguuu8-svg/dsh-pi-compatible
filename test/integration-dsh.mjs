import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply as applyFs } from '../pi-core-fs.mjs'
import { apply as applySearch } from '../pi-core-search.mjs'
import { apply as applyShell } from '../pi-core-shell.mjs'

const npmRoot = process.platform === 'win32'
  ? join(process.env.APPDATA, 'npm', 'node_modules')
  : '/usr/local/lib/node_modules'
const dshNodeModules = join(npmRoot, '@deepseek-ai', 'dsh', 'node_modules')
const moduleUrl = (name) => pathToFileURL(join(dshNodeModules, '@deepseek-ai', name, 'lib', 'index.js')).href
const cordisUrl = pathToFileURL(join(dshNodeModules, '@deepseek-ai', 'cordis', 'lib', 'index.js')).href
const [{ Context }, { LocalFileSystem }, { LocalSubprocessRuntime }] = await Promise.all([
  import(cordisUrl),
  import(moduleUrl('dsh-fs-local')),
  import(moduleUrl('dsh-subprocess-local')),
])

const workspace = await mkdtemp(join(tmpdir(), 'pi-compatible-dsh-'))
const host = new Context()
const fs = new LocalFileSystem(host, { cwd: workspace, diffBasisMaxBytes: 10 * 1024 * 1024 })
const subprocess = new LocalSubprocessRuntime(host)
const tools = new Map()
const ctx = {
  fs,
  subprocess,
  tools: { register(definition) { tools.set(definition.name, definition); return () => {} } },
  systemPrompt: { section() {} },
  get() { return undefined },
  waterfall(_name, _target, _exec, fallback) { return fallback() },
  emit() {},
}
const signal = new AbortController().signal
const exec = { signal, agent: { session: { id: 'integration', header: { cwd: workspace } }, options: { provider: 'test', model: 'test' } } }

try {
  applyFs(ctx)
  applySearch(ctx)
  applyShell(ctx, { bashPath: process.env.PI_COMPAT_BASH_PATH })

  await tools.get('write').execute({ path: 'src/sample.txt', content: 'alpha\nbeta\ngamma\n' }, exec)
  const read = await tools.get('read').execute({ path: 'src/sample.txt', offset: 2, limit: 1 }, exec)
  assert.match(read.text, /^beta/u)
  await tools.get('edit').execute({ path: 'src/sample.txt', edits: [{ oldText: 'beta', newText: 'BETA' }] }, exec)

  const shell = await tools.get('bash').execute({ command: 'printf "bash-ok"' }, exec)
  assert.equal(shell.text, 'bash-ok')

  const found = await tools.get('find').execute({ pattern: '**/*.txt', path: '.' }, exec)
  assert.match(found.text, /src\/sample\.txt/u)
  const grepped = await tools.get('grep').execute({ pattern: 'BETA', path: '.' }, exec)
  assert.match(grepped.text, /src\/sample\.txt:2: BETA/u)
  const listed = await tools.get('ls').execute({ path: 'src' }, exec)
  assert.equal(listed.text, 'sample.txt')

  console.log('DSH rc.6 local fs/subprocess integration passed.')
  console.log(`fd/rg cache: ${join(process.env.DSH_HOME?.trim() || join(process.env.USERPROFILE, '.dsh'), 'pi-compatible', 'bin')}`)
} finally {
  await rm(workspace, { recursive: true, force: true })
}
