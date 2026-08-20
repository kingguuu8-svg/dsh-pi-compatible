import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const plus = join(root, 'presets', 'pi-compatible-plus')
const shared = [
  'pi-core-common.mjs',
  'pi-core-binaries.mjs',
  'pi-core-fs.mjs',
  'pi-core-shell.mjs',
  'pi-core-search.mjs',
]

for (const file of shared) {
  assert.deepEqual(await readFile(join(plus, file)), await readFile(join(root, file)), `${file} drifted between Core and Plus`)
}

for (const file of [
  'pi-catalog.mjs',
  ...shared,
  'pi-web.mjs',
  'pi-task.mjs',
  'pi-todo.mjs',
  'pi-plan.mjs',
  'pi-think.mjs',
  'pi-slash.mjs',
]) {
  await import(pathToFileURL(join(plus, file)).href)
}

console.log('Plus preset copies and modules are valid.')
