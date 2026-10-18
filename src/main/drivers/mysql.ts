import { readFileSync } from 'node:fs'
import mysql from 'mysql2/promise'
import { Types } from 'mysql2'
import type { ColumnDef, ConnectionConfig, ConnectionSecrets, FkAction, TableRequest, TreeNode } from '@shared/types'
import { checkAffected, type DriverSession, type Endpoint } from './types'
import { buildCount, buildSelect, capRows, displaySql, mysqlDialect, normalizeCell, normalizeCellFull, tableRef } from './sql'
import { groupCompletions } from './postgres'

// Protocol type names are terse ("long", "var_string"); show the SQL names people know.
const FRIENDLY: Record<string, string> = {
  tiny: 'tinyint',
  short: 'smallint',
  int24: 'mediumint',
  long: 'int',
  longlong: 'bigint',
  newdecimal: 'decimal',
  var_string: 'varchar',
  string: 'char',
  newdate: 'date',
  long_blob: 'longblob',
  medium_blob: 'mediumblob',
  tiny_blob: 'tinyblob'
}

const typeNames = new Map<number, string>(
  Object.entries(Types as unknown as Record<string, number | string>)
    .filter((e): e is [string, number] => typeof e[1] === 'number')
    .map(([name, id]) => [id, FRIENDLY[name.toLowerCase()] ?? name.toLowerCase()])
)

function sslOption(cfg: ConnectionConfig): mysql.ConnectionOptions['ssl'] {
  switch (cfg.ssl.mode) {
    case 'disable':
    case 'prefer':
      // mysql2 has no opportunistic TLS; treat "prefer" as plain unless required.
      return undefined
    case 'require':
      return { rejectUnauthorized: false }
    case 'verify-full':
      return { rejectUnauthorized: true, ca: cfg.ssl.caPath ? readFileSync(cfg.ssl.caPath, 'utf8') : undefined }
  }
}

