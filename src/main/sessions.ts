import { randomUUID } from 'node:crypto'
import {
  effectiveSafeMode,
  type ChangeSet,
  type ConnectionConfig,
  type ConnectionSecrets,
  type RunError,
  type RunResult,
  type SessionInfo,
  type StatementResult,
  type AdminAction,
  type AppSettings,
  type BackupOptions,
  type ExportTableRequest,
  type ImportSpec,
  type RestoreOptions,
  type ToolName,
  type ToolStatus,
  type TreeNode,
  type ErdModel,
  type ErdTable
} from '@shared/types'
import { isReadStatement, splitStatements } from '@shared/sqlsplit'
import { openDriver, type DriverSession } from './drivers'
import { buildChanges, displaySql } from './drivers/sql'
import { notSupported } from './drivers/types'
import { ENGINES } from '@shared/engines'
import { adminSql } from './drivers/ddl'
import * as transfer from './transfer'
import * as tools from './tools'
import { rmSync } from 'node:fs'
import { openTunnel, type Tunnel } from './ssh'

interface LiveSession {
  connectionId: string
  config: ConnectionConfig
  /** Kept in memory only, so backup tools can authenticate the same way. */
  secrets: ConnectionSecrets
  driver: DriverSession
  tunnel?: Tunnel
}

const sessions = new Map<string, LiveSession>()

async function connect(cfg: ConnectionConfig, secrets: ConnectionSecrets) {
  const useTunnel = cfg.engine !== 'sqlite' && cfg.ssh.enabled
  const tunnel = useTunnel ? await openTunnel(cfg, secrets) : undefined
  try {
    const driver = await openDriver(cfg, secrets, tunnel?.endpoint ?? { host: cfg.host || '127.0.0.1', port: cfg.port })
    return { driver, tunnel }
  } catch (err) {
    tunnel?.close()
    throw err
  }
}

async function info(sessionId: string, live: LiveSession): Promise<SessionInfo> {
  return {
    sessionId,
    connectionId: live.connectionId,
    serverVersion: live.driver.serverVersion,
    databases: await live.driver.listDatabases(),
    currentDatabase: live.driver.currentDatabase()
  }
}

/** Connect and immediately disconnect; returns the server version. */
export async function testConnection(cfg: ConnectionConfig, secrets: ConnectionSecrets): Promise<string> {
  const { driver, tunnel } = await connect(cfg, secrets)
  const version = driver.serverVersion
  await driver.close()
  tunnel?.close()
  return version
}

export async function openSession(cfg: ConnectionConfig, secrets: ConnectionSecrets): Promise<SessionInfo> {
  const { driver, tunnel } = await connect(cfg, secrets)
  const id = randomUUID()
  const live = { connectionId: cfg.id, config: cfg, secrets, driver, tunnel }
  sessions.set(id, live)
  return info(id, live)
}

export function getDriver(sessionId: string): DriverSession {
  const live = sessions.get(sessionId)
  if (!live) throw new Error('Session is closed. Reconnect to continue.')
  return live.driver
}

function getLive(sessionId: string): LiveSession {
  const live = sessions.get(sessionId)
  if (!live) throw new Error('Session is closed. Reconnect to continue.')
  return live
}

/** A driver member the engine may not have, with a readable error when it doesn't. */
function need<T>(live: LiveSession, value: T | undefined, what: string): T {
  if (value === undefined) throw notSupported(ENGINES[live.config.engine].label, what)
  return value
}

/** SQL engines run shared-builder statements in one transaction. */
function sqlPath(live: LiveSession, what: string) {
  const { driver } = live
  if (!driver.dialect || !driver.execute) throw notSupported(ENGINES[live.config.engine].label, what)
  return { dialect: driver.dialect, execute: driver.execute.bind(driver) }
}

/** The SQL a commit would run, with values inlined for reading. */
export async function previewChanges(sessionId: string, set: ChangeSet): Promise<string[]> {
  const live = getLive(sessionId)
  if (live.driver.changes) return live.driver.changes.preview(set)
  return buildChanges(sqlPath(live, 'Editing').dialect, set).map((st) => displaySql(st.sql, st.params))
}

