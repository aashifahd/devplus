import { existsSync } from 'node:fs'
import { BigQuery, type Job, type TableField } from '@google-cloud/bigquery'
import type { CellValue, ColumnDef, CompletionTable, ConnectionConfig, TableRequest, TreeNode } from '@shared/types'
import type { DriverSession, RawStatementResult } from './types'
import { bigqueryDialect, buildCount, buildSelect, displaySql, MAX_RESULT_ROWS, normalizeCell } from './sql'

const q = bigqueryDialect.quote

/** BigQuery wraps dates, timestamps and INT64 in objects with a string `value`; unwrap recursively. */
function plain(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (Buffer.isBuffer(v)) return v
  if (Array.isArray(v)) return v.map(plain)
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    // BigQueryInt/Date/Timestamp/... are class instances; STRUCT values are plain objects.
    if (Object.getPrototypeOf(o) !== Object.prototype && 'value' in o && typeof o.value !== 'object') return o.value
    if (typeof (o as { toFixed?: unknown }).toFixed === 'function' && 'c' in o && 'e' in o) return String(v)
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, plain(x)]))
  }
  return v
}

const cell = (v: unknown): CellValue => normalizeCell(plain(v))

/** Field type with REPEATED and nested RECORD shown the way BigQuery SQL spells them. */
function fieldType(f: TableField): string {
  const base = f.type === 'RECORD' || f.type === 'STRUCT' ? `STRUCT<${(f.fields ?? []).map((x) => `${x.name} ${fieldType(x)}`).join(', ')}>` : String(f.type)
  return f.mode === 'REPEATED' ? `ARRAY<${base}>` : base
}

const NUMERIC_TYPES = /^(INT64|INTEGER|NUMERIC|BIGNUMERIC|FLOAT64|FLOAT)$/i

