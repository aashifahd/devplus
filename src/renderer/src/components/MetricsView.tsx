import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, BarChart3, Hash, LineChart as LineIcon, Pencil, Plus, RefreshCw, Table as TableIcon, Trash2 } from 'lucide-react'
import type { ColumnMeta, CellValue, SavedQuery } from '@shared/types'
import { chartData, isNumericColumn, MAX_SERIES, REFRESH_CHOICES, type MetricsBoard, type MetricsWidget, type WidgetKind } from '@shared/metrics'
import { call } from '../api'
import { useApp, type MetricsTab } from '../store'
import Modal from './Modal'
import { BarChart, LineChart, ResultTable, StatTile } from './charts'

interface WidgetState {
  loading: boolean
  columns?: ColumnMeta[]
  rows?: CellValue[][]
  error?: string
  at?: number
}

const KINDS: { kind: WidgetKind; label: string; icon: typeof Hash }[] = [
  { kind: 'number', label: 'Number', icon: Hash },
  { kind: 'line', label: 'Line', icon: LineIcon },
  { kind: 'bar', label: 'Bar', icon: BarChart3 },
  { kind: 'table', label: 'Table', icon: TableIcon }
]

const refreshLabel = (s: number) => (s === 0 ? 'Off' : s < 60 ? `${s}s` : `${s / 60} min`)
const newId = () => `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

/** The rows a query produced: the last statement that returned a result set. */
async function runSql(sessionId: string, sql: string): Promise<{ columns: ColumnMeta[]; rows: CellValue[][] }> {
  const res = await call('metrics:run', sessionId, sql)
  if (res.error) throw new Error(res.error.message)
  const r = [...res.results].reverse().find((x) => x.hasRows)
  if (!r) throw new Error('The query returned no rows to chart.')
  return { columns: r.columns, rows: r.rows }
}

function WidgetBody({ w, s, asTable }: { w: MetricsWidget; s: WidgetState; asTable: boolean }) {
  const data = useMemo(() => (s.columns && s.rows ? chartData(s.columns, s.rows, w) : null), [s.columns, s.rows, w])
  if (s.error) return <div className="select-text text-xs text-danger">{s.error}</div>
  if (!s.columns || !s.rows || !data) return <div className="animate-pulse text-xs text-muted">Loading…</div>
  if (w.kind === 'table' || asTable) return <ResultTable columns={s.columns} rows={s.rows} />
  if (s.rows.length === 0) return <div className="text-xs text-muted">No rows.</div>
  if (w.kind === 'number') return <StatTile data={data} />
  if (data.series.length === 0) return <div className="text-xs text-muted">No numeric columns to chart. Edit the widget to pick value columns.</div>
  return (
    <>
      {w.kind === 'line' ? <LineChart data={data} height={200} /> : <BarChart data={data} height={200} />}
      {(data.droppedSeries > 0 || data.truncatedRows) && (
        <div className="mt-1 text-[10px] text-faint">
          {data.droppedSeries > 0 && `${data.droppedSeries} more value columns not drawn (limit ${MAX_SERIES}). `}
          {data.truncatedRows && 'Only the first 500 rows are drawn.'}
        </div>
      )}
    </>
  )
}

export default function MetricsView({ sessionId, tab, active }: { sessionId: string; tab: MetricsTab; active: boolean }) {
  const connection = useApp((s) => s.connection)
  const updateTabTitle = useApp((s) => s.updateTabTitle)
  const openMetrics = useApp((s) => s.openMetrics)
  const closeTab = useApp((s) => s.closeTab)
  const setError = useApp((s) => s.setError)
  const [board, setBoard] = useState<MetricsBoard | null>(null)
  const [others, setOthers] = useState<MetricsBoard[]>([])
  const [saved, setSaved] = useState<SavedQuery[]>([])
  const [state, setState] = useState<Record<string, WidgetState>>({})
  const [asTable, setAsTable] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<MetricsWidget | null>(null)
  const ranOnce = useRef(false)

  const load = useCallback(async () => {
    if (!connection) return
    const [boards, queries] = await Promise.all([call('metrics:list', connection.id), call('saved:list', connection.id)])
    setSaved(queries)
    setOthers(boards.filter((b) => b.id !== tab.boardId))
    setBoard(boards.find((b) => b.id === tab.boardId) ?? { id: tab.boardId, connectionId: connection.id, name: tab.title, refreshSec: 0, widgets: [], updatedAt: 0 })
  }, [connection, tab.boardId, tab.title])

  useEffect(() => {
    load().catch((err) => setError((err as Error).message))
  }, [load, setError])

  const persist = async (next: MetricsBoard) => {
    setBoard(next)
    updateTabTitle(tab.id, next.name)
    try {
      setBoard(await call('metrics:save', next))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const sqlFor = useCallback((w: MetricsWidget) => (w.source.type === 'sql' ? w.source.sql : saved.find((q) => q.id === (w.source as { savedId: string }).savedId)?.sql ?? null), [saved])

  const runWidget = useCallback(
    async (w: MetricsWidget) => {
      const sql = sqlFor(w)
      setState((s) => ({ ...s, [w.id]: { ...s[w.id], loading: true } }))
      try {
        if (!sql) throw new Error('The saved query this widget uses was deleted.')
        const r = await runSql(sessionId, sql)
        setState((s) => ({ ...s, [w.id]: { loading: false, ...r, at: Date.now() } }))
      } catch (err) {
        setState((s) => ({ ...s, [w.id]: { loading: false, error: (err as Error).message, at: Date.now() } }))
      }
    },
    [sessionId, sqlFor]
  )

  const refreshAll = useCallback(() => {
    // One at a time: the session has a single connection, and a slow widget shouldn't starve the rest.
    void (async () => {
      for (const w of board?.widgets ?? []) await runWidget(w)
    })()
  }, [board?.widgets, runWidget])

  useEffect(() => {
    if (board && active && !ranOnce.current) {
      ranOnce.current = true
      refreshAll()
    }
  }, [board, active, refreshAll])

  useEffect(() => {
    if (!board?.refreshSec || !active) return
    const t = setInterval(refreshAll, board.refreshSec * 1000)
    return () => clearInterval(t)
  }, [board?.refreshSec, active, refreshAll])

  if (!board) return <div className="p-4 text-xs text-muted">Loading board…</div>

  const saveWidget = (w: MetricsWidget) => {
    const exists = board.widgets.some((x) => x.id === w.id)
    void persist({ ...board, widgets: exists ? board.widgets.map((x) => (x.id === w.id ? w : x)) : [...board.widgets, w] })
    setEditing(null)
    void runWidget(w)
  }

  const move = (id: string, dir: -1 | 1) => {
    const i = board.widgets.findIndex((w) => w.id === id)
    const j = i + dir
    if (j < 0 || j >= board.widgets.length) return
    const ws = [...board.widgets]
    ;[ws[i], ws[j]] = [ws[j], ws[i]]
    void persist({ ...board, widgets: ws })
  }

  const removeBoard = async () => {
    if (!confirm(`Delete the board "${board.name}"? Saved queries are kept.`)) return
    await call('metrics:delete', board.id)
    closeTab(tab.id)
  }

  return (
    <div className="flex h-full flex-col" data-testid="metrics-view">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line bg-panel px-2 text-xs">
        <input
          className="field h-6 w-56 font-medium"
          defaultValue={board.name}
          key={board.id}
          aria-label="Board name"
          onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== board.name && void persist({ ...board, name: e.target.value.trim() })}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <button className="btn btn-primary h-6 px-2" onClick={() => setEditing({ id: newId(), title: '', kind: 'line', source: saved[0] ? { type: 'saved', savedId: saved[0].id } : { type: 'sql', sql: '' }, x: '', y: [], span: 1 })}>
          <Plus size={12} /> Add widget
        </button>
        <button className="btn h-6 px-2" onClick={refreshAll} disabled={board.widgets.length === 0}>
          <RefreshCw size={12} className={Object.values(state).some((s) => s.loading) ? 'animate-spin' : ''} /> Refresh
        </button>
        <label className="flex items-center gap-1 text-muted">
          Auto
          <select className="field h-6 w-20" value={board.refreshSec} onChange={(e) => void persist({ ...board, refreshSec: Number(e.target.value) })}>
            {REFRESH_CHOICES.map((s) => (
              <option key={s} value={s}>
                {refreshLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex-1" />
        {others.length > 0 && (
          <select className="field h-6 w-44" value="" onChange={(e) => e.target.value && openMetrics(e.target.value, others.find((b) => b.id === e.target.value)!.name)}>
            <option value="">Other boards…</option>
            {others.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}
        <button className="btn h-6 px-2" onClick={() => openMetrics(`board-${Date.now()}`, 'Metrics')}>
          New board
        </button>
        {board.updatedAt > 0 && (
          <button className="icon-btn" title="Delete board" onClick={() => void removeBoard()}>
            <Trash2 size={13} />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-panel p-3">
        {board.widgets.length === 0 ? (
          <div className="mx-auto mt-16 max-w-md text-center text-xs text-muted">
            <BarChart3 size={28} className="mx-auto mb-3 text-faint" />
            <p className="mb-1 text-sm text-fg">An empty board</p>
            <p>Add widgets that chart a saved query or a SQL snippet. Widgets run read-only and refresh together.</p>
            {saved.length === 0 && <p className="mt-2 text-faint">Tip: save queries from the SQL editor to reuse them here.</p>}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {board.widgets.map((w, i) => {
              const s = state[w.id] ?? { loading: true }
              const tableToggle = w.kind === 'line' || w.kind === 'bar'
              return (
                <section
                  key={w.id}
                  className={`group flex min-w-0 flex-col rounded-lg border border-line bg-bg p-3 ${w.span === 3 ? 'md:col-span-3' : w.span === 2 ? 'md:col-span-2' : ''}`}
                  data-widget={w.title || w.id}
                >
                  <header className="mb-2 flex items-center gap-1">
                    <h3 className="min-w-0 flex-1 truncate text-xs font-semibold">{w.title || 'Untitled'}</h3>
                    <div className="invisible flex items-center group-hover:visible">
                      {tableToggle && (
                        <button
                          className={`icon-btn ${asTable.has(w.id) ? 'text-accent' : ''}`}
                          title="Show as table"
                          onClick={() => setAsTable((t) => (t.has(w.id) ? new Set([...t].filter((x) => x !== w.id)) : new Set(t).add(w.id)))}
                        >
                          <TableIcon size={12} />
                        </button>
                      )}
                      <button className="icon-btn" title="Move left" disabled={i === 0} onClick={() => move(w.id, -1)}>
                        <ArrowLeft size={12} />
                      </button>
                      <button className="icon-btn" title="Move right" disabled={i === board.widgets.length - 1} onClick={() => move(w.id, 1)}>
                        <ArrowRight size={12} />
                      </button>
                      <button className="icon-btn" title="Refresh" onClick={() => void runWidget(w)}>
                        <RefreshCw size={12} className={s.loading ? 'animate-spin' : ''} />
                      </button>
                      <button className="icon-btn" title="Edit" onClick={() => setEditing(w)}>
                        <Pencil size={12} />
                      </button>
                      <button
                        className="icon-btn"
                        title="Remove"
                        onClick={() => confirm(`Remove "${w.title || 'Untitled'}" from the board?`) && void persist({ ...board, widgets: board.widgets.filter((x) => x.id !== w.id) })}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </header>
                  <div className={`min-h-0 ${w.kind === 'number' ? 'h-28' : 'h-60'}`}>
                    <WidgetBody w={w} s={s} asTable={asTable.has(w.id)} />
                  </div>
                  {s.at && (
                    <footer className="mt-1 text-[10px] text-faint">
                      Updated {new Date(s.at).toLocaleTimeString()}
                      {s.rows && ` · ${s.rows.length.toLocaleString()} row${s.rows.length === 1 ? "" : "s"}`}
                    </footer>
                  )}
                </section>
              )
            })}
          </div>
        )}
      </div>

      {editing && <WidgetEditor sessionId={sessionId} initial={editing} saved={saved} onClose={() => setEditing(null)} onSave={saveWidget} />}
    </div>
  )
}

function WidgetEditor({
  sessionId,
  initial,
  saved,
  onClose,
  onSave
}: {
  sessionId: string
  initial: MetricsWidget
  saved: SavedQuery[]
  onClose: () => void
  onSave: (w: MetricsWidget) => void
}) {
  const [w, setW] = useState<MetricsWidget>(initial)
  const [preview, setPreview] = useState<{ columns: ColumnMeta[]; rows: CellValue[][] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const sql = w.source.type === 'sql' ? w.source.sql : saved.find((q) => q.id === (w.source as { savedId: string }).savedId)?.sql ?? ''

  const runPreview = useCallback(async () => {
    if (!sql.trim()) return
    setRunning(true)
    setError(null)
    try {
      setPreview(await runSql(sessionId, sql))
    } catch (err) {
      setPreview(null)
      setError((err as Error).message)
    } finally {
      setRunning(false)
    }
  }, [sessionId, sql])

  // Columns for the pickers come from running the query once.
  useEffect(() => {
    if (w.source.type === 'saved') void runPreview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.source.type === 'saved' ? w.source.savedId : null])

  const numeric = preview ? preview.columns.map((c, i) => isNumericColumn(c, preview.rows, i)) : []
  const data = useMemo(() => (preview ? chartData(preview.columns, preview.rows, w) : null), [preview, w])
  const effectiveY = data?.series.map((s) => s.name) ?? []

  const title = w.title.trim() || (w.source.type === 'saved' ? saved.find((q) => q.id === (w.source as { savedId: string }).savedId)?.name ?? '' : '')

  return (
    <Modal
      title={initial.title ? 'Edit widget' : 'Add widget'}
      width={720}
      onClose={onClose}
      footer={
        <>
          <div className="min-w-0 flex-1 truncate text-xs text-danger">{error}</div>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!sql.trim()} onClick={() => onSave({ ...w, title })}>
            Save widget
          </button>
        </>
      }
    >
      <div className="grid grid-cols-[110px_1fr] items-center gap-x-4 gap-y-3 text-xs">
        <span>Title</span>
        <input className="field" value={w.title} placeholder={title || 'Widget title'} onChange={(e) => setW({ ...w, title: e.target.value })} />

        <span>Chart</span>
        <div className="flex gap-1">
          {KINDS.map(({ kind, label, icon: Icon }) => (
            <button key={kind} className={`btn h-7 ${w.kind === kind ? 'border-accent text-accent' : ''}`} onClick={() => setW({ ...w, kind })}>
              <Icon size={12} /> {label}
            </button>
          ))}
        </div>

        <span>Width</span>
        <div className="flex gap-1">
          {([1, 2, 3] as const).map((n) => (
            <button key={n} className={`btn h-7 ${w.span === n ? 'border-accent text-accent' : ''}`} onClick={() => setW({ ...w, span: n })}>
              {n === 1 ? 'One third' : n === 2 ? 'Two thirds' : 'Full'}
            </button>
          ))}
        </div>

        <span>Data from</span>
        <div className="flex gap-2">
          <select
            className="field"
            value={w.source.type === 'saved' ? w.source.savedId : '__sql'}
            onChange={(e) => setW({ ...w, source: e.target.value === '__sql' ? { type: 'sql', sql } : { type: 'saved', savedId: e.target.value }, x: '', y: [] })}
          >
            {saved.map((q) => (
              <option key={q.id} value={q.id}>
                Saved: {q.name}
              </option>
            ))}
            <option value="__sql">SQL written here</option>
          </select>
          <button className="btn h-7 shrink-0" disabled={running || !sql.trim()} onClick={() => void runPreview()}>
            <RefreshCw size={12} className={running ? 'animate-spin' : ''} /> Run
          </button>
        </div>

        <span className="self-start pt-1">Query</span>
        {w.source.type === 'sql' ? (
          <textarea
            className="field h-28 resize-y py-1.5 font-mono text-[11px]"
            spellCheck={false}
            value={w.source.sql}
            placeholder="SELECT date_trunc('day', created_at) AS day, count(*) AS signups FROM users GROUP BY 1 ORDER BY 1"
            onChange={(e) => setW({ ...w, source: { type: 'sql', sql: e.target.value } })}
          />
        ) : (
          <pre className="max-h-28 select-text overflow-auto rounded-md border border-line bg-panel p-2 font-mono text-[11px] text-muted">{sql || '(empty)'}</pre>
        )}

        {preview && w.kind !== 'table' && (
          <>
            {w.kind !== 'number' && (
              <>
                <span>X axis</span>
                <select className="field" value={w.x} onChange={(e) => setW({ ...w, x: e.target.value })}>
                  <option value="">Automatic ({data?.xName ?? 'none'})</option>
                  {preview.columns.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </>
            )}

            <span className="self-start pt-1">{w.kind === 'number' ? 'Value (last row)' : 'Values'}</span>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {preview.columns.map((c, i) =>
                c.name === (data?.xName ?? '') ? null : (
                  <label key={c.name} className={`flex items-center gap-1.5 ${numeric[i] ? '' : 'text-faint'}`}>
                    <input
                      type={w.kind === 'number' ? 'radio' : 'checkbox'}
                      name="widget-y"
                      checked={effectiveY.includes(c.name)}
                      onChange={(e) => {
                        const base = w.y.length ? w.y : effectiveY
                        const next = w.kind === 'number' ? [c.name] : e.target.checked ? [...base, c.name] : base.filter((n) => n !== c.name)
                        setW({ ...w, y: next })
                      }}
                    />
                    {c.name}
                  </label>
                )
              )}
            </div>
          </>
        )}
      </div>

      {preview && (
        <div className="mt-4 rounded-lg border border-line p-3">
          <div className="mb-2 text-[11px] text-faint">Preview · {preview.rows.length.toLocaleString()} rows</div>
          <div className={w.kind === 'number' ? 'h-28' : 'h-56'}>
            <WidgetBody w={w} s={{ loading: false, ...preview }} asTable={false} />
          </div>
        </div>
      )}
    </Modal>
  )
}
