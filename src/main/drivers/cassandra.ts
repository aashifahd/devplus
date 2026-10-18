import { readFileSync } from 'node:fs'
import cassandra from 'cassandra-driver'
import type { CellValue, ChangeSet, ColumnDef, ConnectionConfig, ConnectionSecrets, EditValue, RowChange, TableRequest, TreeNode } from '@shared/types'
import type { DriverSession, Endpoint, RawStatementResult } from './types'
import { cqlDialect, MAX_RESULT_ROWS } from './sql'

const { types } = cassandra
const q = cqlDialect.quote
const SYSTEM_KEYSPACES = /^system(_.*)?$|^dse_|^solr_admin$|^OpsCenter$/

/** Protocol type code to CQL type name (the driver's own lookup isn't in its typings). */
const TYPE_NAMES = new Map<number, string>(
  Object.entries(types.dataTypes as unknown as Record<string, number | string>)
    .filter((e): e is [string, number] => typeof e[1] === 'number')
    .map(([name, code]) => [code, name])
)

/** Driver values (Long, Uuid, Map, Set, Tuple…) to grid cells. */
function cell(v: unknown): CellValue {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v)
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Date) return v.toISOString()
  if (Buffer.isBuffer(v)) return `0x${v.subarray(0, 64).toString('hex')}${v.length > 64 ? `… (${v.length} bytes)` : ''}`
  if (v instanceof Map) return JSON.stringify(Object.fromEntries([...v].map(([k, x]) => [String(cell(k)), cell(x)])))
  if (v instanceof Set) return JSON.stringify([...v].map(cell))
  if (Array.isArray(v)) return JSON.stringify(v.map(cell))
  if (v instanceof types.Tuple) return JSON.stringify(v.values().map(cell))
  // Long, Uuid, TimeUuid, BigDecimal, InetAddress, LocalDate, Duration… all print themselves.
  return String(v)
}

/** Grid text to a value of the column's CQL type, so prepared statements accept it. */
export function toCql(value: EditValue | CellValue, cqlType: string): unknown {
  if (value === null) return null
  const t = cqlType.toLowerCase().replace(/^frozen<(.*)>$/, '$1')
  const s = String(value)
  if (/^(int|smallint|tinyint|counter)$/.test(t)) return Number.parseInt(s, 10)
  if (t === 'bigint') return types.Long.fromString(s)
  if (t === 'varint') return types.Integer.fromString(s)
  if (t === 'float' || t === 'double') return Number(s)
  if (t === 'decimal') return types.BigDecimal.fromString(s)
  if (t === 'boolean') return s === 'true' || s === '1'
  if (t === 'uuid') return types.Uuid.fromString(s)
  if (t === 'timeuuid') return types.TimeUuid.fromString(s)
  if (t === 'timestamp') return new Date(s)
  if (t === 'date') return types.LocalDate.fromString(s)
  if (t === 'time') return types.LocalTime.fromString(s)
  if (t === 'inet') return types.InetAddress.fromString(s)
  if (t === 'duration') return types.Duration.fromString(s)
  if (t === 'blob') return Buffer.from(s.replace(/^0x/i, ''), 'hex')
  if (/^(list|set|map|tuple)</.test(t)) {
    const parsed = JSON.parse(s)
    if (t.startsWith('set<')) return parsed
    if (t.startsWith('map<')) return parsed
    return parsed
  }
  return s
}

