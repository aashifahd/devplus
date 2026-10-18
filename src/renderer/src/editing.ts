import type { CellValue, ChangeSet, ColumnInfo, EditValue, QueryResult, RowChange, RowKey } from '@shared/types'

/** Unsaved work in one table tab. Row numbers index into the current page of results. */
export interface Pending {
  edits: Map<number, Record<string, EditValue>>
  deleted: Set<number>
  inserts: Record<string, EditValue>[]
}

export const emptyPending = (): Pending => ({ edits: new Map(), deleted: new Set(), inserts: [] })

export function countPending(p: Pending): number {
  let n = p.deleted.size + p.inserts.length
  for (const [row] of p.edits) if (!p.deleted.has(row)) n++
  return n
}

const BINARY = /bytea|blob|binary/i
export const isBinaryType = (type: string) => BINARY.test(type)

/**
 * Indexes of result columns holding binary data. The declared schema type wins:
 * MySQL sends TEXT columns as BLOB on the wire, so the result type alone misleads.
 */
export function binaryColumns(result: QueryResult, columns: ColumnInfo[]): Set<number> {
  const declared = new Map(columns.map((c) => [c.name, c.type]))
  return new Set(result.columns.flatMap((c, i) => (isBinaryType(declared.get(c.name) ?? c.type) ? [i] : [])))
}

/** Value as it will be committed: the pending edit if any, else what the server sent. */
export function currentValue(result: QueryResult, p: Pending, row: number, col: number): CellValue | undefined {
  const name = result.columns[col].name
  const base = result.rows.length
  if (row >= base) {
    const values = p.inserts[row - base]
    return values && name in values ? values[name] : undefined
  }
  const edit = p.edits.get(row)
  if (edit && name in edit) return edit[name]
  return result.rows[row]?.[col]
}

/**
 * Prefer the primary key; without one, match on every non-binary column
 * (the server then changes only the first matching row).
 */
export function rowKey(result: QueryResult, columns: ColumnInfo[], row: number): RowKey {
  const pk = columns.filter((c) => c.isPrimaryKey).map((c) => c.name)
  const pick = (names: string[]) =>
    Object.fromEntries(
      names
        .map((n) => [n, result.columns.findIndex((c) => c.name === n)] as const)
        .filter(([, i]) => i >= 0)
        .map(([n, i]) => [n, result.rows[row][i]])
    )
  if (pk.length > 0) return { primaryKey: true, values: pick(pk) }
  const binary = binaryColumns(result, columns)
  const comparable = result.columns.filter((_, i) => !binary.has(i)).map((c) => c.name)
  return { primaryKey: false, values: pick(comparable) }
}

export function buildChangeSet(
  schema: string,
  table: string,
  result: QueryResult,
  columns: ColumnInfo[],
  p: Pending
): ChangeSet {
  const changes: RowChange[] = []
  for (const row of [...p.deleted].sort((a, b) => a - b)) {
    changes.push({ kind: 'delete', key: rowKey(result, columns, row) })
  }
  for (const [row, set] of [...p.edits].sort(([a], [b]) => a - b)) {
    if (p.deleted.has(row) || Object.keys(set).length === 0) continue
    changes.push({ kind: 'update', key: rowKey(result, columns, row), set })
  }
  for (const values of p.inserts) changes.push({ kind: 'insert', values })
  return { schema, table, changes }
}

/** Return a new Pending with one cell set, dropping edits that match the original. */
export function withCellValue(result: QueryResult, p: Pending, row: number, col: number, value: EditValue): Pending {
  const name = result.columns[col].name
  const base = result.rows.length
  if (row >= base) {
    const inserts = p.inserts.map((v, i) => (i === row - base ? { ...v, [name]: value } : v))
    return { ...p, inserts }
  }
  const original = result.rows[row][col]
  const edits = new Map(p.edits)
  const rowEdits = { ...(edits.get(row) ?? {}) }
  const same = original === null ? value === null : value !== null && String(original) === value
  if (same) delete rowEdits[name]
  else rowEdits[name] = value
  if (Object.keys(rowEdits).length) edits.set(row, rowEdits)
  else edits.delete(row)
  return { ...p, edits }
}

/** Put an inserted row's column back to DEFAULT, or an edited cell back to its original. */
export function withCellReverted(result: QueryResult, p: Pending, row: number, col: number): Pending {
  const name = result.columns[col].name
  const base = result.rows.length
  if (row >= base) {
    const inserts = p.inserts.map((v, i) => {
      if (i !== row - base) return v
      const { [name]: _, ...rest } = v
      return rest
    })
    return { ...p, inserts }
  }
  const edits = new Map(p.edits)
  const { [name]: _, ...rest } = edits.get(row) ?? {}
  if (Object.keys(rest).length) edits.set(row, rest)
  else edits.delete(row)
  return { ...p, edits }
}

/** Mark existing rows deleted and drop inserted rows outright. */
export function withRowsDeleted(result: QueryResult, p: Pending, rows: number[]): Pending {
  const base = result.rows.length
  const deleted = new Set(p.deleted)
  const dropInserts = new Set<number>()
  for (const r of rows) {
    if (r >= base) dropInserts.add(r - base)
    else deleted.add(r)
  }
  return { ...p, deleted, inserts: p.inserts.filter((_, i) => !dropInserts.has(i)) }
}

export function withRowsRestored(p: Pending, rows: number[]): Pending {
  const deleted = new Set(p.deleted)
  for (const r of rows) deleted.delete(r)
  return { ...p, deleted }
}

/** Copy a row into a new insert, leaving primary keys to their DEFAULT (e.g. serial). */
export function withRowDuplicated(result: QueryResult, columns: ColumnInfo[], p: Pending, row: number): Pending {
  const pk = new Set(columns.filter((c) => c.isPrimaryKey).map((c) => c.name))
  const binary = binaryColumns(result, columns)
  const values: Record<string, EditValue> = {}
  result.columns.forEach((c, i) => {
    if (pk.has(c.name) || binary.has(i)) return
    const v = currentValue(result, p, row, i)
    if (v !== undefined) values[c.name] = v === null ? null : String(v)
  })
  return { ...p, inserts: [...p.inserts, values] }
}
