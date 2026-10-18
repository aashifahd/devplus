import type { CellValue, ColumnMeta } from './types'

/** GeoJSON geometry, in longitude/latitude (WGS 84). */
export type Position = [number, number]
export type Geometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'MultiPoint'; coordinates: Position[] }
  | { type: 'LineString'; coordinates: Position[] }
  | { type: 'MultiLineString'; coordinates: Position[][] }
  | { type: 'Polygon'; coordinates: Position[][] }
  | { type: 'MultiPolygon'; coordinates: Position[][][] }
  | { type: 'GeometryCollection'; geometries: Geometry[] }

export type GeoSource =
  | { id: string; label: string; kind: 'latlng'; lat: number; lng: number }
  | { id: string; label: string; kind: 'geometry'; column: number }

export interface GeoFeature {
  row: number
  geometry: Geometry
}

const SAMPLE = 25

// ---- WKB / EWKB ---------------------------------------------------------------------

class Reader {
  private pos = 0
  private little = true
  constructor(private view: DataView) {}
  byteOrder() {
    this.little = this.view.getUint8(this.pos++) === 1
  }
  u32() {
    const v = this.view.getUint32(this.pos, this.little)
    this.pos += 4
    return v
  }
  f64() {
    const v = this.view.getFloat64(this.pos, this.little)
    this.pos += 8
    return v
  }
  get done() {
    return this.pos >= this.view.byteLength
  }
}

function readGeometry(r: Reader, srid: { value: number | null }): Geometry {
  r.byteOrder()
  let type = r.u32()
  // EWKB flags (PostGIS) or ISO type offsets (1000 Z, 2000 M, 3000 ZM).
  let dims = 2
  if (type & 0x80000000) dims++
  if (type & 0x40000000) dims++
  if (type & 0x20000000) srid.value = r.u32()
  type &= 0x0fffffff
  if (type >= 3000) {
    dims = 4
    type -= 3000
  } else if (type >= 1000) {
    dims = 3
    type -= type >= 2000 ? 2000 : 1000
  }
  const point = (): Position => {
    const x = r.f64()
    const y = r.f64()
    for (let i = 2; i < dims; i++) r.f64()
    return [x, y]
  }
  const points = () => Array.from({ length: r.u32() }, point)
  const rings = () => Array.from({ length: r.u32() }, points)
  const children = () => Array.from({ length: r.u32() }, () => readGeometry(r, srid))
  switch (type) {
    case 1:
      return { type: 'Point', coordinates: point() }
    case 2:
      return { type: 'LineString', coordinates: points() }
    case 3:
      return { type: 'Polygon', coordinates: rings() }
    case 4:
      return { type: 'MultiPoint', coordinates: children().map((g) => (g as { coordinates: Position }).coordinates) }
    case 5:
      return { type: 'MultiLineString', coordinates: children().map((g) => (g as { coordinates: Position[] }).coordinates) }
    case 6:
      return { type: 'MultiPolygon', coordinates: children().map((g) => (g as { coordinates: Position[][] }).coordinates) }
    case 7:
      return { type: 'GeometryCollection', geometries: children() }
    default:
      throw new Error(`Unsupported WKB type ${type}`)
  }
}

function hexBytes(hex: string): DataView {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return new DataView(bytes.buffer)
}

export function parseWkbHex(hex: string): { geometry: Geometry; srid: number | null } {
  const srid = { value: null as number | null }
  const geometry = readGeometry(new Reader(hexBytes(hex)), srid)
  return { geometry, srid: srid.value }
}

// ---- WKT ------------------------------------------------------------------------------

const WKT = /^\s*(?:SRID=(\d+);)?\s*(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)\b/i

