import type { Engine } from './engines'
export type { Engine } from './engines'

export type EnvTag = 'local' | 'development' | 'testing' | 'staging' | 'production'

export type SslMode = 'disable' | 'prefer' | 'require' | 'verify-full'

export interface SshConfig {
  enabled: boolean
  host: string
  port: number
  user: string
  authMethod: 'password' | 'key' | 'agent'
  privateKeyPath?: string
}

/** Secrets never live in the connection file; they go through the keychain store. */
export interface ConnectionSecrets {
  password?: string
  sshPassword?: string
  sshPassphrase?: string
}

/**
 * off: commit straight away. confirm: always show the SQL and ask first.
 * readonly: no writes at all (enforced in the main process too).
 */
export type SafeMode = 'off' | 'confirm' | 'readonly'

export interface ConnectionConfig {
  id: string
  name: string
  engine: Engine
  group?: string
  color: string
  tag: EnvTag
  host: string
  port: number
  user: string
  database: string
  /** SQLite only */
  filePath?: string
  ssl: { mode: SslMode; caPath?: string }
  ssh: SshConfig
  savePassword: boolean
  /** Missing on connections saved before safe mode existed; see effectiveSafeMode. */
  safeMode?: SafeMode
  /** Engine-specific settings (warehouse, auth database, region...), keyed by EngineInfo.options. */
  options?: Record<string, string>
}

export function effectiveSafeMode(c: Pick<ConnectionConfig, 'safeMode' | 'tag'>): SafeMode {
  return c.safeMode ?? (c.tag === 'production' ? 'confirm' : 'off')
}

/** Shape sent from the editor: config plus any secrets the user typed. */
export interface ConnectionDraft extends ConnectionConfig {
  secrets: ConnectionSecrets
}

export interface ColumnMeta {
  name: string
  type: string
}

export interface ColumnInfo extends ColumnMeta {
  nullable: boolean
  defaultValue: string | null
  isPrimaryKey: boolean
}

/** Cell values are normalized in the main process so they survive IPC unchanged. */
export type CellValue = string | number | boolean | null

export interface QueryResult {
  columns: ColumnMeta[]
  rows: CellValue[][]
  durationMs: number
  sql: string
}

export type TreeNodeKind = 'schema' | 'table' | 'view' | 'function' | 'procedure'

export interface TreeNode {
  kind: TreeNodeKind
  name: string
  schema: string
  /** Routines only: engine-specific identity (Postgres oid) so overloads stay distinct. */
  id?: string
  /** Routines only: argument list shown next to the name. */
  detail?: string
  children?: TreeNode[]
}

export type FilterOp =
  | '='
  | '!='
  | '<'
  | '>'
  | '<='
  | '>='
  | 'contains'
  | 'not contains'
  | 'starts with'
  | 'like'
  | 'in'
  | 'is null'
  | 'is not null'

export const FILTER_OPS: FilterOp[] = [
  '=',
  '!=',
  '<',
  '>',
  '<=',
  '>=',
  'contains',
  'not contains',
  'starts with',
  'like',
  'in',
  'is null',
  'is not null'
]

export interface TableFilter {
  column: string
  op: FilterOp
  value: string
}

export interface TableRequest {
  schema: string
  table: string
  limit: number
  offset: number
  orderBy?: { column: string; dir: 'asc' | 'desc' }
  filters: TableFilter[]
}

/** A value typed by the user. null means SQL NULL. */
export type EditValue = string | null

/**
 * How to find one existing row. With a primary key, `values` holds just the key
 * columns; otherwise it holds every comparable column and the first match is used.
 */
export interface RowKey {
  values: Record<string, CellValue>
  primaryKey: boolean
}

export type RowChange =
  | { kind: 'update'; key: RowKey; set: Record<string, EditValue> }
  /** Columns left out of `values` get their DEFAULT. */
  | { kind: 'insert'; values: Record<string, EditValue> }
  | { kind: 'delete'; key: RowKey }

export interface ChangeSet {
  schema: string
  table: string
  changes: RowChange[]
}

