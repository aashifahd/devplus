import { readFileSync } from 'node:fs'
import pg from 'pg'
import type { ColumnDef, CompletionTable, ConnectionConfig, ConnectionSecrets, FkAction, TableRequest, TreeNode } from '@shared/types'
import { checkAffected, parseTriggerHeader, type DriverSession, type Endpoint } from './types'
import { schemaChangeSql } from './ddl'
import { buildCount, buildSelect, capRows, displaySql, normalizeCell, normalizeCellFull, pgDialect, tableRef } from './sql'

// Keep date/time values exactly as the server sent them; JS Dates would shift time zones.
for (const oid of [1082, 1083, 1114, 1184, 1266]) pg.types.setTypeParser(oid, (v: string) => v)
// Keep json/jsonb as the server's text so it can be edited and matched verbatim.
for (const oid of [114, 3802]) pg.types.setTypeParser(oid, (v: string) => v)

type SslOption = pg.ClientConfig['ssl']

function sslOptions(cfg: ConnectionConfig): SslOption[] {
  switch (cfg.ssl.mode) {
    case 'disable':
      return [false]
    case 'prefer':
      return [{ rejectUnauthorized: false }, false]
    case 'require':
      return [{ rejectUnauthorized: false }]
    case 'verify-full':
      return [{ rejectUnauthorized: true, ca: cfg.ssl.caPath ? readFileSync(cfg.ssl.caPath, 'utf8') : undefined }]
  }
}

async function connectClient(
  cfg: ConnectionConfig,
  secrets: ConnectionSecrets,
  endpoint: Endpoint,
  database: string
): Promise<pg.Client> {
  const attempts = sslOptions(cfg)
  let lastError: unknown
  for (const ssl of attempts) {
    const client = new pg.Client({
      host: endpoint.host,
      port: endpoint.port,
      user: cfg.user,
      password: secrets.password,
      database: database || 'postgres',
      ssl,
      connectionTimeoutMillis: 15000,
      application_name: 'DevPlus'
    })
    try {
      await client.connect()
      return client
    } catch (err) {
      lastError = err
      await client.end().catch(() => {})
    }
  }
  throw lastError
}

