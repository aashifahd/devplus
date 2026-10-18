import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { DuckDBInstance, type DuckDBConnection, type DuckDBResultReader } from '@duckdb/node-api'
import type { ColumnDef, ConnectionConfig, FkAction, TableRequest, TreeNode } from '@shared/types'
import { checkAffected, type DriverSession, type RawStatementResult } from './types'
import { buildCount, buildSelect, displaySql, duckdbDialect, MAX_RESULT_ROWS, normalizeCell } from './sql'
import { groupCompletions } from './postgres'

const q = duckdbDialect.quote
/**
 * DuckDB won't compare a VARCHAR parameter with an INTEGER column, but a string literal
 * casts implicitly. displaySql writes standard SQL literals (quotes doubled), so use it.
 */
const inline = (sql: string, params: unknown[]) => (params.length ? displaySql(sql, params) : sql)

function readerRows(reader: DuckDBResultReader): RawStatementResult {
  const names = reader.columnNames()
  const types = reader.columnTypes().map((t) => t.toString().toLowerCase())
  const rows = reader.getRowsJson() as unknown[][]
  const truncated = rows.length > MAX_RESULT_ROWS
  return {
    hasRows: names.length > 0,
    columns: names.map((n, i) => ({ name: n, type: types[i] })),
    rows: (truncated ? rows.slice(0, MAX_RESULT_ROWS) : rows).map((r) => r.map(normalizeCell)),
    affected: null,
    command: '',
    truncated
  }
}

