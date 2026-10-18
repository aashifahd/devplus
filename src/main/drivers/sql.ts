import type { CellValue, ChangeSet, RowChange, RowKey, TableFilter, TableRequest } from '@shared/types'

export interface Dialect {
  quote(ident: string): string
  /** Placeholder for the n-th (1-based) bound parameter. */
  param(n: number): string
  /** Case-insensitive LIKE operator for this engine. */
  ilike: string
  /** Expression that casts a column to text so LIKE works on any type. */
  asText(expr: string): string
  /** Appended after LIKE patterns that use backslash escapes. */
  likeEscape: string
  /**
   * How to hit exactly one row when the table has no primary key: a hidden row id
   * (ctid / rowid) picked by subquery, MySQL's LIMIT 1, SQL Server's TOP (1), or
   * 'none' (match only; the one-row check then rolls back anything broader).
   */
  rowLocator: 'ctid' | 'rowid' | 'limit' | 'top' | 'none'
  /** LIMIT/OFFSET clause, or the engine's equivalent. `ordered` says an ORDER BY is present. */
  paginate(limit: number, offset: number, ordered: boolean): string
  /** INSERT with no explicit columns. */
  defaultValuesInsert: string
  /** Wrap a statement so the server shows its plan without running it. */
  explain(sql: string): string
  /** LIKE is case-sensitive and there is no ILIKE: compare LOWER() of both sides for "contains". */
  foldCase?: boolean
}

/** Query editor result sets are cut here so a stray SELECT * can't exhaust memory. */
export const MAX_RESULT_ROWS = 50_000

export const pgDialect: Dialect = {
  quote: (i) => `"${i.replace(/"/g, '""')}"`,
  param: (n) => `$${n}`,
  ilike: 'ILIKE',
  asText: (e) => `${e}::text`,
  likeEscape: '',
  rowLocator: 'ctid',
  paginate: (l, o) => ` LIMIT ${l} OFFSET ${o}`,
  defaultValuesInsert: 'DEFAULT VALUES',
  explain: (sql) => `EXPLAIN ${sql}`
}

export const mysqlDialect: Dialect = {
  quote: (i) => `\`${i.replace(/`/g, '``')}\``,
  param: () => '?',
  ilike: 'LIKE',
  asText: (e) => `CAST(${e} AS CHAR)`,
  likeEscape: '',
  rowLocator: 'limit',
  paginate: (l, o) => ` LIMIT ${l} OFFSET ${o}`,
  defaultValuesInsert: '() VALUES ()',
  explain: (sql) => `EXPLAIN ${sql}`
}

export const sqliteDialect: Dialect = {
  quote: (i) => `"${i.replace(/"/g, '""')}"`,
  param: () => '?',
  ilike: 'LIKE',
  asText: (e) => `CAST(${e} AS TEXT)`,
  likeEscape: " ESCAPE '\\'",
  rowLocator: 'rowid',
  paginate: (l, o) => ` LIMIT ${l} OFFSET ${o}`,
  defaultValuesInsert: 'DEFAULT VALUES',
  explain: (sql) => `EXPLAIN QUERY PLAN ${sql}`
}

export const mssqlDialect: Dialect = {
  quote: (i) => `[${i.replace(/]/g, ']]')}]`,
  param: (n) => `@p${n}`,
  // Case sensitivity follows the column collation; the default collations ignore case.
  ilike: 'LIKE',
  asText: (e) => `CAST(${e} AS NVARCHAR(MAX))`,
  likeEscape: " ESCAPE '\\'",
  rowLocator: 'top',
  paginate: (l, o, ordered) => `${ordered ? '' : ' ORDER BY (SELECT NULL)'} OFFSET ${o} ROWS FETCH NEXT ${l} ROWS ONLY`,
  defaultValuesInsert: 'DEFAULT VALUES',
  explain: (sql) => sql
}

export const duckdbDialect: Dialect = {
  quote: (i) => `"${i.replace(/"/g, '""')}"`,
  param: () => '?',
  ilike: 'ILIKE',
  asText: (e) => `CAST(${e} AS VARCHAR)`,
  likeEscape: " ESCAPE '\\'",
  rowLocator: 'rowid',
  paginate: (l, o) => ` LIMIT ${l} OFFSET ${o}`,
  defaultValuesInsert: 'DEFAULT VALUES',
  explain: (sql) => `EXPLAIN ${sql}`
}

export const clickhouseDialect: Dialect = {
  quote: (i) => `\`${i.replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\``,
  param: () => '?',
  ilike: 'ILIKE',
  asText: (e) => `toString(${e})`,
  likeEscape: '',
  rowLocator: 'none',
  paginate: (l, o) => ` LIMIT ${l} OFFSET ${o}`,
  defaultValuesInsert: 'VALUES ()',
  explain: (sql) => `EXPLAIN ${sql}`
}

