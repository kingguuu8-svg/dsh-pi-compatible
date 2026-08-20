import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-pi-compatible'

const SOURCE_DIR = fileURLToPath(new URL('../', import.meta.url))

export const PRESETS = [
  {
    id: 'pi-compatible',
    sourceDir: SOURCE_DIR,
    legacyFiles: [
      'pi-core-fs-loader.mjs',
      'pi-fs.mjs',
      'pi-search.mjs',
      'pi-shell.mjs',
      'pi-web.mjs',
      'pi-task.mjs',
      'pi-todo.mjs',
      'pi-plan.mjs',
      'pi-think.mjs',
      'pi-slash.mjs',
    ],
    files: [
      'agent.cordis.yml',
      'preset.yml',
      'pi-catalog.mjs',
      'pi-core-common.mjs',
      'pi-core-binaries.mjs',
      'pi-core-fs.mjs',
      'pi-core-shell.mjs',
      'pi-core-search.mjs',
    ],
  },
  {
    id: 'pi-compatible-plus',
    sourceDir: join(SOURCE_DIR, 'presets', 'pi-compatible-plus'),
    files: [
      'agent.cordis.yml',
      'preset.yml',
      'pi-catalog.mjs',
      'pi-core-common.mjs',
      'pi-core-binaries.mjs',
      'pi-core-fs.mjs',
      'pi-core-shell.mjs',
      'pi-core-search.mjs',
      'pi-web.mjs',
      'pi-task.mjs',
      'pi-todo.mjs',
      'pi-plan.mjs',
      'pi-think.mjs',
      'pi-slash.mjs',
    ],
  },
]

export function userPresetRoot() {
  const configured = process.env.DSH_HOME?.trim()
  const dshHome = configured ? configured : join(homedir(), '.dsh')
  return join(dshHome, '.agent-presets')
}

function filesEqual(left, right) {
  try {
    return readFileSync(left).equals(readFileSync(right))
  } catch {
    return false
  }
}

function samePath(left, right) {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase()
}

export function installPreset(definition, root, force = false) {
  const targetDir = join(root, definition.id)
  const complete = definition.files.every((file) => existsSync(join(targetDir, file)))
  const changed = complete && definition.files.some((file) => !filesEqual(
    join(definition.sourceDir, file),
    join(targetDir, file),
  ))

  if (complete && !force) {
    console.log(
      `[${name}] preset "${definition.id}" already exists at ${targetDir}`
      + (changed ? '; packaged files differ — set force: true to overwrite' : ''),
    )
    return { installed: false, changed }
  }

  mkdirSync(targetDir, { recursive: true })
  for (const file of definition.files) {
    const source = join(definition.sourceDir, file)
    const target = join(targetDir, file)
    if (samePath(source, target)) continue
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, target, { force: true })
  }
  if (force) {
    for (const legacy of definition.legacyFiles ?? []) rmSync(join(targetDir, legacy), { force: true })
  }
  console.log(`[${name}] installed preset "${definition.id}" -> ${targetDir}`)
  return { installed: true, changed }
}

export function apply(_ctx, config = {}) {
  const force = config.force === true
  const root = userPresetRoot()
  for (const preset of PRESETS) installPreset(preset, root, force)
}
