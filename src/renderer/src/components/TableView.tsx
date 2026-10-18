import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CompactSelection, type GridSelection } from '@glideapps/glide-data-grid'
import { ChevronLeft, ChevronRight, Download, Filter, Lock, Map as MapIcon, Plus, RefreshCw, Trash2, Upload, X } from 'lucide-react'
import {
  effectiveSafeMode,
  FILTER_OPS,
  type ChangeSet,
  type ColumnInfo,
  type QueryResult,
  type TableFilter,
  type TableRequest
} from '@shared/types'
import { call } from '../api'
import {
  buildChangeSet,
  countPending,
  currentValue,
  emptyPending,
  binaryColumns,
  withCellReverted,
  withCellValue,
  withRowDuplicated,
  withRowsDeleted,
  withRowsRestored,
  type Pending
} from '../editing'
import { useApp, type TableTab } from '../store'
import { caps } from '@shared/engines'
import CommitModal from './CommitModal'
import ContextMenu, { type MenuItem } from './ContextMenu'
import DataGrid from './DataGrid'
import { copyAsItems } from './copyAs'
import StructureView from './StructureView'
import { useShortcut, displayCombo } from '../keymap'
import { keyFor, type ActionId } from '@shared/settings'
import { useDisplayOverrides } from '../plugins/host'
import MapView from './MapView'
import { detectGeo } from '@shared/geo'

const PAGE_SIZES = [100, 300, 1000, 5000]
const NO_VALUE_OPS = new Set(['is null', 'is not null'])
const emptySelection = (): GridSelection => ({ columns: CompactSelection.empty(), rows: CompactSelection.empty() })

