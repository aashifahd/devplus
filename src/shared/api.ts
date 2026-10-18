import type {
  AdminAction,
  BackupOptions,
  CellValue,
  ChangeSet,
  ColumnMeta,
  ExportTableRequest,
  ImportPreview,
  ImportSpec,
  RestoreOptions,
  ToolName,
  ToolStatus,
  ProcessInfo,
  TableStructure,
  UserInfo,
  CompletionTable,
  ErdModel,
  ImportCandidate,
  Engine,
  HistoryEntry,
  RunResult,
  SavedQuery,
  ColumnInfo,
  ConnectionConfig,
  ConnectionDraft,
  ConnectionSecrets,
  QueryResult,
  SessionInfo,
  TableRequest,
  TreeNode
} from './types'
import type { FormatOptions } from './formats'
import type { AiProvider, AppSettings, DeepPartial } from './settings'
import type { MetricsBoard } from './metrics'
import type { AppInfo, UpdateState } from './app'
import type { ServerDraft, ServerEngine, ServerRelease, ServerState, ServerView, LocalServer } from './servers'
import type { AiRequest, AiResult, AiTestRequest } from './ai'

/** Event channel for TaskEvent updates (progress and tool output). */
export const TASK_EVENT = 'task:event'

/**
 * Every IPC channel and its signature. The preload exposes exactly this map,
 * and the main process registers a handler for each key.
 */