export function parseWkt(text: string): { geometry: Geometry; srid: number | null } {
  const m = WKT.exec(text)
  if (!m) throw new Error('Not WKT')
  let i = m[0].length
  const s = text

  const skip = () => {
    while (i < s.length && /\s/.test(s[i])) i++
  }
  const expect = (ch: string) => {
    skip()
    if (s[i] !== ch) throw new Error(`Expected ${ch} at ${i}`)
    i++
  }
  const word = () => {
    skip()
    const w = /^[A-Za-z]+/.exec(s.slice(i))?.[0] ?? ''
    i += w.length
    return w.toUpperCase()
  }
  const number = () => {
    skip()
    const n = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(s.slice(i))?.[0]
    if (!n) throw new Error(`Expected a number at ${i}`)
    i += n.length
    return Number(n)
  }
  const point = (): Position => {
    const x = number()
    const y = number()
    skip()
    while (/[-+\d.]/.test(s[i] ?? '')) {
      number() // Z / M
      skip()
    }
    return [x, y]
  }
  const list = <T,>(item: () => T): T[] => {
    expect('(')
    const out = [item()]
    skip()
    while (s[i] === ',') {
      i++
      out.push(item())
      skip()
    }
    expect(')')
    return out
  }
  // MULTIPOINT allows both "(1 2, 3 4)" and "((1 2), (3 4))".
  const multiPoint = () => {
    skip()
    return s[i] === '(' ? list(point) : [point()]
  }
  const body = (type: string): Geometry => {
    const modifier = word()
    if (modifier && !['Z', 'M', 'ZM'].includes(modifier)) throw new Error(`Unexpected ${modifier}`)
    skip()
    if (s.slice(i, i + 5).toUpperCase() === 'EMPTY') throw new Error('Empty geometry')
    switch (type) {
      case 'POINT':
        return { type: 'Point', coordinates: list(point)[0] }
      case 'LINESTRING':
        return { type: 'LineString', coordinates: list(point) }
      case 'POLYGON':
        return { type: 'Polygon', coordinates: list(() => list(point)) }
      case 'MULTIPOINT':
        return { type: 'MultiPoint', coordinates: list(multiPoint).flat() }
      case 'MULTILINESTRING':
        return { type: 'MultiLineString', coordinates: list(() => list(point)) }
      case 'MULTIPOLYGON':
        return { type: 'MultiPolygon', coordinates: list(() => list(() => list(point))) }
      default:
        return { type: 'GeometryCollection', geometries: list(() => body(word())) }
    }
  }
  const geometry = body(m[2].toUpperCase())
  return { geometry, srid: m[1] ? Number(m[1]) : null }
}

// ---- normalising ------------------------------------------------------------------------

function mapCoords(g: Geometry, f: (p: Position) => Position): Geometry {
  switch (g.type) {
    case 'Point':
      return { type: g.type, coordinates: f(g.coordinates) }
    case 'MultiPoint':
    case 'LineString':
      return { type: g.type, coordinates: g.coordinates.map(f) } as Geometry
    case 'MultiLineString':
    case 'Polygon':
      return { type: g.type, coordinates: g.coordinates.map((r) => r.map(f)) } as Geometry
    case 'MultiPolygon':
      return { type: g.type, coordinates: g.coordinates.map((p) => p.map((r) => r.map(f))) }
    case 'GeometryCollection':
      return { type: g.type, geometries: g.geometries.map((c) => mapCoords(c, f)) }
  }
}

function everyCoord(g: Geometry, f: (p: Position) => boolean): boolean {
  let ok = true
  mapCoords(g, (p) => {
    if (!f(p)) ok = false
    return p
  })
  return ok
}

const R = 6378137
const fromWebMercator = ([x, y]: Position): Position => [(x / R) * (180 / Math.PI), (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI)]
const inRange = ([x, y]: Position) => Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 180 && Math.abs(y) <= 90

/** Bring a geometry to lon/lat; null when the coordinate system isn't one we can place on a map. */
function toLonLat(g: Geometry, srid: number | null): Geometry | null {
  if (srid === 3857 || srid === 900913) g = mapCoords(g, fromWebMercator)
  else if (srid !== null && srid !== 0 && srid !== 4326 && srid !== 4269) return null
  return everyCoord(g, inRange) ? g : null
}

