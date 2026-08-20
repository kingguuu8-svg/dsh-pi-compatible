// fd/rg discovery and Full Access-only installation into DSH home.

import { createHash, randomBytes } from 'node:crypto'
import { chmod, copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome } from './pi-core-common.mjs'

const TOOLS = {
  fd: {
    repo: 'sharkdp/fd',
    systemNames: process.platform === 'linux' ? ['fd', 'fdfind'] : ['fd'],
    executable: process.platform === 'win32' ? 'fd.exe' : 'fd',
  },
  rg: {
    repo: 'BurntSushi/ripgrep',
    systemNames: ['rg'],
    executable: process.platform === 'win32' ? 'rg.exe' : 'rg',
  },
}

const pending = new Map()
const failures = new Map()
const FAILURE_RETRY_MS = 60_000
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024

export function piCompatBinDir() {
  return join(resolveDshHome(), 'pi-compatible', 'bin')
}

function offline() {
  const value = (process.env.PI_COMPAT_OFFLINE ?? process.env.PI_OFFLINE ?? '').trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

function overridePath(name) {
  const key = name === 'fd' ? 'PI_COMPAT_FD_PATH' : 'PI_COMPAT_RG_PATH'
  return process.env[key]?.trim() || undefined
}

async function resolveIfPresent(ctx, name, signal) {
  try {
    return await ctx.subprocess.resolveExecutable(name, undefined, signal)
  } catch {
    return undefined
  }
}

function targetTriple(name, version) {
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : undefined
  if (arch === undefined) return undefined
  if (process.platform === 'win32') {
    return name === 'fd'
      ? `fd-v${version}-${arch}-pc-windows-msvc.zip`
      : `ripgrep-${version}-${arch}-pc-windows-msvc.zip`
  }
  if (process.platform === 'darwin') {
    return name === 'fd'
      ? `fd-v${version}-${arch}-apple-darwin.tar.gz`
      : `ripgrep-${version}-${arch}-apple-darwin.tar.gz`
  }
  if (process.platform === 'linux') {
    const suffix = name === 'rg' && arch === 'x86_64' ? 'unknown-linux-musl' : 'unknown-linux-gnu'
    return name === 'fd'
      ? `fd-v${version}-${arch}-unknown-linux-gnu.tar.gz`
      : `ripgrep-${version}-${arch}-${suffix}.tar.gz`
  }
  return undefined
}

async function fetchJson(url, signal) {
  const timeout = AbortSignal.timeout(10_000)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const response = await fetch(url, { headers: { 'User-Agent': 'dsh-pi-compatible/0.2.0' }, signal: combined })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)} from ${url}`)
  return await response.json()
}

async function fetchBytes(url, signal) {
  const timeout = AbortSignal.timeout(120_000)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const response = await fetch(url, { headers: { 'User-Agent': 'dsh-pi-compatible/0.2.0' }, signal: combined })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)} while downloading ${url}`)
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) throw new Error(`download exceeds ${String(MAX_DOWNLOAD_BYTES)} bytes`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error(`download exceeds ${String(MAX_DOWNLOAD_BYTES)} bytes`)
  return bytes
}

async function runExtraction(ctx, argv, cwd, signal) {
  const handle = ctx.subprocess.spawn({
    argv,
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 64 * 1024 },
      stderr: { maxBytes: 64 * 1024 },
    },
    graceMs: 3_000,
    signal,
  })
  const outcome = await handle.done
  if (outcome.exitCode === 0) return
  const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
  const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
  throw new Error(stderr || stdout || `${argv[0]} exited with code ${String(outcome.exitCode)}`)
}

