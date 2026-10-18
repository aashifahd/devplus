import { Activity, BarChart3, Network, Sparkles, Eye, HardDriveDownload, HardDriveUpload, FileCode2, Lock, LogOut, Plus, RefreshCw, ShieldCheck, SquarePen, Table2, TablePropertiesIcon, Users, X } from 'lucide-react'
import { effectiveSafeMode } from '@shared/types'
import { caps } from '@shared/engines'
import { TAG_COLORS, useApp, type Tab } from '../store'
import SchemaTree from './SchemaTree'
import TableView from './TableView'
import QueryView from './QueryView'
import StructureView from './StructureView'
import UsersView from './UsersView'
import ProcessView from './ProcessView'
import { ExportModal, ImportModal } from './TransferModals'
import { BackupModal, RestoreModal } from './BackupModals'
import ErdView from './ErdView'
import MetricsView from './MetricsView'
import { call } from '../api'
import { useShortcut, useActionKey, displayCombo } from '../keymap'

export default function Workspace() {
  const {
    connection,
    session,
    tabs,
    activeTabId,
    setActiveTab,
    closeTab,
    disconnect,
    switchDatabase,
    refreshTree,
    treeLoading,
    openQuery,
    openTool,
    replaceWithTable,
    dialog,
    openDialog,
    openErd,
    openMetrics,
    tree,
    askAi
  } = useApp()
  const newQueryKey = displayCombo(useActionKey('tab.newQuery'))

  useShortcut('tab.close', () => activeTabId && closeTab(activeTabId), Boolean(session))
  useShortcut('tab.newQuery', () => openQuery(), Boolean(session))

  /** The most recently edited board, or a new one. */
  const openBoards = async () => {
    if (!connection) return
    const boards = await call('metrics:list', connection.id).catch(() => [])
    if (boards[0]) openMetrics(boards[0].id, boards[0].name)
    else openMetrics(`board-${Date.now()}`, 'Metrics')
  }
  const firstSchema = tree.find((n) => n.kind === 'schema')?.name

  if (!connection || !session) return null
  const tagColor = TAG_COLORS[connection.tag]
  const safeMode = effectiveSafeMode(connection)

  return (
    <div className="flex h-full flex-col">
      <header
        className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-panel px-3"
        style={{ boxShadow: `inset 0 3px 0 ${connection.tag === 'production' ? tagColor : connection.color}` }}
      >
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: connection.color }} />
        <span className="whitespace-nowrap font-semibold">{connection.name}</span>
        <span
          className="rounded px-1.5 py-px text-[10px] font-semibold uppercase text-white"
          style={{ background: tagColor }}
        >
          {connection.tag}
        </span>
        {safeMode !== 'off' && (
          <span
            className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-muted"
            title={safeMode === 'readonly' ? 'Edits are disabled for this connection' : 'Every commit shows its SQL first'}
          >
            {safeMode === 'readonly' ? <Lock size={12} /> : <ShieldCheck size={12} />}
            {safeMode === 'readonly' ? 'Read-only' : 'Safe mode'}
          </span>
        )}
        <span className="truncate text-xs text-muted">{session.serverVersion}</span>
        <div className="flex-1" />
        {session.databases.length > 0 && caps(connection.engine).databases && (
          <select
            className="field h-7 w-52"
            value={session.currentDatabase}
            onChange={(e) => switchDatabase(e.target.value)}
            title="Database"
          >
            {!session.currentDatabase && <option value="">Choose database…</option>}
            {session.databases.map((db) => (
              <option key={db} value={db}>
                {db}
              </option>
            ))}
          </select>
        )}
        {caps(connection.engine).users && (
          <button className="icon-btn" title="Users and roles" onClick={() => openTool('users')}>
            <Users size={14} />
          </button>
        )}
        {caps(connection.engine).processes && (
          <button className="icon-btn" title="Process list" onClick={() => openTool('processes')}>
            <Activity size={14} />
          </button>
        )}
        {caps(connection.engine).backup && (
          <button className="icon-btn" title="Back up" onClick={() => openDialog({ type: 'backup' })}>
            <HardDriveDownload size={14} />
          </button>
        )}
        {caps(connection.engine).restore && (
          <button className="icon-btn" title="Restore or run a SQL file" onClick={() => openDialog({ type: 'restore' })}>
            <HardDriveUpload size={14} />
          </button>
        )}
        {caps(connection.engine).structure && firstSchema && (
          <button className="icon-btn" title="ER diagram" onClick={() => openErd(firstSchema)}>
            <Network size={14} />
          </button>
        )}
        <button className="icon-btn" title="Metrics boards" onClick={() => void openBoards()}>
          <BarChart3 size={14} />
        </button>
        <button className="icon-btn" title="Ask AI" onClick={() => askAi('')}>
          <Sparkles size={14} />
        </button>
        <button className="btn h-7" onClick={() => openQuery()} title={`New SQL query (${newQueryKey})`}>
          <SquarePen size={13} /> SQL
        </button>
        <button className="icon-btn" title="Refresh schema" onClick={refreshTree}>
          <RefreshCw size={14} className={treeLoading ? 'animate-spin' : ''} />
        </button>
        <button className="btn h-7" onClick={disconnect} title="Close connection">
          <LogOut size={13} /> Close
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <SchemaTree />

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-end gap-px overflow-x-auto border-b border-line bg-panel px-1">
            {tabs.map((t) => {
              const active = t.id === activeTabId
              return (
                <div
                  key={t.id}
                  className={`group flex h-8 max-w-56 cursor-default items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 text-xs ${
                    active ? 'border-line bg-bg text-fg' : 'border-transparent text-muted hover:bg-panel-2'
                  }`}
                  onMouseDown={(e) => {
                    if (e.button === 1) closeTab(t.id)
                    else setActiveTab(t.id)
                  }}
                  title={t.type === 'table' ? `${t.schema}.${t.table}` : t.title}
                >
                  <TabIcon tab={t} />
                  <span className="truncate">{t.type === 'table' ? t.table : t.title}</span>
                  <button
                    className={`ml-0.5 rounded p-0.5 hover:bg-panel-2 ${active ? '' : 'invisible group-hover:visible'}`}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => closeTab(t.id)}
                    aria-label="Close tab"
                  >
                    <X size={11} />
                  </button>
                </div>
              )
            })}
            <button className="icon-btn mb-1 ml-1 shrink-0" title={`New SQL query (${newQueryKey})`} onClick={() => openQuery()}>
              <Plus size={14} />
            </button>
          </div>

          <div className="relative min-h-0 flex-1">
            {tabs.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-muted">
                Select a table from the sidebar, or
                <button className="btn" onClick={() => openQuery()}>
                  <SquarePen size={13} /> Open a SQL editor
                </button>
              </div>
            )}
            {tabs.map((t) => (
              <div key={t.id} className="absolute inset-0" style={{ display: t.id === activeTabId ? 'block' : 'none' }}>
                {t.type === 'table' ? (
                  <TableView sessionId={session.sessionId} tab={t} active={t.id === activeTabId} />
                ) : t.type === 'query' ? (
                  <QueryView sessionId={session.sessionId} tab={t} active={t.id === activeTabId} />
                ) : t.type === 'newTable' ? (
                  <StructureView
                    sessionId={session.sessionId}
                    engine={connection.engine}
                    schema={t.schema}
                    table={null}
                    kind="table"
                    onApplied={(schema, name) => replaceWithTable(t.id, schema, name, 'structure')}
                  />
                ) : t.type === 'erd' ? (
                  <ErdView sessionId={session.sessionId} schema={t.schema} active={t.id === activeTabId} />
                ) : t.type === 'metrics' ? (
                  <MetricsView sessionId={session.sessionId} tab={t} active={t.id === activeTabId} />
                ) : t.type === 'users' ? (
                  <UsersView sessionId={session.sessionId} />
                ) : (
                  <ProcessView sessionId={session.sessionId} active={t.id === activeTabId} />
                )}
              </div>
            ))}
          </div>
        </main>
      </div>

      {dialog && (dialog.type === 'exportTable' || dialog.type === 'exportRows') && (
        <ExportModal request={dialog} sessionId={session.sessionId} engine={connection.engine} onClose={() => openDialog(null)} />
      )}
      {dialog?.type === 'import' && <ImportModal request={dialog} sessionId={session.sessionId} onClose={() => openDialog(null)} />}
      {dialog?.type === 'backup' && <BackupModal sessionId={session.sessionId} onClose={() => openDialog(null)} />}
      {dialog?.type === 'restore' && <RestoreModal sessionId={session.sessionId} onClose={() => openDialog(null)} />}
    </div>
  )
}

function TabIcon({ tab }: { tab: Tab }) {
  switch (tab.type) {
    case 'query':
      return <FileCode2 size={12} />
    case 'newTable':
      return <TablePropertiesIcon size={12} />
    case 'users':
      return <Users size={12} />
    case 'processes':
      return <Activity size={12} />
    case 'erd':
      return <Network size={12} />
    case 'metrics':
      return <BarChart3 size={12} />
    case 'table':
      return tab.kind === 'view' ? <Eye size={12} /> : <Table2 size={12} />
  }
}
