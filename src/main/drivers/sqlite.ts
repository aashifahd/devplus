import { existsSync } from 'node:fs'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { CellValue, ConnectionConfig, ForeignKeyDef, FkAction, IndexDef, TableRequest } from '@shared/types'
import { checkAffected, parseTriggerHeader, type DriverSession } from './types'
import { buildCount, buildSelect, capRows, displaySql, normalizeCell, normalizeCellFull, sqliteDialect } from './sql'

type SqlParam = string | number | null

/** Run a statement and get rows as arrays, keeping duplicate column names intact. */
function allAsArrays(stmt: StatementSync, params: SqlParam[]): unknown[][] {
  const withArrays = stmt as StatementSync & { setReturnArrays?: (on: boolean) => void }
  if (withArrays.setReturnArrays) {
    withArrays.setReturnArrays(true)
    return stmt.all(...params) as unknown as unknown[][]
  }
  const names = stmt.columns().map((c) => c.name)
  return stmt.all(...params).map((row) => names.map((n) => (row as Record<string, unknown>)[n]))
}

const inferType = (v: CellValue | undefined) =>
  v === null || v === undefined ? '' : typeof v === 'number' ? 'numeric' : 'text'

export async function openSqlite(cfg: ConnectionConfig): Promise<DriverSession> {
  const file = cfg.filePath?.trim()
  if (!file) throw new Error('Choose a SQLite database file.')
  if (file !== ':memory:' && !existsSync(file)) throw new Error(`File not found: ${file}`)

  const db = new DatabaseSync(file)
  const version = String((db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v)
  let schema = 'main'

  return {
    serverVersion: `SQLite ${version}`,
    dialect: sqliteDialect,

    async listDatabases() {
      return (db.prepare('PRAGMA database_list').all() as { name: string }[]).map((r) => r.name)
    },

    currentDatabase: () => schema,

    async switchDatabase(name) {
      schema = name
    },

    async tree() {
      const master = schema === 'temp' ? 'sqlite_temp_master' : `${sqliteDialect.quote(schema)}.sqlite_master`
      const rows = db
        .prepare(`SELECT name, type FROM ${master} WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name`)
        .all() as { name: string; type: string }[]
      return [
        {
          kind: 'schema',
          name: schema,
          schema,
          children: rows.map((r) => ({ kind: r.type === 'view' ? 'view' : 'table', name: r.name, schema }))
        }
      ]
    },

    async columns(s, table) {
      const rows = db
        .prepare(`PRAGMA ${sqliteDialect.quote(s)}.table_info(${sqliteDialect.quote(table)})`)
        .all() as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[]
      return rows.map((r) => ({
        name: r.name,
        type: r.type || 'any',
        nullable: r.notnull === 0,
        defaultValue: r.dflt_value,
        isPrimaryKey: r.pk > 0
      }))
    },

    async fetchTable(req: TableRequest, opts) {
      const norm = opts?.fullBinary ? normalizeCellFull : normalizeCell
      const { sql, params } = buildSelect(sqliteDialect, req)
      const started = performance.now()
      const stmt = db.prepare(sql)
      const rows = allAsArrays(stmt, params as SqlParam[]).map((row) => row.map((v) => norm(v)))
      return {
        columns: stmt.columns().map((c, i) => ({ name: c.name, type: (c.type ?? inferType(rows[0]?.[i])).toLowerCase() })),
        rows,
        durationMs: performance.now() - started,
        sql: displaySql(sql, params)
      }
    },

    async countTable(req) {
      const { sql, params } = buildCount(sqliteDialect, req)
      const row = db.prepare(sql).get(...(params as SqlParam[])) as { n: number }
      return Number(row.n)
    },

    async execute(statements, onStatement) {
      const affected: number[] = []
      db.exec('BEGIN')
      try {
        for (const [i, st] of statements.entries()) {
          const res = db.prepare(st.sql).run(...(st.params as SqlParam[]))
          checkAffected(st, i, Number(res.changes))
          affected.push(Number(res.changes))
          onStatement?.(i)
        }
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
      return affected
    },

    async runStatement(sql) {
      const stmt = db.prepare(sql)
      const cols = stmt.columns()
      if (cols.length === 0) {
        const res = stmt.run()
        return { hasRows: false, columns: [], rows: [], affected: Number(res.changes), command: '', truncated: false }
      }
      const { rows, truncated } = capRows(allAsArrays(stmt, []))
      return {
        hasRows: true,
        columns: cols.map((c, i) => ({ name: c.name, type: (c.type ?? inferType(rows[0]?.[i])).toLowerCase() })),
        rows,
        affected: null,
        command: '',
        truncated
      }
    },

    async withReadOnly(fn) {
      db.exec('PRAGMA query_only = ON')
      try {
        return await fn()
      } finally {
        db.exec('PRAGMA query_only = OFF')
      }
    },

    // node:sqlite runs synchronously on the main thread, so there is nothing to interrupt.
    canCancel: false,

    async cancel() {
      throw new Error('SQLite queries cannot be cancelled.')
    },

    async completions() {
      const master = schema === 'temp' ? 'sqlite_temp_master' : `${sqliteDialect.quote(schema)}.sqlite_master`
      const tables = db
        .prepare(`SELECT name, type FROM ${master} WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name`)
        .all() as { name: string; type: string }[]
      return tables.map((t) => ({
        schema,
        name: t.name,
        kind: t.type === 'view' ? ('view' as const) : ('table' as const),
        columns: (
          db.prepare(`PRAGMA ${sqliteDialect.quote(schema)}.table_info(${sqliteDialect.quote(t.name)})`).all() as {
            name: string
            type: string
          }[]
        ).map((c) => ({ name: c.name, type: c.type || 'any' }))
      }))
    },

    async structure(s, table) {
      const q = sqliteDialect.quote
      const master = s === 'temp' ? 'sqlite_temp_master' : `${q(s)}.sqlite_master`
      const obj = db.prepare(`SELECT type, sql FROM ${master} WHERE name = ? AND type IN ('table', 'view')`).get(table) as
        | { type: string; sql: string | null }
        | undefined
      if (!obj) throw new Error(`${table} no longer exists.`)
      const tableSql = obj.sql ?? ''

      const info = db.prepare(`PRAGMA ${q(s)}.table_info(${q(table)})`).all() as {
        name: string
        type: string
        notnull: number
        dflt_value: string | null
        pk: number
      }[]
      const columns = info.map((c) => ({
        name: c.name,
        type: c.type || 'any',
        nullable: c.notnull === 0 && c.pk === 0,
        defaultValue: c.dflt_value,
        isPrimaryKey: c.pk > 0,
        autoIncrement: c.pk > 0 && /AUTOINCREMENT/i.test(tableSql),
        comment: null
      }))

      const indexList = db.prepare(`PRAGMA ${q(s)}.index_list(${q(table)})`).all() as {
        name: string
        unique: number
        origin: string
      }[]
      const indexes: IndexDef[] = indexList.map((ix) => {
        const cols = db.prepare(`PRAGMA ${q(s)}.index_info(${q(ix.name)})`).all() as { seqno: number; name: string }[]
        const def = db.prepare(`SELECT sql FROM ${master} WHERE type = 'index' AND name = ?`).get(ix.name) as { sql: string | null } | undefined
        return {
          name: ix.name,
          columns: cols.sort((a, b) => a.seqno - b.seqno).map((c) => c.name),
          unique: ix.unique === 1,
          primary: ix.origin === 'pk',
          method: null,
          definition: def?.sql ?? null
        }
      })

      const fkRows = db.prepare(`PRAGMA ${q(s)}.foreign_key_list(${q(table)})`).all() as {
        id: number
        seq: number
        table: string
        from: string
        to: string | null
        on_update: string
        on_delete: string
      }[]
      const fkMap = new Map<number, ForeignKeyDef>()
      for (const r of fkRows.sort((a, b) => a.id - b.id || a.seq - b.seq)) {
        // SQLite foreign keys are unnamed; number them so the UI can refer to each.
        const fk = fkMap.get(r.id) ?? { name: `fk_${r.id}`, columns: [], refSchema: s, refTable: r.table, refColumns: [], onUpdate: r.on_update as FkAction, onDelete: r.on_delete as FkAction }
        fk.columns.push(r.from)
        if (r.to) fk.refColumns.push(r.to)
        fkMap.set(r.id, fk)
      }

      const trg = db.prepare(`SELECT name, sql FROM ${master} WHERE type = 'trigger' AND tbl_name = ? ORDER BY name`).all(table) as {
        name: string
        sql: string
      }[]
      const triggers = trg.map((t) => ({ name: t.name, definition: t.sql, ...parseTriggerHeader(t.sql) }))

      const ddl = [tableSql, ...indexes.map((i) => i.definition).filter(Boolean), ...triggers.map((t) => t.definition)]
        .map((x) => `${x};`)
        .join('\n\n')
      return { schema: s, name: table, kind: obj.type === 'view' ? 'view' : 'table', columns, indexes, foreignKeys: [...fkMap.values()], triggers, ddl }
    },

    async close() {
      db.close()
    }
  }
}
