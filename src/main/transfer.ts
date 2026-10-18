import { createWriteStream, readFileSync, rmSync, statSync } from 'node:fs'
import { once } from 'node:events'
import { extname } from 'node:path'
import type { CellValue, ColumnMeta, Engine, ExportTableRequest, ImportFormat, ImportPreview, ImportSpec } from '@shared/types'
import { createFormatter, formatAll, type FormatOptions } from '@shared/formats'
import { detectDelimiter, parseDelimited } from '@shared/csv'
import { isReadStatement, splitStatements } from '@shared/sqlsplit'
import type { DriverSession } from './drivers/types'
import { tableRef, type Statement } from './drivers/sql'

export type Progress = (done: number, total: number | null) => void

const PAGE = 5000
const MAX_FILE_BYTES = 512 * 1024 * 1024
const BINARY = /bytea|blob|binary/i

/** Calls `fn` at most every 150 ms, plus whenever `force` is set (the final update). */
function throttle(fn: Progress): (done: number, total: number | null, force?: boolean) => void {
  let last = 0
  return (done, total, force) => {
    const now = Date.now()
    if (force || now - last > 150) {
      last = now
      fn(done, total)
    }
  }
}

/** Stream text to a file, removing the partial file if anything fails. */
async function writeFile(path: string, produce: (write: (s: string) => Promise<void>) => Promise<void>) {
  const out = createWriteStream(path, { encoding: 'utf8' })
  const write = async (s: string) => {
    if (s && !out.write(s)) await once(out, 'drain')
  }
  try {
    await produce(write)
    out.end()
    await once(out, 'finish')
  } catch (err) {
    out.destroy()
    rmSync(path, { force: true })
    throw err
  }
}

function readText(path: string): string {
  const size = statSync(path).size
  if (size > MAX_FILE_BYTES) throw new Error(`The file is ${(size / 1e6).toFixed(0)} MB; the limit is ${MAX_FILE_BYTES / 1e6} MB.`)
  return readFileSync(path, 'utf8').replace(/^﻿/, '')
}

// ---- export ----------------------------------------------------------------------------

/** Page through a table and stream it to disk, so size is bounded by the file, not memory. */
export async function exportTable(driver: DriverSession, req: ExportTableRequest, path: string, onProgress: Progress): Promise<number> {
  const declared = await driver.columns(req.schema, req.table)
  const pk = declared.find((c) => c.isPrimaryKey)
  // A stable order keeps pages from overlapping or skipping rows.
  const orderBy = req.orderBy ?? (pk ? { column: pk.name, dir: 'asc' as const } : undefined)
  const base = { schema: req.schema, table: req.table, filters: req.filters, orderBy, limit: PAGE, offset: 0 }
  const total = await driver.countTable(base).catch(() => null)
  const report = throttle(onProgress)
  const typeOf = new Map(declared.map((c) => [c.name, c.type]))
  let count = 0

  await writeFile(path, async (write) => {
    if (req.includeCreate && req.options.format === 'sql' && driver.structure) {
      const st = await driver.structure(req.schema, req.table)
      await write(`${st.ddl}\n\n`)
    }
    let formatter: ReturnType<typeof createFormatter> | null = null
    for (let offset = 0; ; offset += PAGE) {
      const page = await driver.fetchTable({ ...base, offset }, { fullBinary: true })
      if (!formatter) {
        const binaryColumns = page.columns.flatMap((c, i) => (BINARY.test(typeOf.get(c.name) ?? c.type) ? [i] : []))
        formatter = createFormatter(page.columns, { ...req.options, tableName: req.options.tableName || req.table, binaryColumns })
        await write(formatter.head())
      }
      await write(formatter.rows(page.rows))
      count += page.rows.length
      report(count, total)
      if (page.rows.length < PAGE) break
    }
    await write(formatter!.tail())
  })
  report(count, total, true)
  return count
}

