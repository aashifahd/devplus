import type {
  AdminAction,
  CellValue,
  ChangeSet,
  ColumnInfo,
  ColumnMeta,
  CompletionTable,
  ProcessInfo,
  QueryResult,
  TableRequest,
  TableStructure,
  TreeNode,
  UserInfo
} from '@shared/types'
import type { Dialect, Statement } from './sql'

/** Where the driver should actually connect (after any SSH tunnel is applied). */
export interface Endpoint {
  host: string
  port: number
}

/** What a single raw statement produced, before the session adds timing and offsets. */
export interface RawStatementResult {
  hasRows: boolean
  columns: ColumnMeta[]
  rows: CellValue[][]
  affected: number | null
  command: string
  truncated: boolean
}

/**
 * The contract every engine implements. SQL engines provide `dialect` and `execute`,
 * and the shared builders do the rest; other engines supply `changes` and `admin`
 * themselves. Optional members correspond to EngineCapabilities flags.
 */
export interface DriverSession {
  readonly serverVersion: string
  /** SQL engines only: quoting, parameters and paging for the shared SQL builder. */
  readonly dialect?: Dialect
  listDatabases(): Promise<string[]>
  currentDatabase(): string
  switchDatabase(name: string): Promise<void>
  tree(): Promise<TreeNode[]>
  columns(schema: string, table: string): Promise<ColumnInfo[]>
  /** `fullBinary` keeps whole binary values instead of a short preview (for export). */
  fetchTable(req: TableRequest, opts?: { fullBinary?: boolean }): Promise<QueryResult>
  countTable(req: TableRequest): Promise<number>
  /** SQL engines: run all statements in one transaction; returns rows affected by each (-1 if unknown). */
  execute?(statements: Statement[], onStatement?: (index: number) => void): Promise<number[]>
  /** Non-SQL engines: preview and apply grid edits natively. */
  changes?: { preview(set: ChangeSet): string[] | Promise<string[]>; apply(set: ChangeSet): Promise<number> }
  /** Run one statement typed by the user. SQL Server batches can return several result sets. */
  runStatement(sql: string): Promise<RawStatementResult | RawStatementResult[]>
  /** Run `fn` with the server refusing writes where the engine supports it. */
  withReadOnly<T>(fn: () => Promise<T>): Promise<T>
  readonly canCancel: boolean
  /** Ask the server to stop whatever this session is running. */
  cancel(): Promise<void>
  /** Tables and columns for editor autocomplete, for the current database. */
  completions(): Promise<CompletionTable[]>
  structure?(schema: string, table: string): Promise<TableStructure>
  /** Plan for one statement, when the engine needs more than prefixing EXPLAIN. */
  explain?(statement: string): Promise<RawStatementResult>
  /** Non-SQL engines: their own drop, truncate and user management. */
  admin?: { preview(action: AdminAction): string[]; apply(action: AdminAction): Promise<void> }
  /** CREATE statement for a function or procedure node from the tree. */
  routineDefinition?(node: TreeNode): Promise<string>
  users?(): Promise<UserInfo[]>
  processes?(): Promise<ProcessInfo[]>
  kill?(id: string, mode: 'cancel' | 'terminate'): Promise<void>
  close(): Promise<void>
}

/** Thrown inside a transaction so the driver rolls back before reporting it. Negative means "engine can't tell". */
export function checkAffected(statement: Statement, index: number, affected: number) {
  if (statement.expectOne && affected >= 0 && affected !== 1) {
    throw new Error(
      `Change ${index + 1} matched ${affected} rows instead of 1 (the row may have been changed or deleted by someone else). Nothing was saved.`
    )
  }
}

/** Pull "BEFORE INSERT OR UPDATE" style timing and events out of a CREATE TRIGGER statement. */
export function parseTriggerHeader(sql: string): { timing: string; events: string } {
  const m = /\b(BEFORE|AFTER|INSTEAD\s+OF)\s+(.+?)\s+ON\b/is.exec(sql)
  return { timing: m?.[1].toUpperCase().replace(/\s+/g, ' ') ?? '', events: m?.[2].replace(/\s+/g, ' ').toUpperCase() ?? '' }
}

/** Build a ColumnMeta list from the keys of document-style records, in first-seen order. */
export function unionKeys(records: Record<string, unknown>[], preferFirst: string[] = []): string[] {
  const keys = [...preferFirst]
  for (const r of records) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k)
  return keys
}

/** Describe a JS value's type for result headers of schemaless engines. */
export function typeOfValue(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (Array.isArray(v)) return 'array'
  if (v instanceof Date) return 'date'
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return 'binary'
  return typeof v
}

export const notSupported = (engine: string, what: string) => new Error(`${what} is not available for ${engine}.`)
