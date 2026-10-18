import { randomUUID } from 'node:crypto'
import { ClickHouseLogLevel, createClient, type ClickHouseClient } from '@clickhouse/client'
import type { ColumnDef, ConnectionConfig, ConnectionSecrets, TableRequest, TreeNode } from '@shared/types'
import type { DriverSession, Endpoint, RawStatementResult } from './types'
import { buildCount, buildSelect, clickhouseDialect, displaySql, inlineParams, MAX_RESULT_ROWS, normalizeCell, normalizeCellFull } from './sql'
import { groupCompletions } from './postgres'

const q = clickhouseDialect.quote
const SELECT_LIKE = /^\s*(select|with|show|describe|desc|explain|exists|\()/i
/** ClickHouse string literal: backslash and quote escaped. */
const lit = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

export async function openClickhouse(cfg: ConnectionConfig, secrets: ConnectionSecrets, endpoint: Endpoint): Promise<DriverSession> {
  const protocol = cfg.options?.protocol === 'https' || cfg.ssl.mode === 'require' || cfg.ssl.mode === 'verify-full' ? 'https' : 'http'
  let database = cfg.database || 'default'
  let readOnly = false
  let runningId: string | null = null
  /** Set when the user cancels: ClickHouse may still return the rows it had, which must not look like success. */
  let cancelledId: string | null = null

  const make = (db: string): ClickHouseClient =>
    createClient({
      url: `${protocol}://${endpoint.host}:${endpoint.port}`,
      username: cfg.user || 'default',
      password: secrets.password ?? '',
      database: db,
      request_timeout: 300_000,
      application: 'DevPlus',
      // Errors reach the user through the UI; the library's own console logging is just noise here.
      log: { level: ClickHouseLogLevel.OFF },
      // Progress headers keep long queries alive through proxies with idle timeouts.
      clickhouse_settings: { send_progress_in_http_headers: 1, http_headers_progress_interval_ms: '110000' }
    })
  let client = make(database)

  /** Rows as arrays plus names and types, with a server-side row cap. */
  const select = async (sql: string, cap = MAX_RESULT_ROWS + 1) => {
    const queryId = randomUUID()
    runningId = queryId
    try {
      const rs = await client.query({
        query: sql,
        format: 'JSONCompactEachRowWithNamesAndTypes',
        query_id: queryId,
        clickhouse_settings: {
          max_result_rows: String(cap),
          result_overflow_mode: 'break',
          ...(readOnly ? { readonly: '2' } : {})
        }
      })
      const data = (await rs.json()) as unknown[][]
      if (cancelledId === queryId) throw new Error('Query cancelled.')
      const [names = [], types = [], ...rows] = data
      return { names: names as string[], types: types as string[], rows }
    } catch (err) {
      if (cancelledId === queryId) throw new Error('Query cancelled.')
      throw err
    } finally {
      runningId = null
    }
  }

  const command = async (sql: string) => {
    const queryId = randomUUID()
    runningId = queryId
    try {
      await client.command({ query: sql, query_id: queryId, clickhouse_settings: readOnly ? { readonly: '2' } : {} })
    } finally {
      runningId = null
    }
  }

  const objects = async (sql: string) => {
    const r = await select(sql, 1_000_000)
    return r.rows.map((row) => Object.fromEntries(r.names.map((n, i) => [n, row[i]])))
  }

  await client.ping()
  const version = String((await objects('SELECT version() AS v'))[0]?.v ?? '')

  const columnsOf = async (db: string, table: string): Promise<ColumnDef[]> => {
    const rows = await objects(
      `SELECT name, type, default_kind, default_expression, is_in_primary_key, comment
       FROM system.columns WHERE database = ${lit(db)} AND table = ${lit(table)} ORDER BY position`
    )
    return rows.map((r) => ({
      name: String(r.name),
      type: String(r.type),
      nullable: String(r.type).startsWith('Nullable('),
      defaultValue: r.default_expression ? String(r.default_expression) : null,
      isPrimaryKey: Number(r.is_in_primary_key) === 1,
      autoIncrement: false,
      comment: r.comment ? String(r.comment) : null
    }))
  }

  const toRaw = (r: { names: string[]; types: string[]; rows: unknown[][] }, full = false): RawStatementResult => {
    const truncated = r.rows.length > MAX_RESULT_ROWS
    const norm = full ? normalizeCellFull : normalizeCell
    return {
      hasRows: true,
      columns: r.names.map((n, i) => ({ name: n, type: r.types[i] ?? '' })),
      rows: (truncated ? r.rows.slice(0, MAX_RESULT_ROWS) : r.rows).map((row) => row.map((v) => norm(v))),
      affected: null,
      command: '',
      truncated
    }
  }

  return {
    serverVersion: `ClickHouse ${version}`,
    dialect: clickhouseDialect,

    async listDatabases() {
      return (await objects("SELECT name FROM system.databases WHERE name NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') ORDER BY name")).map((r) => String(r.name))
    },

    currentDatabase: () => database,

    async switchDatabase(name) {
      const next = make(name)
      await next.ping()
      await client.close().catch(() => {})
      client = next
      database = name
    },

    async tree() {
      const rows = await objects(`SELECT name, engine FROM system.tables WHERE database = ${lit(database)} ORDER BY name`)
      return [
        {
          kind: 'schema',
          name: database,
          schema: database,
          children: rows.map((r) => ({ kind: /View$/.test(String(r.engine)) ? 'view' : 'table', name: String(r.name), schema: database }) as TreeNode)
        }
      ]
    },

    columns: (schema, table) => columnsOf(schema, table),

    async fetchTable(req: TableRequest, opts) {
      const { sql, params } = buildSelect(clickhouseDialect, req)
      const started = performance.now()
      const r = toRaw(await select(inlineParams(sql, params), req.limit), opts?.fullBinary)
      return { columns: r.columns, rows: r.rows, durationMs: performance.now() - started, sql: displaySql(sql, params) }
    },

    async countTable(req) {
      const { sql, params } = buildCount(clickhouseDialect, req)
      return Number((await objects(inlineParams(sql, params)))[0]?.n ?? 0)
    },

    async execute(statements, onStatement) {
      // ClickHouse has no multi-statement transactions; run in order and report unknown counts.
      for (const [i, st] of statements.entries()) {
        await command(inlineParams(st.sql, st.params))
        onStatement?.(i)
      }
      return statements.map(() => -1)
    },

    async runStatement(sql) {
      if (SELECT_LIKE.test(sql)) return toRaw(await select(sql))
      await command(sql)
      return { hasRows: false, columns: [], rows: [], affected: null, command: sql.trim().split(/\s+/)[0].toUpperCase(), truncated: false }
    },

    async withReadOnly(fn) {
      // readonly=2 forbids writes but still lets each query set its own limits.
      readOnly = true
      try {
        return await fn()
      } finally {
        readOnly = false
      }
    },

    canCancel: true,

    async cancel() {
      if (!runningId) return
      cancelledId = runningId
      const killer = make(database)
      try {
        await killer.command({ query: `KILL QUERY WHERE query_id = ${lit(runningId)} ASYNC` })
      } finally {
        await killer.close().catch(() => {})
      }
    },

    async completions() {
      const rows = await objects(
        `SELECT c.database AS schema, c.table AS name, t.engine AS kind, c.name AS column, c.type AS type
         FROM system.columns c JOIN system.tables t ON t.database = c.database AND t.name = c.table
         WHERE c.database = ${lit(database)} ORDER BY c.table, c.position`
      )
      return groupCompletions(rows.map((r) => ({ schema: String(r.schema), name: String(r.name), kind: /View$/.test(String(r.kind)) ? 'view' : 'table', column: String(r.column), type: String(r.type) })))
    },

    async structure(schema, table) {
      const info = (await objects(`SELECT engine, primary_key, sorting_key FROM system.tables WHERE database = ${lit(schema)} AND name = ${lit(table)}`))[0]
      if (!info) throw new Error(`${schema}.${table} no longer exists.`)
      const columns = await columnsOf(schema, table)
      const skips = await objects(`SELECT name, expr, type, granularity FROM system.data_skipping_indices WHERE database = ${lit(schema)} AND table = ${lit(table)}`)
      const keyCols = (expr: unknown) =>
        String(expr ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      const indexes = [
        ...(info.primary_key ? [{ name: 'PRIMARY KEY', columns: keyCols(info.primary_key), unique: false, primary: true, method: String(info.engine), definition: null }] : []),
        ...(info.sorting_key && info.sorting_key !== info.primary_key
          ? [{ name: 'ORDER BY', columns: keyCols(info.sorting_key), unique: false, primary: false, method: 'sorting key', definition: null }]
          : []),
        ...skips.map((s) => ({
          name: String(s.name),
          columns: [String(s.expr)],
          unique: false,
          primary: false,
          method: String(s.type),
          definition: `INDEX ${q(String(s.name))} ${s.expr} TYPE ${s.type} GRANULARITY ${s.granularity}`
        }))
      ]
      const ddl = String((await objects(`SHOW CREATE TABLE ${q(schema)}.${q(table)}`))[0]?.statement ?? '')
      return { schema, name: table, kind: /View$/.test(String(info.engine)) ? 'view' : 'table', columns, indexes, foreignKeys: [], triggers: [], ddl }
    },

    async users() {
      const users = await objects('SELECT name, auth_type, host_ip, host_names FROM system.users ORDER BY name')
      const grants = await objects('SELECT user_name, granted_role_name FROM system.role_grants WHERE user_name IS NOT NULL').catch(() => [])
      return users.map((u) => ({
        name: String(u.name),
        host: null,
        attributes: [String(u.auth_type).replace(/[[\]']/g, '')].filter(Boolean),
        memberOf: grants.filter((g) => g.user_name === u.name).map((g) => String(g.granted_role_name))
      }))
    },

    async processes() {
      const rows = await objects(
        `SELECT query_id, user, current_database AS db, address, elapsed, query, is_cancelled
         FROM system.processes ORDER BY elapsed DESC`
      )
      return rows.map((r) => ({
        id: String(r.query_id),
        user: String(r.user),
        database: String(r.db),
        client: String(r.address),
        state: Number(r.is_cancelled) ? 'cancelling' : 'running',
        seconds: Number(r.elapsed),
        query: String(r.query),
        // The process-list query itself is the only one this app has running right now.
        self: /FROM system\.processes/.test(String(r.query))
      }))
    },

    async kill(id) {
      await command(`KILL QUERY WHERE query_id = ${lit(id)} ASYNC`)
    },

    async close() {
      await client.close().catch(() => {})
    }
  }
}
