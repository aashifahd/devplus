import type { CellValue, ColumnMeta } from './types'

export type WidgetKind = 'number' | 'line' | 'bar' | 'table'

export interface MetricsWidget {
  id: string
  title: string
  kind: WidgetKind
  /** A saved query (kept in sync when it is edited) or SQL typed into the widget. */
  source: { type: 'saved'; savedId: string } | { type: 'sql'; sql: string }
  /** Category or time column; empty picks the first non-numeric column. */
  x: string
  /** Value columns; empty picks every numeric column (up to the series limit). */
  y: string[]
  /** Columns of a three-column grid. */
  span: 1 | 2 | 3
}

export interface MetricsBoard {
  id: string
  connectionId: string
  name: string
  /** Seconds between automatic refreshes while the board is open; 0 is off. */
  refreshSec: number
  widgets: MetricsWidget[]
  updatedAt: number
}

export const REFRESH_CHOICES = [0, 30, 60, 300, 900]
/** More series than this fold away; a ninth color is never generated. */
export const MAX_SERIES = 8
export const MAX_POINTS = 500

const NUMERIC_TYPE = /int|serial|numeric|decimal|float|double|real|money|number|long|short|count|sum/i

export function toNumber(v: CellValue): number | null {
  if (v === null || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** A column counts as numeric when its type says so, or when every sampled value parses. */
export function isNumericColumn(col: ColumnMeta, rows: CellValue[][], index: number): boolean {
  if (NUMERIC_TYPE.test(col.type)) return true
  const sample = rows.slice(0, 50).map((r) => r[index]).filter((v) => v !== null)
  return sample.length > 0 && sample.every((v) => toNumber(v) !== null)
}

export type XScale = 'time' | 'linear' | 'band'

export interface Series {
  name: string
  values: (number | null)[]
}

export interface ChartData {
  xName: string
  xLabels: string[]
  /** Parsed x for time (ms) and linear scales; null for band. */
  xValues: number[] | null
  xScale: XScale
  series: Series[]
  /** Value columns that didn't fit under MAX_SERIES. */
  droppedSeries: number
  truncatedRows: boolean
}

const looksLikeDate = (v: CellValue) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v))

/** Pick the x column and value columns for a chart, honouring the widget's choices. */
export function chartData(columns: ColumnMeta[], rows: CellValue[][], widget: Pick<MetricsWidget, 'x' | 'y' | 'kind'>): ChartData {
  const numeric = columns.map((c, i) => isNumericColumn(c, rows, i))
  let xi = widget.x ? columns.findIndex((c) => c.name === widget.x) : -1
  if (xi < 0) xi = numeric.findIndex((n) => !n)
  if (xi < 0 && columns.length > 1) xi = 0
  const wanted = widget.y.length ? widget.y.map((n) => columns.findIndex((c) => c.name === n)).filter((i) => i >= 0 && i !== xi) : columns.map((_, i) => i).filter((i) => i !== xi && numeric[i])
  const yIdx = wanted.slice(0, MAX_SERIES)
  const used = rows.slice(0, MAX_POINTS)

  const rawX = xi >= 0 ? used.map((r) => r[xi]) : used.map((_, i) => i + 1)
  let xScale: XScale = 'band'
  let xValues: number[] | null = null
  if (widget.kind === 'line' && rawX.length > 0) {
    if (rawX.every((v) => looksLikeDate(v as CellValue))) {
      xScale = 'time'
      xValues = rawX.map((v) => Date.parse(String(v)))
    } else if (xi >= 0 && numeric[xi] && rawX.every((v) => toNumber(v as CellValue) !== null)) {
      xScale = 'linear'
      xValues = rawX.map((v) => toNumber(v as CellValue)!)
    }
  }

  return {
    xName: xi >= 0 ? columns[xi].name : '#',
    xLabels: rawX.map((v) => (v === null ? 'NULL' : String(v))),
    xValues,
    xScale,
    series: yIdx.map((i) => ({ name: columns[i].name, values: used.map((r) => toNumber(r[i])) })),
    droppedSeries: wanted.length - yIdx.length,
    truncatedRows: rows.length > used.length
  }
}

/** Round axis ticks: 1, 2 or 5 times a power of ten. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) {
    const pad = Math.abs(min) || 1
    min -= pad
    max += pad
  }
  const raw = (max - min) / Math.max(1, count)
  const pow = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow
  const start = Math.floor(min / step) * step
  const ticks: number[] = []
  for (let v = start; v <= max + step * 0.5; v += step) ticks.push(Number(v.toPrecision(12)))
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step)
  return ticks
}

const compactFmt = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const fullFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

/** 1,284 · 12.9K · 4.2M */
export function compact(n: number): string {
  return Math.abs(n) < 10_000 ? fullFmt.format(n) : compactFmt.format(n)
}

export const fullNumber = (n: number) => fullFmt.format(n)
