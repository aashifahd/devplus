import { create } from 'zustand'
import type {
  CellValue,
  ColumnMeta,
  CompletionTable,
  ConnectionConfig,
  ConnectionSecrets,
  EnvTag,
  SessionInfo,
  TableFilter,
  TableRequest,
  TreeNode
} from '@shared/types'
import { call } from './api'
import { ENGINES } from '@shared/engines'
import type { AppSettings, DeepPartial } from '@shared/settings'
import { applyTheme } from './theme'

export interface TableTab {
  type: 'table'
  id: string
  schema: string
  table: string
  kind: TreeNode['kind']
  /** Rows or the structure editor; kept here so the tree can switch it. */
  view: 'data' | 'structure'
}

/** The table designer for a table that does not exist yet. */
export interface NewTableTab {
  type: 'newTable'
  id: string
  schema: string
  title: string
}

/** One-per-connection admin screens. */
export interface ToolTab {
  type: 'users' | 'processes'
  id: string
  title: string
}

/** Entity-relationship diagram for one schema. */
export interface ErdTab {
  type: 'erd'
  id: string
  schema: string
  title: string
}

/** A dashboard of charts built from queries. */
export interface MetricsTab {
  type: 'metrics'
  id: string
  boardId: string
  title: string
}

export interface QueryTab {
  type: 'query'
  id: string
  title: string
  /** Set once the tab is saved, so Ctrl+S updates instead of asking for a name. */
  savedId?: string
  /** Text to start with (an opened saved query). */
  initialSql?: string
}

export type Tab = TableTab | QueryTab | NewTableTab | ToolTab | ErdTab | MetricsTab

/** Workspace-level dialogs, opened from tabs, the tree or the header. */
export type DialogRequest =
  | { type: 'exportTable'; schema: string; table: string; filters: TableFilter[]; orderBy?: TableRequest['orderBy'] }
  | { type: 'exportRows'; name: string; columns: ColumnMeta[]; rows: CellValue[][]; tableName: string }
  | { type: 'import'; schema: string; table: string }
  | { type: 'backup' }
  | { type: 'restore' }

interface AppState {
  connections: ConnectionConfig[]
  connection: ConnectionConfig | null
  session: SessionInfo | null
  tree: TreeNode[]
  treeLoading: boolean
  tabs: Tab[]
  activeTabId: string | null
  /** Tables and columns for editor autocomplete in the current database. */
  completions: CompletionTable[]
  /** Unsaved change count per tab, so closing or switching can warn first. */
  dirty: Record<string, number>
  dialog: DialogRequest | null
  /** Bumped to make an open table tab re-fetch (after an import or restore). */
  reloadTokens: Record<string, number>
  error: string | null
  settings: AppSettings | null
  /** Neutral, auto-dismissing message (plugin notifications, confirmations). */
  notice: string | null
  /** Full-window overlays opened from shortcuts or the palette. */
  overlay: 'palette' | 'settings' | null
  /** Which settings section opens next (e.g. About from "Check for updates"). */
  settingsSection: 'appearance' | 'keyboard' | 'ai' | 'servers' | 'plugins' | 'about'
  /** Text the AI panel should start with (set by "Ask AI" from elsewhere). */
  aiPrompt: { tabId: string; text: string } | null

  loadConnections(): Promise<void>
  connect(conn: ConnectionConfig, override?: ConnectionSecrets): Promise<void>
  disconnect(): Promise<void>
  switchDatabase(name: string): Promise<void>
  refreshTree(): Promise<void>
  refreshCompletions(): Promise<void>
  openTable(node: TreeNode, view?: TableTab['view']): void
  setTableView(id: string, view: TableTab['view']): void
  openNewTable(schema: string): void
  openTool(type: ToolTab['type']): void
  /** Swap a tab for the table it now refers to (after create or rename). */
  replaceWithTable(oldId: string, schema: string, table: string, view: TableTab['view']): void
  openQuery(opts?: { title?: string; sql?: string; savedId?: string }): void
  updateQueryTab(id: string, patch: Partial<Pick<QueryTab, 'title' | 'savedId'>>): void
  closeTab(id: string): void
  setActiveTab(id: string): void
  setDirty(tabId: string, count: number): void
  openDialog(dialog: DialogRequest | null): void
  reloadTable(schema: string, table: string): void
  reloadAllTables(): void
  setError(error: string | null): void
  loadSettings(): Promise<void>
  updateSettings(patch: DeepPartial<AppSettings>): Promise<void>
  setOverlay(overlay: AppState['overlay']): void
  setNotice(notice: string | null): void
  openErd(schema: string): void
  openMetrics(boardId: string, title: string): void
  updateTabTitle(id: string, title: string): void
  /** Open the AI panel in the active SQL tab (or a new one), optionally with starting text. */
  askAi(text: string): void
}