/** A CQL literal for previews (statements actually run with bound, typed values). */
function literal(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Buffer.isBuffer(v)) return `0x${v.toString('hex')}`
  if (v instanceof Date) return `'${v.toISOString()}'`
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`
  if (Array.isArray(v)) return `[${v.map(literal).join(', ')}]`
  if (typeof v === 'object' && v.constructor === Object) return `{${Object.entries(v).map(([k, x]) => `${literal(k)}: ${literal(x)}`).join(', ')}}`
  return String(v)
}

export async function openCassandra(cfg: ConnectionConfig, secrets: ConnectionSecrets, endpoint: Endpoint): Promise<DriverSession> {
  const hosts = cfg.ssh.enabled ? [endpoint.host] : (cfg.host || '127.0.0.1').split(',').map((h) => h.trim()).filter(Boolean)
  const tls = cfg.ssl.mode === 'require' || cfg.ssl.mode === 'verify-full'
  const client = new cassandra.Client({
    contactPoints: hosts,
    protocolOptions: { port: endpoint.port },
    localDataCenter: cfg.options?.localDataCenter?.trim() || 'datacenter1',
    keyspace: cfg.database?.trim() || undefined,
    credentials: cfg.user ? { username: cfg.user, password: secrets.password ?? '' } : undefined,
    sslOptions: tls ? { rejectUnauthorized: cfg.ssl.mode === 'verify-full', ...(cfg.ssl.caPath ? { ca: [readFileSync(cfg.ssl.caPath)] } : {}) } : undefined,
    socketOptions: { connectTimeout: 15000, readTimeout: 120000 },
    applicationName: 'DevPlus'
  })
  await client.connect()

  const rows = async (query: string, params: unknown[] = []) => (await client.execute(query, params, { prepare: params.length > 0 })).rows
  const local = (await rows('SELECT release_version, cluster_name, data_center FROM system.local'))[0]
  const isScylla = (await rows("SELECT keyspace_name FROM system_schema.keyspaces WHERE keyspace_name = 'system_distributed_everywhere'").catch(() => [])).length > 0 ||
    Boolean((await rows('SELECT * FROM system.local').catch(() => []))[0]?.scylla_version)
  let keyspace = client.keyspace ?? ''

  const columnTypes = async (ks: string, table: string) =>
    (await rows('SELECT column_name, type, kind, position, clustering_order FROM system_schema.columns WHERE keyspace_name = ? AND table_name = ?', [ks, table])).map((r) => ({
      name: String(r.column_name),
      type: String(r.type),
      kind: String(r.kind),
      position: Number(r.position),
      order: String(r.clustering_order)
    }))

  /** Partition keys, then clustering keys, then the rest: the order CQL tables are read in. */
  const orderedColumns = async (ks: string, table: string) => {
    const cols = await columnTypes(ks, table)
    const rank = (k: string) => (k === 'partition_key' ? 0 : k === 'clustering' ? 1 : k === 'static' ? 2 : 3)
    return cols.sort((a, b) => rank(a.kind) - rank(b.kind) || a.position - b.position || a.name.localeCompare(b.name))
  }

  const toRaw = (result: cassandra.types.ResultSet, cap = MAX_RESULT_ROWS): RawStatementResult => {
    const cols = result.columns ?? []
    const all = result.rows ?? []
    const truncated = all.length > cap
    return {
      hasRows: cols.length > 0,
      columns: cols.map((c) => ({ name: c.name, type: TYPE_NAMES.get(c.type.code) ?? String(c.type.code) })),
      rows: (truncated ? all.slice(0, cap) : all).map((r) => cols.map((c) => cell(r.get(c.name)))),
      affected: null,
      command: '',
      truncated
    }
  }

  /** Build one bound statement for a grid change, converting every value by its CQL type. */
  const statementFor = (c: RowChange, ref: string, typeOf: Map<string, string>) => {
    const conv = (col: string, v: EditValue | CellValue) => toCql(v, typeOf.get(col) ?? 'text')
    switch (c.kind) {
      case 'update': {
        const sets = Object.keys(c.set)
        const keys = Object.keys(c.key.values)
        return {
          query: `UPDATE ${ref} SET ${sets.map((s) => `${q(s)} = ?`).join(', ')} WHERE ${keys.map((k) => `${q(k)} = ?`).join(' AND ')}`,
          params: [...sets.map((s) => conv(s, c.set[s])), ...keys.map((k) => conv(k, c.key.values[k]))]
        }
      }
      case 'insert': {
        const cols = Object.keys(c.values)
        if (cols.length === 0) throw new Error('A Cassandra row needs at least its primary key columns.')
        return {
          query: `INSERT INTO ${ref} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
          params: cols.map((col) => conv(col, c.values[col]))
        }
      }
      case 'delete': {
        const keys = Object.keys(c.key.values)
        return { query: `DELETE FROM ${ref} WHERE ${keys.map((k) => `${q(k)} = ?`).join(' AND ')}`, params: keys.map((k) => conv(k, c.key.values[k])) }
      }
    }
  }

  /** ScyllaDB backs each secondary index with a view named <index>_index; those aren't user objects. */
  const indexViews = async (ks: string) =>
    new Set((await rows('SELECT index_name FROM system_schema.indexes WHERE keyspace_name = ?', [ks]).catch(() => [])).map((r) => `${r.index_name}_index`))

  const listKeyspaces = async () =>
    (await rows('SELECT keyspace_name FROM system_schema.keyspaces')).map((r) => String(r.keyspace_name)).filter((k) => !SYSTEM_KEYSPACES.test(k)).sort()

  const describeColumns = async (ks: string, table: string): Promise<ColumnDef[]> =>
    (await orderedColumns(ks, table)).map((c) => ({
      name: c.name,
      type: c.type,
      nullable: c.kind === 'regular' || c.kind === 'static',
      defaultValue: null,
      isPrimaryKey: c.kind === 'partition_key' || c.kind === 'clustering',
      autoIncrement: false,
      comment: c.kind === 'partition_key' ? 'partition key' : c.kind === 'clustering' ? `clustering (${c.order})` : c.kind === 'static' ? 'static' : null
    }))

  const changeStatements = async (set: ChangeSet) => {
    const typeOf = new Map((await columnTypes(set.schema, set.table)).map((c) => [c.name, c.type]))
    const ref = `${q(set.schema)}.${q(set.table)}`
    return set.changes.map((c) => statementFor(c, ref, typeOf))
  }

  return {
    serverVersion: `${isScylla ? 'ScyllaDB' : 'Cassandra'} ${local?.release_version ?? ''} · ${local?.data_center ?? ''}`,
    dialect: cqlDialect,

    listDatabases: listKeyspaces,

    currentDatabase: () => keyspace,

    async switchDatabase(name) {
      await client.execute(`USE ${q(name)}`)
      keyspace = name
    },

    async tree() {
      const keyspaces = keyspace ? [keyspace] : await listKeyspaces()
      const out: TreeNode[] = []
      for (const ks of keyspaces) {
        const tables = await rows('SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?', [ks])
        const hidden = await indexViews(ks)
        const views = (await rows('SELECT view_name FROM system_schema.views WHERE keyspace_name = ?', [ks]).catch(() => [])).filter((v) => !hidden.has(String(v.view_name)))
        out.push({
          kind: 'schema',
          name: ks,
          schema: ks,
          children: [
            ...tables.map((t) => ({ kind: 'table', name: String(t.table_name), schema: ks }) as TreeNode),
            ...views.map((v) => ({ kind: 'view', name: String(v.view_name), schema: ks }) as TreeNode)
          ].sort((a, b) => a.name.localeCompare(b.name))
        })
      }
      return out
    },

    columns: describeColumns,

    async fetchTable(req: TableRequest) {
      if (req.filters.length) throw new Error('Cassandra filters need ALLOW FILTERING; use the CQL editor for filtered reads.')
      const started = performance.now()
      // No OFFSET in CQL: read through the window and drop the rows before it.
      const query = `SELECT * FROM ${q(req.schema)}.${q(req.table)} LIMIT ${req.offset + req.limit}`
      const res = await client.execute(query, [], { fetchSize: Math.min(5000, req.offset + req.limit), autoPage: true })
      const raw = toRaw(res, Number.MAX_SAFE_INTEGER)
      let page = raw.rows.slice(req.offset, req.offset + req.limit)
      if (req.orderBy) {
        // Server-side ORDER BY only works within one partition, so sort what was read.
        const i = raw.columns.findIndex((c) => c.name === req.orderBy!.column)
        page = [...page].sort((a, b) => {
          const x = a[i] ?? ''
          const y = b[i] ?? ''
          const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })
          return req.orderBy!.dir === 'desc' ? -cmp : cmp
        })
      }
      return { columns: raw.columns, rows: page, durationMs: performance.now() - started, sql: `${query}${req.orderBy ? ' (page sorted locally)' : ''}` }
    },

    async countTable(req) {
      const r = await rows(`SELECT COUNT(*) AS n FROM ${q(req.schema)}.${q(req.table)}`)
      return Number(String(r[0]?.n ?? 0))
    },

    async execute(statements, onStatement) {
      // Schema statements only (no bound values): CQL has no multi-statement transactions.
      for (const [i, st] of statements.entries()) {
        await client.execute(st.sql, st.params as unknown[], { prepare: st.params.length > 0 })
        onStatement?.(i)
      }
      return statements.map(() => -1)
    },

    changes: {
      async preview(set: ChangeSet) {
        return (await changeStatements(set)).map((st) => {
          let i = 0
          return st.query.replace(/\?/g, () => literal(st.params[i++]))
        })
      },
      async apply(set: ChangeSet) {
        // A logged batch is atomic for writes. CQL UPDATE is an upsert, so editing a row
        // someone else deleted recreates it rather than failing.
        const statements = await changeStatements(set)
        await client.batch(statements, { prepare: true, logged: true })
        return statements.length
      }
    },

    async runStatement(query) {
      const res = await client.execute(query, [], { fetchSize: MAX_RESULT_ROWS + 1, autoPage: false })
      if (!res.columns || res.columns.length === 0) return { hasRows: false, columns: [], rows: [], affected: null, command: query.trim().split(/\s+/)[0].toUpperCase(), truncated: false }
      const raw = toRaw(res)
      return { ...raw, truncated: raw.truncated || Boolean(res.pageState) }
    },

    // No read-only mode; read-only connections are guarded by the statement check before sending.
    withReadOnly: (fn) => fn(),

    canCancel: false,
    async cancel() {
      throw new Error('Cassandra queries cannot be cancelled from the client.')
    },

    async completions() {
      if (!keyspace) return []
      const cols = await rows('SELECT table_name, column_name, type FROM system_schema.columns WHERE keyspace_name = ?', [keyspace])
      const hidden = await indexViews(keyspace)
      const by = new Map<string, { name: string; type: string }[]>()
      for (const c of cols.filter((x) => !hidden.has(String(x.table_name)))) by.set(String(c.table_name), [...(by.get(String(c.table_name)) ?? []), { name: String(c.column_name), type: String(c.type) }])
      return [...by].map(([name, columns]) => ({ schema: keyspace, name, kind: 'table' as const, columns }))
    },

    async structure(ks, table) {
      const cols = await orderedColumns(ks, table)
      if (cols.length === 0) throw new Error(`${ks}.${table} no longer exists.`)
      const isView = (await rows('SELECT view_name FROM system_schema.views WHERE keyspace_name = ? AND view_name = ?', [ks, table]).catch(() => [])).length > 0
      const columns = await describeColumns(ks, table)
      const pk = cols.filter((c) => c.kind === 'partition_key').map((c) => c.name)
      const ck = cols.filter((c) => c.kind === 'clustering')
      const idx = await rows('SELECT index_name, kind, options FROM system_schema.indexes WHERE keyspace_name = ? AND table_name = ?', [ks, table]).catch(() => [])
      const indexes = [
        { name: 'PRIMARY KEY', columns: [...pk, ...ck.map((c) => c.name)], unique: true, primary: true, method: `partition (${pk.join(', ')})`, definition: null },
        ...idx.map((r) => {
          const target = (r.options as Map<string, string> | Record<string, string> | null)
          const t = target instanceof Map ? target.get('target') : target?.target
          return { name: String(r.index_name), columns: [String(t ?? '')], unique: false, primary: false, method: String(r.kind).toLowerCase(), definition: `CREATE INDEX ${q(String(r.index_name))} ON ${q(ks)}.${q(table)} (${t ?? ''})` }
        })
      ]
      const key = `PRIMARY KEY (${pk.length > 1 ? `(${pk.map(q).join(', ')})` : q(pk[0] ?? '')}${ck.length ? `, ${ck.map((c) => q(c.name)).join(', ')}` : ''})`
      const order = ck.length ? `\nWITH CLUSTERING ORDER BY (${ck.map((c) => `${q(c.name)} ${c.order.toUpperCase()}`).join(', ')})` : ''
      const ddl = [
        `CREATE TABLE ${q(ks)}.${q(table)} (\n  ${cols.map((c) => `${q(c.name)} ${c.type}${c.kind === 'static' ? ' STATIC' : ''}`).join(',\n  ')},\n  ${key}\n)${order};`,
        ...indexes.filter((i) => i.definition).map((i) => `${i.definition};`)
      ].join('\n\n')
      return { schema: ks, name: table, kind: isView ? 'view' : 'table', columns, indexes, foreignKeys: [], triggers: [], ddl }
    },

    async close() {
      await client.shutdown().catch(() => {})
    }
  }
}