export async function openBigquery(cfg: ConnectionConfig): Promise<DriverSession> {
  const keyFile = cfg.filePath?.trim()
  if (keyFile && !existsSync(keyFile)) throw new Error(`Key file not found: ${keyFile}`)
  const endpoint = cfg.options?.endpoint?.trim()
  const location = cfg.options?.location?.trim() || undefined
  const bq = new BigQuery({
    projectId: cfg.database || undefined,
    keyFilename: keyFile || undefined,
    location,
    ...(endpoint ? { apiEndpoint: endpoint } : {})
  })
  const projectId = cfg.database || (await bq.getProjectId())
  let running: Job | null = null

  /**
   * Parameter values go out as strings with explicit types: the API defines them as strings,
   * and stricter implementations (the emulator) reject raw JSON numbers.
   */
  const typed = (params: unknown[]) => ({
    params: params.map((p) => (p === null || p === undefined ? null : String(p))),
    types: params.map((p) =>
      typeof p === 'number' ? (Number.isInteger(p) ? 'INT64' : 'FLOAT64') : typeof p === 'boolean' ? 'BOOL' : typeof p === 'bigint' ? 'INT64' : 'STRING'
    )
  })

  /** Run a query job and read up to `max` rows with their schema. */
  const run = async (query: string, params: unknown[] = [], max = MAX_RESULT_ROWS + 1) => {
    const [job] = await bq.createQueryJob({ query, ...(params.length ? typed(params) : {}), location, useLegacySql: false })
    running = job
    try {
      const [rows, , response] = await job.getQueryResults({ maxResults: max, wrapIntegers: true, autoPaginate: false })
      const fields = ((response as { schema?: { fields?: TableField[] } } | undefined)?.schema?.fields ?? []) as TableField[]
      const [meta] = await job.getMetadata()
      return { rows: rows as Record<string, unknown>[], fields, meta: meta as { statistics?: { query?: { numDmlAffectedRows?: string; statementType?: string } } } }
    } finally {
      running = null
    }
  }

  const tableMeta = async (dataset: string, table: string) => {
    const [meta] = await bq.dataset(dataset).table(table).getMetadata()
    return meta as { type?: string; numRows?: string; schema?: { fields?: TableField[] }; view?: { query?: string }; timePartitioning?: { field?: string; type?: string }; clustering?: { fields?: string[] } }
  }

  const columnsOf = async (dataset: string, table: string): Promise<ColumnDef[]> =>
    ((await tableMeta(dataset, table)).schema?.fields ?? []).map((f) => ({
      name: String(f.name),
      type: fieldType(f),
      nullable: f.mode !== 'REQUIRED',
      defaultValue: (f as { defaultValueExpression?: string }).defaultValueExpression ?? null,
      isPrimaryKey: false,
      autoIncrement: false,
      comment: f.description ?? null
    }))

  /** BigQuery won't compare INT64 with a STRING parameter, so type filter values from the schema. */
  const typedRequest = async (req: TableRequest): Promise<TableRequest> => {
    if (req.filters.length === 0) return req
    const types = new Map((await columnsOf(req.schema, req.table)).map((c) => [c.name, c.type]))
    return {
      ...req,
      filters: req.filters.map((f) => {
        const t = types.get(f.column) ?? ''
        if (['=', '!=', '<', '>', '<=', '>='].includes(f.op)) {
          if (NUMERIC_TYPES.test(t) && f.value.trim() !== '' && !Number.isNaN(Number(f.value))) return { ...f, value: Number(f.value) as unknown as string }
          if (t === 'BOOL' || t === 'BOOLEAN') return { ...f, value: (f.value.toLowerCase() === 'true') as unknown as string }
        }
        return f
      })
    }
  }

  const toRaw = (rows: Record<string, unknown>[], fields: TableField[]): RawStatementResult => {
    const names = fields.length ? fields.map((f) => String(f.name)) : Object.keys(rows[0] ?? {})
    const truncated = rows.length > MAX_RESULT_ROWS
    return {
      hasRows: true,
      columns: names.map((n, i) => ({ name: n, type: fields[i] ? fieldType(fields[i]) : '' })),
      rows: (truncated ? rows.slice(0, MAX_RESULT_ROWS) : rows).map((r) => names.map((n) => cell(r[n]))),
      affected: null,
      command: '',
      truncated
    }
  }

  const datasets = async () => (await bq.getDatasets({ projectId }))[0].map((d) => String(d.id))

  return {
    serverVersion: `BigQuery · ${projectId}${endpoint ? ` (${endpoint})` : ''}`,
    dialect: bigqueryDialect,

    listDatabases: async () => [projectId],
    currentDatabase: () => projectId,
    async switchDatabase() {
      throw new Error('Open another connection to use a different BigQuery project.')
    },

    async tree() {
      const out: TreeNode[] = []
      for (const ds of await datasets()) {
        const [tables] = await bq.dataset(ds).getTables()
        out.push({
          kind: 'schema',
          name: ds,
          schema: ds,
          children: tables
            .map((t) => ({ kind: /VIEW/.test(String(t.metadata?.type)) ? 'view' : 'table', name: String(t.id), schema: ds }) as TreeNode)
            .sort((a, b) => a.name.localeCompare(b.name))
        })
      }
      return out
    },

    columns: columnsOf,

    async fetchTable(req: TableRequest) {
      const typed = await typedRequest(req)
      const { sql, params } = buildSelect(bigqueryDialect, typed)
      const started = performance.now()
      const r = await run(sql, params, req.limit)
      const raw = toRaw(r.rows, r.fields)
      return { columns: raw.columns, rows: raw.rows, durationMs: performance.now() - started, sql: displaySql(sql, params) }
    },

    async countTable(req) {
      // Table metadata has the row count for free; only filtered counts cost a query.
      if (req.filters.length === 0) {
        const meta = await tableMeta(req.schema, req.table)
        if (meta.numRows !== undefined && !/VIEW/.test(String(meta.type))) return Number(meta.numRows)
      }
      const { sql, params } = buildCount(bigqueryDialect, await typedRequest(req))
      const r = await run(sql, params, 1)
      return Number(plain(r.rows[0]?.n) ?? 0)
    },

    async runStatement(sql) {
      const r = await run(sql)
      const dml = r.meta.statistics?.query?.numDmlAffectedRows
      if (dml !== undefined || r.fields.length === 0) {
        return { hasRows: false, columns: [], rows: [], affected: dml === undefined ? null : Number(dml), command: r.meta.statistics?.query?.statementType ?? '', truncated: false }
      }
      return toRaw(r.rows, r.fields)
    },

    // No transactions to lean on; read-only connections are guarded by the statement check before sending.
    withReadOnly: (fn) => fn(),

    canCancel: true,

    async cancel() {
      await running?.cancel()
    },

    async explain(statement) {
      // A dry run validates the query and reports what it would scan, at no cost.
      const [job] = await bq.createQueryJob({ query: statement, dryRun: true, location, useLegacySql: false })
      const stats = (job.metadata as { statistics?: { totalBytesProcessed?: string; query?: { referencedTables?: { datasetId: string; tableId: string }[]; statementType?: string } } }).statistics
      const bytes = Number(stats?.totalBytesProcessed ?? 0)
      const tables = (stats?.query?.referencedTables ?? []).map((t) => `${t.datasetId}.${t.tableId}`).join(', ')
      return {
        hasRows: true,
        columns: [
          { name: 'statement', type: 'STRING' },
          { name: 'bytes_processed', type: 'INT64' },
          { name: 'size', type: 'STRING' },
          { name: 'tables', type: 'STRING' }
        ],
        rows: [[stats?.query?.statementType ?? '', bytes, `${(bytes / 1e9).toFixed(3)} GB`, tables]],
        affected: null,
        command: 'DRY RUN',
        truncated: false
      }
    },

    async completions() {
      const out: CompletionTable[] = []
      for (const ds of await datasets()) {
        const [tables] = await bq.dataset(ds).getTables()
        // Metadata calls are free but slow; cap them so huge projects still open quickly.
        for (const t of tables.slice(0, 200)) {
          const cols = await columnsOf(ds, String(t.id)).catch(() => [])
          out.push({ schema: ds, name: String(t.id), kind: /VIEW/.test(String(t.metadata?.type)) ? 'view' : 'table', columns: cols.map((c) => ({ name: c.name, type: c.type })) })
        }
      }
      return out
    },

    async structure(dataset, table) {
      const meta = await tableMeta(dataset, table)
      const columns = await columnsOf(dataset, table)
      const isView = /VIEW/.test(String(meta.type))
      const ref = `${q(projectId)}.${q(dataset)}.${q(table)}`
      const parts = meta.timePartitioning?.field ? `\nPARTITION BY ${meta.timePartitioning.type === 'DAY' ? `DATE(${q(meta.timePartitioning.field)})` : q(meta.timePartitioning.field)}` : ''
      const cluster = meta.clustering?.fields?.length ? `\nCLUSTER BY ${meta.clustering.fields.map(q).join(', ')}` : ''
      const ddl = isView
        ? `CREATE VIEW ${ref} AS\n${meta.view?.query ?? ''}`
        : `CREATE TABLE ${ref} (\n  ${columns.map((c) => `${q(c.name)} ${c.type}${c.nullable ? '' : ' NOT NULL'}`).join(',\n  ')}\n)${parts}${cluster};`
      const indexes = [
        ...(meta.timePartitioning ? [{ name: 'PARTITION', columns: [meta.timePartitioning.field ?? '_PARTITIONTIME'], unique: false, primary: false, method: String(meta.timePartitioning.type ?? ''), definition: null }] : []),
        ...(meta.clustering?.fields?.length ? [{ name: 'CLUSTER', columns: meta.clustering.fields, unique: false, primary: false, method: 'clustering', definition: null }] : [])
      ]
      return { schema: dataset, name: table, kind: isView ? 'view' : 'table', columns, indexes, foreignKeys: [], triggers: [], ddl }
    },

    async close() {
      // The client keeps no open connections between requests.
    }
  }
}
