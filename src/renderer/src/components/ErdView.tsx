import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, LayoutGrid, Maximize, RefreshCw, Search } from 'lucide-react'
import type { ErdModel, ErdTable } from '@shared/types'
import { call, newTaskId } from '../api'
import { useApp } from '../store'
import { BOX_W, HEADER_H, MAX_ROWS, ROW_H, boxHeight, bounds, layout, rowY, type Point } from '../erdLayout'

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function storageKey(connectionId: string, database: string, schema: string) {
  return `erd:${connectionId}:${database}:${schema}`
}

function loadPositions(key: string): Record<string, Point> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, Point>
  } catch {
    return {}
  }
}

interface Edge {
  id: string
  from: string
  to: string
  d: string
}

function edgesFor(tables: ErdTable[], pos: Record<string, Point>): Edge[] {
  const byName = new Map(tables.map((t) => [t.name, t]))
  const out: Edge[] = []
  for (const t of tables) {
    const a = pos[t.name]
    if (!a) continue
    for (const fk of t.foreignKeys) {
      const target = byName.get(fk.refTable)
      const b = target && fk.refSchema === t.schema ? pos[target.name] : undefined
      if (!target || !b) continue
      const sy = rowY(t, a, fk.columns[0])
      const ty = rowY(target, b, fk.refColumns[0])
      let d: string
      if (target === t) {
        // Self reference: a loop off the right edge.
        const x = a.x + BOX_W
        d = `M ${x} ${sy} C ${x + 50} ${sy}, ${x + 50} ${ty}, ${x} ${ty}`
      } else {
        const leftToRight = a.x + BOX_W / 2 <= b.x + BOX_W / 2
        const sx = leftToRight ? a.x + BOX_W : a.x
        const tx = leftToRight ? b.x : b.x + BOX_W
        const bend = Math.max(40, Math.abs(tx - sx) / 2) * (leftToRight ? 1 : -1)
        // When boxes overlap horizontally, leave from the same side so the curve stays readable.
        d = `M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}`
      }
      out.push({ id: `${t.name}:${fk.name}:${fk.columns.join(',')}`, from: t.name, to: target.name, d })
    }
  }
  return out
}

