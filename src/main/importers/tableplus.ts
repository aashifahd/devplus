import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ENGINES, type Engine } from '@shared/engines'
import type { ConnectionConfig, EnvTag, ImportCandidate } from '@shared/types'
import { parsePlist, type PlistValue } from './plist'

const MAX_FILE_BYTES = 20_000_000

/** Where TablePlus keeps its connection list on each OS. */
export function findTablePlusFile(): string | null {
  const candidates =
    process.platform === 'win32'
      ? [join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'com.tinyapp.TablePlus', 'Data', 'Connections.plist')]
      : process.platform === 'darwin'
        ? [
            join(homedir(), 'Library', 'Application Support', 'com.tinyapp.TablePlus', 'Data', 'Connections.plist'),
            join(homedir(), 'Library', 'Containers', 'com.tinyapp.TablePlus', 'Data', 'Library', 'Application Support', 'com.tinyapp.TablePlus', 'Data', 'Connections.plist')
          ]
        : []
  return candidates.find((p) => existsSync(p)) ?? null
}

/** TablePlus driver names to our engines. Anything else is listed but can't be imported. */
function engineFor(driver: string): Engine | null {
  const d = driver.toLowerCase().replace(/[\s_-]/g, '')
  if (d.includes('postgres') || d.includes('cockroach') || d.includes('redshift')) return 'postgres'
  if (d.includes('mysql') || d.includes('mariadb')) return 'mysql'
  if (d.includes('sqlserver') || d.includes('mssql')) return 'mssql'
  if (d.includes('duckdb')) return 'duckdb'
  if (d.includes('sqlite')) return 'sqlite'
  if (d.includes('clickhouse')) return 'clickhouse'
  if (d.includes('snowflake')) return 'snowflake'
  if (d.includes('bigquery')) return 'bigquery'
  if (d.includes('mongo')) return 'mongodb'
  if (d.includes('redis')) return 'redis'
  if (d.includes('cassandra') || d.includes('scylla')) return 'cassandra'
  if (d.includes('dynamo')) return 'dynamodb'
  return null
}

const TAGS: EnvTag[] = ['local', 'development', 'testing', 'staging', 'production']
const TAG_COLOR: Record<EnvTag, string> = { local: '#64748b', development: '#1f9d55', testing: '#0ea5a4', staging: '#e08a12', production: '#d93a3a' }

const str = (v: PlistValue | undefined) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')
const num = (v: PlistValue | undefined) => {
  const n = Number(str(v))
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null
}
const flag = (v: PlistValue | undefined) => v === true || v === 1 || v === '1'

function groupNames(file: string): Map<string, string> {
  const out = new Map<string, string>()
  const groups = join(dirname(file), 'ConnectionGroups.plist')
  if (!existsSync(groups)) return out
  try {
    const parsed = parsePlist(readFileSync(groups, 'utf8'))
    for (const g of Array.isArray(parsed) ? parsed : []) {
      if (g && typeof g === 'object' && !Array.isArray(g) && !(g instanceof Date)) out.set(str(g.ID), str(g.Name))
    }
  } catch {
    // Groups are a nicety; connections still import without them.
  }
  return out
}

