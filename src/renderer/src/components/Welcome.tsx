import { useMemo, useState } from 'react'
import { Copy, Download, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { nanoid } from 'nanoid'
import type { ConnectionConfig } from '@shared/types'
import { call } from '../api'
import { ENGINE_LABELS, TAG_COLORS, useApp } from '../store'
import { ENGINES } from '@shared/engines'
import ConnectionEditor from './ConnectionEditor'
import PasswordPrompt from './PasswordPrompt'
import ImportModal from './ImportModal'
import ServersPanel from './ServersPanel'
import appIcon from '../../../../build/icon.png'

function subtitle(c: ConnectionConfig) {
  const info = ENGINES[c.engine]
  if (info.fields.file && !info.fields.host) {
    if (c.engine === 'bigquery') return c.database ? `project ${c.database}` : 'No project set'
    return c.filePath || 'No file selected'
  }
  if (c.engine === 'dynamodb') return c.host || `AWS ${c.options?.region || 'us-east-1'}`
  if (c.engine === 'snowflake') return `${c.user ? `${c.user}@` : ''}${c.host}${c.database ? `/${c.database}` : ''}`
  const target = `${c.user ? `${c.user}@` : ''}${c.host}:${c.port}${c.database ? `/${c.database}` : ''}`
  return c.ssh.enabled ? `${target} via ${c.ssh.host}` : target
}

export default function Welcome() {
  const { connections, connect, loadConnections, setError } = useApp()
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<ConnectionConfig | 'new' | null>(null)
  const [prompting, setPrompting] = useState<ConnectionConfig | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [view, setView] = useState<'connections' | 'servers'>('connections')

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const match = (c: ConnectionConfig) =>
      !q || [c.name, c.host, c.database, c.group ?? '', c.filePath ?? ''].some((v) => v.toLowerCase().includes(q))
    const map = new Map<string, ConnectionConfig[]>()
    for (const c of connections.filter(match).sort((a, b) => a.name.localeCompare(b.name))) {
      const key = c.group?.trim() || ''
      map.set(key, [...(map.get(key) ?? []), c])
    }
    return [...map.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
  }, [connections, query])

  const open = async (c: ConnectionConfig) => {
    // Ask only when the engine takes a password and none is saved (DuckDB, BigQuery… have none).
    if (ENGINES[c.engine].fields.password && !c.savePassword) {
      setPrompting(c)
      return
    }
    setBusyId(c.id)
    try {
      await connect(c)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (c: ConnectionConfig) => {
    if (!confirm(`Delete connection "${c.name}"?`)) return
    await call('connections:delete', c.id)
    await loadConnections()
  }

  const duplicate = async (c: ConnectionConfig) => {
    await call('connections:save', { ...c, id: nanoid(), name: `${c.name} copy`, secrets: {} })
    await loadConnections()
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col items-center justify-center gap-3 border-r border-line bg-panel px-6 text-center">
        <img src={appIcon} alt="" className="h-20 w-20" />
        <div className="text-lg font-semibold">DevPlus</div>
        <div className="text-xs text-muted">SQL and NoSQL, twelve engines, one app</div>
        <button className="btn btn-primary mt-4" onClick={() => setEditing('new')}>
          <Plus size={14} /> New connection
        </button>
        <button className="btn" onClick={() => setImporting(true)}>
          <Download size={14} /> Import from TablePlus
        </button>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-end gap-1 border-b border-line px-3" role="tablist">
          {(['connections', 'servers'] as const).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              className={`-mb-px border-b-2 px-3 pb-2 text-xs font-medium ${view === v ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'}`}
              onClick={() => setView(v)}
            >
              {v === 'connections' ? `Connections${connections.length ? ` (${connections.length})` : ''}` : 'Local servers'}
            </button>
          ))}
        </div>
        {view === 'servers' ? (
          <ServersPanel />
        ) : (
          <>
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <div className="relative flex-1">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
              <input
                className="field pl-8"
                placeholder="Search connections"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <button className="icon-btn" title="New connection" onClick={() => setEditing('new')}>
              <Plus size={16} />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {connections.length === 0 && (
              <div className="mt-24 text-center text-muted">
                No connections yet.
                <div className="mt-3">
                  <button className="btn" onClick={() => setEditing('new')}>
                    <Plus size={14} /> Create your first connection
                  </button>
                </div>
              </div>
            )}

            {groups.map(([group, items]) => (
              <section key={group || '_'} className="mb-2">
                {group && <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-faint">{group}</div>}
                {items.map((c) => (
                  <div
                    key={c.id}
                    className={`group flex cursor-default items-center gap-3 rounded-lg px-3 py-2 ${
                      selectedId === c.id ? 'bg-accent-soft' : 'hover:bg-panel'
                    }`}
                    onClick={() => setSelectedId(c.id)}
                    onDoubleClick={() => open(c)}
                    onKeyDown={(e) => e.key === 'Enter' && open(c)}
                    tabIndex={0}
                  >
                    <div
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold text-white"
                      style={{ background: c.color }}
                    >
                      {ENGINES[c.engine].badge}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{c.name}</span>
                        <span
                          className="rounded px-1.5 py-px text-[10px] font-semibold uppercase text-white"
                          style={{ background: TAG_COLORS[c.tag] }}
                        >
                          {c.tag}
                        </span>
                      </div>
                      <div className="truncate text-xs text-muted">
                        {ENGINE_LABELS[c.engine]} · {subtitle(c)}
                      </div>
                    </div>
                    {busyId === c.id ? (
                      <span className="text-xs text-muted">Connecting…</span>
                    ) : (
                      <div className="hidden items-center gap-0.5 group-hover:flex">
                        <button className="icon-btn" title="Edit" onClick={() => setEditing(c)}>
                          <Pencil size={13} />
                        </button>
                        <button className="icon-btn" title="Duplicate" onClick={() => duplicate(c)}>
                          <Copy size={13} />
                        </button>
                        <button className="icon-btn" title="Delete" onClick={() => remove(c)}>
                          <Trash2 size={13} />
                        </button>
                        <button className="btn ml-1 h-6 px-2 text-xs" onClick={() => open(c)}>
                          Connect
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </section>
            ))}
          </div>
          </>
        )}
      </main>

      {editing && (
        <ConnectionEditor
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async (saved, connectNow) => {
            setEditing(null)
            await loadConnections()
            if (connectNow) await open(saved)
          }}
        />
      )}

      {prompting && (
        <PasswordPrompt
          connection={prompting}
          onClose={() => setPrompting(null)}
          onSubmit={async (secrets) => {
            await connect(prompting, secrets)
            setPrompting(null)
          }}
        />
      )}

      {importing && <ImportModal onClose={() => setImporting(false)} />}
    </div>
  )
}
