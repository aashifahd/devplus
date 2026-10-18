import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { CellValue, ColumnMeta } from '@shared/types'
import { featuresFor, type GeoSource } from '@shared/geo'
import { THEME_EVENT, isDark } from '../theme'

const FEATURE_LIMIT = 5000
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

function popupHtml(columns: ColumnMeta[], row: CellValue[], skip: Set<number>): string {
  const cells = columns
    .map((c, i) => ({ c, v: row[i], i }))
    .filter((x) => !skip.has(x.i))
    .slice(0, 14)
    .map(({ c, v }) => {
      const text = v === null ? 'NULL' : String(v)
      return `<tr><th>${escapeHtml(c.name)}</th><td>${escapeHtml(text.length > 80 ? `${text.slice(0, 79)}…` : text)}</td></tr>`
    })
  return `<table class="dbc-map-popup">${cells.join('')}</table>`
}

const cssColor = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

export default function MapView({ columns, rows, sources }: { columns: ColumnMeta[]; rows: CellValue[][]; sources: GeoSource[] }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.GeoJSON | null>(null)
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? '')
  const [dark, setDark] = useState(isDark)
  const source = sources.find((s) => s.id === sourceId) ?? sources[0]
  const { features, skipped } = useMemo(() => (source ? featuresFor(source, rows, FEATURE_LIMIT) : { features: [], skipped: 0 }), [source, rows])

  useEffect(() => {
    const map = L.map(hostRef.current!, { worldCopyJump: true, preferCanvas: true, attributionControl: true })
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map)
    map.setView([20, 0], 2)
    mapRef.current = map
    // The container is sized by flexbox after mount; tell Leaflet once it settles.
    const ro = new ResizeObserver(() => map.invalidateSize())
    ro.observe(hostRef.current!)
    const onTheme = () => setDark(isDark())
    window.addEventListener(THEME_EVENT, onTheme)
    return () => {
      ro.disconnect()
      window.removeEventListener(THEME_EVENT, onTheme)
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    layerRef.current?.remove()
    // Leaflet paints with attributes, so CSS variables are resolved here.
    const fill = cssColor('--series-1') || '#2a78d6'
    const ring = cssColor('--bg') || '#ffffff'
    const skip = new Set(source?.kind === 'latlng' ? [source.lat, source.lng] : source ? [source.column] : [])
    const layer = L.geoJSON(
      { type: 'FeatureCollection', features: features.map((f) => ({ type: 'Feature', properties: { row: f.row }, geometry: f.geometry })) } as GeoJSON.FeatureCollection,
      {
        style: () => ({ color: fill, weight: 2, fillColor: fill, fillOpacity: 0.12 }),
        pointToLayer: (_f, at) => L.circleMarker(at, { radius: 5, color: ring, weight: 2, fillColor: fill, fillOpacity: 1 }),
        onEachFeature: (f, l) => l.bindPopup(() => popupHtml(columns, rows[(f.properties as { row: number }).row], skip), { maxWidth: 360 })
      }
    ).addTo(map)
    layerRef.current = layer
    const b = layer.getBounds()
    if (b.isValid()) map.fitBounds(b, { padding: [30, 30], maxZoom: 15 })
  }, [features, columns, rows, source, dark])

  return (
    <div className="flex h-full flex-col" data-testid="map-view">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-panel px-2 text-xs">
        {sources.length > 1 ? (
          <select className="field h-6 w-56" value={source?.id} onChange={(e) => setSourceId(e.target.value)} aria-label="Location column">
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-muted">{source?.label}</span>
        )}
        <span className="text-faint">
          {features.length.toLocaleString()} shown
          {features.length === FEATURE_LIMIT && rows.length > FEATURE_LIMIT && ` (first ${FEATURE_LIMIT.toLocaleString()})`}
          {skipped > 0 && ` · ${skipped.toLocaleString()} without a usable location`}
        </span>
      </div>
      <div ref={hostRef} className={`min-h-0 flex-1 ${dark ? 'dbc-map-dark' : ''}`} />
    </div>
  )
}