/**
 * Read-only is enforced here as well as in the UI. The connection is re-read from
 * disk so a safe-mode change made while connected applies immediately.
 */
export async function applyChanges(
  sessionId: string,
  set: ChangeSet,
  latest: ConnectionConfig | undefined
): Promise<number> {
  const live = getLive(sessionId)
  if (effectiveSafeMode(latest ?? live.config) === 'readonly') {
    throw new Error('This connection is read-only. Change its safe mode to allow edits.')
  }
  if (live.driver.changes) return live.driver.changes.apply(set)
  const { dialect, execute } = sqlPath(live, 'Editing')
  const affected = await execute(buildChanges(dialect, set))
  return affected.reduce((a, b) => a + Math.max(0, b), 0)
}

export function connectionIdOf(sessionId: string): string {
  return getLive(sessionId).connectionId
}

export async function switchDatabase(sessionId: string, name: string): Promise<SessionInfo> {
  const live = sessions.get(sessionId)
  if (!live) throw new Error('Session is closed. Reconnect to continue.')
  await live.driver.switchDatabase(name)
  return info(sessionId, live)
}

export async function closeSession(sessionId: string) {
  const live = sessions.get(sessionId)
  if (!live) return
  sessions.delete(sessionId)
  await live.driver.close()
  live.tunnel?.close()
}

export async function closeAll() {
  await Promise.all([...sessions.keys()].map(closeSession))
}

/**
 * Run a script statement by statement (autocommit), stopping at the first error.
 * Read-only connections refuse writes up front and also run inside a server-side
 * read-only transaction, so a write hidden in a CTE is still rejected.
 */
export async function runScript(sessionId: string, sql: string, latest: ConnectionConfig | undefined): Promise<RunResult> {
  const live = getLive(sessionId)
  const { driver } = live
  const spans = splitStatements(sql, live.config.engine)
  const readOnly = effectiveSafeMode(latest ?? live.config) === 'readonly'

  if (readOnly) {
    const write = spans.findIndex((s) => !isReadStatement(s.text, live.config.engine))
    if (write >= 0) {
      return {
        results: [],
        durationMs: 0,
        error: {
          message: 'This connection is read-only, so only SELECT, SHOW and EXPLAIN statements can run.',
          statementIndex: write,
          start: spans[write].start,
          end: spans[write].end,
          position: null
        }
      }
    }
  }

  const started = performance.now()
  const results: StatementResult[] = []
  let error: RunError | null = null

  const runAll = async () => {
    for (const [i, span] of spans.entries()) {
      const t0 = performance.now()
      try {
        const raw = await driver.runStatement(span.text)
        const elapsed = performance.now() - t0
        // A SQL Server batch can produce several result sets; each gets its own tab.
        for (const r of Array.isArray(raw) ? raw : [raw]) {
          results.push({ ...r, sql: span.text, start: span.start, end: span.end, durationMs: elapsed })
        }
      } catch (err) {
        // Postgres reports a 1-based character position inside the statement.
        const pos = Number((err as { position?: string }).position)
        error = {
          message: err instanceof Error ? err.message : String(err),
          statementIndex: i,
          start: span.start,
          end: span.end,
          position: Number.isFinite(pos) && pos > 0 ? span.start + pos - 1 : null
        }
        return
      }
    }
  }

  if (readOnly) await driver.withReadOnly(runAll)
  else await runAll()

  return { results, error, durationMs: performance.now() - started }
}

