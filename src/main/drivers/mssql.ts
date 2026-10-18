import sql from 'mssql'
import { readFileSync } from 'node:fs'
import type { ColumnDef, ConnectionConfig, ConnectionSecrets, FkAction, TableRequest, TreeNode } from '@shared/types'
import { checkAffected, type DriverSession, type Endpoint, type RawStatementResult } from './types'
import { buildCount, buildSelect, capRows, displaySql, mssqlDialect, normalizeCell, normalizeCellFull } from './sql'
import { schemaChangeSql } from './ddl'
import { groupCompletions } from './postgres'

const q = mssqlDialect.quote

/** SQL Server stores defaults wrapped in parentheses: ((0)) or (getdate()). Peel balanced outer pairs. */
export function stripParens(expr: string | null): string | null {
  if (expr === null) return null
  let s = expr.trim()
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0
    let balanced = true
    for (let i = 0; i < s.length - 1; i++) {
      if (s[i] === '(') depth++
      else if (s[i] === ')') depth--
      if (depth === 0) {
        balanced = false
        break
      }
    }
    if (!balanced) break
    s = s.slice(1, -1).trim()
  }
  return s
}

function encryption(cfg: ConnectionConfig) {
  switch (cfg.ssl.mode) {
    case 'disable':
      return { encrypt: false, trustServerCertificate: true }
    case 'prefer':
    case 'require':
      return { encrypt: true, trustServerCertificate: true }
    case 'verify-full':
      return {
        encrypt: true,
        trustServerCertificate: false,
        ...(cfg.ssl.caPath ? { cryptoCredentialsDetails: { ca: readFileSync(cfg.ssl.caPath, 'utf8') } } : {})
      }
  }
}

const typeName = (col: { type?: { declaration?: string } }) => col.type?.declaration ?? 'unknown'