export async function openDuckdb(cfg: ConnectionConfig): Promise<DriverSession> {
  const file = cfg.filePath?.trim() || ':memory:'
  // DuckDB creates a missing file on open, so only the folder has to exist.
  if (file !== ':memory:' && !existsSync(dirname(file))) throw new Error(`Folder not found: ${dirname(file)}`)
  const instance = await DuckDBInstance.create(file)
  const conn: DuckDBConnection = await instance.connect()

  const all = async (sql: string, params: unknown[] = []) => (await conn.runAndReadAll(inline(sql, params))).getRowObjectsJson() as Record<string, unknown>[]
  const version = String((await all('SELECT version() AS v'))[0].v)
  let database = String((await all('SELECT current_database() AS d'))[0].d)

  const columnsOf = async (schema: string, table: string): Promise<ColumnDef[]> => {
    const cols = await all(
      `SELECT column_name AS name, data_type AS type, is_nullable AS nullable, column_default AS def
       FROM duckdb_columns() WHERE database_name = ? AND schema_name = ? AND table_name = ? ORDER BY column_index`,
      [database, schema, table]
    )
    const pk = await all(
      `SELECT constraint_column_names AS cols FROM duckdb_constraints()
       WHERE database_name = ? AND schema_name = ? AND table_name = ? AND constraint_type = 'PRIMARY KEY'`,
      [database, schema, table]
    )
    const pkCols = new Set((pk[0]?.cols as string[] | undefined) ?? [])
    return cols.map((c) => ({
      name: String(c.name),
      type: String(c.type),
      nullable: Boolean(c.nullable),
      defaultValue: c.def === null ? null : String(c.def),
      isPrimaryKey: pkCols.has(String(c.name)),
      autoIncrement: /^nextval\(/i.test(String(c.def ?? '')),
      comment: null
    }))
  }

  return {
    serverVersion: `DuckDB ${version}`,
    dialect: duckdbDialect,

    async listDatabases() {
      return (await all('SELECT database_name AS n FROM duckdb_databases() WHERE NOT internal ORDER BY 1')).map((r) => String(r.n))
    },

    currentDatabase: () => database,

    async switchDatabase(name) {
      await conn.run(`USE ${q(name)}`)
      database = name
    },

    async tree() {
      const schemas = await all('SELECT schema_name AS n FROM duckdb_schemas() WHERE database_name = ? AND NOT internal ORDER BY n = \'main\' DESC, n', [database])
      const rels = await all(
        `SELECT schema_name AS s, table_name AS n, 'table' AS k FROM duckdb_tables() WHERE database_name = ? AND NOT internal
         UNION ALL
         SELECT schema_name, view_name, 'view' FROM duckdb_views() WHERE database_name = ? AND NOT internal
         ORDER BY n`,
        [database, database]
      )
      const by = new Map<string, TreeNode>(schemas.map((s) => [String(s.n), { kind: 'schema', name: String(s.n), schema: String(s.n), children: [] }]))
      for (const r of rels) {
        const s = String(r.s)
        if (!by.has(s)) by.set(s, { kind: 'schema', name: s, schema: s, children: [] })
        by.get(s)!.children!.push({ kind: r.k === 'view' ? 'view' : 'table', name: String(r.n), schema: s })
      }
      return [...by.values()]
    },

    columns: columnsOf,

    async fetchTable(req: TableRequest) {
      const { sql, params } = buildSelect(duckdbDialect, req)
      const started = performance.now()
      const r = readerRows(await conn.runAndReadUntil(inline(sql, params), req.limit))
      return { columns: r.columns, rows: r.rows, durationMs: performance.now() - started, sql: displaySql(sql, params) }
    },

    async countTable(req) {
      const { sql, params } = buildCount(duckdbDialect, req)
      return Number((await all(sql, params))[0].n)
    },

    async execute(statements, onStatement) {
      const affected: number[] = []
      await conn.run('BEGIN TRANSACTION')
      try {
        for (const [i, st] of statements.entries()) {
          const reader = await conn.runAndReadAll(inline(st.sql, st.params))
          checkAffected(st, i, reader.rowsChanged)
          affected.push(reader.rowsChanged)
          onStatement?.(i)
        }
        await conn.run('COMMIT')
      } catch (err) {
        await conn.run('ROLLBACK').catch(() => {})
        throw err
      }
      return affected
    },

    async runStatement(sql) {
      const reader = await conn.runAndReadUntil(sql, MAX_RESULT_ROWS + 1)
      // DML reports a single "Count" column; show it as rows affected instead of a result set.
      if (reader.columnNames().length === 0 || /^\s*(insert|update|delete)\b/i.test(sql)) {
        return { hasRows: false, columns: [], rows: [], affected: reader.rowsChanged, command: '', truncated: false }
      }
      return readerRows(reader)
    },

    async withReadOnly(fn) {
      // No read-only transaction mode; DDL is transactional too, so a rollback undoes anything.
      await conn.run('BEGIN TRANSACTION')
      try {
        return await fn()
      } finally {
        await conn.run('ROLLBACK').catch(() => {})
      }
    },

    canCancel: true,

    async cancel() {
      conn.interrupt()
    },

    async completions() {
      const rows = await all(
        `SELECT c.schema_name AS schema, c.table_name AS name, CASE WHEN v.view_name IS NULL THEN 'table' ELSE 'view' END AS kind,
                c.column_name AS column, c.data_type AS type
         FROM duckdb_columns() c
         LEFT JOIN duckdb_views() v ON v.database_name = c.database_name AND v.schema_name = c.schema_name AND v.view_name = c.table_name
         WHERE c.database_name = ? AND NOT c.internal
         ORDER BY c.schema_name, c.table_name, c.column_index`,
        [database]
      )
      return groupCompletions(rows.map((r) => ({ schema: String(r.schema), name: String(r.name), kind: String(r.kind), column: String(r.column), type: String(r.type) })))
    },

    async structure(schema, table) {
      const view = await all('SELECT sql FROM duckdb_views() WHERE database_name = ? AND schema_name = ? AND view_name = ?', [database, schema, table])
      const columns = await columnsOf(schema, table)
      if (view[0]) {
        return { schema, name: table, kind: 'view', columns, indexes: [], foreignKeys: [], triggers: [], ddl: String(view[0].sql) }
      }
      const tbl = await all('SELECT sql FROM duckdb_tables() WHERE database_name = ? AND schema_name = ? AND table_name = ?', [database, schema, table])
      if (!tbl[0]) throw new Error(`${schema}.${table} no longer exists.`)

      const idx = await all('SELECT index_name AS n, is_unique AS u, sql, expressions AS e FROM duckdb_indexes() WHERE database_name = ? AND schema_name = ? AND table_name = ?', [database, schema, table])
      const cons = await all(
        `SELECT constraint_type AS t, constraint_name AS n, constraint_column_names AS cols, referenced_table AS rt, referenced_column_names AS rcols
         FROM duckdb_constraints() WHERE database_name = ? AND schema_name = ? AND table_name = ?`,
        [database, schema, table]
      )
      const pk = cons.find((c) => c.t === 'PRIMARY KEY')
      const indexes = [
        ...(pk ? [{ name: String(pk.n ?? `${table}_pkey`), columns: (pk.cols as string[]) ?? [], unique: true, primary: true, method: null, definition: null }] : []),
        ...idx.map((i) => ({
          name: String(i.n),
          columns: String(i.e ?? '')
            .replace(/^\[|\]$/g, '')
            .split(',')
            .map((x) => x.trim().replace(/^'|'$/g, ''))
            .filter(Boolean),
          unique: Boolean(i.u),
          primary: false,
          method: null,
          definition: i.sql ? String(i.sql) : null
        }))
      ]
      const foreignKeys = cons
        .filter((c) => c.t === 'FOREIGN KEY')
        .map((c) => ({
          name: String(c.n ?? ''),
          columns: (c.cols as string[]) ?? [],
          refSchema: schema,
          refTable: String(c.rt ?? ''),
          refColumns: (c.rcols as string[]) ?? [],
          onUpdate: 'NO ACTION' as FkAction,
          onDelete: 'NO ACTION' as FkAction
        }))
      const ddl = [String(tbl[0].sql), ...indexes.map((i) => i.definition).filter(Boolean)].map((s) => (String(s).trim().endsWith(';') ? s : `${s};`)).join('\n\n')
      return { schema, name: table, kind: 'table', columns, indexes, foreignKeys, triggers: [], ddl }
    },

    async close() {
      conn.closeSync()
      instance.closeSync()
    }
  }
}
