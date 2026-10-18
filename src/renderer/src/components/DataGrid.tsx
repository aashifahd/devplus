import { useCallback, useEffect, useMemo, useState } from 'react'
import DataEditor, {
  GridCellKind,
  type EditableGridCell,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
  type Theme
} from '@glideapps/glide-data-grid'
import type { EditValue, QueryResult } from '@shared/types'
import { currentValue, emptyPending, type Pending } from '../editing'
import { THEME_EVENT } from '../theme'
import { useApp } from '../store'

const NUMERIC = /int|serial|numeric|decimal|float|double|real|money|number|long|short|tiny|year|^bit$/i
const MAX_DISPLAY = 400

// Translucent so they read on both light and dark backgrounds.
const TINT = {
  edited: 'rgba(224, 138, 18, 0.22)',
  inserted: 'rgba(31, 157, 85, 0.20)',
  deleted: 'rgba(217, 58, 58, 0.22)'
}

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

const ROW_HEIGHT = { compact: 22, regular: 26, comfortable: 32 } as const

function readTheme(fontSize: number): Partial<Theme> {
  return {
    accentColor: cssVar('--accent'),
    accentLight: cssVar('--accent-soft'),
    textDark: cssVar('--text'),
    textMedium: cssVar('--muted'),
    textLight: cssVar('--faint'),
    textHeader: cssVar('--text'),
    textHeaderSelected: '#ffffff',
    bgCell: cssVar('--bg'),
    bgCellMedium: cssVar('--panel'),
    bgHeader: cssVar('--panel'),
    bgHeaderHasFocus: cssVar('--panel-2'),
    bgHeaderHovered: cssVar('--panel-2'),
    bgBubble: cssVar('--panel-2'),
    bgSearchResult: cssVar('--accent-soft'),
    borderColor: cssVar('--border'),
    horizontalBorderColor: cssVar('--border'),
    headerFontStyle: `600 ${fontSize}px`,
    baseFontStyle: `${fontSize}px`,
    fontFamily: cssVar('--font-mono') || 'Consolas, monospace',
    editorFontSize: `${fontSize}px`,
    cellHorizontalPadding: 8,
    cellVerticalPadding: 3
  }
}

/** Re-read CSS variables whenever the theme or accent changes (the grid paints on a canvas). */
function useGridTheme(fontSize: number) {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const onChange = () => setVersion((v) => v + 1)
    window.addEventListener(THEME_EVENT, onChange)
    return () => window.removeEventListener(THEME_EVENT, onChange)
  }, [])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => readTheme(fontSize), [fontSize, version])
}

export interface DataGridProps {
  result: QueryResult
  rowOffset: number
  sort?: { column: string; dir: 'asc' | 'desc' }
  /** Omit for result sets that cannot be re-sorted on the server (query editor). */
  onSort?: (column: string) => void
  pending?: Pending
  /** False for views, read-only connections and query results. */
  editable?: boolean
  /** Column indexes that can never be edited inline (binary data). */
  lockedColumns?: Set<number>
  /** Omit both to let the grid manage selection itself. */
  selection?: GridSelection
  onSelectionChange?: (s: GridSelection) => void
  onCellEdit?: (row: number, col: number, value: EditValue) => void
  onDeleteRows?: (rows: number[]) => void
  onCellMenu?: (row: number, col: number, x: number, y: number) => void
  /** Display text from plugin formatters, by column index then row. Raw values stay for copy and edit. */
  displayOverrides?: Map<number, (string | null)[]>
}

const NO_PENDING = emptyPending()
const NO_LOCKS = new Set<number>()
const noop = () => {}

