import type { CellValue, ColumnMeta, Engine } from './types'

export type ExportFormat = 'csv' | 'tsv' | 'json' | 'sql'

export interface FormatOptions {
  format: ExportFormat
  /** CSV/TSV: write a header row. */
  header: boolean
  /** CSV/TSV: how NULL is written (empty by default, so it round-trips with "empty as NULL"). */
  nullText: string
  /** SQL: table name used in INSERT statements. */
  tableName: string
  /** SQL: identifier quoting and literal rules. */
  engine: Engine
  /** SQL: rows per INSERT statement. */
  batchSize: number
  /** SQL: column indexes holding binary values (normalized as 0x… hex). */
  binaryColumns: number[]
}

export const defaultFormatOptions = (engine: Engine, tableName: string, format: ExportFormat = 'csv'): FormatOptions => ({
  format,
  header: true,
  nullText: '',
  tableName,
  engine,
  batchSize: 100,
  binaryColumns: []
})

export const FORMAT_EXTENSIONS: Record<ExportFormat, string> = { csv: 'csv', tsv: 'tsv', json: 'json', sql: 'sql' }

export function quoteIdent(engine: Engine, name: string): string {
  // Backticks for MySQL, BigQuery and ClickHouse; standard double quotes everywhere else.
  return engine === 'mysql' || engine === 'bigquery' || engine === 'clickhouse' ? `\`${name.replace(/`/g, '``')}\`` : `"${name.replace(/"/g, '""')}"`
}

function delimitedField(v: CellValue, delimiter: string, nullText: string): string {
  if (v === null) return nullText
  const s = String(v)
  const needsQuotes = s.includes(delimiter) || /["\r\n]/.test(s) || s !== s.trim()
  return needsQuotes ? `"${s.replace(/"/g, '""')}"` : s
}

/** A SQL literal for one value, following each engine's string and binary rules. */
export function sqlLiteral(v: CellValue, engine: Engine, binary = false): string {
  if (v === null) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : `'${v}'`
  if (typeof v === 'boolean') return engine === 'postgres' ? (v ? 'TRUE' : 'FALSE') : v ? '1' : '0'
  if (binary && /^0x[0-9a-f]*$/i.test(v)) {
    const hex = v.slice(2)
    return engine === 'postgres' ? `'\\x${hex}'` : `X'${hex}'`
  }
  // MySQL treats backslash as an escape inside strings by default.
  const body = engine === 'mysql' ? v.replace(/\\/g, '\\\\').replace(/'/g, "''") : v.replace(/'/g, "''")
  return `'${body}'`
}

/** JSON keys must be unique; repeated column names (joins) get a numeric suffix. */
function uniqueNames(columns: ColumnMeta[]): string[] {
  const seen = new Map<string, number>()
  return columns.map((c) => {
    const n = (seen.get(c.name) ?? 0) + 1
    seen.set(c.name, n)
    return n === 1 ? c.name : `${c.name}_${n}`
  })
}

/**
 * A formatter that can be fed rows in chunks (for streaming a large table to disk)
 * and produces the same text as formatting everything at once.
 */
export function createFormatter(columns: ColumnMeta[], o: FormatOptions) {
  let first = true
  const names = uniqueNames(columns)
  const binary = new Set(o.binaryColumns)
  const delimiter = o.format === 'tsv' ? '\t' : ','

  const head = (): string => {
    if (o.format === 'json') return '[\n'
    if ((o.format === 'csv' || o.format === 'tsv') && o.header) {
      return columns.map((c) => delimitedField(c.name, delimiter, '')).join(delimiter) + '\r\n'
    }
    return ''
  }

  const rows = (chunk: CellValue[][]): string => {
    if (chunk.length === 0) return ''
    let out: string
    switch (o.format) {
      case 'csv':
      case 'tsv':
        out = chunk.map((r) => r.map((v) => delimitedField(v, delimiter, o.nullText)).join(delimiter)).join('\r\n') + '\r\n'
        break
      case 'json':
        out =
          (first ? '' : ',\n') +
          chunk.map((r) => '  ' + JSON.stringify(Object.fromEntries(names.map((n, i) => [n, r[i] ?? null])))).join(',\n')
        break
      case 'sql': {
        const cols = columns.map((c) => quoteIdent(o.engine, c.name)).join(', ')
        const target = quoteIdent(o.engine, o.tableName)
        const parts: string[] = []
        for (let i = 0; i < chunk.length; i += o.batchSize) {
          const values = chunk
            .slice(i, i + o.batchSize)
            .map((r) => `  (${r.map((v, j) => sqlLiteral(v, o.engine, binary.has(j))).join(', ')})`)
            .join(',\n')
          parts.push(`INSERT INTO ${target} (${cols}) VALUES\n${values};\n`)
        }
        out = parts.join('')
        break
      }
    }
    first = false
    return out
  }

  const tail = (): string => (o.format === 'json' ? '\n]\n' : '')

  return { head, rows, tail }
}

export function formatAll(columns: ColumnMeta[], data: CellValue[][], o: FormatOptions): string {
  const f = createFormatter(columns, o)
  return f.head() + f.rows(data) + f.tail()
}