export const TAG_COLORS: Record<EnvTag, string> = {
  local: '#8a8f98',
  development: '#1f9d55',
  testing: '#7c5cff',
  staging: '#e08a12',
  production: '#d93a3a'
}

export const ENGINE_LABELS = Object.fromEntries(Object.entries(ENGINES).map(([k, v]) => [k, v.label])) as Record<ConnectionConfig['engine'], string>

const tabId = (schema: string, table: string) => `${schema}.${table}`

/** Ask before throwing away unsaved edits. Returns true when it is fine to continue. */
function confirmDiscard(count: number): boolean {
  return count === 0 || confirm(`Discard ${count} unsaved change${count === 1 ? '' : 's'}?`)
}

let queryCounter = 0

const totalDirty = (dirty: Record<string, number>) => Object.values(dirty).reduce((a, b) => a + b, 0)

export const useApp = create<AppState>((set, get) => ({
  connections: [],
  connection: null,
  session: null,
  tree: [],
  treeLoading: false,
  tabs: [],
  activeTabId: null,
  completions: [],
  dirty: {},
  dialog: null,
  reloadTokens: {},
  error: null,
  settings: null,
  notice: null,
  overlay: null,
  settingsSection: 'appearance',
  aiPrompt: null,

  async loadConnections() {
    set({ connections: await call('connections:list') })
  },

  async connect(conn, override) {
    const session = await call('session:open', conn.id, override)
    set({ connection: conn, session, tabs: [], activeTabId: null, tree: [], dirty: {}, error: null })
    await get().refreshTree()
  },

  async disconnect() {
    const { session, dirty } = get()
    if (!confirmDiscard(totalDirty(dirty))) return
    if (session) await call('session:close', session.sessionId).catch(() => {})
    set({ connection: null, session: null, tree: [], tabs: [], activeTabId: null, dirty: {} })
  },

  async switchDatabase(name) {
    const { session, dirty } = get()
    if (!session || !confirmDiscard(totalDirty(dirty))) return
    try {
      const next = await call('session:switchDb', session.sessionId, name)
      set({ session: next, tabs: [], activeTabId: null, dirty: {} })
      await get().refreshTree()
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  async refreshCompletions() {
    const { session } = get()
    if (!session) return
    try {
      set({ completions: await call('query:completions', session.sessionId) })
    } catch {
      // Autocomplete is a convenience; a failure here should not interrupt work.
      set({ completions: [] })
    }
  },

  openQuery(opts) {
    // Re-focus a saved query that is already open rather than duplicating it.
    const existing = opts?.savedId && get().tabs.find((t) => t.type === 'query' && t.savedId === opts.savedId)
    if (existing) {
      set({ activeTabId: existing.id })
      return
    }
    queryCounter += 1
    const tab: QueryTab = {
      type: 'query',
      id: `query:${Date.now()}:${queryCounter}`,
      title: opts?.title ?? `Query ${queryCounter}`,
      savedId: opts?.savedId,
      initialSql: opts?.sql
    }
    set({ tabs: [...get().tabs, tab], activeTabId: tab.id })
  },

  updateQueryTab(id, patch) {
    set({ tabs: get().tabs.map((t) => (t.id === id && t.type === 'query' ? { ...t, ...patch } : t)) })
  },

  async refreshTree() {
    const { session } = get()
    if (!session) return
    void get().refreshCompletions()
    set({ treeLoading: true })
    try {
      set({ tree: await call('session:tree', session.sessionId) })
    } catch (err) {
      set({ error: (err as Error).message })
    } finally {
      set({ treeLoading: false })
    }
  },

  openTable(node, view) {
    if (node.kind !== 'table' && node.kind !== 'view') return
    const id = tabId(node.schema, node.name)
    const { tabs } = get()
    const existing = tabs.find((t) => t.id === id)
    if (!existing) {
      set({ tabs: [...tabs, { type: 'table', id, schema: node.schema, table: node.name, kind: node.kind, view: view ?? 'data' }] })
    } else if (view) {
      get().setTableView(id, view)
    }
    set({ activeTabId: id })
  },

  setTableView(id, view) {
    set({ tabs: get().tabs.map((t) => (t.id === id && t.type === 'table' ? { ...t, view } : t)) })
  },

  openNewTable(schema) {
    queryCounter += 1
    const tab: NewTableTab = { type: 'newTable', id: `new:${Date.now()}:${queryCounter}`, schema, title: 'New table' }
    set({ tabs: [...get().tabs, tab], activeTabId: tab.id })
  },

  openTool(type) {
    const id = `tool:${type}`
    if (!get().tabs.some((t) => t.id === id)) {
      set({ tabs: [...get().tabs, { type, id, title: type === 'users' ? 'Users' : 'Processes' }] })
    }
    set({ activeTabId: id })
  },

  replaceWithTable(oldId, schema, table, view) {
    const id = tabId(schema, table)
    const { [oldId]: _, ...dirty } = get().dirty
    const next: TableTab = { type: 'table', id, schema, table, kind: 'table', view }
    const tabs = get().tabs.filter((t) => t.id !== id).map((t) => (t.id === oldId ? next : t))
    set({ tabs, activeTabId: id, dirty })
  },

  closeTab(id) {
    const { tabs, activeTabId, dirty } = get()
    if (!confirmDiscard(dirty[id] ?? 0)) return
    const { [id]: _, ...restDirty } = dirty
    const i = tabs.findIndex((t) => t.id === id)
    const next = tabs.filter((t) => t.id !== id)
    const active = activeTabId === id ? (next[Math.min(i, next.length - 1)]?.id ?? null) : activeTabId
    set({ tabs: next, activeTabId: active, dirty: restDirty })
  },

  setActiveTab(id) {
    set({ activeTabId: id })
  },

  openDialog(dialog) {
    set({ dialog })
  },

  reloadTable(schema, table) {
    const id = tabId(schema, table)
    set({ reloadTokens: { ...get().reloadTokens, [id]: (get().reloadTokens[id] ?? 0) + 1 } })
  },

  reloadAllTables() {
    const tokens = { ...get().reloadTokens }
    for (const t of get().tabs) if (t.type === 'table') tokens[t.id] = (tokens[t.id] ?? 0) + 1
    set({ reloadTokens: tokens })
  },

  setDirty(tabId, count) {
    if ((get().dirty[tabId] ?? 0) !== count) set({ dirty: { ...get().dirty, [tabId]: count } })
  },

  async loadSettings() {
    const settings = await call('settings:get')
    applyTheme(settings.ui)
    set({ settings })
  },

  async updateSettings(patch) {
    const settings = await call('settings:update', patch)
    applyTheme(settings.ui)
    set({ settings })
  },

  setOverlay(overlay) {
    set({ overlay })
  },

  setNotice(notice) {
    set({ notice })
    if (notice) setTimeout(() => get().notice === notice && set({ notice: null }), 5000)
  },

  openErd(schema) {
    const id = `erd:${schema}`
    if (!get().tabs.some((t) => t.id === id)) set({ tabs: [...get().tabs, { type: 'erd', id, schema, title: `${schema} diagram` }] })
    set({ activeTabId: id })
  },

  askAi(text) {
    const active = get().tabs.find((t) => t.id === get().activeTabId)
    if (active?.type !== 'query') get().openQuery()
    set({ aiPrompt: { tabId: get().activeTabId!, text } })
  },

  openMetrics(boardId, title) {
    const id = `metrics:${boardId}`
    if (!get().tabs.some((t) => t.id === id)) set({ tabs: [...get().tabs, { type: 'metrics', id, boardId, title }] })
    set({ activeTabId: id })
  },

  updateTabTitle(id, title) {
    set({ tabs: get().tabs.map((t) => (t.id === id && 'title' in t ? { ...t, title } : t)) })
  },

  setError(error) {
    set({ error })
  }
}))