export async function openMysql(
  cfg: ConnectionConfig,
  secrets: ConnectionSecrets,
  endpoint: Endpoint
): Promise<DriverSession> {
  const options: mysql.ConnectionOptions = {
    host: endpoint.host,
    port: endpoint.port,
    user: cfg.user,
    password: secrets.password,
    database: cfg.database || undefined,
    ssl: sslOption(cfg),
    connectTimeout: 15000,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
    // Report rows matched, not rows changed, so re-saving an identical value still counts as 1.
    flags: ['FOUND_ROWS']
  }
  const conn = await mysql.createConnection(options)

  let database = cfg.database || ''
  const [versionRows] = await conn.query<mysql.RowDataPacket[]>('SELECT VERSION() AS v')
  const version = String(versionRows[0]?.v ?? '')

  return {
    serverVersion: `${/mariadb/i.test(version) ? 'MariaDB' : 'MySQL'} ${version}`,
    dialect: mysqlDialect,

    async listDatabases() {
      const [rows] = await conn.query<mysql.RowDataPacket[]>('SHOW DATABASES')
      return rows.map((r) => String(Object.values(r)[0]))
    },

    currentDatabase: () => database,

    async switchDatabase(name) {
      await conn.query(`USE ${mysqlDialect.quote(name)}`)
      database = name
    },

    async tree() {
      if (!database) return []
      const [rows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
        [database]
      )
      const [routines] = await conn.query<mysql.RowDataPacket[]>(
        'SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME',
        [database]
      )
      const children: TreeNode[] = rows.map((r) => ({
        kind: r.type === 'VIEW' || r.type === 'SYSTEM VIEW' ? 'view' : 'table',
        name: String(r.name),
        schema: database
      }))
      for (const r of routines) {
        children.push({ kind: r.type === 'PROCEDURE' ? 'procedure' : 'function', name: String(r.name), schema: database })
      }
      return [{ kind: 'schema', name: database, schema: database, children }]
    },

    async columns(schema, table) {
      const [rows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
                COLUMN_DEFAULT AS def, COLUMN_KEY AS col_key
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
        [schema, table]
      )
      return rows.map((r) => ({
        name: String(r.name),
        type: String(r.type),
        nullable: r.nullable === 'YES',
        defaultValue: r.def === null ? null : String(r.def),
        isPrimaryKey: r.col_key === 'PRI'
      }))
    },

    async fetchTable(req: TableRequest, opts) {
      const norm = opts?.fullBinary ? normalizeCellFull : normalizeCell
      const { sql, params } = buildSelect(mysqlDialect, req)
      const started = performance.now()
      const [rows, fields] = await conn.query<mysql.RowDataPacket[][]>({ sql, values: params, rowsAsArray: true })
      return {
        columns: fields.map((f) => ({ name: f.name, type: typeNames.get(f.columnType ?? f.type ?? -1) ?? 'unknown' })),
        rows: (rows as unknown as unknown[][]).map((row) => row.map((v) => norm(v))),
        durationMs: performance.now() - started,
        sql: displaySql(sql, params)
      }
    },

    async countTable(req) {
      const { sql, params } = buildCount(mysqlDialect, req)
      const [rows] = await conn.query<mysql.RowDataPacket[]>(sql, params)
      return Number(rows[0]?.n ?? 0)
    },

    async execute(statements, onStatement) {
      const affected: number[] = []
      await conn.beginTransaction()
      try {
        for (const [i, st] of statements.entries()) {
          const [res] = await conn.query<mysql.ResultSetHeader>(st.sql, st.params)
          checkAffected(st, i, res.affectedRows)
          affected.push(res.affectedRows)
          onStatement?.(i)
        }
        await conn.commit()
      } catch (err) {
        await conn.rollback().catch(() => {})
        throw err
      }
      return affected
    },

    async runStatement(sql) {
      const [result, fields] = await conn.query({ sql, rowsAsArray: true })
      if (!Array.isArray(result)) {
        const header = result as mysql.ResultSetHeader
        return { hasRows: false, columns: [], rows: [], affected: header.affectedRows, command: '', truncated: false }
      }
      // CALL returns several result sets plus a status header; show the first set.
      const nested = Array.isArray(fields) && Array.isArray(fields[0])
      const rowSet = (nested ? result[0] : result) as unknown[][]
      const fieldSet = (nested ? fields[0] : fields) as unknown as mysql.FieldPacket[] | undefined
      const { rows, truncated } = capRows(rowSet)
      return {
        hasRows: true,
        columns: (fieldSet ?? []).map((f) => ({
          name: f.name,
          type: typeNames.get(f.columnType ?? f.type ?? -1) ?? 'unknown'
        })),
        rows,
        affected: null,
        command: '',
        truncated
      }
    },

    async withReadOnly(fn) {
      await conn.query('START TRANSACTION READ ONLY')
      try {
        return await fn()
      } finally {
        await conn.query('ROLLBACK').catch(() => {})
      }
    },

    canCancel: true,

    async cancel() {
      const side = await mysql.createConnection({ ...options, database: undefined })
      try {
        await side.query(`KILL QUERY ${Number(conn.threadId)}`)
      } finally {
        await side.end().catch(() => {})
      }
    },

    async completions() {
      if (!database) return []
      const [rows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT c.TABLE_SCHEMA AS s, c.TABLE_NAME AS n, t.TABLE_TYPE AS k, c.COLUMN_NAME AS c, c.DATA_TYPE AS t
         FROM information_schema.COLUMNS c
         JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
         WHERE c.TABLE_SCHEMA = ?
         ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
        [database]
      )
      return groupCompletions(
        rows.map((r) => ({ schema: String(r.s), name: String(r.n), kind: String(r.k), column: String(r.c), type: String(r.t) }))
      )
    },

    async structure(schema, table) {
      const q = async (sql: string) => (await conn.query<mysql.RowDataPacket[]>(sql, [schema, table]))[0]
      const [info] = await q('SELECT TABLE_TYPE AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?')
      if (!info) throw new Error(`${schema}.${table} no longer exists.`)
      const isView = String(info.t).includes('VIEW')

      const NUMERIC = /int|decimal|numeric|float|double|real|bit|year/i
      const cols = await q(
        `SELECT COLUMN_NAME AS n, COLUMN_TYPE AS t, IS_NULLABLE AS nl, COLUMN_DEFAULT AS d, COLUMN_KEY AS k,
                EXTRA AS e, COLUMN_COMMENT AS c, DATA_TYPE AS dt
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`
      )
      const columns: ColumnDef[] = cols.map((r) => {
        const raw = r.d === null ? null : String(r.d)
        // information_schema gives literal defaults unquoted; turn them back into SQL expressions.
        const expr =
          raw === null
            ? null
            : /DEFAULT_GENERATED/i.test(String(r.e)) || /^(CURRENT_TIMESTAMP|NULL)\b/i.test(raw) || NUMERIC.test(String(r.dt))
              ? raw
              : `'${raw.replace(/'/g, "''")}'`
        return {
          name: String(r.n),
          type: String(r.t),
          nullable: r.nl === 'YES',
          defaultValue: expr,
          isPrimaryKey: r.k === 'PRI',
          autoIncrement: /auto_increment/i.test(String(r.e)),
          comment: r.c ? String(r.c) : null
        }
      })

      const idxRows = await q(
        `SELECT INDEX_NAME AS n, NON_UNIQUE AS nu, COLUMN_NAME AS c, INDEX_TYPE AS m
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX`
      )
      const indexMap = new Map<string, { name: string; columns: string[]; unique: boolean; primary: boolean; method: string | null; definition: null }>()
      for (const r of idxRows) {
        const name = String(r.n)
        const entry = indexMap.get(name) ?? { name, columns: [], unique: Number(r.nu) === 0, primary: name === 'PRIMARY', method: r.m ? String(r.m) : null, definition: null }
        if (r.c !== null) entry.columns.push(String(r.c))
        indexMap.set(name, entry)
      }

      const fkRows = await q(
        `SELECT k.CONSTRAINT_NAME AS n, k.COLUMN_NAME AS c, k.REFERENCED_TABLE_SCHEMA AS rs,
                k.REFERENCED_TABLE_NAME AS rt, k.REFERENCED_COLUMN_NAME AS rc, r.UPDATE_RULE AS u, r.DELETE_RULE AS dl
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
         WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
         ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`
      )
      const fkMap = new Map<string, { name: string; columns: string[]; refSchema: string; refTable: string; refColumns: string[]; onUpdate: FkAction; onDelete: FkAction }>()
      for (const r of fkRows) {
        const name = String(r.n)
        const entry = fkMap.get(name) ?? { name, columns: [], refSchema: String(r.rs), refTable: String(r.rt), refColumns: [], onUpdate: r.u as FkAction, onDelete: r.dl as FkAction }
        entry.columns.push(String(r.c))
        entry.refColumns.push(String(r.rc))
        fkMap.set(name, entry)
      }

      const trgRows = await q(
        `SELECT TRIGGER_NAME AS n, ACTION_TIMING AS t, EVENT_MANIPULATION AS e, ACTION_STATEMENT AS s
         FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? ORDER BY TRIGGER_NAME`
      )
      const triggers = trgRows.map((r) => ({
        name: String(r.n),
        timing: String(r.t),
        events: String(r.e),
        definition: `CREATE TRIGGER ${mysqlDialect.quote(String(r.n))} ${r.t} ${r.e} ON ${mysqlDialect.quote(table)} FOR EACH ROW ${r.s}`
      }))

      const [createRows] = await conn.query<mysql.RowDataPacket[]>(`SHOW CREATE TABLE ${tableRef(mysqlDialect, schema, table)}`)
      const create = String(createRows[0]?.['Create Table'] ?? createRows[0]?.['Create View'] ?? '')
      const ddl = [create, ...triggers.map((t) => t.definition)].map((s) => `${s};`).join('\n\n')

      return {
        schema,
        name: table,
        kind: isView ? 'view' : 'table',
        columns,
        indexes: [...indexMap.values()],
        foreignKeys: [...fkMap.values()],
        triggers,
        ddl
      }
    },

    async routineDefinition(node) {
      const type = node.kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION'
      const [rows] = await conn.query<mysql.RowDataPacket[]>(`SHOW CREATE ${type} ${tableRef(mysqlDialect, node.schema, node.name)}`)
      const def = rows[0]?.[node.kind === 'procedure' ? 'Create Procedure' : 'Create Function']
      if (!def) throw new Error(`You don't have permission to read the definition of ${node.name}.`)
      return String(def)
    },

    async users() {
      const [rows] = await conn.query<mysql.RowDataPacket[]>(
        'SELECT User AS u, Host AS h, Super_priv AS s, account_locked AS l, password_expired AS p FROM mysql.user ORDER BY User, Host'
      )
      let edges: mysql.RowDataPacket[] = []
      try {
        ;[edges] = await conn.query<mysql.RowDataPacket[]>('SELECT FROM_USER AS fu, FROM_HOST AS fh, TO_USER AS tu, TO_HOST AS th FROM mysql.role_edges')
      } catch {
        // Older servers have no roles table.
      }
      return rows.map((r) => ({
        name: String(r.u),
        host: String(r.h),
        attributes: [r.s === 'Y' && 'superuser', r.l === 'Y' && 'locked', r.p === 'Y' && 'password expired'].filter(Boolean) as string[],
        memberOf: edges.filter((e) => e.tu === r.u && e.th === r.h).map((e) => `${e.fu}@${e.fh}`)
      }))
    },

    async processes() {
      const [rows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT ID AS id, USER AS u, HOST AS h, DB AS db, COMMAND AS cmd, TIME AS t, STATE AS st, INFO AS info,
                ID = CONNECTION_ID() AS self
         FROM information_schema.PROCESSLIST ORDER BY TIME DESC`
      )
      return rows.map((r) => ({
        id: String(r.id),
        user: r.u === null ? null : String(r.u),
        database: r.db === null ? null : String(r.db),
        client: r.h === null ? null : String(r.h),
        state: [r.cmd, r.st].filter(Boolean).join(': ') || null,
        seconds: r.t === null ? null : Number(r.t),
        query: r.info === null ? null : String(r.info),
        self: Number(r.self) === 1
      }))
    },

    async kill(id, mode) {
      if (!/^\d+$/.test(id)) throw new Error('Invalid process id.')
      await conn.query(`${mode === 'cancel' ? 'KILL QUERY' : 'KILL'} ${id}`)
    },

    async close() {
      await conn.end().catch(() => {})
    }
  }
}