export async function openPostgres(
  cfg: ConnectionConfig,
  secrets: ConnectionSecrets,
  endpoint: Endpoint
): Promise<DriverSession> {
  let database = cfg.database || 'postgres'
  let client = await connectClient(cfg, secrets, endpoint, database)
  let typeNames = new Map<number, string>()

  const loadTypes = async () => {
    const res = await client.query<{ oid: number; name: string }>('SELECT oid::int AS oid, typname AS name FROM pg_type')
    typeNames = new Map(res.rows.map((r) => [r.oid, r.name]))
  }

  const version = (await client.query<{ v: string }>("SELECT current_setting('server_version') AS v")).rows[0]?.v ?? ''
  await loadTypes()

  return {
    serverVersion: `PostgreSQL ${version}`,
    dialect: pgDialect,

    async listDatabases() {
      const res = await client.query<{ datname: string }>(
        'SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY 1'
      )
      return res.rows.map((r) => r.datname)
    },

    currentDatabase: () => database,

    async switchDatabase(name) {
      // Postgres binds a connection to one database, so reconnect.
      const next = await connectClient(cfg, secrets, endpoint, name)
      await client.end().catch(() => {})
      client = next
      database = name
      await loadTypes()
    },

    async tree() {
      const schemas = await client.query<{ name: string }>(
        `SELECT nspname AS name FROM pg_namespace
         WHERE nspname NOT IN ('pg_catalog', 'information_schema')
           AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%'
         ORDER BY nspname = 'public' DESC, nspname`
      )
      const rels = await client.query<{ schema: string; name: string; relkind: string }>(
        `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS relkind
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
           AND n.nspname NOT IN ('pg_catalog', 'information_schema')
           AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
           AND NOT c.relispartition
         ORDER BY c.relname`
      )
      const bySchema = new Map<string, TreeNode>(
        schemas.rows.map((s) => [s.name, { kind: 'schema', name: s.name, schema: s.name, children: [] }])
      )
      for (const r of rels.rows) {
        bySchema.get(r.schema)?.children!.push({
          kind: r.relkind === 'v' || r.relkind === 'm' ? 'view' : 'table',
          name: r.name,
          schema: r.schema
        })
      }
      // User-defined functions and procedures; ones owned by extensions are noise here.
      const routines = await client.query<{ schema: string; name: string; id: string; args: string; kind: string }>(
        `SELECT n.nspname AS schema, p.proname AS name, p.oid::text AS id,
                pg_get_function_identity_arguments(p.oid) AS args, p.prokind::text AS kind
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
           AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
           AND p.prokind IN ('f', 'p')
           AND NOT EXISTS (SELECT 1 FROM pg_depend d
                           WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
         ORDER BY p.proname`
      )
      for (const r of routines.rows) {
        bySchema.get(r.schema)?.children!.push({
          kind: r.kind === 'p' ? 'procedure' : 'function',
          name: r.name,
          schema: r.schema,
          id: r.id,
          detail: r.args
        })
      }
      return [...bySchema.values()]
    },

    async columns(schema, table) {
      const res = await client.query(
        `SELECT a.attname AS name,
                format_type(a.atttypid, a.atttypmod) AS type,
                NOT a.attnotnull AS nullable,
                pg_get_expr(d.adbin, d.adrelid) AS default_value,
                COALESCE((SELECT true FROM pg_index i
                          WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)), false) AS is_pk
         FROM pg_attribute a
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE a.attrelid = (quote_ident($1) || '.' || quote_ident($2))::regclass
           AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attnum`,
        [schema, table]
      )
      return res.rows.map((r) => ({
        name: r.name,
        type: r.type,
        nullable: r.nullable,
        defaultValue: r.default_value,
        isPrimaryKey: r.is_pk
      }))
    },

    async fetchTable(req: TableRequest, opts) {
      const norm = opts?.fullBinary ? normalizeCellFull : normalizeCell
      const { sql, params } = buildSelect(pgDialect, req)
      const started = performance.now()
      const res = await client.query({ text: sql, values: params, rowMode: 'array' })
      return {
        columns: res.fields.map((f) => ({ name: f.name, type: typeNames.get(f.dataTypeID) ?? String(f.dataTypeID) })),
        rows: (res.rows as unknown[][]).map((row) => row.map((v) => norm(v))),
        durationMs: performance.now() - started,
        sql: displaySql(sql, params)
      }
    },

    async countTable(req) {
      const { sql, params } = buildCount(pgDialect, req)
      const res = await client.query<{ n: string }>(sql, params)
      return Number(res.rows[0]?.n ?? 0)
    },

    async execute(statements, onStatement) {
      const affected: number[] = []
      await client.query('BEGIN')
      try {
        for (const [i, st] of statements.entries()) {
          const res = await client.query(st.sql, st.params)
          checkAffected(st, i, res.rowCount ?? 0)
          affected.push(res.rowCount ?? 0)
          onStatement?.(i)
        }
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      }
      return affected
    },

    async runStatement(sql) {
      const res = await client.query({ text: sql, rowMode: 'array' })
      const hasRows = Array.isArray(res.fields) && res.fields.length > 0
      const { rows, truncated } = capRows(hasRows ? (res.rows as unknown[][]) : [])
      return {
        hasRows,
        columns: hasRows
          ? res.fields.map((f) => ({ name: f.name, type: typeNames.get(f.dataTypeID) ?? String(f.dataTypeID) }))
          : [],
        rows,
        affected: hasRows || res.rowCount === null ? null : res.rowCount,
        command: res.command ?? '',
        truncated
      }
    },

    async withReadOnly(fn) {
      await client.query('BEGIN READ ONLY')
      try {
        return await fn()
      } finally {
        await client.query('ROLLBACK').catch(() => {})
      }
    },

    canCancel: true,

    async cancel() {
      // The running connection is busy, so ask from a short-lived second one.
      const pid = (client as unknown as { processID: number | null }).processID
      if (!pid) return
      const side = await connectClient(cfg, secrets, endpoint, database)
      try {
        await side.query('SELECT pg_cancel_backend($1)', [pid])
      } finally {
        await side.end().catch(() => {})
      }
    },

    async completions() {
      const res = await client.query<CompletionRow>(
        `SELECT c.table_schema AS schema, c.table_name AS name, t.table_type AS kind,
                c.column_name AS column, c.data_type AS type
         FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
         WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
         ORDER BY c.table_schema, c.table_name, c.ordinal_position`
      )
      return groupCompletions(res.rows)
    },

    async structure(schema, table) {
      const rel = await client.query<{ kind: string; oid: number }>(
        `SELECT c.relkind::text AS kind, c.oid::int AS oid FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`,
        [schema, table]
      )
      if (!rel.rows[0]) throw new Error(`${schema}.${table} no longer exists.`)
      const { kind: relkind, oid } = rel.rows[0]
      const isView = relkind === 'v' || relkind === 'm'
      const ref = tableRef(pgDialect, schema, table)

      const cols = await client.query(
        `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
                pg_get_expr(d.adbin, d.adrelid) AS default_value, a.attidentity <> '' AS identity,
                col_description(a.attrelid, a.attnum) AS comment,
                COALESCE((SELECT true FROM pg_index i
                          WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)), false) AS is_pk
         FROM pg_attribute a
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attnum`,
        [oid]
      )
      const columns: ColumnDef[] = cols.rows.map((r) => ({
        name: r.name,
        type: r.type,
        nullable: r.nullable,
        defaultValue: r.default_value,
        isPrimaryKey: r.is_pk,
        autoIncrement: r.identity || /^nextval\(/.test(r.default_value ?? ''),
        comment: r.comment
      }))

      const idx = await client.query(
        `SELECT i.relname AS name, ix.indisunique AS is_unique, ix.indisprimary AS is_primary, am.amname AS method,
                pg_get_indexdef(ix.indexrelid) AS definition,
                (SELECT json_agg(a.attname ORDER BY k.ord)
                 FROM unnest(ix.indkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum) AS columns
         FROM pg_index ix
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_am am ON am.oid = i.relam
         WHERE ix.indrelid = $1
         ORDER BY ix.indisprimary DESC, i.relname`,
        [oid]
      )
      const indexes = idx.rows.map((r) => ({
        name: r.name,
        columns: JSON.parse(r.columns ?? '[]') as string[],
        unique: r.is_unique,
        primary: r.is_primary,
        method: r.method,
        definition: r.definition
      }))

      const ACTIONS: Record<string, FkAction> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' }
      const fk = await client.query(
        `SELECT c.conname AS name, rn.nspname AS ref_schema, rc.relname AS ref_table,
                c.confupdtype::text AS on_update, c.confdeltype::text AS on_delete,
                (SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns,
                (SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS ref_columns
         FROM pg_constraint c
         JOIN pg_class rc ON rc.oid = c.confrelid
         JOIN pg_namespace rn ON rn.oid = rc.relnamespace
         WHERE c.contype = 'f' AND c.conrelid = $1
         ORDER BY c.conname`,
        [oid]
      )
      const foreignKeys = fk.rows.map((r) => ({
        name: r.name,
        columns: JSON.parse(r.columns ?? '[]') as string[],
        refSchema: r.ref_schema,
        refTable: r.ref_table,
        refColumns: JSON.parse(r.ref_columns ?? '[]') as string[],
        onUpdate: ACTIONS[r.on_update] ?? 'NO ACTION',
        onDelete: ACTIONS[r.on_delete] ?? 'NO ACTION'
      }))

      const trg = await client.query<{ name: string; definition: string }>(
        `SELECT t.tgname AS name, pg_get_triggerdef(t.oid, true) AS definition
         FROM pg_trigger t WHERE t.tgrelid = $1 AND NOT t.tgisinternal ORDER BY t.tgname`,
        [oid]
      )
      const triggers = trg.rows.map((r) => ({ name: r.name, definition: r.definition, ...parseTriggerHeader(r.definition) }))

      let ddl: string
      if (isView) {
        const def = await client.query<{ def: string }>('SELECT pg_get_viewdef($1::oid, true) AS def', [oid])
        const verb = relkind === 'm' ? 'CREATE MATERIALIZED VIEW' : 'CREATE OR REPLACE VIEW'
        ddl = `${verb} ${ref} AS\n${def.rows[0]?.def ?? ''}`
      } else {
        // Postgres has no SHOW CREATE TABLE, so rebuild one from the catalog.
        const forDdl = cols.rows.map((r, i) => ({ ...columns[i], autoIncrement: Boolean(r.identity) }))
        const create = schemaChangeSql('postgres', {
          schema,
          table,
          ops: [{ op: 'createTable', columns: forDdl, foreignKeys }]
        })
        const extras = indexes.filter((i) => !i.primary).map((i) => i.definition)
        const comments = columns
          .filter((c) => c.comment)
          .map((c) => `COMMENT ON COLUMN ${ref}.${pgDialect.quote(c.name)} IS '${c.comment!.replace(/'/g, "''")}'`)
        ddl = [...create, ...extras, ...comments, ...triggers.map((t) => t.definition)].map((s) => `${s};`).join('\n\n')
      }
      return { schema, name: table, kind: isView ? 'view' : 'table', columns, indexes, foreignKeys, triggers, ddl }
    },

    async routineDefinition(node) {
      const res = await client.query<{ def: string }>('SELECT pg_get_functiondef($1::oid) AS def', [node.id])
      if (!res.rows[0]) throw new Error(`${node.name} no longer exists.`)
      return res.rows[0].def
    },

    async users() {
      const res = await client.query(
        `SELECT r.rolname AS name, r.rolsuper, r.rolcanlogin, r.rolcreatedb, r.rolcreaterole, r.rolreplication,
                r.rolbypassrls, r.rolconnlimit, r.rolvaliduntil::text AS valid_until,
                COALESCE((SELECT json_agg(g.rolname ORDER BY g.rolname) FROM pg_auth_members m
                          JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid), '[]') AS member_of
         FROM pg_roles r WHERE r.rolname NOT LIKE 'pg\\_%' ORDER BY r.rolname`
      )
      return res.rows.map((r) => ({
        name: r.name,
        host: null,
        attributes: [
          r.rolsuper && 'superuser',
          r.rolcanlogin ? 'login' : 'no login',
          r.rolcreatedb && 'create db',
          r.rolcreaterole && 'create role',
          r.rolreplication && 'replication',
          r.rolbypassrls && 'bypass RLS',
          r.rolconnlimit >= 0 && `max ${r.rolconnlimit} connections`,
          r.valid_until && `valid until ${r.valid_until}`
        ].filter(Boolean) as string[],
        memberOf: JSON.parse(r.member_of) as string[]
      }))
    },

    async processes() {
      const res = await client.query(
        `SELECT pid::text AS id, usename AS "user", datname AS database, COALESCE(client_addr::text, 'local') AS client,
                state, EXTRACT(EPOCH FROM (now() - query_start))::float8 AS seconds, query,
                pid = pg_backend_pid() AS self
         FROM pg_stat_activity WHERE backend_type = 'client backend'
         ORDER BY query_start DESC NULLS LAST`
      )
      return res.rows.map((r) => ({ ...r, seconds: r.seconds === null ? null : Number(r.seconds) }))
    },

    async kill(id, mode) {
      const fn = mode === 'cancel' ? 'pg_cancel_backend' : 'pg_terminate_backend'
      const res = await client.query<{ ok: boolean }>(`SELECT ${fn}($1::int) AS ok`, [id])
      if (!res.rows[0]?.ok) throw new Error(`Could not signal process ${id}: it may have ended, or you lack permission.`)
    },

    async close() {
      await client.end().catch(() => {})
    }
  }
}

export interface CompletionRow {
  schema: string
  name: string
  kind: string
  column: string
  type: string
}

/** Fold one-row-per-column results into one entry per table. */
export function groupCompletions(rows: CompletionRow[]): CompletionTable[] {
  const byKey = new Map<string, CompletionTable>()
  for (const r of rows) {
    const key = `${r.schema}.${r.name}`
    let t = byKey.get(key)
    if (!t) {
      t = { schema: r.schema, name: r.name, kind: /view/i.test(r.kind) ? 'view' : 'table', columns: [] }
      byKey.set(key, t)
    }
    t.columns.push({ name: r.column, type: r.type })
  }
  return [...byKey.values()]
}
