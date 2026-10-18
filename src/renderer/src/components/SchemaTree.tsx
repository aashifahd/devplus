import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Eye, Folder, Plus, Search, SquareFunction, Table2 } from 'lucide-react'
import type { AdminAction, TreeNode } from '@shared/types'
import { call } from '../api'
import { useApp } from '../store'
import { caps, ENGINES } from '@shared/engines'
import { sampleQuery } from '../sampleQuery'
import CommitModal from './CommitModal'
import ContextMenu, { type MenuItem } from './ContextMenu'

const KIND_ORDER: Record<TreeNode['kind'], number> = { schema: 0, table: 1, view: 2, function: 3, procedure: 4 }


export default function SchemaTree() {
  const {
    tree,
    openTable,
    openQuery,
    openNewTable,
    activeTabId,
    treeLoading,
    session,
    connection,
    refreshTree,
    tabs,
    closeTab,
    setError,
    openDialog
  } = useApp()
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [menu, setMenu] = useState<{ node: TreeNode; x: number; y: number } | null>(null)
  const [review, setReview] = useState<{ statements: string[]; action: AdminAction; closeTabId?: string } | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const sorted = tree.map((s) => ({
      ...s,
      children: [...(s.children ?? [])].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name))
    }))
    if (!q) return sorted
    return sorted
      .map((s) => ({ ...s, children: s.children.filter((c) => c.name.toLowerCase().includes(q)) }))
      .filter((s) => s.children.length > 0)
  }, [tree, query])

  // With many schemas, only the default ones start open.
  const isOpen = (s: TreeNode) =>
    collapsed[s.name] === undefined ? tree.length === 1 || s.name === 'public' || Boolean(query) : !collapsed[s.name]

  const openRoutine = async (node: TreeNode) => {
    if (!session) return
    try {
      openQuery({ title: node.name, sql: await call('structure:routine', session.sessionId, node) })
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const askAdmin = async (action: AdminAction, closeTabId?: string) => {
    if (!session) return
    try {
      setReview({ statements: await call('admin:preview', session.sessionId, action), action, closeTabId })
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const engine = connection?.engine ?? 'postgres'
  const engineCaps = caps(engine)
  const objectLabel = ENGINES[engine].objectLabel

  const menuItems = (node: TreeNode): (MenuItem | 'separator')[] => {
    if (node.kind === 'schema') {
      return engineCaps.ddl
        ? [{ label: 'New table…', onSelect: () => openNewTable(node.name) }]
        : [{ label: 'Copy name', onSelect: () => navigator.clipboard.writeText(node.name) }]
    }
    if (node.kind === 'function' || node.kind === 'procedure') {
      return [
        { label: 'Open definition', onSelect: () => void openRoutine(node) },
        { label: 'Copy name', onSelect: () => navigator.clipboard.writeText(node.name) }
      ]
    }
    const tabId = `${node.schema}.${node.name}`
    const items: (MenuItem | 'separator')[] = [
      { label: 'Open data', onSelect: () => openTable(node, 'data') },
      ...(engineCaps.structure ? [{ label: 'Open structure', onSelect: () => openTable(node, 'structure') }] : []),
      { label: 'Open in query editor', onSelect: () => openQuery({ title: node.name, sql: sampleQuery(engine, node.schema, node.name) }) },
      { label: 'Copy name', onSelect: () => navigator.clipboard.writeText(node.name) },
      'separator',
      { label: 'Export…', onSelect: () => openDialog({ type: 'exportTable', schema: node.schema, table: node.name, filters: [] }) },
      ...(node.kind === 'table' && engineCaps.importRows
        ? [{ label: 'Import from CSV or JSON…', onSelect: () => openDialog({ type: 'import', schema: node.schema, table: node.name }) }]
        : []),
      'separator'
    ]
    if (node.kind === 'table' && engineCaps.truncate) {
      items.push({ label: 'Truncate…', danger: true, onSelect: () => void askAdmin({ kind: 'truncateTable', schema: node.schema, name: node.name }) })
    }
    if (engineCaps.drop) items.push({
      label: `Drop ${node.kind === 'table' ? objectLabel : node.kind}…`,
      danger: true,
      onSelect: () => void askAdmin({ kind: 'dropObject', schema: node.schema, name: node.name, objectType: node.kind === 'view' ? 'view' : 'table' }, tabId)
    })
    return items
  }

  const icon = (node: TreeNode, active: boolean) => {
    const cls = active ? '' : 'text-faint'
    if (node.kind === 'view') return <Eye size={12} className={cls} />
    if (node.kind === 'function' || node.kind === 'procedure') return <SquareFunction size={12} className={cls} />
    return <Table2 size={12} className={cls} />
  }

  const defaultSchema = tree.find((s) => s.name === 'public')?.name ?? tree[0]?.name

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex items-center gap-1 p-2">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <input className="field h-7 pl-7 text-xs" placeholder="Filter" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {defaultSchema && engineCaps.ddl && (
          <button className="icon-btn shrink-0" title="New table" onClick={() => openNewTable(defaultSchema)}>
            <Plus size={14} />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {!treeLoading && filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-muted">{query ? 'Nothing matches' : 'No tables'}</div>
        )}
        {filtered.map((schema) => {
          const open = isOpen(schema)
          return (
            <div key={schema.name}>
              <button
                className="flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-xs font-medium hover:bg-panel-2"
                onClick={() => setCollapsed((c) => ({ ...c, [schema.name]: open }))}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ node: schema, x: e.clientX, y: e.clientY })
                }}
              >
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <Folder size={13} className="text-faint" />
                <span className="truncate">{schema.name}</span>
                <span className="ml-auto text-[10px] text-faint">{schema.children.length}</span>
              </button>
              {open &&
                schema.children.map((node) => {
                  const routine = node.kind === 'function' || node.kind === 'procedure'
                  const active = !routine && activeTabId === `${node.schema}.${node.name}`
                  return (
                    <button
                      key={`${node.kind}:${node.id ?? node.name}`}
                      className={`flex w-full items-center gap-1.5 rounded py-1 pl-7 pr-2 text-left text-xs ${
                        active ? 'bg-accent text-white' : 'hover:bg-panel-2'
                      }`}
                      onClick={() => (routine ? void openRoutine(node) : openTable(node))}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        setMenu({ node, x: e.clientX, y: e.clientY })
                      }}
                      title={routine ? `${node.name}(${node.detail ?? ''})` : `${node.schema}.${node.name}`}
                    >
                      {icon(node, active)}
                      <span className="truncate">{node.name}</span>
                      {routine && <span className={`truncate text-[10px] ${active ? '' : 'text-faint'}`}>({node.detail ?? ''})</span>}
                    </button>
                  )
                })}
            </div>
          )
        })}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.node)} onClose={() => setMenu(null)} />}

      {review && connection && session && (
        <CommitModal
          verb="Apply"
          statements={review.statements}
          connection={connection}
          onClose={() => setReview(null)}
          onCommit={async () => {
            await call('admin:apply', session.sessionId, review.action)
            if (review.closeTabId && tabs.some((t) => t.id === review.closeTabId)) closeTab(review.closeTabId)
            setReview(null)
            await refreshTree()
          }}
        />
      )}
    </aside>
  )
}