export default function DataGrid({
  result,
  rowOffset,
  sort,
  onSort,
  pending = NO_PENDING,
  editable = false,
  lockedColumns = NO_LOCKS,
  selection,
  onSelectionChange,
  onCellEdit = noop,
  onDeleteRows = noop,
  onCellMenu,
  displayOverrides
}: DataGridProps) {
  const ui = useApp((s) => s.settings?.ui)
  const theme = useGridTheme(ui?.gridFontSize ?? 12)
  const rowHeight = ROW_HEIGHT[ui?.density ?? 'regular']
  const [widths, setWidths] = useState<Record<string, number>>({})
  const baseRows = result.rows.length

  const numericCols = useMemo(() => result.columns.map((c) => NUMERIC.test(c.type)), [result.columns])

  const columns = useMemo<GridColumn[]>(
    () =>
      result.columns.map((c, i) => {
        const arrow = sort?.column === c.name ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''
        // Size from the header and the first rows so wide text doesn't swallow the screen.
        const sample = result.rows.slice(0, 50).reduce((m, r) => Math.max(m, String(r[i] ?? 'NULL').length), 0)
        const guess = Math.min(320, Math.max(70, Math.max(c.name.length + 3, sample) * 7.5 + 20))
        return { id: `${i}:${c.name}`, title: `${c.name}${arrow}`, width: widths[`${i}:${c.name}`] ?? guess }
      }),
    [result.columns, result.rows, sort, widths]
  )

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const inserted = row >= baseRows
      const deleted = !inserted && pending.deleted.has(row)
      const name = result.columns[col].name
      const edited = !inserted && Boolean(pending.edits.get(row) && name in pending.edits.get(row)!)
      const value = currentValue(result, pending, row, col)
      const readonly = !editable || deleted || lockedColumns.has(col)

      const bgCell = deleted ? TINT.deleted : inserted ? TINT.inserted : edited ? TINT.edited : undefined
      const faint = value === null || value === undefined || deleted

      if (value === null || value === undefined) {
        return {
          kind: GridCellKind.Text,
          data: '',
          displayData: value === undefined ? 'DEFAULT' : 'NULL',
          allowOverlay: !readonly,
          readonly,
          themeOverride: { textDark: theme.textLight, ...(bgCell && { bgCell }) }
        }
      }
      const text = String(value)
      // A plugin's formatted text, unless the cell was edited (then show what was typed).
      const override = !inserted && !edited ? displayOverrides?.get(col)?.[row] : undefined
      const shown = override ?? text
      const display = shown.length > MAX_DISPLAY ? `${shown.slice(0, MAX_DISPLAY)}…` : shown
      return {
        kind: GridCellKind.Text,
        data: text,
        displayData: display.replace(/\r?\n/g, ' ↵ '),
        allowOverlay: true,
        readonly,
        contentAlign: numericCols[col] ? 'right' : 'left',
        themeOverride: bgCell || faint ? { ...(bgCell && { bgCell }), ...(faint && { textDark: theme.textLight }) } : undefined
      }
    },
    [result, pending, baseRows, editable, lockedColumns, numericCols, theme, displayOverrides]
  )

  const onCellEdited = useCallback(
    ([col, row]: Item, cell: EditableGridCell) => {
      if (cell.kind !== GridCellKind.Text) return
      const before = currentValue(result, pending, row, col)
      // Opening the editor on NULL/DEFAULT and closing it without typing is not an edit.
      if ((before === null || before === undefined) && cell.data === '') return
      onCellEdit(row, col, cell.data)
    },
    [result, pending, onCellEdit]
  )

  return (
    <DataEditor
      className="h-full w-full"
      width="100%"
      height="100%"
      theme={theme}
      columns={columns}
      rows={baseRows + pending.inserts.length}
      getCellContent={getCellContent}
      getCellsForSelection
      rowMarkers="both"
      rowMarkerStartIndex={rowOffset + 1}
      rowSelectionMode="multi"
      rowHeight={rowHeight}
      headerHeight={rowHeight + 2}
      smoothScrollX
      smoothScrollY
      gridSelection={selection}
      onGridSelectionChange={onSelectionChange}
      onCellEdited={onCellEdited}
      onDelete={(sel) => {
        // Delete key on whole rows marks them for deletion; it never blanks cells.
        const rows = sel.rows.toArray()
        if (editable && rows.length) onDeleteRows(rows)
        return false
      }}
      onCellContextMenu={
        onCellMenu &&
        (([col, row], e) => {
          e.preventDefault()
          onCellMenu(row, col, e.bounds.x + e.localEventX, e.bounds.y + e.localEventY)
        })
      }
      onColumnResize={(col, w) => setWidths((prev) => ({ ...prev, [col.id!]: w }))}
      onHeaderClicked={onSort && ((col) => onSort(result.columns[col].name))}
    />
  )
}