export interface Api {
  'connections:list': () => ConnectionConfig[]
  'connections:save': (draft: ConnectionDraft) => ConnectionConfig
  'connections:delete': (id: string) => void
  'connections:secrets': (id: string) => { hasPassword: boolean }
  'connections:test': (draft: ConnectionDraft) => string
  'session:open': (connectionId: string, override?: ConnectionSecrets) => SessionInfo
  'session:close': (sessionId: string) => void
  'session:switchDb': (sessionId: string, name: string) => SessionInfo
  'session:tree': (sessionId: string) => TreeNode[]
  'session:columns': (sessionId: string, schema: string, table: string) => ColumnInfo[]
  'session:fetch': (sessionId: string, req: TableRequest) => QueryResult
  'session:count': (sessionId: string, req: TableRequest) => number
  'session:previewChanges': (sessionId: string, set: ChangeSet) => string[]
  'session:applyChanges': (sessionId: string, set: ChangeSet) => number
  'query:run': (sessionId: string, sql: string) => RunResult
  'query:explain': (sessionId: string, statement: string) => RunResult
  'query:cancel': (sessionId: string) => void
  'query:capabilities': (sessionId: string) => { canCancel: boolean; engine: Engine }
  'query:completions': (sessionId: string) => CompletionTable[]
  'structure:get': (sessionId: string, schema: string, table: string) => TableStructure
  'structure:routine': (sessionId: string, node: TreeNode) => string
  'schema:erd': (sessionId: string, schema: string, taskId: string) => ErdModel
  'metrics:list': (connectionId: string) => MetricsBoard[]
  'metrics:save': (board: MetricsBoard) => MetricsBoard
  'metrics:delete': (id: string) => void
  'metrics:run': (sessionId: string, sql: string) => RunResult
  'admin:users': (sessionId: string) => UserInfo[]
  'admin:processes': (sessionId: string) => ProcessInfo[]
  'admin:kill': (sessionId: string, id: string, mode: 'cancel' | 'terminate') => void
  'admin:preview': (sessionId: string, action: AdminAction) => string[]
  'admin:apply': (sessionId: string, action: AdminAction) => void
  'export:table': (sessionId: string, req: ExportTableRequest, path: string, taskId: string) => number
  'export:rows': (data: { columns: ColumnMeta[]; rows: CellValue[][]; options: FormatOptions }, path: string) => number
  'import:preview': (path: string, opts: { delimiter?: string; header: boolean }) => ImportPreview
  'import:run': (sessionId: string, spec: ImportSpec, taskId: string) => number
  'import:sqlFile': (sessionId: string, path: string, taskId: string) => { statements: number; durationMs: number }
  'tools:status': (sessionId: string) => ToolStatus[]
  'tools:setPath': (name: ToolName, path: string | null) => void
  'backup:run': (sessionId: string, opts: BackupOptions, path: string, taskId: string) => { bytes: number }
  'restore:run': (sessionId: string, opts: RestoreOptions, path: string, taskId: string) => void
  'settings:get': () => AppSettings
  'settings:update': (patch: DeepPartial<AppSettings>) => AppSettings
  'ai:setKey': (provider: AiProvider, key: string | null) => void
  'ai:keyStatus': () => Record<AiProvider, boolean>
  'ai:ask': (req: AiRequest) => AiResult
  'ai:cancel': (taskId: string) => void
  'ai:test': (req: AiTestRequest) => string
  'plugins:list': () => { id: string; file: string; source: string; bytes: number }[]
  'plugins:openFolder': () => void
  'plugins:createExample': () => string
  'files:writeText': (path: string, text: string) => number
  'servers:catalog': () => { releases: ServerRelease[]; installed: Record<ServerEngine, string[]> }
  'servers:list': () => ServerView[]
  'servers:suggestPort': (engine: ServerEngine) => number
  'servers:create': (draft: ServerDraft, taskId: string) => ServerView
  'servers:start': (id: string) => ServerState
  'servers:stop': (id: string) => ServerState
  'servers:restart': (id: string) => ServerState
  'servers:update': (id: string, patch: Partial<Pick<LocalServer, 'name' | 'port' | 'autoStart' | 'binlog'>>) => ServerView
  'servers:delete': (id: string, deleteData: boolean) => void
  'servers:logs': (id: string) => string
  'servers:open': (id: string, which: 'data' | 'config' | 'log') => void
  'servers:connection': (id: string) => ConnectionConfig
  'import:tableplusFind': () => string | null
  'import:tableplusRead': (path: string) => ImportCandidate[]
  'import:save': (configs: ConnectionConfig[]) => number
  'app:info': () => AppInfo
  'app:openLogs': () => void
  'app:openNotices': () => void
  'app:logError': (message: string, stack?: string) => void
  'app:reportProblem': () => string
  'updates:state': () => UpdateState
  'updates:check': () => UpdateState
  'updates:download': () => UpdateState
  'updates:install': () => void
  'history:list': (connectionId: string) => HistoryEntry[]
  'history:clear': (connectionId: string) => void
  'saved:list': (connectionId: string) => SavedQuery[]
  'saved:save': (q: { id?: string; connectionId: string; name: string; sql: string }) => SavedQuery
  'saved:delete': (id: string) => void
  'dialog:openFile': (opts: { title: string; filters?: { name: string; extensions: string[] }[] }) => string | null
  'dialog:saveFile': (opts: { title: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => string | null
}

export type Channel = keyof Api

export const CHANNELS: Channel[] = [
  'connections:list',
  'connections:save',
  'connections:delete',
  'connections:secrets',
  'connections:test',
  'session:open',
  'session:close',
  'session:switchDb',
  'session:tree',
  'session:columns',
  'session:fetch',
  'session:count',
  'session:previewChanges',
  'session:applyChanges',
  'query:run',
  'query:explain',
  'query:cancel',
  'query:capabilities',
  'query:completions',
  'structure:get',
  'structure:routine',
  'schema:erd',
  'metrics:list',
  'metrics:save',
  'metrics:delete',
  'metrics:run',
  'admin:users',
  'admin:processes',
  'admin:kill',
  'admin:preview',
  'admin:apply',
  'export:table',
  'export:rows',
  'import:preview',
  'import:run',
  'import:sqlFile',
  'tools:status',
  'tools:setPath',
  'backup:run',
  'restore:run',
  'settings:get',
  'settings:update',
  'ai:setKey',
  'ai:keyStatus',
  'ai:ask',
  'ai:cancel',
  'ai:test',
  'plugins:list',
  'plugins:openFolder',
  'plugins:createExample',
  'files:writeText',
  'servers:catalog',
  'servers:list',
  'servers:suggestPort',
  'servers:create',
  'servers:start',
  'servers:stop',
  'servers:restart',
  'servers:update',
  'servers:delete',
  'servers:logs',
  'servers:open',
  'servers:connection',
  'import:tableplusFind',
  'import:tableplusRead',
  'import:save',
  'app:info',
  'app:openLogs',
  'app:openNotices',
  'app:logError',
  'app:reportProblem',
  'updates:state',
  'updates:check',
  'updates:download',
  'updates:install',
  'history:list',
  'history:clear',
  'saved:list',
  'saved:save',
  'saved:delete',
  'dialog:openFile',
  'dialog:saveFile'
]
