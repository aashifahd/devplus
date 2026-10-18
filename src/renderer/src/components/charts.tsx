import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { CellValue, ColumnMeta } from '@shared/types'
import { compact, fullNumber, niceTicks, type ChartData } from '@shared/metrics'

/** Series colors come from theme tokens, assigned in fixed order and never cycled. */
export const seriesColor = (i: number) => `var(--series-${i + 1})`

const AXIS_FONT = 10
const CHAR_W = 6.2

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

export function Legend({ names }: { names: string[] }) {
  if (names.length < 2) return null
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 pb-1.5 text-[11px] text-muted">
      {names.map((n, i) => (
        <span key={n} className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: seriesColor(i) }} />
          {n}
        </span>
      ))}
    </div>
  )
}

function Tooltip({ x, y, width, title, rows }: { x: number; y: number; width: number; title: string; rows: { name: string; value: number | null; i: number }[] }) {
  const left = x > width - 180 ? Math.max(0, x - 172) : x + 12
  return (
    <div
      className="pointer-events-none absolute z-10 min-w-36 max-w-64 rounded-md border border-line bg-panel px-2.5 py-1.5 text-[11px] shadow-lg"
      style={{ left, top: Math.max(0, y - 10) }}
    >
      <div className="mb-1 truncate font-medium text-fg">{title}</div>
      {rows.map((r) => (
        <div key={r.name} className="flex items-center gap-1.5">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: seriesColor(r.i) }} />
          <span className="min-w-0 flex-1 truncate text-muted">{r.name}</span>
          <span className="tabular-nums text-fg">{r.value === null ? '–' : fullNumber(r.value)}</span>
        </div>
      ))}
    </div>
  )
}

function yDomain(data: ChartData) {
  const vals = data.series.flatMap((s) => s.values.filter((v): v is number => v !== null))
  const lo = Math.min(0, ...vals)
  const hi = Math.max(0, ...vals)
  const ticks = niceTicks(lo, hi, 4)
  return { ticks, min: ticks[0], max: ticks[ticks.length - 1] }
}

/** Axis labels drop the year when every point falls in the same one; tooltips (full) always show it. */
function formatX(data: ChartData, i: number, full = false): string {
  if (data.xScale === 'time' && data.xValues) {
    const xs = data.xValues
    const span = new Date(Math.min(...xs)).getUTCFullYear() !== new Date(Math.max(...xs)).getUTCFullYear()
    const year = full || span ? { year: 'numeric' as const } : {}
    // Plain dates parse as UTC midnight; show them as the same calendar day everywhere.
    if (/^\d{4}-\d{2}-\d{2}$/.test(data.xLabels[i])) {
      return new Date(xs[i]).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...year, timeZone: 'UTC' })
    }
    const d = new Date(xs[i])
    const midnight = d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0
    return midnight
      ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...year })
      : d.toLocaleString(undefined, { month: 'short', day: 'numeric', ...year, hour: '2-digit', minute: '2-digit' })
  }
  return data.xLabels[i]
}

/** Evenly spaced indexes whose labels fit side by side. */
function labelIndexes(n: number, plotW: number, labelW: number): number[] {
  if (n === 0) return []
  const fit = Math.max(1, Math.floor(plotW / Math.max(40, labelW)))
  if (n <= fit) return Array.from({ length: n }, (_, i) => i)
  const step = (n - 1) / (fit - 1 || 1)
  return Array.from(new Set(Array.from({ length: fit }, (_, k) => Math.round(k * step))))
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function Frame({
  data,
  height,
  rightPad,
  children
}: {
  data: ChartData
  height: number
  rightPad: number
  children: (g: { width: number; plotW: number; plotH: number; left: number; top: number; y: (v: number) => number; ticks: number[] }) => ReactNode
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const { ticks, min, max } = yDomain(data)
  const left = Math.max(...ticks.map((t) => compact(t).length)) * CHAR_W + 10
  const top = 8
  const bottom = 22
  const plotW = Math.max(10, width - left - rightPad)
  const plotH = Math.max(10, height - top - bottom)
  const y = (v: number) => top + plotH - ((v - min) / (max - min || 1)) * plotH
  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && children({ width, plotW, plotH, left, top, y, ticks })}
    </div>
  )
}

