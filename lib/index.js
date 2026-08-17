import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-pi-compatible'

const PRESET_ID = 'pi-compatible'
const PRESET_FILES = [
  'agent.cordis.yml',
  'preset.yml',
  'pi-catalog.mjs',
  'pi-core-fs-loader.mjs',
  'pi-core-fs.mjs',
  'pi-core-search.mjs',
  'pi-core-shell.mjs',
  'pi-fs.mjs',
  'pi-plan.mjs',
  'pi-search.mjs',
  'pi-shell.mjs',
  'pi-slash.mjs',
  'pi-task.mjs',
  'pi-think.mjs',
  'pi-todo.mjs',
  'pi-web.mjs',
]

const SOURCE_DIR = fileURLToPath(new URL('../', import.meta.url))

function userPresetRoot() {
  const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(dshHome, '.agent-presets')
}

function filesEqual(left, right) {
  try {
    return readFileSync(left).equals(readFileSync(right))
  } catch {
    return false
  }
}

export function apply(_ctx, config = {}) {
  const force = config.force === true
  const targetDir = join(userPresetRoot(), PRESET_ID)
  const alreadyInstalled = PRESET_FILES.every((file) => existsSync(join(targetDir, file)))

  if (alreadyInstalled && !force) {
    const changed = PRESET_FILES.some((file) => !filesEqual(join(SOURCE_DIR, file), join(targetDir, file)))
    console.log(
      `[${name}] preset "${PRESET_ID}" already exists at ${targetDir}`
      + (changed ? '; packaged files differ — set force: true to overwrite' : ''),
    )
    return
  }

  mkdirSync(targetDir, { recursive: true })
  for (const file of PRESET_FILES) {
    cpSync(join(SOURCE_DIR, file), join(targetDir, file), { force: true })
  }
  console.log(`[${name}] installed preset "${PRESET_ID}" -> ${targetDir}`)
}