export async function explain(sessionId: string, statement: string, latest: ConnectionConfig | undefined): Promise<RunResult> {
  const live = getLive(sessionId)
  const { driver } = live
  const trimmed = statement.replace(/;\s*$/, '')
  if (driver.explain) {
    const t0 = performance.now()
    try {
      const r = await driver.explain(trimmed)
      return { results: [{ ...r, sql: trimmed, start: 0, end: statement.length, durationMs: performance.now() - t0 }], error: null, durationMs: performance.now() - t0 }
    } catch (err) {
      return {
        results: [],
        durationMs: performance.now() - t0,
        error: { message: (err as Error).message, statementIndex: 0, start: 0, end: statement.length, position: null }
      }
    }
  }
  const wrapped = need(live, driver.dialect, 'Explain').explain(trimmed)
  const res = await runScript(sessionId, wrapped, latest)
  // Offsets refer to the wrapped text; point them back at the original statement.
  const shift = wrapped.length - statement.length
  return {
    ...res,
    results: res.results.map((r) => ({ ...r, start: 0, end: statement.length })),
    error: res.error && {
      ...res.error,
      start: 0,
      end: statement.length,
      position: res.error.position === null ? null : Math.max(0, res.error.position - shift)
    }
  }
}

export function cancel(sessionId: string): Promise<void> {
  return getLive(sessionId).driver.cancel()
}

export function canCancel(sessionId: string): boolean {
  return getLive(sessionId).driver.canCancel
}

export function completions(sessionId: string) {
  return getLive(sessionId).driver.completions()
}

export function engineOf(sessionId: string) {
  return getLive(sessionId).config.engine
}

// ---- structure and administration ------------------------------------------------

export function structure(sessionId: string, schema: string, table: string) {
  const live = getLive(sessionId)
  return need(live, live.driver.structure, 'The structure view').call(live.driver, schema, table)
}

export function routineDefinition(sessionId: string, node: TreeNode) {
  const live = getLive(sessionId)
  return need(live, live.driver.routineDefinition, 'Routines').call(live.driver, node)
}

export function users(sessionId: string) {
  const live = getLive(sessionId)
  return need(live, live.driver.users, 'User management').call(live.driver)
}

export function processes(sessionId: string) {
  const live = getLive(sessionId)
  return need(live, live.driver.processes, 'The process list').call(live.driver)
}

function assertWritable(live: LiveSession, latest: ConnectionConfig | undefined) {
  if (effectiveSafeMode(latest ?? live.config) === 'readonly') {
    throw new Error('This connection is read-only. Change its safe mode to allow this.')
  }
}

export async function kill(sessionId: string, id: string, mode: 'cancel' | 'terminate', latest: ConnectionConfig | undefined) {
  const live = getLive(sessionId)
  assertWritable(live, latest)
  await need(live, live.driver.kill, 'Killing processes').call(live.driver, id, mode)
}

/** Statements an admin action would run, with secrets masked for display. */
export function previewAdmin(sessionId: string, action: AdminAction): string[] {
  const live = getLive(sessionId)
  if (live.driver.admin) return live.driver.admin.preview(action)
  return adminSql(live.config.engine, action, true)
}

/** Build the real statements and run them in one transaction where the engine allows. */
export async function applyAdmin(sessionId: string, action: AdminAction, latest: ConnectionConfig | undefined) {
  const live = getLive(sessionId)
  assertWritable(live, latest)
  if (live.driver.admin) return live.driver.admin.apply(action)
  const { execute } = sqlPath(live, 'This action')
  const statements = adminSql(live.config.engine, action, false).map((sql) => ({ sql, params: [], expectOne: false }))
  if (live.config.engine === 'duckdb') {
    // DuckDB still sees an index dropped earlier in the same transaction as blocking its column,
    // so schema changes commit one statement at a time (the safe op order keeps each step valid).
    for (const st of statements) await execute([st])
  } else {
    await execute(statements)
  }
}

// ---- import, export, backup -----------------------------------------------------------------

export function exportTable(sessionId: string, req: ExportTableRequest, path: string, onProgress: transfer.Progress) {
  return transfer.exportTable(getLive(sessionId).driver, req, path, onProgress)
}

export async function importIntoTable(sessionId: string, spec: ImportSpec, latest: ConnectionConfig | undefined, onProgress: transfer.Progress) {
  const live = getLive(sessionId)
  assertWritable(live, latest)
  return transfer.importIntoTable(live.driver, live.config.engine, spec, onProgress)
}

