import { createConnection, createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { existsSync, rmSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { BrowserWindow, shell } from 'electron'
import { APP_EVENT, type AppEvent } from '@shared/app'
import { SERVER_ENGINES, byVersionDesc, type LocalServer, type ServerDraft, type ServerEngine, type ServerState, type ServerView } from '@shared/servers'
import type { ConnectionConfig } from '@shared/types'
import * as store from '../store'
import { log } from '../logs'
import { findRelease, install, installedVersions, isInstalled, releasesFor, type Progress } from './binaries'
import { DRIVERS } from './engines'
import { dataDir, ensureDir, instanceDir, logPath } from './paths'

const READY_TIMEOUT_MS = 60_000
const states = new Map<string, ServerState>()
const listeners = new Set<() => void>()

/** Called whenever a server's state or the server list changes (the tray uses it). */
export function onChange(cb: () => void) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function emit() {
  const event: AppEvent = { type: 'servers', states: [...states.values()] }
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(APP_EVENT, event)
  for (const cb of listeners) cb()
}

function setState(id: string, s: Omit<ServerState, 'id'>) {
  states.set(id, { id, ...s })
  emit()
}

const stateOf = (id: string): ServerState => states.get(id) ?? { id, status: 'stopped', pid: null }

function processAlive(pid: number | null): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Something accepts connections on 127.0.0.1:port. */
export function portOpen(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port })
    const done = (v: boolean) => {
      sock.destroy()
      resolve(v)
    }
    sock.setTimeout(timeoutMs, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

/** Free to listen on, for both IPv4 loopback and any address. */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.listen({ host: '127.0.0.1', port }, () => srv.close(() => resolve(true)))
  })
}

/** The engine's default port if free and unused by another server here, otherwise the next one. */
export async function suggestPort(engine: ServerEngine): Promise<number> {
  const taken = new Set(store.listServers().map((s) => s.port))
  for (let p = SERVER_ENGINES[engine].defaultPort; p < SERVER_ENGINES[engine].defaultPort + 100; p++) {
    if (!taken.has(p) && (await portFree(p))) return p
  }
  throw new Error('No free port found near the default.')
}

/** The last part of a server's log, for the logs view and error messages. */
export function tail(id: string, bytes = 64 * 1024): string {
  const path = logPath(id)
  if (!existsSync(path)) return ''
  const size = statSync(path).size
  const len = Math.min(size, bytes)
  const buf = Buffer.alloc(len)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buf, 0, len, size - len)
  } finally {
    closeSync(fd)
  }
  const text = buf.toString('utf8')
  return size > len ? text.slice(text.indexOf('\n') + 1) : text
}

const lastLines = (id: string, n = 6) =>
  tail(id, 16 * 1024)
    .trimEnd()
    .split(/\r?\n/)
    .filter((l) => /error|fatal|abort|denied|failed|could not|unable/i.test(l))
    .slice(-n)
    .join('\n')

function view(s: LocalServer): ServerView {
  return { ...s, state: stateOf(s.id), dataDir: dataDir(s.id), configPath: DRIVERS[s.engine].configPath(s), logPath: logPath(s.id) }
}

export function list(): ServerView[] {
  return store
    .listServers()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(view)
}

export function catalog() {
  return { releases: [...releasesFor()].sort((a, b) => a.engine.localeCompare(b.engine) || byVersionDesc(a.version, b.version)), installed: installedVersions() }
}

const get = (id: string) => {
  const s = store.listServers().find((x) => x.id === id)
  if (!s) throw new Error('That server no longer exists.')
  return s
}

/** The DevPlus connection that opens a server; created or refreshed on demand. */
export function connectionFor(s: LocalServer): ConnectionConfig {
  const info = SERVER_ENGINES[s.engine]
  const existing = store.listConnections().find((c) => c.id === s.connectionId)
  const config: ConnectionConfig = {
    id: s.connectionId,
    name: existing?.name ?? s.name,
    engine: info.client,
    group: existing?.group ?? 'Local servers',
    color: existing?.color ?? info.color,
    tag: 'local',
    host: '127.0.0.1',
    port: s.port,
    user: existing?.user ?? info.user,
    database: existing?.database ?? info.database,
    filePath: '',
    ssl: { mode: 'disable' },
    ssh: { enabled: false, host: '', port: 22, user: '', authMethod: 'key', privateKeyPath: '' },
    // Local servers use trust / an empty root password, so there is nothing to ask for.
    savePassword: true,
    safeMode: existing?.safeMode ?? 'off',
    options: existing?.options ?? {}
  }
  return store.saveConnection({ ...config, secrets: {} })
}

async function waitReady(s: LocalServer): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < READY_TIMEOUT_MS) {
    if (await portOpen(s.port, 500)) return
    // MySQL/MariaDB write their pid file early; if it's there and the process died, stop waiting.
    const pid = DRIVERS[s.engine].pid(s)
    if (pid && !processAlive(pid) && Date.now() - t0 > 3000) break
    await new Promise((r) => setTimeout(r, 400))
  }
  const why = lastLines(s.id)
  throw new Error(`${SERVER_ENGINES[s.engine].label} didn't start on port ${s.port}.${why ? `\n${why}` : ' See its log for details.'}`)
}