export default function TableView({ sessionId, tab, active }: { sessionId: string; tab: TableTab; active: boolean }) {
  const connection = useApp((s) => s.connection)
  const setTableView = useApp((s) => s.setTableView)
  const replaceWithTable = useApp((s) => s.replaceWithTable)
  const openDialog = useApp((s) => s.openDialog)
  const reloadToken = useApp((s) => s.reloadTokens[tab.id] ?? 0)
  const setDirty = useApp((s) => s.setDirty)
  const setAppError = useApp((s) => s.setError)

  const [columns, setColumns] = useState<ColumnInfo[]>([])
  const [result, setResult] = useState<QueryResult | null>(null)
  const [total, setTotal] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [limit, setLimit] = useState(300)
  const [offset, setOffset] = useState(0)
  const [orderBy, setOrderBy] = useState<TableRequest['orderBy']>()
  const [showFilters, setShowFilters] = useState(false)
  const [draftFilters, setDraftFilters] = useState<TableFilter[]>([])
  const [filters, setFilters] = useState<TableFilter[]>([])
  const requestSeq = useRef(0)

  const [pending, setPending] = useState<Pending>(emptyPending)
  const [selection, setSelection] = useState<GridSelection>(emptySelection)
  const [menu, setMenu] = useState<{ row: number; col: number; x: number; y: number } | null>(null)
  const [review, setReview] = useState<{ statements: string[]; set: ChangeSet } | null>(null)
  const [committing, setCommitting] = useState(false)

  const pendingCount = countPending(pending)
  const safeMode = connection ? effectiveSafeMode(connection) : 'off'

  useEffect(() => {
    setDirty(tab.id, pendingCount)
  }, [tab.id, pendingCount, setDirty])

  useEffect(() => {
    call('session:columns', sessionId, tab.schema, tab.table)
      .then(setColumns)
      .catch(() => setColumns([]))
  }, [sessionId, tab.schema, tab.table])

  const load = useCallback(async () => {
    const seq = ++requestSeq.current
    const req: TableRequest = { schema: tab.schema, table: tab.table, limit, offset, orderBy, filters }
    setLoading(true)
    setError(null)
    try {
      const [rows, count] = await Promise.all([
        call('session:fetch', sessionId, req),
        call('session:count', sessionId, req).catch(() => null)
      ])
      // Ignore responses from requests that a newer one superseded.
      if (seq !== requestSeq.current) return
      setResult(rows)
      setTotal(count)
      // Pending edits point at row numbers on the old page, so they cannot carry over.
      setPending(emptyPending())
      setSelection(emptySelection())
    } catch (err) {
      if (seq === requestSeq.current) setError((err as Error).message)
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
    // reloadToken is a dependency only so that an import elsewhere refreshes this tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, tab.schema, tab.table, limit, offset, orderBy, filters, reloadToken])

  useEffect(() => {
    void load()
  }, [load])

  /** Run an action that reloads data, asking first if it would drop unsaved edits. */
  const guard = (fn: () => void) => {
    if (pendingCount === 0 || confirm(`Discard ${pendingCount} unsaved change${pendingCount === 1 ? '' : 's'}?`)) fn()
  }

  const lockedColumns = useMemo(() => (result ? binaryColumns(result, columns) : new Set<number>()), [result, columns])

  const engineCaps = connection ? caps(connection.engine) : null
  const editBlockedReason = useMemo(() => {
    if (engineCaps && !engineCaps.edit) return 'Read-only for this engine'
    if (tab.kind === 'view') return 'Views are read-only'
    if (safeMode === 'readonly') return 'Read-only connection'
    if (result && lockedColumns.size === result.columns.length && !columns.some((c) => c.isPrimaryKey))
      return 'Rows cannot be identified'
    return null
  }, [tab.kind, safeMode, result, columns, lockedColumns, engineCaps])
  const editable = Boolean(result) && editBlockedReason === null

  // ---- editing actions ------------------------------------------------------

  const selectedRows = (): number[] => {
    const rows = selection.rows.toArray()
    if (rows.length) return rows
    const range = selection.current?.range
    if (!range) return []
    return Array.from({ length: range.height }, (_, i) => range.y + i)
  }

  const addRow = () => {
    if (!editable || !result) return
    setPending((p) => ({ ...p, inserts: [...p.inserts, {}] }))
  }

  const deleteRows = (rows: number[]) => {
    if (!editable || !result || rows.length === 0) return
    setPending((p) => withRowsDeleted(result, p, rows))
    setSelection(emptySelection())
  }

  const discard = () => {
    setPending(emptyPending())
    setSelection(emptySelection())
  }

  const applySet = async (set: ChangeSet) => {
    await call('session:applyChanges', sessionId, set)
    setReview(null)
    await load()
  }

  const commit = async (forceReview = false) => {
    if (!result || pendingCount === 0 || committing) return
    const set = buildChangeSet(tab.schema, tab.table, result, columns, pending)
    setCommitting(true)
    try {
      if (forceReview || safeMode === 'confirm') {
        setReview({ statements: await call('session:previewChanges', sessionId, set), set })
      } else {
        await applySet(set)
      }
    } catch (err) {
      setAppError((err as Error).message)
    } finally {
      setCommitting(false)
    }
  }

  // ---- keyboard ---------------------------------------------------------------

  const keysLive = active && !review
  useShortcut('table.reload', () => guard(() => void load()), keysLive)
  useShortcut('table.filter', () => openFilters(), keysLive)
  useShortcut('table.commit', () => void commit(), keysLive)
  useShortcut('table.addRow', () => addRow(), keysLive)
  const settings = useApp((s) => s.settings)
  const keyLabel = (id: ActionId) => displayCombo(keyFor(settings, id))
  const displayOverrides = useDisplayOverrides(result)
  const geoSources = useMemo(() => (result ? detectGeo(result.columns, result.rows) : []), [result])
  const [showMap, setShowMap] = useState(false)

  // ---- filters, sort, paging --------------------------------------------------

  const columnNames = columns.length ? columns.map((c) => c.name) : (result?.columns.map((c) => c.name) ?? [])

  const openFilters = () => {
    setShowFilters(true)
    if (draftFilters.length === 0) setDraftFilters([{ column: columnNames[0] ?? '', op: 'contains', value: '' }])
  }

  const applyFilters = () =>
    guard(() => {
      setOffset(0)
      setFilters(draftFilters.filter((f) => f.column && (NO_VALUE_OPS.has(f.op) || f.value !== '')))
    })

  const clearFilters = () =>
    guard(() => {
      setDraftFilters([])
      setFilters([])
      setOffset(0)
      setShowFilters(false)
    })

  const updateFilter = (i: number, p: Partial<TableFilter>) =>
    setDraftFilters((fs) => fs.map((f, j) => (j === i ? { ...f, ...p } : f)))

  const cycleSort = (column: string) =>
    guard(() => {
      setOffset(0)
      setOrderBy((cur) =>
        cur?.column !== column ? { column, dir: 'asc' } : cur.dir === 'asc' ? { column, dir: 'desc' } : undefined
      )
    })

  // ---- context menu -------------------------------------------------------------

  const menuItems = (row: number, col: number): (MenuItem | 'separator')[] => {
    if (!result) return []
    const baseRows = result.rows.length
    const inserted = row >= baseRows
    const deleted = !inserted && pending.deleted.has(row)
    const name = result.columns[col].name
    const edited = !inserted && Boolean(pending.edits.get(row) && name in pending.edits.get(row)!)
    const value = currentValue(result, pending, row, col)
    const cellEditable = editable && !deleted && !lockedColumns.has(col)
    const rows = selectedRows().includes(row) ? selectedRows() : [row]
    const plural = rows.length > 1 ? `${rows.length} rows` : 'row'

    const existingRows = rows.filter((r) => r < baseRows)
    return [
      {
        label: 'Copy value',
        shortcut: 'Ctrl+C',
        onSelect: () => navigator.clipboard.writeText(value === null || value === undefined ? '' : String(value))
      },
      ...copyAsItems(result, existingRows, connection?.engine ?? 'postgres', tab.table),
      'separator',
      {
        label: 'Set NULL',
        disabled: !cellEditable || value === null,
        onSelect: () => setPending((p) => withCellValue(result, p, row, col, null))
      },
      {
        label: 'Set empty string',
        disabled: !cellEditable || value === '',
        onSelect: () => setPending((p) => withCellValue(result, p, row, col, ''))
      },
      inserted
        ? {
            label: 'Set DEFAULT',
            disabled: !cellEditable || value === undefined,
            onSelect: () => setPending((p) => withCellReverted(result, p, row, col))
          }
        : {
            label: 'Revert cell',
            disabled: !edited,
            onSelect: () => setPending((p) => withCellReverted(result, p, row, col))
          },
      'separator',
      { label: 'Add row', shortcut: keyLabel('table.addRow'), disabled: !editable, onSelect: addRow },
      {
        label: 'Duplicate row',
        disabled: !editable,
        onSelect: () => setPending((p) => withRowDuplicated(result, columns, p, row))
      },
      deleted
        ? {
            label: `Restore ${plural}`,
            onSelect: () => setPending((p) => withRowsRestored(p, rows))
          }
        : {
            label: `Delete ${plural}`,
            shortcut: 'Del',
            danger: true,
            disabled: !editable,
            onSelect: () => deleteRows(rows)
          }
    ]
  }

  // ---- render -------------------------------------------------------------------

  const rowCount = result?.rows.length ?? 0
  const pageCount = total !== null ? Math.max(1, Math.ceil(total / limit)) : null
  const page = Math.floor(offset / limit) + 1
  const hasNext = total !== null ? offset + limit < total : rowCount === limit

  const toggle = engineCaps?.structure === false ? null : <ViewToggle view={tab.view} onChange={(v) => setTableView(tab.id, v)} />

  if (tab.view === 'structure' && connection) {
    return (
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1">
          <StructureView
            sessionId={sessionId}
            engine={connection.engine}
            schema={tab.schema}
            table={tab.table}
            kind={tab.kind === 'view' ? 'view' : 'table'}
            onApplied={(schema, name) => replaceWithTable(tab.id, schema, name, 'structure')}
          />
        </div>
        <footer className="flex h-9 shrink-0 items-center gap-2 border-t border-line bg-panel px-2 text-xs">{toggle}</footer>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {showFilters && (
        <div className="space-y-1.5 border-b border-line bg-panel px-3 py-2">
          {draftFilters.map((f, i) => (
            <div key={i} className="flex items-center gap-2">
              <select className="field h-7 w-48" value={f.column} onChange={(e) => updateFilter(i, { column: e.target.value })}>
                {columnNames.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <select
                className="field h-7 w-36"
                value={f.op}
                onChange={(e) => updateFilter(i, { op: e.target.value as TableFilter['op'] })}
              >
                {FILTER_OPS.map((op) => (
                  <option key={op} value={op}>
                    {op}
                  </option>
                ))}
              </select>
              <input
                className="field h-7 flex-1 font-mono text-xs"
                disabled={NO_VALUE_OPS.has(f.op)}
                placeholder={f.op === 'in' ? 'a, b, c' : 'Value'}
                value={f.value}
                autoFocus={i === draftFilters.length - 1}
                onChange={(e) => updateFilter(i, { value: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && applyFilters()}
              />
              <button
                className="icon-btn"
                title="Remove filter"
                onClick={() => setDraftFilters((fs) => fs.filter((_, j) => j !== i))}
              >
                <X size={13} />
              </button>
              {i === draftFilters.length - 1 && (
                <>
                  <button
                    className="icon-btn"
                    title="Add filter"
                    onClick={() =>
                      setDraftFilters((fs) => [...fs, { column: columnNames[0] ?? '', op: 'contains', value: '' }])
                    }
                  >
                    <Plus size={13} />
                  </button>
                  <button className="btn h-7 btn-primary" onClick={applyFilters}>
                    Apply
                  </button>
                  <button className="btn h-7" onClick={clearFilters}>
                    Clear
                  </button>
                </>
              )}
            </div>
          ))}
          {draftFilters.length === 0 && (
            <div className="flex items-center gap-2 text-xs text-muted">
              No filters.
              <button className="btn h-7" onClick={openFilters}>
                <Plus size={13} /> Add filter
              </button>
            </div>
          )}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {error ? (
          <div className="select-text p-6 font-mono text-xs text-danger">{error}</div>
        ) : result ? (
          result.columns.length === 0 ? (
            <div className="p-6 text-muted">This table has no columns.</div>
          ) : showMap && geoSources.length > 0 ? (
            <MapView columns={result.columns} rows={result.rows} sources={geoSources} />
          ) : (
            <DataGrid
              result={result}
              rowOffset={offset}
              sort={orderBy}
              onSort={cycleSort}
              pending={pending}
              editable={editable}
              lockedColumns={lockedColumns}
              selection={selection}
              onSelectionChange={setSelection}
              onCellEdit={(row, col, value) => setPending((p) => withCellValue(result, p, row, col, value))}
              onDeleteRows={deleteRows}
              onCellMenu={(row, col, x, y) => setMenu({ row, col, x, y })}
              displayOverrides={displayOverrides}
            />
          )
        ) : null}
        {loading && (
          <div className="pointer-events-none absolute right-3 top-2 rounded bg-panel px-2 py-1 text-xs text-muted shadow">
            Loading…
          </div>
        )}
      </div>

      <footer className="flex h-9 shrink-0 items-center gap-2 border-t border-line bg-panel px-2 text-xs">
        {toggle}
        {engineCaps?.filters !== false && (
          <button
          className={`btn h-6 px-2 ${filters.length ? 'border-accent text-accent' : ''}`}
          onClick={() => (showFilters ? setShowFilters(false) : openFilters())}
          title={`Filter rows (${keyLabel('table.filter')})`}
        >
          <Filter size={12} /> {filters.length ? `${filters.length} filter${filters.length > 1 ? 's' : ''}` : 'Filter'}
        </button>
        )}
        {geoSources.length > 0 && (
          <button className={`btn h-6 px-2 ${showMap ? 'border-accent text-accent' : ''}`} onClick={() => setShowMap(!showMap)} title="Show this page's locations on a map">
            <MapIcon size={12} /> Map
          </button>
        )}
        <button className="icon-btn" title={`Reload (${keyLabel('table.reload')})`} onClick={() => guard(() => void load())}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
        {editable ? (
          <>
            <button className="icon-btn" title={`Add row (${keyLabel('table.addRow')})`} onClick={addRow}>
              <Plus size={14} />
            </button>
            <button className="icon-btn" title="Delete selected rows (Del)" onClick={() => deleteRows(selectedRows())}>
              <Trash2 size={13} />
            </button>
          </>
        ) : (
          editBlockedReason && (
            <span className="inline-flex items-center gap-1 whitespace-nowrap text-faint" title={editBlockedReason}>
              <Lock size={12} /> {editBlockedReason}
            </span>
          )
        )}
        <button
          className="icon-btn"
          title="Export rows"
          onClick={() => openDialog({ type: 'exportTable', schema: tab.schema, table: tab.table, filters, orderBy })}
        >
          <Download size={13} />
        </button>
        {editable && engineCaps?.importRows !== false && (
          <button className="icon-btn" title="Import rows from CSV or JSON" onClick={() => openDialog({ type: 'import', schema: tab.schema, table: tab.table })}>
            <Upload size={13} />
          </button>
        )}
        <span className="whitespace-nowrap text-muted">
          {result
            ? `${rowCount ? `${offset + 1}–${offset + rowCount}` : '0'} of ${total ?? '?'} rows`
            : ''}
          {result && ` · ${result.durationMs.toFixed(0)} ms`}
        </span>

        {pendingCount > 0 ? (
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
            <span className="whitespace-nowrap rounded bg-accent-soft px-2 py-0.5 font-medium text-accent">
              {pendingCount} unsaved change{pendingCount === 1 ? '' : 's'}
            </span>
            <button className="btn h-6 px-2" onClick={discard}>
              Discard
            </button>
            <button className="btn h-6 px-2" disabled={committing} onClick={() => void commit(true)}>
              Preview SQL
            </button>
            <button
              className="btn btn-primary h-6 px-2"
              disabled={committing}
              onClick={() => void commit()}
              title={`Commit (${keyLabel('table.commit')})`}
            >
              {committing ? 'Saving…' : safeMode === 'confirm' ? 'Review & commit' : 'Commit'}
            </button>
          </div>
        ) : (
          <span
            className="min-w-0 flex-1 cursor-pointer truncate font-mono text-[11px] text-faint hover:text-muted"
            title="Click to copy SQL"
            onClick={() => result && navigator.clipboard.writeText(result.sql)}
          >
            {result?.sql}
          </span>
        )}

        <select
          className="field h-6 w-20 px-1 text-xs"
          value={limit}
          onChange={(e) => {
            const next = Number(e.target.value)
            guard(() => {
              setLimit(next)
              setOffset(0)
            })
          }}
          title="Rows per page"
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button
          className="icon-btn"
          disabled={offset === 0}
          onClick={() => guard(() => setOffset(Math.max(0, offset - limit)))}
          title="Previous page"
        >
          <ChevronLeft size={14} />
        </button>
        <span className="whitespace-nowrap tabular-nums text-muted">
          {page}
          {pageCount !== null && ` / ${pageCount}`}
        </span>
        <button className="icon-btn" disabled={!hasNext} onClick={() => guard(() => setOffset(offset + limit))} title="Next page">
          <ChevronRight size={14} />
        </button>
      </footer>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.row, menu.col)} onClose={() => setMenu(null)} />}

      {review && connection && (
        <CommitModal
          statements={review.statements}
          connection={connection}
          onClose={() => setReview(null)}
          onCommit={() => applySet(review.set)}
        />
      )}
    </div>
  )
}

function ViewToggle({ view, onChange }: { view: TableTab['view']; onChange: (v: TableTab['view']) => void }) {
  return (
    <div className="flex rounded-md border border-line p-0.5">
      {(['data', 'structure'] as const).map((v) => (
        <button
          key={v}
          className={`h-5 rounded px-2 capitalize ${view === v ? 'bg-accent text-white' : 'text-muted hover:text-fg'}`}
          onClick={() => onChange(v)}
        >
          {v}
        </button>
      ))}
    </div>
  )
}