export function runSqlFile(sessionId: string, path: string, latest: ConnectionConfig | undefined, onProgress: transfer.Progress) {
  const live = getLive(sessionId)
  const readOnly = effectiveSafeMode(latest ?? live.config) === 'readonly'
  return transfer.runSqlFile(live.driver, live.config.engine, path, readOnly, onProgress)
}

/** Where external tools should connect: through the SSH tunnel when there is one. */
function toolConnection(live: LiveSession): tools.ToolConnection {
  const endpoint = live.tunnel?.endpoint ?? { host: live.config.host || '127.0.0.1', port: live.config.port }
  return {
    engine: live.config.engine,
    host: endpoint.host,
    port: endpoint.port,
    user: live.config.user,
    password: live.secrets.password,
    database: live.driver.currentDatabase(),
    ssl: live.config.ssl
  }
}

function resolveTools(engine: ConnectionConfig['engine'], settings: AppSettings): Partial<Record<ToolName, string | null>> {
  return Object.fromEntries((tools.TOOLS_FOR[engine] ?? []).map((t) => [t, tools.findTool(t, settings.toolPaths[t]).path]))
}

export function toolStatus(sessionId: string, settings: AppSettings): ToolStatus[] {
  const { engine } = getLive(sessionId).config
  return (tools.TOOLS_FOR[engine] ?? []).map((name) => {
    const found = tools.findTool(name, settings.toolPaths[name])
    return { name, path: found.path, custom: found.custom, version: found.path ? tools.toolVersion(found.path) : null }
  })
}

export async function backup(sessionId: string, o: BackupOptions, outPath: string, settings: AppSettings, onLog: tools.LogLine) {
  const live = getLive(sessionId)
  if (live.config.engine === 'sqlite') {
    // VACUUM INTO writes a compact, consistent copy and refuses to overwrite.
    rmSync(outPath, { force: true })
    onLog(`VACUUM INTO ${outPath}`)
    await live.driver.runStatement(`VACUUM INTO '${outPath.replace(/'/g, "''")}'`)
    return { bytes: (await import('node:fs')).statSync(outPath).size }
  }
  return tools.backup(resolveTools(live.config.engine, settings), toolConnection(live), o, outPath, onLog)
}

export async function restore(
  sessionId: string,
  o: RestoreOptions,
  inPath: string,
  settings: AppSettings,
  latest: ConnectionConfig | undefined,
  onLog: tools.LogLine
) {
  const live = getLive(sessionId)
  assertWritable(live, latest)
  await tools.restore(resolveTools(live.config.engine, settings), toolConnection(live), o, inPath, onLog)
}

const ERD_TABLE_LIMIT = 300

/** Tables, columns and foreign keys for one schema, read a few tables at a time. */
export async function erd(sessionId: string, schema: string, onProgress: (done: number, total: number | null) => void): Promise<ErdModel> {
  const live = getLive(sessionId)
  const structureOf = need(live, live.driver.structure, 'The ER diagram')
  const all = (await live.driver.completions()).filter((t) => t.schema === schema)
  const picked = all.slice(0, ERD_TABLE_LIMIT)
  const tables: ErdTable[] = []
  const failed: string[] = []
  let next = 0
  let done = 0
  onProgress(0, picked.length)
  const worker = async () => {
    while (next < picked.length) {
      const t = picked[next++]
      try {
        const s = await structureOf.call(live.driver, schema, t.name)
        tables.push({
          schema,
          name: t.name,
          kind: s.kind,
          columns: s.columns.map((c) => ({ name: c.name, type: c.type, pk: c.isPrimaryKey, nullable: c.nullable })),
          foreignKeys: s.foreignKeys
        })
      } catch {
        failed.push(t.name)
      }
      onProgress(++done, picked.length)
    }
  }
  // One at a time: each session has a single connection, and some drivers (pg) reject overlapping queries.
  await worker()
  tables.sort((a, b) => a.name.localeCompare(b.name))
  return { tables, truncated: all.length - picked.length, failed }
}
