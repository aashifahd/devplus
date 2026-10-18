import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { SERVER_CATALOG } from '@shared/serverCatalog'
import type { ServerEngine, ServerRelease } from '@shared/servers'
import { binDir, downloadsDir } from './paths'

const run = promisify(execFile)
const MARKER = '.devplus-installed'

/** Parts of the archives a server doesn't need (EDB ships pgAdmin and StackBuilder in the zip). */
const EXCLUDE: Record<ServerEngine, string[]> = {
  postgres: ['*/pgAdmin 4/*', '*/StackBuilder/*', '*/doc/*', '*/symbols/*'],
  mysql: ['*/docs/*', '*/lib/plugin/debug/*', '*.pdb'],
  mariadb: ['*.pdb', '*/mysql-test/*', '*/sql-bench/*']
}

export function releasesFor(platform = `${process.platform}-${process.arch}`): ServerRelease[] {
  return SERVER_CATALOG.filter((r) => r.platform === platform)
}

export function findRelease(engine: ServerEngine, version: string): ServerRelease | undefined {
  return releasesFor().find((r) => r.engine === engine && r.version === version)
}

export const isInstalled = (engine: ServerEngine, version: string) => existsSync(join(binDir(engine, version), MARKER))

export function installedVersions(): Record<ServerEngine, string[]> {
  const out: Record<ServerEngine, string[]> = { postgres: [], mysql: [], mariadb: [] }
  for (const r of releasesFor()) if (isInstalled(r.engine, r.version)) out[r.engine].push(r.version)
  return out
}

export type Progress = (done: number, total: number | null) => void

/** Hash while writing, so a 300 MB archive is read once. */
function hashing(hash: ReturnType<typeof createHash>, onBytes: (n: number) => void) {
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk)
      onBytes(chunk.length)
      cb(null, chunk)
    }
  })
}

async function download(release: ServerRelease, onProgress: Progress, signal?: AbortSignal): Promise<string> {
  const target = join(downloadsDir(), release.file)
  const part = `${target}.part`
  const hash = createHash('sha256')
  let done = 0

  // Test-only seam: a folder of already downloaded archives (still verified below).
  const cached = process.env.DBC_SERVER_CACHE ? join(process.env.DBC_SERVER_CACHE, release.file) : null
  if (cached && existsSync(cached)) {
    copyFileSync(cached, part)
    // The hashing transform must be drained, or the pipeline stalls once its buffer fills.
    const sink = new Writable({ write: (_chunk, _enc, cb) => cb() })
    await pipeline(createReadStream(part), hashing(hash, (n) => onProgress((done += n), release.bytes)), sink)
  } else {
    const res = await fetch(release.url, { signal })
    if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}) from ${new URL(release.url).host}.`)
    const total = Number(res.headers.get('content-length')) || release.bytes
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), hashing(hash, (n) => onProgress((done += n), total)), createWriteStream(part))
  }

  const digest = hash.digest('hex')
  if (digest !== release.sha256) {
    rmSync(part, { force: true })
    throw new Error(`The downloaded ${release.file} doesn't match its published checksum, so it was discarded. Try again; if it keeps happening, the download may have been tampered with.`)
  }
  renameSync(part, target)
  return target
}

/** Windows 10+ ships bsdtar, which unpacks zip archives. */
async function extract(archive: string, into: string, exclude: string[]) {
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  const args = ['-xf', archive, '-C', into, ...exclude.flatMap((p) => ['--exclude', p])]
  await run(tar, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true })
}

/** Download, verify and unpack a server build. Safe to call again; finished installs are kept. */
export async function install(release: ServerRelease, onProgress: Progress, signal?: AbortSignal): Promise<string> {
  const dir = binDir(release.engine, release.version)
  if (isInstalled(release.engine, release.version)) return dir
  const archive = await download(release, onProgress, signal)
  const staging = `${dir}.staging`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  try {
    onProgress(release.bytes, release.bytes)
    await extract(archive, staging, EXCLUDE[release.engine])
    // Each archive has one top-level folder (pgsql, mysql-x.y.z-winx64, mariadb-x.y.z-winx64).
    const top = readdirSync(staging).filter((n) => statSync(join(staging, n)).isDirectory())
    const inner = top.length === 1 ? join(staging, top[0]) : staging
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(join(dir, '..'), { recursive: true })
    renameSync(inner, dir)
    writeFileSync(join(dir, MARKER), JSON.stringify({ version: release.version, sha256: release.sha256, at: Date.now() }))
  } finally {
    rmSync(staging, { recursive: true, force: true })
    rmSync(archive, { force: true })
  }
  return dir
}

/** The program files a server engine needs, inside its unpacked folder. */
export function exe(engine: ServerEngine, version: string, name: string): string {
  const ext = process.platform === 'win32' ? '.exe' : ''
  const path = join(binDir(engine, version), 'bin', `${name}${ext}`)
  if (!existsSync(path)) throw new Error(`${name} is missing from ${engine} ${version}. Reinstall that version.`)
  return path
}

export const hasExe = (engine: ServerEngine, version: string, name: string) =>
  existsSync(join(binDir(engine, version), 'bin', `${name}${process.platform === 'win32' ? '.exe' : ''}`))
