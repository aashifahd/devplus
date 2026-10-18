import type { ErdTable } from '@shared/types'

export const BOX_W = 240
export const HEADER_H = 28
export const ROW_H = 20
/** Columns drawn per table; the rest collapse into a "+N more" row. */
export const MAX_ROWS = 24
const GAP_X = 110
const GAP_Y = 32

export interface Point {
  x: number
  y: number
}

export const shownRows = (t: ErdTable) => Math.min(t.columns.length, MAX_ROWS) + (t.columns.length > MAX_ROWS ? 1 : 0)
export const boxHeight = (t: ErdTable) => HEADER_H + shownRows(t) * ROW_H + 6

/** Vertical centre of a column's row, or of the header when the column isn't drawn. */
export function rowY(t: ErdTable, at: Point, column: string): number {
  const i = t.columns.findIndex((c) => c.name === column)
  if (i < 0 || i >= MAX_ROWS) return at.y + HEADER_H / 2
  return at.y + HEADER_H + i * ROW_H + ROW_H / 2
}

/** Foreign keys that point at another table drawn in the same diagram. */
export function references(tables: ErdTable[]): Map<string, Set<string>> {
  const names = new Set(tables.map((t) => t.name))
  const out = new Map<string, Set<string>>()
  for (const t of tables) {
    const refs = new Set<string>()
    for (const fk of t.foreignKeys) if (fk.refTable !== t.name && names.has(fk.refTable) && fk.refSchema === t.schema) refs.add(fk.refTable)
    out.set(t.name, refs)
  }
  return out
}

/**
 * Layered layout: referenced tables to the left, the tables that point at them to the right,
 * ordered within each column by where their parents sit. Unrelated tables go in a grid below.
 */
export function layout(tables: ErdTable[]): Record<string, Point> {
  const refs = references(tables)
  const referenced = new Set([...refs.values()].flatMap((s) => [...s]))
  const linked = tables.filter((t) => refs.get(t.name)!.size > 0 || referenced.has(t.name))
  const loose = tables.filter((t) => !linked.includes(t))
  const byName = new Map(tables.map((t) => [t.name, t]))

  const rank = new Map<string, number>()
  const visiting = new Set<string>()
  const rankOf = (name: string): number => {
    const known = rank.get(name)
    if (known !== undefined) return known
    if (visiting.has(name)) return 0 // cycle: break it here
    visiting.add(name)
    let r = 0
    for (const p of refs.get(name) ?? []) r = Math.max(r, rankOf(p) + 1)
    visiting.delete(name)
    rank.set(name, r)
    return r
  }
  for (const t of linked) rankOf(t.name)

  const columns: string[][] = []
  for (const t of linked) (columns[rank.get(t.name)!] ??= []).push(t.name)

  const pos: Record<string, Point> = {}
  const order = new Map<string, number>()
  let maxBottom = 0
  columns.forEach((col, ci) => {
    if (!col) return
    if (ci === 0) {
      // Most-referenced tables first: they anchor the most edges.
      const fanIn = (n: string) => [...refs.values()].filter((s) => s.has(n)).length
      col.sort((a, b) => fanIn(b) - fanIn(a) || a.localeCompare(b))
    } else {
      const bary = (n: string) => {
        const ps = [...(refs.get(n) ?? [])].map((p) => order.get(p)).filter((v): v is number => v !== undefined)
        return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : Number.MAX_SAFE_INTEGER
      }
      col.sort((a, b) => bary(a) - bary(b) || a.localeCompare(b))
    }
    let y = 0
    col.forEach((name, i) => {
      order.set(name, i)
      pos[name] = { x: ci * (BOX_W + GAP_X), y }
      y += boxHeight(byName.get(name)!) + GAP_Y
    })
    maxBottom = Math.max(maxBottom, y)
  })

  // Unrelated tables: a grid under the graph, row by row.
  const perRow = Math.max(3, Math.min(8, Math.ceil(Math.sqrt(loose.length * 1.5))))
  let y = linked.length ? maxBottom + GAP_Y * 2 : 0
  for (let i = 0; i < loose.length; i += perRow) {
    const row = loose.slice(i, i + perRow)
    row.forEach((t, j) => (pos[t.name] = { x: j * (BOX_W + GAP_X / 2), y }))
    y += Math.max(...row.map(boxHeight)) + GAP_Y
  }
  return pos
}

/** Bounding box of every table, for fitting and export. */
export function bounds(tables: ErdTable[], pos: Record<string, Point>) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const t of tables) {
    const p = pos[t.name]
    if (!p) continue
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x + BOX_W)
    maxY = Math.max(maxY, p.y + boxHeight(t))
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 0, maxY: 0 }
}
