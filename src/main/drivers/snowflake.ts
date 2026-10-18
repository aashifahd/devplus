import snowflake, { type Connection, type RowStatement } from 'snowflake-sdk'
import type { ColumnDef, ConnectionConfig, ConnectionSecrets, FkAction, TableRequest, TreeNode } from '@shared/types'
import { checkAffected, type DriverSession, type RawStatementResult } from './types'
import { buildCount, buildSelect, displaySql, MAX_RESULT_ROWS, normalizeCell, normalizeCellFull, snowflakeDialect } from './sql'
import { groupCompletions } from './postgres'

// Failures reach the user through the UI; the SDK's own JSON log lines would only add noise.
snowflake.configure({ logLevel: 'OFF' })

const q = snowflakeDialect.quote
const lit = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`

interface Exec {
  rows: unknown[][]
  columns: { name: string; type: string }[]
  updated: number | undefined
}

export async function openSnowflake(cfg: ConnectionConfig, secrets: ConnectionSecrets): Promise<DriverSession> {
  if (!cfg.host) throw new Error('Enter your Snowflake account identifier (for example orgname-accountname).')
  const conn: Connection = snowflake.createConnection({
    account: cfg.host.replace(/\.snowflakecomputing\.com$/i, ''),
    username: cfg.user,
    password: secrets.password,
    database: cfg.database || undefined,
    warehouse: cfg.options?.warehouse || undefined,
    role: cfg.options?.role || undefined,
    application: 'DevPlus'
  })
  // The callback form reports the real cause (bad account, auth, network) rather than a later "terminated" error.
  await new Promise<void>((resolve, reject) => conn.connect((err) => (err ? reject(err) : resolve())))

  let running: RowStatement | null = null

  const exec = (sqlText: string, binds: unknown[] = []): Promise<Exec> =>
    new Promise((resolve, reject) => {
      const statement = conn.execute({
        sqlText,
        binds: binds as snowflake.Binds,
        rowMode: 'array',
        complete: (err, stmt, rows) => {
          running = null
          if (err) return reject(err)
          resolve({
            rows: (rows ?? []) as unknown[][],
            columns: (stmt.getColumns() ?? []).map((c) => ({ name: c.getName(), type: c.getType() })),
            updated: stmt.getNumUpdatedRows()
          })
        }
      }) as RowStatement
      running = statement
    })

  const objects = async (sqlText: string, binds: unknown[] = []) => {
    const r = await exec(sqlText, binds)
    return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c.name.toLowerCase(), row[i]])))
  }

  const ctx = (await objects('SELECT CURRENT_VERSION() AS v, CURRENT_DATABASE() AS d'))[0]
  let database = String(ctx.d ?? cfg.database ?? '')

  const toRaw = (r: Exec, full = false): RawStatementResult => {
    const truncated = r.rows.length > MAX_RESULT_ROWS
    const norm = full ? normalizeCellFull : normalizeCell
    return {
      hasRows: r.columns.length > 0,
      columns: r.columns.map((c) => ({ name: c.name, type: c.type.toLowerCase() })),
      rows: (truncated ? r.rows.slice(0, MAX_RESULT_ROWS) : r.rows).map((row) => row.map((v) => norm(v))),
      affected: null,
      command: '',
      truncated
    }
  }

  const columnsOf = async (schema: string, table: string): Promise<ColumnDef[]> => {
    const cols = await objects(
      `SELECT column_name, data_type, character_maximum_length AS len, numeric_precision AS p, numeric_scale AS s,
              is_nullable, column_default, comment, is_identity
       FROM ${q(database)}.information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
      [schema, table]
    )
    const pk = await objects(`SHOW PRIMARY KEYS IN TABLE ${q(database)}.${q(schema)}.${q(table)}`).catch(() => [])
    const pkCols = new Set(pk.map((r) => String(r.column_name)))
    return cols.map((c) => {
      const base = String(c.data_type)
      const type =
        base === 'TEXT' && c.len ? `VARCHAR(${c.len})` : base === 'NUMBER' && c.p !== null ? `NUMBER(${c.p},${c.s ?? 0})` : base
      return {
        name: String(c.column_name),
        type,
        nullable: c.is_nullable === 'YES',
        defaultValue: c.column_default === null ? null : String(c.column_default),
        isPrimaryKey: pkCols.has(String(c.column_name)),
        autoIncrement: c.is_identity === 'YES',
        comment: c.comment ? String(c.comment) : null
      }
    })
  }

  return {
    serverVersion: `Snowflake ${ctx.v}`,
    dialect: snowflakeDialect,

    async listDatabases() {
      return (await objects('SHOW DATABASES')).map((r) => String(r.name))
    },

    currentDatabase: () => database,

    async switchDatabase(name) {
      await exec(`USE DATABASE ${q(name)}`)
      database = name
    },

    async tree() {
      if (!database) return []
      const schemas = await objects(`SELECT schema_name FROM ${q(database)}.information_schema.schemata WHERE schema_name <> 'INFORMATION_SCHEMA' ORDER BY schema_name = 'PUBLIC' DESC, schema_name`)
      const rels = await objects(
        `SELECT table_schema, table_name, table_type FROM ${q(database)}.information_schema.tables
         WHERE table_schema <> 'INFORMATION_SCHEMA' ORDER BY table_name`
      )
      const by = new Map<string, TreeNode>(schemas.map((s) => [String(s.schema_name), { kind: 'schema', name: String(s.schema_name), schema: String(s.schema_name), children: [] }]))
      for (const r of rels) {
        by.get(String(r.table_schema))?.children!.push({ kind: /VIEW/.test(String(r.table_type)) ? 'view' : 'table', name: String(r.table_name), schema: String(r.table_schema) })
      }
      return [...by.values()]
    },

    columns: columnsOf,

    async fetchTable(req: TableRequest, opts) {
      const { sql, params } = buildSelect(snowflakeDialect, req)
      const started = performance.now()
      const r = toRaw(await exec(sql, params), opts?.fullBinary)
      return { columns: r.columns, rows: r.rows, durationMs: performance.now() - started, sql: displaySql(sql, params) }
    },

    async countTable(req) {
      const { sql, params } = buildCount(snowflakeDialect, req)
      return Number((await objects(sql, params))[0]?.n ?? 0)
    },

    async execute(statements, onStatement) {
      const affected: number[] = []
      await exec('BEGIN')
      try {
        for (const [i, st] of statements.entries()) {
          const r = await exec(st.sql, st.params)
          const n = r.updated ?? -1
          checkAffected(st, i, n)
          affected.push(n)
          onStatement?.(i)
        }
        await exec('COMMIT')
      } catch (err) {
        await exec('ROLLBACK').catch(() => {})
        throw err
      }
      return affected
    },

    async runStatement(sqlText) {
      const r = await exec(sqlText)
      if (r.columns.length === 0 || /^\s*(insert|update|delete|merge)\b/i.test(sqlText)) {
        return { hasRows: false, columns: [], rows: [], affected: r.updated ?? null, command: '', truncated: false }
      }
      return toRaw(r)
    },

    async withReadOnly(fn) {
      // No read-only mode; DML in the transaction is rolled back (DDL commits implicitly in Snowflake,
      // which is why read-only connections also block writes before they are sent).
      await exec('BEGIN')
      try {
        return await fn()
      } finally {
        await exec('ROLLBACK').catch(() => {})
      }
    },

    canCancel: true,

    async cancel() {
      running?.cancel()
    },

    async completions() {
      if (!database) return []
      const rows = await objects(
        `SELECT c.table_schema AS "schema", c.table_name AS name, t.table_type AS kind, c.column_name AS "column", c.data_type AS type
         FROM ${q(database)}.information_schema.columns c
         JOIN ${q(database)}.information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
         WHERE c.table_schema <> 'INFORMATION_SCHEMA' ORDER BY c.table_schema, c.table_name, c.ordinal_position`
      )
      return groupCompletions(rows.map((r) => ({ schema: String(r.schema), name: String(r.name), kind: String(r.kind), column: String(r.column), type: String(r.type) })))
    },

    async structure(schema, table) {
      const info = (await objects(`SELECT table_type FROM ${q(database)}.information_schema.tables WHERE table_schema = ? AND table_name = ?`, [schema, table]))[0]
      if (!info) throw new Error(`${schema}.${table} no longer exists.`)
      const isView = /VIEW/.test(String(info.table_type))
      const columns = await columnsOf(schema, table)
      const fq = `${q(database)}.${q(schema)}.${q(table)}`
      const fkRows = isView ? [] : await objects(`SHOW IMPORTED KEYS IN TABLE ${fq}`).catch(() => [])
      const fkMap = new Map<string, { name: string; columns: string[]; refSchema: string; refTable: string; refColumns: string[]; onUpdate: FkAction; onDelete: FkAction }>()
      for (const r of fkRows) {
        const name = String(r.fk_name)
        const e = fkMap.get(name) ?? { name, columns: [] as string[], refSchema: String(r.pk_schema_name), refTable: String(r.pk_table_name), refColumns: [] as string[], onUpdate: String(r.update_rule) as FkAction, onDelete: String(r.delete_rule) as FkAction }
        e.columns.push(String(r.fk_column_name))
        e.refColumns.push(String(r.pk_column_name))
        fkMap.set(name, e)
      }
      const pk = columns.filter((c) => c.isPrimaryKey).map((c) => c.name)
      const ddl = String((await objects(`SELECT GET_DDL(${lit(isView ? 'VIEW' : 'TABLE')}, ${lit(`${q(database)}.${q(schema)}.${q(table)}`)}) AS ddl`))[0]?.ddl ?? '')
      return {
        schema,
        name: table,
        kind: isView ? 'view' : 'table',
        columns,
        indexes: pk.length ? [{ name: 'PRIMARY KEY', columns: pk, unique: true, primary: true, method: 'not enforced', definition: null }] : [],
        foreignKeys: [...fkMap.values()],
        triggers: [],
        ddl
      }
    },

    async close() {
      await new Promise<void>((resolve) => conn.destroy(() => resolve()))
    }
  }
}