/** Write rows the renderer already has (a query result). */
export async function exportRows(columns: ColumnMeta[], rows: CellValue[][], options: FormatOptions, path: string): Promise<number> {
  const binaryColumns = columns.flatMap((c, i) => (BINARY.test(c.type) ? [i] : []))
  await writeFile(path, (write) => write(formatAll(columns, rows, { ...options, binaryColumns })))
  return rows.length
}

// ---- import ----------------------------------------------------------------------------

interface ParsedSource {
  format: ImportFormat
  delimiter: string
  columns: string[]
  rows: unknown[][]
}

function formatFromPath(path: string): ImportFormat {
  const ext = extname(path).toLowerCase()
  return ext === '.json' ? 'json' : ext === '.tsv' || ext === '.tab' ? 'tsv' : 'csv'
}

function parseSource(path: string, opts: { format?: ImportFormat; delimiter?: string; header: boolean }): ParsedSource {
  const text = readText(path)
  const format = opts.format ?? formatFromPath(path)

  if (format === 'json') {
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch (err) {
      throw new Error(`Not valid JSON: ${(err as Error).message}`)
    }
    // Accept a bare array or a common wrapper like { "rows": [...] }.
    const list = Array.isArray(data) ? data : Object.values(data as object).find(Array.isArray)
    if (!Array.isArray(list)) throw new Error('Expected a JSON array of objects.')
    const objects = list.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x))
    if (objects.length === 0) throw new Error('The JSON array has no objects to import.')
    const keys: string[] = []
    for (const o of objects.slice(0, 1000)) for (const k of Object.keys(o)) if (!keys.includes(k)) keys.push(k)
    return { format, delimiter: '', columns: keys, rows: objects.map((o) => keys.map((k) => o[k])) }
  }

  const delimiter = format === 'tsv' ? '\t' : opts.delimiter || detectDelimiter(text.slice(0, 65536))
  const all = parseDelimited(text, delimiter)
  if (all.length === 0) throw new Error('The file is empty.')
  const width = Math.max(...all.slice(0, 100).map((r) => r.length))
  const columns = opts.header ? all[0].map((c, i) => c.trim() || `column_${i + 1}`) : Array.from({ length: width }, (_, i) => `column_${i + 1}`)
  return { format, delimiter, columns, rows: opts.header ? all.slice(1) : all }
}

const displayValue = (v: unknown): string | null =>
  v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v)

export function previewImport(path: string, opts: { delimiter?: string; header: boolean }): ImportPreview {
  const src = parseSource(path, opts)
  return {
    format: src.format,
    delimiter: src.delimiter,
    columns: src.columns,
    sample: src.rows.slice(0, 20).map((r) => src.columns.map((_, i) => displayValue(r[i]))),
    totalRows: src.rows.length
  }
}

/** Shape a source value into a bind parameter every driver accepts. */
function toParam(v: unknown, engine: Engine, emptyAsNull: boolean): string | number | bigint | boolean | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v === '' && emptyAsNull ? null : v
  // node:sqlite binds every JS number as REAL, so a TEXT column would store 40 as "40.0".
  if (typeof v === 'number') return engine === 'sqlite' && Number.isSafeInteger(v) ? BigInt(v) : v
  // node:sqlite cannot bind booleans, and MySQL would read 'true' as 0.
  if (typeof v === 'boolean') return engine === 'postgres' ? v : engine === 'sqlite' ? (v ? 1n : 0n) : v ? 1 : 0
  return JSON.stringify(v)
}

/**
 * Insert every row in one transaction with parameterized multi-row INSERTs.
 * Any failure rolls back everything, so a half-imported table never happens.
 */