export const snowflakeDialect: Dialect = {
  quote: (i) => `"${i.replace(/"/g, '""')}"`,
  param: () => '?',
  ilike: 'ILIKE',
  asText: (e) => `TO_VARCHAR(${e})`,
  likeEscape: " ESCAPE '\\\\'",
  rowLocator: 'none',
  paginate: (l, o) => ` LIMIT ${l} OFFSET ${o}`,
  defaultValuesInsert: 'DEFAULT VALUES',
  explain: (sql) => `EXPLAIN ${sql}`
}

export const bigqueryDialect: Dialect = {
  quote: (i) => `\`${i.replace(/`/g, '\\`')}\``,
  param: () => '?',
  // BigQuery has no ILIKE; LIKE is case-sensitive there.
  ilike: 'LIKE',
  asText: (e) => `CAST(${e} AS STRING)`,
  likeEscape: '',
  rowLocator: 'none',
  paginate: (l, o) => ` LIMIT ${l} OFFSET ${o}`,
  defaultValuesInsert: 'DEFAULT VALUES',
  explain: (sql) => sql,
  foldCase: true
}

/** CQL: no OFFSET (the driver pages), no casts in WHERE, and every table has a primary key. */
export const cqlDialect: Dialect = {
  quote: (i) => `"${i.replace(/"/g, '""')}"`,
  param: () => '?',
  ilike: 'LIKE',
  asText: (e) => e,
  likeEscape: '',
  rowLocator: 'none',
  paginate: (l) => ` LIMIT ${l}`,
  defaultValuesInsert: 'DEFAULT VALUES',
  explain: (sql) => sql
}

/**
 * Inline bound values for engines whose client takes no positional parameters (ClickHouse).
 * Strings escape backslashes and quotes, which is safe for ClickHouse's literal rules.
 */
export function inlineParams(sql: string, params: unknown[]): string {
  let i = 0
  const lit = (v: unknown) => {
    if (v === null || v === undefined) return 'NULL'
    if (typeof v === 'number' || typeof v === 'bigint') return String(v)
    if (typeof v === 'boolean') return v ? '1' : '0'
    return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  }
  return sql.replace(/\?/g, () => lit(params[i++]))
}

const escapeLike = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`)

function buildWhere(d: Dialect, filters: TableFilter[]): { sql: string; params: unknown[] } {
  const parts: string[] = []
  const params: unknown[] = []
  const bind = (v: unknown) => {
    params.push(v)
    return d.param(params.length)
  }

  for (const f of filters) {
    if (!f.column) continue
    const col = d.quote(f.column)
    switch (f.op) {
      case 'is null':
        parts.push(`${col} IS NULL`)
        break
      case 'is not null':
        parts.push(`${col} IS NOT NULL`)
        break
      case 'contains':
      case 'not contains':
      case 'starts with': {
        const pattern = f.op === 'starts with' ? `${escapeLike(f.value)}%` : `%${escapeLike(f.value)}%`
        const not = f.op === 'not contains' ? 'NOT ' : ''
        parts.push(
          d.foldCase
            ? `LOWER(${d.asText(col)}) ${not}LIKE LOWER(${bind(pattern)})${d.likeEscape}`
            : `${d.asText(col)} ${not}${d.ilike} ${bind(pattern)}${d.likeEscape}`
        )
        break
      }
      case 'like':
        parts.push(`${d.asText(col)} LIKE ${bind(f.value)}`)
        break
      case 'in': {
        const values = f.value
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean)
        if (values.length === 0) parts.push('1 = 0')
        else parts.push(`${d.asText(col)} IN (${values.map(bind).join(', ')})`)
        break
      }
      default:
        // Bind the raw string and let the engine coerce it to the column type.
        parts.push(`${col} ${f.op} ${bind(f.value)}`)
    }
  }

  return { sql: parts.length ? ` WHERE ${parts.join(' AND ')}` : '', params }
}

export function tableRef(d: Dialect, schema: string, table: string): string {
  return schema ? `${d.quote(schema)}.${d.quote(table)}` : d.quote(table)
}

export function buildSelect(d: Dialect, req: TableRequest): { sql: string; params: unknown[] } {
  const where = buildWhere(d, req.filters)
  let sql = `SELECT * FROM ${tableRef(d, req.schema, req.table)}${where.sql}`
  if (req.orderBy) sql += ` ORDER BY ${d.quote(req.orderBy.column)} ${req.orderBy.dir === 'desc' ? 'DESC' : 'ASC'}`
  sql += d.paginate(Math.max(1, Math.floor(req.limit)), Math.max(0, Math.floor(req.offset)), Boolean(req.orderBy))
  return { sql, params: where.params }
}

export function buildCount(d: Dialect, req: TableRequest): { sql: string; params: unknown[] } {
  const where = buildWhere(d, req.filters)
  return { sql: `SELECT COUNT(*) AS n FROM ${tableRef(d, req.schema, req.table)}${where.sql}`, params: where.params }
}

/** Inline params into SQL for display only (never executed). */
export function displaySql(sql: string, params: unknown[]): string {
  let i = 0
  const lit = (v: unknown) =>
    v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`
  return sql.replace(/\$(\d+)|@p(\d+)|\?/g, (m, n, p) =>
    n ? lit(params[Number(n) - 1]) : p ? lit(params[Number(p) - 1]) : i < params.length ? lit(params[i++]) : m
  )
}

