import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import type { ConnectionConfig, ConnectionDraft, ConnectionSecrets, HistoryEntry, SavedQuery } from '@shared/types'
import type { MetricsBoard } from '@shared/metrics'
import type { LocalServer } from '@shared/servers'
import { mergeSettings, withDefaults, type AiProvider, type AppSettings, type DeepPartial } from '@shared/settings'

const dir = () => {
  const d = app.getPath('userData')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}
const connectionsFile = () => join(dir(), 'connections.json')
const secretsFile = () => join(dir(), 'secrets.json')

function readJson<T>(file: string, fallback: T): T {
  try {
    // Strip a UTF-8 BOM: some editors add one and JSON.parse rejects it.
    return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) as T
  } catch {
    return fallback
  }
}

/** Write via a temp file so a crash mid-write never truncates user data. */
function writeJson(file: string, value: unknown) {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

export function listConnections(): ConnectionConfig[] {
  return readJson<ConnectionConfig[]>(connectionsFile(), [])
}

export function getConnection(id: string): ConnectionConfig {
  const found = listConnections().find((c) => c.id === id)
  if (!found) throw new Error('Connection not found')
  return found
}

/** Encrypted with the OS keychain (DPAPI on Windows). Stored as base64 per connection. */
type SecretFile = Record<string, string>

export function getSecrets(id: string): ConnectionSecrets {
  const blob = readJson<SecretFile>(secretsFile(), {})[id]
  if (!blob || !safeStorage.isEncryptionAvailable()) return {}
  try {
    return JSON.parse(safeStorage.decryptString(Buffer.from(blob, 'base64'))) as ConnectionSecrets
  } catch {
    return {}
  }
}

function setSecrets(id: string, secrets: ConnectionSecrets | null) {
  const all = readJson<SecretFile>(secretsFile(), {})
  const hasAny = secrets && Object.values(secrets).some(Boolean)
  if (hasAny && safeStorage.isEncryptionAvailable()) {
    all[id] = safeStorage.encryptString(JSON.stringify(secrets)).toString('base64')
  } else {
    delete all[id]
  }
  writeJson(secretsFile(), all)
}

export function saveConnection(draft: ConnectionDraft): ConnectionConfig {
  const { secrets, ...config } = draft
  const all = listConnections()
  const i = all.findIndex((c) => c.id === config.id)
  if (i >= 0) all[i] = config
  else all.push(config)
  writeJson(connectionsFile(), all)
  setSecrets(config.id, config.savePassword ? secrets : null)
  return config
}

export function deleteConnection(id: string) {
  writeJson(
    connectionsFile(),
    listConnections().filter((c) => c.id !== id)
  )
  setSecrets(id, null)
}

// ---- query history and saved queries -------------------------------------------

const HISTORY_LIMIT = 500
const historyFile = () => join(dir(), 'history.json')
const savedFile = () => join(dir(), 'saved-queries.json')

export function listHistory(connectionId: string): HistoryEntry[] {
  return readJson<Record<string, HistoryEntry[]>>(historyFile(), {})[connectionId] ?? []
}

/** Newest first, capped per connection. Repeating the latest query just refreshes it. */
export function addHistory(entry: Omit<HistoryEntry, 'id'>) {
  const all = readJson<Record<string, HistoryEntry[]>>(historyFile(), {})
  const list = all[entry.connectionId] ?? []
  const rest = list[0]?.sql === entry.sql ? list.slice(1) : list
  all[entry.connectionId] = [{ ...entry, id: randomUUID() }, ...rest].slice(0, HISTORY_LIMIT)
  writeJson(historyFile(), all)
}

export function clearHistory(connectionId: string) {
  const all = readJson<Record<string, HistoryEntry[]>>(historyFile(), {})
  delete all[connectionId]
  writeJson(historyFile(), all)
}

export function listSaved(connectionId: string): SavedQuery[] {
  return readJson<SavedQuery[]>(savedFile(), [])
    .filter((q) => q.connectionId === connectionId)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function saveQuery(q: Omit<SavedQuery, 'id' | 'updatedAt'> & { id?: string }): SavedQuery {
  const all = readJson<SavedQuery[]>(savedFile(), [])
  const saved: SavedQuery = { ...q, id: q.id ?? randomUUID(), updatedAt: Date.now() }
  const i = all.findIndex((x) => x.id === saved.id)
  if (i >= 0) all[i] = saved
  else all.push(saved)
  writeJson(savedFile(), all)
  return saved
}

export function deleteSaved(id: string) {
  writeJson(
    savedFile(),
    readJson<SavedQuery[]>(savedFile(), []).filter((q) => q.id !== id)
  )
}

// ---- app settings ---------------------------------------------------------------------------

const settingsFile = () => join(dir(), 'settings.json')

export function getSettings(): AppSettings {
  return withDefaults(readJson<Partial<AppSettings>>(settingsFile(), {}))
}

export function updateSettings(patch: DeepPartial<AppSettings>): AppSettings {
  const next = mergeSettings(getSettings(), patch)
  writeJson(settingsFile(), next)
  return next
}

// ---- AI provider keys: encrypted like connection secrets, never sent to the renderer ----------

const aiKeysFile = () => join(dir(), 'ai-keys.json')

export function getAiKey(provider: AiProvider): string | null {
  const blob = readJson<Record<string, string>>(aiKeysFile(), {})[provider]
  if (!blob || !safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(blob, 'base64'))
  } catch {
    return null
  }
}

export function setAiKey(provider: AiProvider, key: string | null) {
  const all = readJson<Record<string, string>>(aiKeysFile(), {})
  if (key && safeStorage.isEncryptionAvailable()) all[provider] = safeStorage.encryptString(key).toString('base64')
  else delete all[provider]
  writeJson(aiKeysFile(), all)
}

export function aiKeyStatus(): Record<AiProvider, boolean> {
  const all = readJson<Record<string, string>>(aiKeysFile(), {})
  return { anthropic: Boolean(all.anthropic), openai: Boolean(all.openai), compatible: Boolean(all.compatible) }
}

export function setToolPath(name: keyof AppSettings['toolPaths'], path: string | null) {
  const s = getSettings()
  if (path) s.toolPaths[name] = path
  else delete s.toolPaths[name]
  writeJson(settingsFile(), s)
}

// ---- metrics boards -------------------------------------------------------------------------

const metricsFile = () => join(dir(), 'metrics.json')

export function listBoards(connectionId: string): MetricsBoard[] {
  return readJson<MetricsBoard[]>(metricsFile(), [])
    .filter((b) => b.connectionId === connectionId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function saveBoard(board: MetricsBoard): MetricsBoard {
  const all = readJson<MetricsBoard[]>(metricsFile(), [])
  const saved = { ...board, updatedAt: Date.now() }
  const i = all.findIndex((b) => b.id === saved.id)
  if (i >= 0) all[i] = saved
  else all.push(saved)
  writeJson(metricsFile(), all)
  return saved
}

export function deleteBoard(id: string) {
  writeJson(
    metricsFile(),
    readJson<MetricsBoard[]>(metricsFile(), []).filter((b) => b.id !== id)
  )
}

// ---- local servers ----------------------------------------------------------------------------

const serversFile = () => join(dir(), 'servers.json')

export function listServers(): LocalServer[] {
  return readJson<LocalServer[]>(serversFile(), [])
}

export function saveServer(server: LocalServer): LocalServer {
  const all = listServers()
  const i = all.findIndex((s) => s.id === server.id)
  if (i >= 0) all[i] = server
  else all.push(server)
  writeJson(serversFile(), all)
  return server
}

export function deleteServerRecord(id: string) {
  writeJson(
    serversFile(),
    listServers().filter((s) => s.id !== id)
  )
}