export async function start(id: string): Promise<ServerState> {
  const s = get(id)
  const cur = stateOf(id)
  if (cur.status === 'running' || cur.status === 'starting') return cur
  if (!isInstalled(s.engine, s.version)) throw new Error(`${SERVER_ENGINES[s.engine].label} ${s.version} isn't installed. Delete the server or reinstall that version.`)
  if (await portOpen(s.port)) throw new Error(`Port ${s.port} is already in use by another program. Change this server's port in its settings.`)
  setState(id, { status: 'starting', pid: null })
  try {
    ensureDir(instanceDir(id))
    await DRIVERS[s.engine].initialize(s)
    await DRIVERS[s.engine].start(s)
    await waitReady(s)
    setState(id, { status: 'running', pid: DRIVERS[s.engine].pid(s) })
    log('info', 'main', `Started ${s.engine} ${s.version} "${s.name}" on port ${s.port}`)
  } catch (err) {
    const message = (err as Error).message
    setState(id, { status: 'error', pid: null, message })
    log('error', 'main', `Starting ${s.engine} "${s.name}" failed: ${message}`)
    throw err
  }
  return stateOf(id)
}

export async function stop(id: string): Promise<ServerState> {
  const s = get(id)
  if (stateOf(id).status === 'stopped') return stateOf(id)
  setState(id, { status: 'stopping', pid: stateOf(id).pid })
  const pid = DRIVERS[s.engine].pid(s) ?? stateOf(id).pid
  try {
    await DRIVERS[s.engine].stop(s)
  } catch (err) {
    log('warn', 'main', `Clean shutdown of "${s.name}" failed: ${(err as Error).message}`)
  }
  // The port closes early in shutdown while the data files are still locked (MySQL's ibdata1),
  // so wait for the process itself to exit before calling it stopped.
  const t0 = Date.now()
  while (pid && processAlive(pid) && Date.now() - t0 < 60_000) await new Promise((r) => setTimeout(r, 200))
  if (pid && processAlive(pid)) {
    process.kill(pid)
    log('warn', 'main', `"${s.name}" didn't shut down within a minute; its process was ended.`)
  }
  for (let i = 0; i < 50 && (await portOpen(s.port, 300)); i++) await new Promise((r) => setTimeout(r, 200))
  setState(id, { status: 'stopped', pid: null })
  return stateOf(id)
}

export async function restart(id: string) {
  await stop(id)
  return start(id)
}

/** Install the version if needed, create the server, start it, and make its connection. */
export async function create(draft: ServerDraft, onProgress: Progress): Promise<ServerView> {
  const release = findRelease(draft.engine, draft.version)
  if (!release) throw new Error(`${draft.engine} ${draft.version} isn't available for this computer.`)
  if (store.listServers().some((s) => s.port === draft.port)) throw new Error(`Another server here already uses port ${draft.port}.`)
  if (!(await portFree(draft.port))) throw new Error(`Port ${draft.port} is in use by another program. Pick another port.`)
  await install(release, onProgress)
  const id = randomUUID().slice(0, 8)
  const server: LocalServer = {
    id,
    name: draft.name.trim() || `${SERVER_ENGINES[draft.engine].label} ${draft.version}`,
    engine: draft.engine,
    version: draft.version,
    port: draft.port,
    autoStart: draft.autoStart,
    binlog: SERVER_ENGINES[draft.engine].hasBinlog && draft.binlog,
    connectionId: `local-server-${id}`,
    createdAt: Date.now()
  }
  store.saveServer(server)
  connectionFor(server)
  await start(id)
  return view(server)
}

export async function update(id: string, patch: Partial<Pick<LocalServer, 'name' | 'port' | 'autoStart' | 'binlog'>>): Promise<ServerView> {
  const s = get(id)
  const next = { ...s, ...patch }
  if (patch.port !== undefined && patch.port !== s.port) {
    if (stateOf(id).status !== 'stopped') throw new Error('Stop the server before changing its port.')
    if (store.listServers().some((x) => x.id !== id && x.port === patch.port)) throw new Error(`Another server here already uses port ${patch.port}.`)
  }
  store.saveServer(next)
  connectionFor(next)
  return view(next)
}

export async function remove(id: string, deleteData: boolean) {
  const s = get(id)
  if (stateOf(id).status !== 'stopped') await stop(id)
  store.deleteServerRecord(id)
  store.deleteConnection(s.connectionId)
  states.delete(id)
  if (deleteData) rmSync(instanceDir(id), { recursive: true, force: true })
  emit()
}

export function openFolder(id: string, which: 'data' | 'config' | 'log') {
  const s = get(id)
  const target = which === 'data' ? dataDir(id) : which === 'config' ? DRIVERS[s.engine].configPath(s) : logPath(id)
  if (!existsSync(target)) throw new Error('That file or folder doesn\'t exist yet. Start the server once first.')
  void shell.openPath(target)
}

/** On launch: pick up servers still running from last time, then start the auto-start ones. */
export async function boot() {
  for (const s of store.listServers()) {
    const pid = DRIVERS[s.engine].pid(s)
    if (pid && processAlive(pid) && (await portOpen(s.port))) states.set(s.id, { id: s.id, status: 'running', pid })
  }
  emit()
  for (const s of store.listServers()) {
    if (s.autoStart && stateOf(s.id).status !== 'running') start(s.id).catch(() => {})
  }
}

/** On quit, unless servers should keep running. */
export async function stopAll() {
  await Promise.all(store.listServers().filter((s) => stateOf(s.id).status === 'running').map((s) => stop(s.id).catch(() => {})))
}

export const runningCount = () => [...states.values()].filter((s) => s.status === 'running').length