export default function ErdView({ sessionId, schema, active }: { sessionId: string; schema: string; active: boolean }) {
  const connection = useApp((s) => s.connection)
  const database = useApp((s) => s.session?.currentDatabase ?? '')
  const tree = useApp((s) => s.tree)
  const openTable = useApp((s) => s.openTable)
  const setError = useApp((s) => s.setError)
  const key = storageKey(connection?.id ?? '', database, schema)

  const [model, setModel] = useState<ErdModel | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number | null } | null>(null)
  const [pos, setPos] = useState<Record<string, Point>>({})
  const [view, setView] = useState({ x: 40, y: 40, k: 1 })
  const [hover, setHover] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<{ kind: 'pan' | 'table'; name?: string; sx: number; sy: number; ox: number; oy: number } | null>(null)

  const fit = useCallback((tables: ErdTable[], p: Record<string, Point>) => {
    const el = svgRef.current
    if (!el || tables.length === 0) return
    const b = bounds(tables, p)
    const w = el.clientWidth || 800
    const h = el.clientHeight || 600
    const k = Math.min(1.2, Math.max(0.15, Math.min((w - 60) / (b.maxX - b.minX || 1), (h - 60) / (b.maxY - b.minY || 1))))
    setView({ k, x: (w - (b.maxX - b.minX) * k) / 2 - b.minX * k, y: 30 - b.minY * k })
  }, [])

  const load = useCallback(async () => {
    const taskId = newTaskId()
    const off = window.dbEvents.onTask((e) => {
      if (e.taskId === taskId && e.kind === 'progress') setProgress({ done: e.done ?? 0, total: e.total ?? null })
    })
    setProgress({ done: 0, total: null })
    try {
      const m = await call('schema:erd', sessionId, schema, taskId)
      const auto = layout(m.tables)
      const saved = loadPositions(key)
      const merged = Object.fromEntries(m.tables.map((t) => [t.name, saved[t.name] ?? auto[t.name]]))
      setModel(m)
      setPos(merged)
      requestAnimationFrame(() => fit(m.tables, merged))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      off()
      setProgress(null)
    }
  }, [sessionId, schema, key, fit, setError])

  useEffect(() => {
    void load()
  }, [load])

  const tables = model?.tables ?? []
  const edges = useMemo(() => edgesFor(tables, pos), [tables, pos])
  const needle = filter.trim().toLowerCase()
  const matches = (t: ErdTable) => !needle || t.name.toLowerCase().includes(needle) || t.columns.some((c) => c.name.toLowerCase().includes(needle))
  const related = useMemo(() => {
    if (!hover) return null
    const s = new Set([hover])
    for (const e of edges) if (e.from === hover || e.to === hover) s.add(e.from).add(e.to)
    return s
  }, [hover, edges])

  const savePositions = (p: Record<string, Point>) => {
    try {
      localStorage.setItem(key, JSON.stringify(p))
    } catch {
      // Positions are a convenience; losing them is fine.
    }
  }

  const relayout = () => {
    const auto = layout(tables)
    try {
      localStorage.removeItem(key)
    } catch {
      // ignore
    }
    setPos(auto)
    fit(tables, auto)
  }

  // ---- pan, zoom, drag ----------------------------------------------------------

  const onWheel = (e: React.WheelEvent) => {
    const rect = svgRef.current!.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    setView((v) => {
      const k = Math.min(2.5, Math.max(0.1, v.k * Math.exp(-e.deltaY * 0.0015)))
      return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k }
    })
  }

  const onMouseDown = (e: React.MouseEvent, table?: string) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const p = table ? pos[table] : { x: view.x, y: view.y }
    drag.current = { kind: table ? 'table' : 'pan', name: table, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y }
  }

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current
      if (!d) return
      const dx = e.clientX - d.sx
      const dy = e.clientY - d.sy
      if (d.kind === 'pan') setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }))
      else setPos((p) => ({ ...p, [d.name!]: { x: d.ox + dx / view.k, y: d.oy + dy / view.k } }))
    }
    const up = () => {
      if (drag.current?.kind === 'table') setPos((p) => (savePositions(p), p))
      drag.current = null
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }) // re-bound each render so it sees the current zoom

  const openNode = (name: string) => {
    const node = tree.find((n) => n.kind === 'schema' && n.name === schema)?.children?.find((n) => n.name === name)
    if (node) openTable(node)
  }

  // ---- export -------------------------------------------------------------------

  const exportSvg = async () => {
    const el = svgRef.current
    if (!el || tables.length === 0) return
    const path = await call('dialog:saveFile', { title: 'Export diagram', defaultPath: `${schema}-diagram.svg`, filters: [{ name: 'SVG image', extensions: ['svg'] }] })
    if (!path) return
    const b = bounds(tables, pos)
    const pad = 30
    const clone = el.cloneNode(true) as SVGSVGElement
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    clone.setAttribute('width', String(b.maxX - b.minX + pad * 2 + 60))
    clone.setAttribute('height', String(b.maxY - b.minY + pad * 2))
    clone.querySelector('[data-viewport]')?.setAttribute('transform', `translate(${pad - b.minX} ${pad - b.minY})`)
    clone.querySelector('[data-bg]')?.setAttribute('fill', 'var(--bg)')
    const styles = getComputedStyle(document.documentElement)
    // CSS variables mean nothing outside the app; bake in the current colors.
    const text = new XMLSerializer()
      .serializeToString(clone)
      .replace(/var\((--[a-z0-9-]+)\)/g, (_, name: string) => styles.getPropertyValue(name).trim() || '#888')
    try {
      await call('files:writeText', path, text)
      useApp.getState().setNotice(`Saved ${path}`)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  // ---- render -------------------------------------------------------------------

  const lit = (e: Edge) => hover !== null && (e.from === hover || e.to === hover)

  return (
    <div className="flex h-full flex-col" data-testid="erd-view">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line bg-panel px-2 text-xs">
        <div className="relative">
          <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-faint" />
          <input className="field h-6 w-52 pl-6" placeholder="Find table or column" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <button className="btn h-6 px-2" onClick={() => fit(tables, pos)} title="Fit to window">
          <Maximize size={12} /> Fit
        </button>
        <button className="btn h-6 px-2" onClick={relayout} title="Arrange automatically (forgets moved tables)">
          <LayoutGrid size={12} /> Arrange
        </button>
        <button className="btn h-6 px-2" onClick={() => void load()} disabled={Boolean(progress)} title="Reload from the database">
          <RefreshCw size={12} className={progress ? 'animate-spin' : ''} /> Reload
        </button>
        <button className="btn h-6 px-2" onClick={() => void exportSvg()} disabled={tables.length === 0}>
          <Download size={12} /> Export SVG
        </button>
        <div className="flex-1" />
        {progress && (
          <span className="text-muted">
            Reading tables{progress.total ? ` ${progress.done} / ${progress.total}` : '…'}
          </span>
        )}
        {model && !progress && (
          <span className="text-faint">
            {tables.length} tables · {edges.length} relations
            {model.truncated > 0 && ` · ${model.truncated} more not shown`}
            {model.failed.length > 0 && ` · ${model.failed.length} unreadable`}
          </span>
        )}
        <span className="ml-2 w-10 text-right tabular-nums text-faint">{Math.round(view.k * 100)}%</span>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {model && tables.length === 0 && <div className="absolute inset-0 flex items-center justify-center text-xs text-muted">No tables in {schema}.</div>}
        <svg
          ref={svgRef}
          className={`h-full w-full select-none ${drag.current?.kind === 'pan' ? 'cursor-grabbing' : 'cursor-grab'}`}
          onWheel={onWheel}
          onMouseDown={(e) => onMouseDown(e)}
          style={{ fontFamily: 'var(--font-sans)' }}
          tabIndex={active ? 0 : -1}
        >
          <defs>
            {['faint', 'accent'].map((c) => (
              <g key={c}>
                <marker id={`erd-many-${c}`} viewBox="0 0 12 12" refX="1" refY="6" markerWidth="12" markerHeight="12" orient="auto-start-reverse">
                  <path d="M 11 6 L 1 1 M 11 6 L 1 6 M 11 6 L 1 11" fill="none" stroke={`var(--${c})`} strokeWidth="1.2" />
                </marker>
                <marker id={`erd-one-${c}`} viewBox="0 0 12 12" refX="11" refY="6" markerWidth="12" markerHeight="12" orient="auto">
                  <path d="M 7 1 L 7 11 M 10 1 L 10 11" fill="none" stroke={`var(--${c})`} strokeWidth="1.2" />
                </marker>
              </g>
            ))}
          </defs>
          <rect data-bg x="-100000" y="-100000" width="200000" height="200000" fill="transparent" />
          <g data-viewport transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {edges.map((e) => {
              const c = lit(e) ? 'accent' : 'faint'
              const dim = needle && !(tables.find((t) => t.name === e.from && matches(t)) || tables.find((t) => t.name === e.to && matches(t)))
              return (
                <path
                  key={e.id}
                  d={e.d}
                  fill="none"
                  stroke={`var(--${c})`}
                  strokeWidth={c === 'accent' ? 1.8 : 1.2}
                  markerStart={`url(#erd-many-${c})`}
                  markerEnd={`url(#erd-one-${c})`}
                  opacity={dim ? 0.15 : 1}
                />
              )
            })}
            {tables.map((t) => {
              const p = pos[t.name]
              if (!p) return null
              const h = boxHeight(t)
              const fkCols = new Set(t.foreignKeys.flatMap((f) => f.columns))
              const dim = (needle && !matches(t)) || (related && !related.has(t.name))
              return (
                <g
                  key={t.name}
                  transform={`translate(${p.x} ${p.y})`}
                  opacity={dim ? 0.3 : 1}
                  onMouseEnter={() => setHover(t.name)}
                  onMouseLeave={() => setHover(null)}
                  onDoubleClick={() => openNode(t.name)}
                  data-table={t.name}
                >
                  <rect width={BOX_W} height={h} rx="6" fill="var(--bg)" stroke={hover === t.name ? 'var(--accent)' : 'var(--border)'} />
                  <path
                    d={`M 0 6 a 6 6 0 0 1 6 -6 h ${BOX_W - 12} a 6 6 0 0 1 6 6 v ${HEADER_H - 6} h ${-BOX_W} z`}
                    fill="var(--panel-2)"
                    className="cursor-move"
                    onMouseDown={(e) => onMouseDown(e, t.name)}
                  />
                  <text x="10" y={HEADER_H / 2 + 4} fontSize="12" fontWeight="600" fill="var(--text)" pointerEvents="none">
                    {clip(t.name, 28)}
                  </text>
                  {t.kind === 'view' && (
                    <text x={BOX_W - 10} y={HEADER_H / 2 + 4} fontSize="10" textAnchor="end" fill="var(--faint)" pointerEvents="none">
                      view
                    </text>
                  )}
                  {t.columns.slice(0, MAX_ROWS).map((c, i) => {
                    const y = HEADER_H + i * ROW_H + ROW_H / 2 + 4
                    const hit = needle && c.name.toLowerCase().includes(needle)
                    return (
                      <g key={c.name}>
                        {hit && <rect x="1" y={HEADER_H + i * ROW_H} width={BOX_W - 2} height={ROW_H} fill="var(--accent-soft)" />}
                        <text x="10" y={y} fontSize="9" fontWeight="700" fill={c.pk ? 'var(--accent)' : 'var(--faint)'}>
                          {c.pk ? 'PK' : fkCols.has(c.name) ? 'FK' : ''}
                        </text>
                        <text x="30" y={y} fontSize="11" fill="var(--text)" fontWeight={c.pk ? 600 : 400}>
                          {clip(c.name, 20)}
                          {!c.nullable && !c.pk ? ' *' : ''}
                        </text>
                        <text x={BOX_W - 10} y={y} fontSize="10" textAnchor="end" fill="var(--faint)">
                          {clip(c.type.toLowerCase(), 14)}
                        </text>
                      </g>
                    )
                  })}
                  {t.columns.length > MAX_ROWS && (
                    <text x="30" y={HEADER_H + MAX_ROWS * ROW_H + ROW_H / 2 + 4} fontSize="10" fill="var(--faint)">
                      +{t.columns.length - MAX_ROWS} more columns
                    </text>
                  )}
                </g>
              )
            })}
          </g>
        </svg>
        {tables.length > 0 && (
          <div className="pointer-events-none absolute bottom-2 left-3 text-[11px] text-faint">
            Drag headers to move tables · scroll to zoom · double-click a table to open it · * not null
          </div>
        )}
      </div>
    </div>
  )
}