function toConfig(c: Record<string, PlistValue>, engine: Engine, groups: Map<string, string>): { config: ConnectionConfig; notes: string[] } {
  const info = ENGINES[engine]
  const notes: string[] = []
  const envRaw = str(c.Enviroment ?? c.Environment).toLowerCase()
  const tag = (TAGS.find((t) => t === envRaw || t.startsWith(envRaw)) ?? 'local') as EnvTag
  const color = /^#[0-9a-f]{6}$/i.test(str(c.statusColor)) ? str(c.statusColor) : TAG_COLOR[tag]
  const isFile = Boolean(info.fields.file) && !info.fields.host
  const options: Record<string, string> = {}
  if (engine === 'snowflake') {
    if (str(c.DatabaseWarehouse)) options.warehouse = str(c.DatabaseWarehouse)
    if (str(c.DatabaseUserRole)) options.role = str(c.DatabaseUserRole)
  }

  const overSsh = flag(c.isOverSSH ?? c.OverSSH)
  const keyPath = str(c.ServerPrivateKeyName)
  const config: ConnectionConfig = {
    id: randomUUID(),
    name: str(c.ConnectionName) || `${info.label} connection`,
    engine,
    group: groups.get(str(c.GroupID)) || 'Imported from TablePlus',
    color,
    tag,
    host: isFile ? '' : str(c.DatabaseHost) || (info.fields.port ? '127.0.0.1' : ''),
    port: num(c.DatabasePort) ?? info.defaultPort,
    user: str(c.DatabaseUser),
    database: str(c.DatabaseName),
    filePath: isFile ? str(c.DatabasePath) || str(c.DatabaseHost) : '',
    // Prefer negotiates TLS when the server offers it, so it is the safe default for every source mode.
    ssl: { mode: 'prefer' },
    ssh: {
      enabled: overSsh && Boolean(info.fields.ssh),
      host: str(c.ServerAddress),
      port: num(c.ServerPort) ?? 22,
      user: str(c.ServerUser),
      authMethod: flag(c.isUsePrivateKey) ? 'key' : 'password',
      // TablePlus may store only a key name; keep it when it looks like a path.
      privateKeyPath: /[\\/]/.test(keyPath) ? keyPath : ''
    },
    // TablePlus passwords live in its own secure storage and are never read; the app asks on first connect.
    savePassword: false,
    options
  }
  if (overSsh && !info.fields.ssh) notes.push('SSH tunnel not supported for this engine')
  if (overSsh && info.fields.ssh) notes.push(`SSH via ${config.ssh.host || '?'}`)
  if (flag(c.isUsePrivateKey) && !config.ssh.privateKeyPath && overSsh) notes.push('choose the SSH key after import')
  if (flag(c.UseSock)) notes.push('socket connections import as TCP')
  return { config, notes }
}

const sameTarget = (a: ConnectionConfig, b: ConnectionConfig) =>
  a.engine === b.engine && a.name === b.name && a.host === b.host && a.port === b.port && a.database === b.database && (a.filePath ?? '') === (b.filePath ?? '')

/** Read a TablePlus Connections.plist into import candidates. Nothing is saved here. */
export function readTablePlus(file: string, existing: ConnectionConfig[]): ImportCandidate[] {
  if (!existsSync(file)) throw new Error(`File not found: ${file}`)
  if (statSync(file).size > MAX_FILE_BYTES) throw new Error('That file is too large to be a TablePlus connection list.')
  const text = readFileSync(file, 'utf8').replace(/^﻿/, '')
  let list: PlistValue[]
  if (text.trimStart().startsWith('[')) {
    list = JSON.parse(text) as PlistValue[] // a JSON array with the same keys is accepted too
  } else {
    const parsed = parsePlist(text)
    if (!Array.isArray(parsed)) throw new Error('This file does not contain a list of connections.')
    list = parsed
  }
  const groups = groupNames(file)
  return list
    .filter((c): c is Record<string, PlistValue> => Boolean(c) && typeof c === 'object' && !Array.isArray(c) && !(c instanceof Date))
    .map((c, i) => {
      const driver = str(c.Driver) || 'Unknown'
      const engine = engineFor(driver)
      const key = str(c.ID) || `row-${i}`
      if (!engine) return { key, name: str(c.ConnectionName) || driver, driver, engine: null, config: null, notes: [`${driver} is not supported yet`], duplicateOf: null }
      const { config, notes } = toConfig(c, engine, groups)
      const dup = existing.find((e) => sameTarget(e, config))
      return { key, name: config.name, driver, engine, config, notes, duplicateOf: dup?.id ?? null }
    })
}