async function extractArchive(ctx, archive, destination, signal) {
  await mkdir(destination, { recursive: true, mode: 0o700 })
  if (archive.endsWith('.zip')) {
    if (process.platform === 'win32') {
      const systemTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      const tar = await resolveIfPresent(ctx, systemTar, signal)
      if (tar !== undefined) {
        await runExtraction(ctx, [tar, '-xf', archive, '-C', destination], destination, signal)
        return
      }
      const powershell = await ctx.subprocess.resolveExecutable('powershell.exe', undefined, signal)
      await runExtraction(ctx, [powershell, '-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${JSON.stringify(archive)} -DestinationPath ${JSON.stringify(destination)} -Force`], destination, signal)
      return
    }
    const unzip = await resolveIfPresent(ctx, 'unzip', signal)
    if (unzip !== undefined) {
      await runExtraction(ctx, [unzip, '-q', archive, '-d', destination], destination, signal)
      return
    }
    const tar = await ctx.subprocess.resolveExecutable('tar', undefined, signal)
    await runExtraction(ctx, [tar, '-xf', archive, '-C', destination], destination, signal)
    return
  }
  const tar = await ctx.subprocess.resolveExecutable('tar', undefined, signal)
  await runExtraction(ctx, [tar, '-xzf', archive, '-C', destination], destination, signal)
}

async function findNamedFile(directory, fileName) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return path
    if (entry.isDirectory()) {
      const nested = await findNamedFile(path, fileName)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

function verifyDigest(data, digest) {
  if (typeof digest !== 'string' || !digest.startsWith('sha256:')) return
  const actual = createHash('sha256').update(data).digest('hex')
  const expected = digest.slice('sha256:'.length).toLowerCase()
  if (actual !== expected) throw new Error(`download digest mismatch: expected ${expected}, received ${actual}`)
}

async function downloadTool(ctx, name, signal) {
  const definition = TOOLS[name]
  const release = await fetchJson(`https://api.github.com/repos/${definition.repo}/releases/latest`, signal)
  const version = String(release.tag_name ?? '').replace(/^v/u, '')
  if (version.length === 0) throw new Error(`GitHub returned no release tag for ${definition.repo}`)
  const assetName = targetTriple(name, version)
  if (assetName === undefined) throw new Error(`unsupported platform for ${name}: ${process.platform}/${process.arch}`)
  const asset = Array.isArray(release.assets) ? release.assets.find((item) => item?.name === assetName) : undefined
  if (asset?.browser_download_url === undefined) throw new Error(`release ${release.tag_name} has no asset ${assetName}`)

  const binDir = piCompatBinDir()
  await mkdir(binDir, { recursive: true, mode: 0o700 })
  const token = `${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`
  const archive = join(binDir, `.download-${token}-${assetName}`)
  const extractDir = join(binDir, `.extract-${token}`)
  try {
    const bytes = await fetchBytes(asset.browser_download_url, signal)
    verifyDigest(bytes, asset.digest)
    await writeFile(archive, bytes, { mode: 0o600 })
    await extractArchive(ctx, archive, extractDir, signal)
    const source = await findNamedFile(extractDir, definition.executable)
    if (source === undefined) throw new Error(`${definition.executable} was not found inside ${assetName}`)
    const destination = join(binDir, definition.executable)
    await copyFile(source, destination)
    if (process.platform !== 'win32') await chmod(destination, 0o700)
    return await ctx.subprocess.resolveExecutable(destination, undefined, signal)
  } finally {
    await rm(archive, { force: true }).catch(() => {})
    await rm(extractDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function resolveTool(ctx, name, signal) {
  const definition = TOOLS[name]
  if (definition === undefined) throw new Error(`unknown managed tool ${name}`)
  const explicit = overridePath(name)
  if (explicit !== undefined) return await ctx.subprocess.resolveExecutable(explicit, undefined, signal)
  for (const systemName of definition.systemNames) {
    const resolved = await resolveIfPresent(ctx, systemName, signal)
    if (resolved !== undefined) return resolved
  }
  const cached = await resolveIfPresent(ctx, join(piCompatBinDir(), definition.executable), signal)
  if (cached !== undefined) return cached
  if (offline()) return undefined
  return await downloadTool(ctx, name, signal)
}

export async function ensureBinary(ctx, name, signal) {
  const failure = failures.get(name)
  if (failure !== undefined && Date.now() - failure.time < FAILURE_RETRY_MS) throw failure.error
  let promise = pending.get(name)
  if (promise === undefined) {
    promise = resolveTool(ctx, name, signal).then((value) => {
      failures.delete(name)
      return value
    }).catch((error) => {
      pending.delete(name)
      if (!signal?.aborted) failures.set(name, { time: Date.now(), error })
      throw error
    })
    pending.set(name, promise)
  }
  return await promise
}