export async function openMssql(cfg: ConnectionConfig, secrets: ConnectionSecrets, endpoint: Endpoint): Promise<DriverSession> {
  let database = cfg.database || ''

  const connect = async (db: string) => {
    const pool = new sql.ConnectionPool({
      server: endpoint.host,
      port: cfg.options?.instance ? undefined : endpoint.port,
      user: cfg.user,
      password: secrets.password,
      database: db || undefined,
      connectionTimeout: 15000,
      requestTimeout: 0,
      // One connection, so USE, SET SHOWPLAN and transactions all stay on the same session.
      pool: { max: 1, min: 1, idleTimeoutMillis: 2_147_483_647 },
      options: { ...encryption(cfg), instanceName: cfg.options?.instance || undefined, useUTC: true, appName: 'DevPlus' }
    })
    await pool.connect()
    return pool
  }

  let pool = await connect(database)
  // Requests run one after another; multi-request sequences (explain, read-only) can't interleave.
  let lock: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = lock.then(fn, fn)
    lock = next.catch(() => {})
    return next
  }
  let running: sql.Request | null = null

  const query = async (text: string, params: unknown[] = [], arrayRows = false) => {
    const req = pool.request()
    req.arrayRowMode = arrayRows
    params.forEach((p, i) => req.input(`p${i + 1}`, p))
    running = req
    try {
      return await req.query(text)
    } finally {
      running = null
    }
  }

  const version = String((await query("SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(50)) AS v, @@VERSION AS full_v")).recordset[0].full_v)
  if (!database) database = String((await query('SELECT DB_NAME() AS d')).recordset[0].d)

  const objectName = (schema: string, table: string) => `${q(schema)}.${q(table)}`

  const columnsOf = async (schema: string, table: string): Promise<(ColumnDef & { ident: boolean })[]> => {
    const res = await query(
      `SELECT c.name,
              TYPE_NAME(c.user_type_id) +
                CASE
                  WHEN TYPE_NAME(c.user_type_id) IN ('varchar','char','varbinary','binary') THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length AS varchar(10)) END + ')'
                  WHEN TYPE_NAME(c.user_type_id) IN ('nvarchar','nchar') THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length / 2 AS varchar(10)) END + ')'
                  WHEN TYPE_NAME(c.user_type_id) IN ('decimal','numeric') THEN '(' + CAST(c.precision AS varchar(10)) + ',' + CAST(c.scale AS varchar(10)) + ')'
                  ELSE ''
                END AS type,
              c.is_nullable AS nullable,
              OBJECT_DEFINITION(c.default_object_id) AS def,
              c.is_identity AS ident,
              CASE WHEN EXISTS (
                SELECT 1 FROM sys.index_columns ic JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id) THEN 1 ELSE 0 END AS pk
       FROM sys.columns c WHERE c.object_id = OBJECT_ID(@p1) ORDER BY c.column_id`,
      [objectName(schema, table)]
    )
    return res.recordset.map((r) => ({
      name: r.name,
      type: r.type,
      nullable: Boolean(r.nullable),
      defaultValue: stripParens(r.def),
      isPrimaryKey: r.pk === 1,
      autoIncrement: Boolean(r.ident),
      ident: Boolean(r.ident),
      comment: null
    }))
  }

  const toRaw = (rows: unknown[][], columns: { name: string; type?: { declaration?: string } }[], full = false): RawStatementResult => {
    const { rows: capped, truncated } = capRows(full ? rows.map((r) => r.map(normalizeCellFull)) : rows)
    return { hasRows: true, columns: columns.map((c) => ({ name: c.name, type: typeName(c) })), rows: capped, affected: null, command: '', truncated }
  }

  return {
    serverVersion: version.split('\n')[0].replace(/\s+\(.*$/, ''),
    dialect: mssqlDialect,

    listDatabases: () => serial(async () => (await query('SELECT name FROM sys.databases WHERE state = 0 ORDER BY name')).recordset.map((r) => r.name)),

    currentDatabase: () => database,

    switchDatabase: (name) =>
      serial(async () => {
        // Reconnect rather than USE, so every pooled request starts in the right database.
        const next = await connect(name)
        await pool.close().catch(() => {})
        pool = next
        database = name
      }),

    tree: () =>
      serial(async () => {
        const objs = await query(
          `SELECT s.name AS [schema], o.name, RTRIM(o.type) AS type, o.object_id AS id
           FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
           WHERE o.type IN ('U','V','P','FN','IF','TF') AND o.is_ms_shipped = 0
           ORDER BY o.name`
        )
        const schemas = new Map<string, TreeNode>([['dbo', { kind: 'schema', name: 'dbo', schema: 'dbo', children: [] }]])
        for (const r of objs.recordset) {
          if (!schemas.has(r.schema)) schemas.set(r.schema, { kind: 'schema', name: r.schema, schema: r.schema, children: [] })
          const kind = r.type === 'U' ? 'table' : r.type === 'V' ? 'view' : r.type === 'P' ? 'procedure' : 'function'
          schemas.get(r.schema)!.children!.push({ kind, name: r.name, schema: r.schema, ...(kind === 'function' || kind === 'procedure' ? { id: String(r.id) } : {}) })
        }
        return [...schemas.values()]
      }),

    columns: (schema, table) => serial(async () => (await columnsOf(schema, table)).map(({ ident: _, ...c }) => c)),

    fetchTable: (req: TableRequest, opts) =>
      serial(async () => {
        const { sql: text, params } = buildSelect(mssqlDialect, req)
        const started = performance.now()
        const res = await query(text, params, true)
        const cols = ((res as unknown as { columns: { name: string; type?: { declaration?: string } }[][] }).columns?.[0] ?? [])
        const norm = opts?.fullBinary ? normalizeCellFull : normalizeCell
        return {
          columns: cols.map((c) => ({ name: c.name, type: typeName(c) })),
          rows: (res.recordset as unknown as unknown[][]).map((row) => row.map((v) => norm(v))),
          durationMs: performance.now() - started,
          sql: displaySql(text, params)
        }
      }),

    countTable: (req) =>
      serial(async () => {
        const { sql: text, params } = buildCount(mssqlDialect, req)
        return Number((await query(text, params)).recordset[0].n)
      }),

    execute: (statements, onStatement) =>
      serial(async () => {
        const tx = new sql.Transaction(pool)
        await tx.begin()
        const affected: number[] = []
        try {
          for (const [i, st] of statements.entries()) {
            const req = new sql.Request(tx)
            st.params.forEach((p, j) => req.input(`p${j + 1}`, p))
            const res = await req.query(st.sql)
            const n = res.rowsAffected.reduce((a, b) => a + b, 0)
            checkAffected(st, i, n)
            affected.push(n)
            onStatement?.(i)
          }
          await tx.commit()
        } catch (err) {
          await tx.rollback().catch(() => {})
          throw err
        }
        return affected
      }),

    runStatement: (text) =>
      serial(async () => {
        const res = await query(text, [], true)
        const sets = (res.recordsets as unknown as unknown[][][]) ?? []
        const columns = (res as unknown as { columns?: { name: string; type?: { declaration?: string } }[][] }).columns ?? []
        if (sets.length === 0) {
          return { hasRows: false, columns: [], rows: [], affected: res.rowsAffected.reduce((a, b) => a + b, 0), command: '', truncated: false }
        }
        return sets.map((rows, i) => toRaw(rows, columns[i] ?? []))
      }),

    async withReadOnly(fn) {
      // SQL Server has no read-only transactions; roll back whatever slipped past the client-side check.
      // The statements inside queue normally, so only begin and rollback take the lock.
      await serial(() => query('BEGIN TRANSACTION'))
      try {
        return await fn()
      } finally {
        await serial(() => query('IF @@TRANCOUNT > 0 ROLLBACK')).catch(() => {})
      }
    },

    canCancel: true,

    async cancel() {
      running?.cancel()
    },

    completions: () =>
      serial(async () => {
        const res = await query(
          `SELECT c.TABLE_SCHEMA AS [schema], c.TABLE_NAME AS name, t.TABLE_TYPE AS kind, c.COLUMN_NAME AS [column], c.DATA_TYPE AS type
           FROM INFORMATION_SCHEMA.COLUMNS c
           JOIN INFORMATION_SCHEMA.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
           ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`
        )
        return groupCompletions(res.recordset)
      }),

    structure: (schema, table) =>
      serial(async () => {
        const obj = await query(`SELECT RTRIM(type) AS type, OBJECT_DEFINITION(OBJECT_ID(@p1)) AS def FROM sys.objects WHERE object_id = OBJECT_ID(@p1)`, [objectName(schema, table)])
        if (!obj.recordset[0]) throw new Error(`${schema}.${table} no longer exists.`)
        const isView = obj.recordset[0].type === 'V'
        const cols = await columnsOf(schema, table)
        const columns = cols.map(({ ident: _, ...c }) => c)

        const idx = await query(
          `SELECT i.name, i.is_unique, i.is_primary_key, i.type_desc,
                  STUFF((SELECT ', ' + c.name FROM sys.index_columns ic JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                         WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
                         ORDER BY ic.key_ordinal FOR XML PATH('')), 1, 2, '') AS cols
           FROM sys.indexes i WHERE i.object_id = OBJECT_ID(@p1) AND i.name IS NOT NULL
           ORDER BY i.is_primary_key DESC, i.name`,
          [objectName(schema, table)]
        )
        const indexes = idx.recordset.map((r) => ({
          name: r.name,
          columns: String(r.cols ?? '').split(', ').filter(Boolean),
          unique: Boolean(r.is_unique),
          primary: Boolean(r.is_primary_key),
          method: String(r.type_desc).toLowerCase(),
          definition: r.is_primary_key
            ? null
            : `CREATE ${r.is_unique ? 'UNIQUE ' : ''}${String(r.type_desc).includes('NONCLUSTERED') ? '' : 'CLUSTERED '}INDEX ${q(r.name)} ON ${objectName(schema, table)} (${String(r.cols ?? '')
                .split(', ')
                .filter(Boolean)
                .map(q)
                .join(', ')})`
        }))

        const ACTIONS: Record<string, FkAction> = { NO_ACTION: 'NO ACTION', CASCADE: 'CASCADE', SET_NULL: 'SET NULL', SET_DEFAULT: 'SET DEFAULT' }
        const fk = await query(
          `SELECT f.name, rs.name AS ref_schema, rt.name AS ref_table, f.update_referential_action_desc AS upd, f.delete_referential_action_desc AS del,
                  pc.name AS col, rc.name AS ref_col
           FROM sys.foreign_keys f
           JOIN sys.foreign_key_columns fc ON fc.constraint_object_id = f.object_id
           JOIN sys.columns pc ON pc.object_id = fc.parent_object_id AND pc.column_id = fc.parent_column_id
           JOIN sys.columns rc ON rc.object_id = fc.referenced_object_id AND rc.column_id = fc.referenced_column_id
           JOIN sys.tables rt ON rt.object_id = f.referenced_object_id
           JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
           WHERE f.parent_object_id = OBJECT_ID(@p1)
           ORDER BY f.name, fc.constraint_column_id`,
          [objectName(schema, table)]
        )
        const fkMap = new Map<string, { name: string; columns: string[]; refSchema: string; refTable: string; refColumns: string[]; onUpdate: FkAction; onDelete: FkAction }>()
        for (const r of fk.recordset) {
          const e = fkMap.get(r.name) ?? { name: String(r.name), columns: [] as string[], refSchema: String(r.ref_schema), refTable: String(r.ref_table), refColumns: [] as string[], onUpdate: ACTIONS[r.upd] ?? 'NO ACTION', onDelete: ACTIONS[r.del] ?? 'NO ACTION' }
          e.columns.push(r.col)
          e.refColumns.push(r.ref_col)
          fkMap.set(r.name, e)
        }
        const foreignKeys = [...fkMap.values()]

        const trg = await query(
          `SELECT t.name, OBJECT_DEFINITION(t.object_id) AS def, t.is_instead_of_trigger AS instead,
                  STUFF((SELECT ', ' + e.type_desc FROM sys.trigger_events e WHERE e.object_id = t.object_id FOR XML PATH('')), 1, 2, '') AS events
           FROM sys.triggers t WHERE t.parent_id = OBJECT_ID(@p1) ORDER BY t.name`,
          [objectName(schema, table)]
        )
        const triggers = trg.recordset.map((r) => ({ name: r.name, timing: r.instead ? 'INSTEAD OF' : 'AFTER', events: String(r.events ?? ''), definition: String(r.def ?? '') }))

        const ddl = isView
          ? String(obj.recordset[0].def ?? '')
          : [
              ...schemaChangeSql('mssql', { schema, table, ops: [{ op: 'createTable', columns: cols.map(({ ident, ...c }) => ({ ...c, autoIncrement: ident })), foreignKeys }] }),
              ...indexes.filter((i) => i.definition).map((i) => i.definition!)
            ]
              .map((s) => `${s};`)
              .concat(triggers.map((t) => `${t.definition}\nGO`))
              .join('\n\n')
        return { schema, name: table, kind: isView ? 'view' : 'table', columns, indexes, foreignKeys, triggers, ddl }
      }),

    explain: (statement) =>
      serial(async () => {
        // SHOWPLAN must be alone in its batch, so it takes three requests on the one connection.
        await query('SET SHOWPLAN_TEXT ON')
        try {
          const res = await query(statement, [], true)
          const sets = (res.recordsets as unknown as unknown[][][]) ?? []
          const columns = (res as unknown as { columns?: { name: string }[][] }).columns ?? []
          const lines = sets.slice(1).flatMap((rows) => rows.map((r) => [r[0]]))
          return toRaw(lines.length ? lines : (sets[0] ?? []), lines.length ? [{ name: 'StmtText' }] : (columns[0] ?? []))
        } finally {
          await query('SET SHOWPLAN_TEXT OFF').catch(() => {})
        }
      }),

    routineDefinition: (node) =>
      serial(async () => {
        const res = await query('SELECT OBJECT_DEFINITION(OBJECT_ID(@p1)) AS def', [objectName(node.schema, node.name)])
        const def = res.recordset[0]?.def
        if (!def) throw new Error(`You don't have permission to read the definition of ${node.name}.`)
        return String(def)
      }),

    users: () =>
      serial(async () => {
        const res = await query(
          `SELECT p.name, p.type_desc, p.is_disabled,
                  STUFF((SELECT ', ' + r.name FROM sys.server_role_members m JOIN sys.server_principals r ON r.principal_id = m.role_principal_id
                         WHERE m.member_principal_id = p.principal_id FOR XML PATH('')), 1, 2, '') AS roles
           FROM sys.server_principals p
           WHERE p.type IN ('S','U','G','E','X') AND p.name NOT LIKE '##%' ORDER BY p.name`
        )
        return res.recordset.map((r) => ({
          name: r.name,
          host: null,
          attributes: [String(r.type_desc).toLowerCase().replace(/_/g, ' '), r.is_disabled ? 'disabled' : ''].filter(Boolean),
          memberOf: String(r.roles ?? '').split(', ').filter(Boolean)
        }))
      }),

    processes: () =>
      serial(async () => {
        const res = await query(
          `SELECT s.session_id AS id, s.login_name AS [user], DB_NAME(s.database_id) AS db, s.host_name AS client,
                  COALESCE(r.status, s.status) AS state,
                  DATEDIFF(MILLISECOND, COALESCE(r.start_time, s.last_request_start_time), SYSDATETIME()) / 1000.0 AS secs,
                  t.text AS query, CASE WHEN s.session_id = @@SPID THEN 1 ELSE 0 END AS self
           FROM sys.dm_exec_sessions s
           LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
           OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
           WHERE s.is_user_process = 1
           ORDER BY secs DESC`
        )
        return res.recordset.map((r) => ({
          id: String(r.id),
          user: r.user,
          database: r.db,
          client: r.client,
          state: r.state,
          seconds: r.secs === null ? null : Number(r.secs),
          query: r.query,
          self: r.self === 1
        }))
      }),

    kill: (id) =>
      serial(async () => {
        if (!/^\d+$/.test(id)) throw new Error('Invalid session id.')
        // SQL Server has no "cancel query only"; KILL ends the session and rolls back its work.
        await query(`KILL ${id}`)
      }),

    async close() {
      await pool.close().catch(() => {})
    }
  }
}