/** Turn any driver value into something structured-clone safe and grid friendly. */
export function normalizeCell(v: unknown): CellValue {
  if (v === null || v === undefined) return null
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return v
    case 'number':
      return Number.isFinite(v) ? v : String(v)
    case 'bigint':
      return v.toString()
  }
  if (v instanceof Date) return isNaN(v.getTime()) ? String(v) : v.toISOString()
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const buf = Buffer.from(v as Uint8Array)
    const hex = buf.subarray(0, 64).toString('hex')
    return `0x${hex}${buf.length > 64 ? `… (${buf.length} bytes)` : ''}`
  }
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export interface Statement {
  sql: string
  params: unknown[]
  /** Updates and deletes must touch exactly one row, or the whole commit is rolled back. */
  expectOne: boolean
}

function paramBinder(d: Dialect) {
  const params: unknown[] = []
  const bind = (v: unknown) => {
    params.push(v)
    return d.param(params.length)
  }
  return { params, bind }
}

function keyCondition(d: Dialect, key: RowKey, bind: (v: unknown) => string): string {
  const parts = Object.entries(key.values).map(([col, v]) => {
    if (v === null) return `${d.quote(col)} IS NULL`
    // Without a primary key we compare the text form we showed the user,
    // so values like timestamps and JSON match exactly what is on screen.
    // The bound value must be text too: SQLite won't coerce an integer param to match.
    if (!key.primaryKey) return `${d.asText(d.quote(col))} = ${bind(String(v))}`
    return `${d.quote(col)} = ${bind(typeof v === 'boolean' ? String(v) : v)}`
  })
  if (parts.length === 0) throw new Error('Cannot identify the row: it has no comparable columns.')
  return parts.join(' AND ')
}

/** WHERE clause (plus MySQL LIMIT) that targets the one row described by `key`. */
function rowTarget(d: Dialect, ref: string, key: RowKey, bind: (v: unknown) => string): string {
  const cond = keyCondition(d, key, bind)
  if (key.primaryKey) return ` WHERE ${cond}`
  switch (d.rowLocator) {
    case 'ctid':
      return ` WHERE ctid = (SELECT ctid FROM ${ref} WHERE ${cond} LIMIT 1)`
    case 'rowid':
      return ` WHERE rowid = (SELECT rowid FROM ${ref} WHERE ${cond} LIMIT 1)`
    case 'limit':
      return ` WHERE ${cond} LIMIT 1`
    case 'top':
    case 'none':
      return ` WHERE ${cond}`
  }
}

function buildChange(d: Dialect, ref: string, change: RowChange): Statement {
  const { params, bind } = paramBinder(d)
  switch (change.kind) {
    case 'update': {
      const sets = Object.entries(change.set).map(([col, v]) => `${d.quote(col)} = ${v === null ? 'NULL' : bind(v)}`)
      if (sets.length === 0) throw new Error('Nothing to update.')
      const top = !change.key.primaryKey && d.rowLocator === 'top' ? 'TOP (1) ' : ''
      const sql = `UPDATE ${top}${ref} SET ${sets.join(', ')}${rowTarget(d, ref, change.key, bind)}`
      return { sql, params, expectOne: true }
    }
    case 'delete':
      const top = !change.key.primaryKey && d.rowLocator === 'top' ? 'TOP (1) ' : ''
      return { sql: `DELETE ${top}FROM ${ref}${rowTarget(d, ref, change.key, bind)}`, params, expectOne: true }
    case 'insert': {
      const cols = Object.keys(change.values)
      if (cols.length === 0) return { sql: `INSERT INTO ${ref} ${d.defaultValuesInsert}`, params, expectOne: false }
      const values = cols.map((c) => (change.values[c] === null ? 'NULL' : bind(change.values[c])))
      return {
        sql: `INSERT INTO ${ref} (${cols.map(d.quote).join(', ')}) VALUES (${values.join(', ')})`,
        params,
        expectOne: false
      }
    }
  }
}

const ORDER: Record<RowChange['kind'], number> = { delete: 0, update: 1, insert: 2 }

/** Deletes first (frees unique values), then updates, then inserts. */
export function buildChanges(d: Dialect, set: ChangeSet): Statement[] {
  const ref = tableRef(d, set.schema, set.table)
  return [...set.changes].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]).map((c) => buildChange(d, ref, c))
}

/** Cap and normalize raw driver rows for the query editor. */
export function capRows(rows: unknown[][]): { rows: CellValue[][]; truncated: boolean } {
  const truncated = rows.length > MAX_RESULT_ROWS
  return { rows: (truncated ? rows.slice(0, MAX_RESULT_ROWS) : rows).map((r) => r.map(normalizeCell)), truncated }
}

/** Like normalizeCell, but binary values keep every byte (exports must not truncate). */
export function normalizeCellFull(v: unknown): CellValue {
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return `0x${Buffer.from(v as Uint8Array).toString('hex')}`
  return normalizeCell(v)
}