export async function importIntoTable(driver: DriverSession, engine: Engine, spec: ImportSpec, onProgress: Progress): Promise<number> {
  if (spec.mapping.length === 0) throw new Error('Map at least one column.')
  const src = parseSource(spec.path, { format: spec.format, delimiter: spec.delimiter, header: spec.header })
  const d = driver.dialect
  const execute = driver.execute?.bind(driver)
  if (!d || !execute) throw new Error('Importing rows is not available for this engine.')
  const ref = tableRef(d, spec.schema, spec.table)
  const cols = spec.mapping.map((m) => d.quote(m.column)).join(', ')
  // Stay well under every engine's bound-parameter limit (SQLite's is the lowest).
  const rowsPerStatement = Math.max(1, Math.min(500, Math.floor(30000 / spec.mapping.length)))

  const statements: Statement[] = []
  const rowsAfter: number[] = []
  if (spec.truncate) {
    // TRUNCATE commits implicitly on MySQL, which would defeat the rollback; DELETE does not.
    statements.push({ sql: engine === 'postgres' ? `TRUNCATE TABLE ${ref}` : `DELETE FROM ${ref}`, params: [], expectOne: false })
    rowsAfter.push(0)
  }
  for (let start = 0; start < src.rows.length; start += rowsPerStatement) {
    const chunk = src.rows.slice(start, start + rowsPerStatement)
    const params: unknown[] = []
    const tuples = chunk.map((row) => {
      const marks = spec.mapping.map((m) => {
        params.push(toParam(row[m.source], engine, spec.emptyAsNull))
        return d.param(params.length)
      })
      return `(${marks.join(', ')})`
    })
    statements.push({ sql: `INSERT INTO ${ref} (${cols}) VALUES ${tuples.join(', ')}`, params, expectOne: false })
    rowsAfter.push(start + chunk.length)
  }

  const report = throttle(onProgress)
  let completed = -1
  try {
    await execute(statements, (i) => {
      completed = i
      report(rowsAfter[i], src.rows.length)
    })
  } catch (err) {
    const failed = completed + 1
    const from = failed > 0 ? rowsAfter[failed - 1] + 1 : 1
    const to = rowsAfter[failed] ?? src.rows.length
    const where = spec.truncate && failed === 0 ? 'Clearing the table failed' : `Rows ${from}–${to} failed`
    throw new Error(`${where}: ${(err as Error).message}. Nothing was imported.`)
  }
  report(src.rows.length, src.rows.length, true)
  return src.rows.length
}

// ---- SQL files ---------------------------------------------------------------------------

const lineOf = (text: string, offset: number) => text.slice(0, offset).split('\n').length

/** Run a .sql file statement by statement (autocommit), stopping at the first error. */
export async function runSqlFile(
  driver: DriverSession,
  engine: Engine,
  path: string,
  readOnly: boolean,
  onProgress: Progress
): Promise<{ statements: number; durationMs: number }> {
  const text = readText(path)
  if (engine === 'postgres' && /\bFROM\s+stdin\s*;/i.test(text)) {
    throw new Error('This is a pg_dump file with COPY data. Restore it through Backup & Restore (psql) instead.')
  }
  if (engine === 'mysql' && /^\s*DELIMITER\s+/im.test(text)) {
    throw new Error('This file uses DELIMITER, a mysql command-line directive. Restore it through Backup & Restore instead.')
  }
  const spans = splitStatements(text, engine)
  if (readOnly) {
    const write = spans.find((s) => !isReadStatement(s.text, engine))
    if (write) throw new Error(`This connection is read-only; line ${lineOf(text, write.start)} changes data.`)
  }
  const report = throttle(onProgress)
  const started = performance.now()
  for (const [i, span] of spans.entries()) {
    try {
      await driver.runStatement(span.text)
    } catch (err) {
      const applied = i === 0 ? 'Nothing before it ran.' : `The ${i} statement${i === 1 ? '' : 's'} before it already ran.`
      throw new Error(`Statement ${i + 1} of ${spans.length} (line ${lineOf(text, span.start)}) failed: ${(err as Error).message}. ${applied}`)
    }
    report(i + 1, spans.length)
  }
  report(spans.length, spans.length, true)
  return { statements: spans.length, durationMs: performance.now() - started }
}