export interface SessionInfo {
  sessionId: string
  connectionId: string
  serverVersion: string
  databases: string[]
  currentDatabase: string
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

/** One statement's outcome in a script run from the query editor. */
export interface StatementResult {
  sql: string
  /** Offsets of the statement within the submitted text. */
  start: number
  end: number
  /** True when the statement returned a result set (even an empty one). */
  hasRows: boolean
  columns: ColumnMeta[]
  rows: CellValue[][]
  /** Rows changed by INSERT/UPDATE/DELETE, when the engine reports it. */
  affected: number | null
  command: string
  durationMs: number
  /** Result set was cut at the row limit. */
  truncated: boolean
}

export interface RunError {
  message: string
  statementIndex: number
  start: number
  end: number
  /** Absolute offset of the error in the submitted text, when the server reports one. */
  position: number | null
}

export interface RunResult {
  results: StatementResult[]
  error: RunError | null
  durationMs: number
}

export interface CompletionTable {
  schema: string
  name: string
  kind: 'table' | 'view'
  columns: ColumnMeta[]
}

export interface HistoryEntry {
  id: string
  connectionId: string
  sql: string
  at: number
  durationMs: number
  ok: boolean
  statements: number
}

export interface SavedQuery {
  id: string
  connectionId: string
  name: string
  sql: string
  updatedAt: number
}

// ---- structure and DDL -------------------------------------------------------------

export interface ColumnDef {
  name: string
  type: string
  nullable: boolean
  /** A SQL expression, exactly as it would appear after DEFAULT ('abc', 0, now()). */
  defaultValue: string | null
  isPrimaryKey: boolean
  autoIncrement: boolean
  comment: string | null
}

export interface IndexDef {
  name: string
  columns: string[]
  unique: boolean
  primary: boolean
  method: string | null
  definition: string | null
}

export type FkAction = 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT'
export const FK_ACTIONS: FkAction[] = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']

export interface ForeignKeyDef {
  name: string
  columns: string[]
  refSchema: string
  refTable: string
  refColumns: string[]
  onUpdate: FkAction
  onDelete: FkAction
}

export interface TriggerDef {
  name: string
  timing: string
  events: string
  definition: string
}

export interface TableStructure {
  schema: string
  name: string
  kind: 'table' | 'view'
  columns: ColumnDef[]
  indexes: IndexDef[]
  foreignKeys: ForeignKeyDef[]
  triggers: TriggerDef[]
  /** CREATE statement(s) that would rebuild the object. */
  ddl: string
}

export type SchemaOp =
  | { op: 'createTable'; columns: ColumnDef[]; foreignKeys: ForeignKeyDef[] }
  | { op: 'addColumn'; column: ColumnDef }
  | { op: 'dropColumn'; name: string }
  /** `from` is the column as introspected, `to` the edited version. */
  | { op: 'alterColumn'; from: ColumnDef; to: ColumnDef }
  | { op: 'addIndex'; index: Pick<IndexDef, 'name' | 'columns' | 'unique'> }
  | { op: 'dropIndex'; name: string }
  | { op: 'addForeignKey'; fk: ForeignKeyDef }
  | { op: 'dropForeignKey'; name: string }
  | { op: 'renameTable'; to: string }

export interface SchemaChange {
  schema: string
  table: string
  ops: SchemaOp[]
}

/** Everything that changes schema or server state goes through one preview/apply path. */
export type AdminAction =
  | { kind: 'schemaChange'; change: SchemaChange }
  | { kind: 'dropObject'; schema: string; name: string; objectType: 'table' | 'view' }
  | { kind: 'truncateTable'; schema: string; name: string }
  | {
      kind: 'createUser'
      name: string
      password: string
      /** MySQL only. */
      host?: string
      login?: boolean
      superuser?: boolean
      createDb?: boolean
      createRole?: boolean
    }
  | { kind: 'dropUser'; name: string; host?: string }

export interface UserInfo {
  name: string
  host: string | null
  attributes: string[]
  memberOf: string[]
}

export interface ProcessInfo {
  id: string
  user: string | null
  database: string | null
  client: string | null
  state: string | null
  seconds: number | null
  query: string | null
  /** This app's own connection. */
  self: boolean
}

// ---- import, export, backup -----------------------------------------------------------

export interface ExportTableRequest {
  schema: string
  table: string
  /** Empty to export every row; the tab's filters to export what is on screen. */
  filters: TableFilter[]
  orderBy?: { column: string; dir: 'asc' | 'desc' }
  options: import('./formats').FormatOptions
  /** SQL format only: put the CREATE statement before the INSERTs. */
  includeCreate: boolean
}

export type ImportFormat = 'csv' | 'tsv' | 'json'

export interface ImportPreview {
  format: ImportFormat
  delimiter: string
  columns: string[]
  /** First rows as display strings (null stays null). */
  sample: (string | null)[][]
  totalRows: number
}

export interface ImportSpec {
  path: string
  format: ImportFormat
  delimiter: string
  header: boolean
  emptyAsNull: boolean
  truncate: boolean
  schema: string
  table: string
  /** Target column and the index of the source column feeding it. */
  mapping: { column: string; source: number }[]
}

/** Streamed from the main process while a long task runs. */
export interface TaskEvent {
  taskId: string
  kind: 'progress' | 'log' | 'delta'
  done?: number
  total?: number | null
  line?: string
  /** delta: the next piece of streamed AI text. */
  text?: string
}

export type ToolName = 'pg_dump' | 'pg_restore' | 'psql' | 'mysqldump' | 'mysql'

export interface ToolStatus {
  name: ToolName
  path: string | null
  version: string | null
  /** True when the path came from the user's settings rather than detection. */
  custom: boolean
}

export interface BackupOptions {
  /** Postgres: plain SQL or pg_dump's custom archive. */
  format: 'plain' | 'custom'
  content: 'all' | 'schema' | 'data'
  /** Empty for everything. Postgres: schema.table; MySQL/SQLite: table. */
  tables: string[]
  /** Postgres plain: DROP ... IF EXISTS before each CREATE. */
  clean: boolean
  /** Postgres: skip ownership and GRANTs so the dump restores under any user. */
  noOwner: boolean
  /** MySQL: include stored routines and events. */
  routines: boolean
  /** MySQL: consistent snapshot for InnoDB without locking. */
  singleTransaction: boolean
}

export interface RestoreOptions {
  /** Postgres custom archives: drop objects before recreating them. */
  clean: boolean
  noOwner: boolean
  singleTransaction: boolean
  stopOnError: boolean
}

export type { AppSettings } from './settings'

/** One table in an entity-relationship diagram. */
export interface ErdTable {
  schema: string
  name: string
  kind: 'table' | 'view'
  columns: { name: string; type: string; pk: boolean; nullable: boolean }[]
  foreignKeys: ForeignKeyDef[]
}

export interface ErdModel {
  tables: ErdTable[]
  /** Tables beyond the size limit, not drawn. */
  truncated: number
  /** Tables whose structure could not be read. */
  failed: string[]
}

/** One connection found in another app's settings, ready to import. */
export interface ImportCandidate {
  key: string
  name: string
  /** The source app's name for the database type. */
  driver: string
  /** Null when we don't support that database yet. */
  engine: Engine | null
  config: ConnectionConfig | null
  notes: string[]
  /** An existing connection that looks the same, if any. */
  duplicateOf: string | null
}