const GEOJSON_TYPES = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection'])

/** Any one cell as a geometry: GeoJSON, WKT, (E)WKB hex, or MySQL's SRID-prefixed binary. */
export function parseGeometry(v: CellValue): Geometry | null {
  if (typeof v !== 'string') return null
  const text = v.trim()
  try {
    if (text.startsWith('{')) {
      let obj = JSON.parse(text) as { type?: string; geometry?: unknown; coordinates?: unknown }
      if (obj.type === 'Feature') obj = obj.geometry as typeof obj
      if (!obj || !GEOJSON_TYPES.has(obj.type ?? '')) return null
      return toLonLat(obj as Geometry, null)
    }
    if (WKT.test(text)) {
      const { geometry, srid } = parseWkt(text)
      return toLonLat(geometry, srid)
    }
    if (/^0x[0-9a-f]+$/i.test(text) && text.length >= 2 + 8 + 42) {
      // MySQL: 4-byte little-endian SRID, then WKB.
      const hex = text.slice(2)
      const srid = hexBytes(hex.slice(0, 8)).getUint32(0, true)
      return toLonLat(parseWkbHex(hex.slice(8)).geometry, srid || null)
    }
    if (/^0[01][0-9a-f]{8,}$/i.test(text) && text.length % 2 === 0 && text.length >= 42) {
      const { geometry, srid } = parseWkbHex(text)
      return toLonLat(geometry, srid)
    }
  } catch {
    return null
  }
  return null
}

const LAT = /^(.*?)(lat|latitude)$/i
const LNG = /^(.*?)(lng|lon|long|longitude)$/i

const num = (v: CellValue) => (v === null || v === '' ? null : Number(v))

/** Columns (or column pairs) that hold mappable locations in this result. */
export function detectGeo(columns: ColumnMeta[], rows: CellValue[][]): GeoSource[] {
  const out: GeoSource[] = []
  const sample = rows.slice(0, 200)
  const names = columns.map((c) => c.name)

  names.forEach((name, li) => {
    const m = LAT.exec(name)
    if (!m) return
    const prefix = m[1].toLowerCase()
    const gi = names.findIndex((n) => {
      const g = LNG.exec(n)
      return g !== null && g[1].toLowerCase() === prefix
    })
    if (gi < 0) return
    const pairs = sample.map((r) => [num(r[li]), num(r[gi])]).filter(([a, b]) => a !== null && b !== null).slice(0, SAMPLE)
    if (pairs.length && pairs.every(([a, b]) => Math.abs(a!) <= 90 && Math.abs(b!) <= 180)) {
      out.push({ id: `ll:${li}:${gi}`, label: `${name}, ${names[gi]}`, kind: 'latlng', lat: li, lng: gi })
    }
  })

  columns.forEach((c, ci) => {
    const values = sample.map((r) => r[ci]).filter((v) => v !== null && v !== '').slice(0, SAMPLE)
    if (values.length === 0 || typeof values[0] !== 'string') return
    const parsed = values.filter((v) => parseGeometry(v) !== null).length
    if (parsed / values.length >= 0.8) out.push({ id: `g:${ci}`, label: c.name, kind: 'geometry', column: ci })
  })
  return out
}

export function featuresFor(source: GeoSource, rows: CellValue[][], limit: number): { features: GeoFeature[]; skipped: number } {
  const features: GeoFeature[] = []
  let skipped = 0
  for (let i = 0; i < rows.length && features.length < limit; i++) {
    const r = rows[i]
    let geometry: Geometry | null = null
    if (source.kind === 'latlng') {
      const lat = num(r[source.lat])
      const lng = num(r[source.lng])
      if (lat !== null && lng !== null && inRange([lng, lat])) geometry = { type: 'Point', coordinates: [lng, lat] }
    } else {
      geometry = parseGeometry(r[source.column])
    }
    if (geometry) features.push({ row: i, geometry })
    else skipped++
  }
  return { features, skipped }
}