function YAxis({ ticks, y, left, plotW }: { ticks: number[]; y: (v: number) => number; left: number; plotW: number }) {
  return (
    <g>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={left} x2={left + plotW} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} shapeRendering="crispEdges" />
          <text x={left - 6} y={y(t) + 3} textAnchor="end" fontSize={AXIS_FONT} fill="var(--faint)">
            {compact(t)}
          </text>
        </g>
      ))}
    </g>
  )
}

export function LineChart({ data, height }: { data: ChartData; height: number }) {
  const [hover, setHover] = useState<{ i: number; px: number; py: number } | null>(null)
  const n = data.xLabels.length
  const single = data.series.length === 1
  const lastVal = single ? data.series[0].values.at(-1) : undefined
  const rightPad = single && lastVal !== null && lastVal !== undefined ? compact(lastVal).length * CHAR_W + 14 : 12

  return (
    <div>
      <Legend names={data.series.map((s) => s.name)} />
      <Frame data={data} height={height} rightPad={rightPad}>
        {({ width, plotW, plotH, left, top, y, ticks }) => {
          const xs = data.xValues
          const xmin = xs ? Math.min(...xs) : 0
          const xmax = xs ? Math.max(...xs) : n - 1
          const x = (i: number) => left + (xs ? (xmax === xmin ? 0.5 : (xs[i] - xmin) / (xmax - xmin)) : n === 1 ? 0.5 : i / (n - 1)) * plotW
          const path = (vals: (number | null)[]) => {
            let d = ''
            let pen = false
            vals.forEach((v, i) => {
              if (v === null) {
                pen = false
                return
              }
              d += `${pen ? 'L' : 'M'} ${x(i).toFixed(1)} ${y(v).toFixed(1)} `
              pen = true
            })
            return d
          }
          const nearest = (px: number) => {
            let best = 0
            let dist = Infinity
            for (let i = 0; i < n; i++) {
              const d = Math.abs(x(i) - px)
              if (d < dist) {
                dist = d
                best = i
              }
            }
            return best
          }
          const labels = labelIndexes(n, plotW, Math.max(...data.xLabels.slice(0, 50).map((_, i) => formatX(data, i).length), 4) * CHAR_W + 28)
          const base = y(Math.max(ticks[0], Math.min(0, ticks[ticks.length - 1])))
          return (
            <>
              <svg width={width} height={height} className="block overflow-visible">
                <YAxis ticks={ticks} y={y} left={left} plotW={plotW} />
                {labels.map((i) => (
                  <text key={i} x={x(i)} y={top + plotH + 15} textAnchor={i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle'} fontSize={AXIS_FONT} fill="var(--faint)">
                    {clip(formatX(data, i), 18)}
                  </text>
                ))}
                {single && data.series[0].values.every((v) => v !== null) && n > 1 && (
                  <path d={`${path(data.series[0].values)} L ${x(n - 1)} ${base} L ${x(0)} ${base} Z`} fill={seriesColor(0)} opacity={0.1} />
                )}
                {data.series.map((s, si) => (
                  <path key={s.name} d={path(s.values)} fill="none" stroke={seriesColor(si)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                ))}
                {single && lastVal !== null && lastVal !== undefined && (
                  <>
                    <circle cx={x(n - 1)} cy={y(lastVal)} r={4} fill={seriesColor(0)} stroke="var(--bg)" strokeWidth={2} />
                    <text x={x(n - 1) + 8} y={y(lastVal) + 3} fontSize={AXIS_FONT + 1} fontWeight={600} fill="var(--text)">
                      {compact(lastVal)}
                    </text>
                  </>
                )}
                {hover && (
                  <g pointerEvents="none">
                    <line x1={x(hover.i)} x2={x(hover.i)} y1={top} y2={top + plotH} stroke="var(--muted)" strokeWidth={1} />
                    {data.series.map((s, si) => {
                      const v = s.values[hover.i]
                      return v === null ? null : <circle key={s.name} cx={x(hover.i)} cy={y(v)} r={4} fill={seriesColor(si)} stroke="var(--bg)" strokeWidth={2} />
                    })}
                  </g>
                )}
                <rect
                  x={left}
                  y={top}
                  width={plotW}
                  height={plotH}
                  fill="transparent"
                  onMouseMove={(e) => {
                    const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect()
                    setHover({ i: nearest(e.clientX - r.left), px: e.clientX - r.left, py: e.clientY - r.top })
                  }}
                  onMouseLeave={() => setHover(null)}
                />
              </svg>
              {hover && (
                <Tooltip
                  x={hover.px}
                  y={hover.py}
                  width={width}
                  title={formatX(data, hover.i, true)}
                  rows={data.series.map((s, i) => ({ name: s.name, value: s.values[hover.i], i }))}
                />
              )}
            </>
          )
        }}
      </Frame>
    </div>
  )
}

/** A bar with a 4px rounded data end and a square end at the baseline. */
function barPath(x: number, w: number, y0: number, y1: number): string {
  const up = y1 <= y0
  const h = Math.abs(y0 - y1)
  const r = Math.min(4, w / 2, h)
  if (h < 0.5) return ''
  return up
    ? `M ${x} ${y0} V ${y1 + r} Q ${x} ${y1} ${x + r} ${y1} H ${x + w - r} Q ${x + w} ${y1} ${x + w} ${y1 + r} V ${y0} Z`
    : `M ${x} ${y0} V ${y1 - r} Q ${x} ${y1} ${x + r} ${y1} H ${x + w - r} Q ${x + w} ${y1} ${x + w} ${y1 - r} V ${y0} Z`
}

export function BarChart({ data, height }: { data: ChartData; height: number }) {
  const [hover, setHover] = useState<{ i: number; px: number; py: number } | null>(null)
  const n = data.xLabels.length
  const k = data.series.length
  return (
    <div>
      <Legend names={data.series.map((s) => s.name)} />
      <Frame data={data} height={height} rightPad={12}>
        {({ width, plotW, plotH, left, top, y, ticks }) => {
          const band = plotW / Math.max(1, n)
          const gap = 2
          const barW = Math.max(1, Math.min(24, (band * 0.72 - gap * (k - 1)) / k))
          const groupW = barW * k + gap * (k - 1)
          const zero = y(Math.max(ticks[0], Math.min(0, ticks[ticks.length - 1])))
          const labelCaps = k === 1 && n <= 12 && band > 34
          const labels = labelIndexes(n, plotW, Math.min(14, Math.max(...data.xLabels.slice(0, 100).map((l) => l.length), 3)) * CHAR_W + 10)
          return (
            <>
              <svg width={width} height={height} className="block overflow-visible">
                <YAxis ticks={ticks} y={y} left={left} plotW={plotW} />
                {data.xLabels.map((label, i) => {
                  const gx = left + band * i + (band - groupW) / 2
                  return (
                    <g key={i} opacity={hover && hover.i !== i ? 0.55 : 1}>
                      {data.series.map((s, si) => {
                        const v = s.values[i]
                        if (v === null) return null
                        return <path key={s.name} d={barPath(gx + si * (barW + gap), barW, zero, y(v))} fill={seriesColor(si)} />
                      })}
                      {labelCaps && data.series[0].values[i] !== null && (
                        <text
                          x={gx + barW / 2}
                          y={(data.series[0].values[i] as number) >= 0 ? y(data.series[0].values[i] as number) - 4 : y(data.series[0].values[i] as number) + 11}
                          textAnchor="middle"
                          fontSize={AXIS_FONT}
                          fill="var(--muted)"
                        >
                          {compact(data.series[0].values[i] as number)}
                        </text>
                      )}
                      {labels.includes(i) && (
                        <text x={left + band * i + band / 2} y={top + plotH + 15} textAnchor="middle" fontSize={AXIS_FONT} fill="var(--faint)">
                          {clip(label, 14)}
                        </text>
                      )}
                    </g>
                  )
                })}
                <line x1={left} x2={left + plotW} y1={zero} y2={zero} stroke="var(--muted)" strokeWidth={1} shapeRendering="crispEdges" />
                {/* Hit targets: the whole band, not just the bar. */}
                {data.xLabels.map((_, i) => (
                  <rect
                    key={i}
                    x={left + band * i}
                    y={top}
                    width={band}
                    height={plotH}
                    fill="transparent"
                    onMouseMove={(e) => {
                      const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect()
                      setHover({ i, px: e.clientX - r.left, py: e.clientY - r.top })
                    }}
                    onMouseLeave={() => setHover(null)}
                  />
                ))}
              </svg>
              {hover && (
                <Tooltip
                  x={hover.px}
                  y={hover.py}
                  width={width}
                  title={data.xLabels[hover.i]}
                  rows={data.series.map((s, i) => ({ name: s.name, value: s.values[hover.i], i }))}
                />
              )}
            </>
          )
        }}
      </Frame>
    </div>
  )
}

/** One headline number: the last row's value, with a trend line when there are several rows. */
export function StatTile({ data }: { data: ChartData }) {
  const s = data.series[0]
  const vals = s?.values ?? []
  const last = [...vals].reverse().find((v) => v !== null) ?? null
  const trend = vals.filter((v): v is number => v !== null)
  const [ref, width] = useWidth<HTMLDivElement>()
  if (!s) return <div className="text-xs text-muted">The query returned no numeric column.</div>
  const h = 36
  const lo = Math.min(...trend)
  const hi = Math.max(...trend)
  const px = (i: number) => (trend.length === 1 ? width / 2 : (i / (trend.length - 1)) * (width - 8) + 4)
  const py = (v: number) => (hi === lo ? h / 2 : 4 + (1 - (v - lo) / (hi - lo)) * (h - 8))
  return (
    <div ref={ref} className="flex h-full flex-col justify-center">
      <div className="text-[32px] font-semibold leading-tight tabular-nums text-fg" title={last === null ? '' : fullNumber(last)}>
        {last === null ? '–' : compact(last)}
      </div>
      <div className="text-[11px] text-muted">{s.name}</div>
      {trend.length >= 3 && width > 0 && (
        <svg width={width} height={h} className="mt-2 block">
          <path d={trend.map((v, i) => `${i ? 'L' : 'M'} ${px(i).toFixed(1)} ${py(v).toFixed(1)}`).join(' ')} fill="none" stroke="var(--faint)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={px(trend.length - 1)} cy={py(trend[trend.length - 1])} r={4} fill="var(--accent)" stroke="var(--bg)" strokeWidth={2} />
        </svg>
      )}
    </div>
  )
}

export function ResultTable({ columns, rows, limit = 100 }: { columns: ColumnMeta[]; rows: CellValue[][]; limit?: number }) {
  return (
    <div className="h-full overflow-auto">
      <table className="w-full select-text border-collapse text-[11px]">
        <thead className="sticky top-0 bg-panel">
          <tr>
            {columns.map((c, i) => (
              <th key={i} className="whitespace-nowrap border-b border-line px-2 py-1 text-left font-medium text-muted">
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map((r, ri) => (
            <tr key={ri} className="hover:bg-panel">
              {r.map((v, ci) => (
                <td key={ci} className={`max-w-56 truncate whitespace-nowrap border-b border-line px-2 py-1 ${v === null ? 'text-faint' : typeof v === 'number' ? 'text-right tabular-nums' : ''}`}>
                  {v === null ? 'NULL' : String(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > limit && <div className="px-2 py-1 text-[11px] text-faint">Showing {limit} of {rows.length.toLocaleString()} rows.</div>}
    </div>
  )
}
