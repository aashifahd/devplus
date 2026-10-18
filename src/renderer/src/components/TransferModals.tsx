import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, FolderOpen, XCircle } from 'lucide-react'
import { effectiveSafeMode, type ColumnInfo, type Engine, type ImportPreview } from '@shared/types'
import { defaultFormatOptions, FORMAT_EXTENSIONS, type ExportFormat } from '@shared/formats'
import { call } from '../api'
import { useApp, type DialogRequest } from '../store'
import { ProgressBar, useTask } from '../useTask'
import Modal from './Modal'
import { runExporter, usePluginExporters } from '../plugins/host'

/** Plugin exporters get rows in memory, so table exports through them are capped. */
const PLUGIN_EXPORT_LIMIT = 50_000

const FORMATS: { id: ExportFormat; label: string }[] = [
  { id: 'csv', label: 'CSV' },
  { id: 'tsv', label: 'TSV' },
  { id: 'json', label: 'JSON' },
  { id: 'sql', label: 'SQL INSERT' }
]

function Outcome({ error, result }: { error: string | null; result: string | null }) {
  if (error)
    return (
      <div className="flex select-text items-start gap-2 text-danger">
        <XCircle size={14} className="mt-px shrink-0" /> {error}
      </div>
    )
  if (result)
    return (
      <div className="flex select-text items-start gap-2 text-ok">
        <CheckCircle2 size={14} className="mt-px shrink-0" /> {result}
      </div>
    )
  return null
}

// ---- export -----------------------------------------------------------------------------------

export function ExportModal({
  request,
  sessionId,
  engine,
  onClose
}: {
  request: Extract<DialogRequest, { type: 'exportTable' | 'exportRows' }>
  sessionId: string
  engine: Engine
  onClose: () => void
}) {
  const [format, setFormatState] = useState<ExportFormat>('csv')
  const [pluginFormat, setPluginFormat] = useState<{ plugin: string; id: string; title: string; extension: string } | null>(null)
  const exporters = usePluginExporters()
  const setFormat = (f: ExportFormat) => {
    setFormatState(f)
    setPluginFormat(null)
  }
  const [header, setHeader] = useState(true)
  const [nullAsText, setNullAsText] = useState(false)
  const [onlyFiltered, setOnlyFiltered] = useState(true)
  const [includeCreate, setIncludeCreate] = useState(false)
  const task = useTask()

  const isTable = request.type === 'exportTable'
  const name = isTable ? request.table : request.name
  const hasFilters = isTable && request.filters.length > 0

  const startPlugin = async (x: NonNullable<typeof pluginFormat>) => {
    const path = await call('dialog:saveFile', {
      title: 'Export',
      defaultPath: `${name}.${x.extension}`,
      filters: [{ name: x.title, extensions: [x.extension] }]
    })
    if (!path) return
    await task.run(async () => {
      const data = isTable
        ? await call('session:fetch', sessionId, {
            schema: request.schema,
            table: request.table,
            limit: PLUGIN_EXPORT_LIMIT,
            offset: 0,
            orderBy: request.orderBy,
            filters: hasFilters && onlyFiltered ? request.filters : []
          })
        : { columns: request.columns, rows: request.rows }
      const text = await runExporter(x.plugin, x.id, data.columns, data.rows)
      await call('files:writeText', path, text)
      const n = data.rows.length
      return `Exported ${n.toLocaleString()} row${n === 1 ? '' : 's'} to ${path} with ${x.plugin}${isTable && n === PLUGIN_EXPORT_LIMIT ? ` (plugin exports stop at ${PLUGIN_EXPORT_LIMIT.toLocaleString()} rows)` : ''}`
    })
  }

  const start = async () => {
    if (pluginFormat) return startPlugin(pluginFormat)
    const path = await call('dialog:saveFile', {
      title: 'Export',
      defaultPath: `${name}.${FORMAT_EXTENSIONS[format]}`,
      filters: [{ name: format.toUpperCase(), extensions: [FORMAT_EXTENSIONS[format]] }]
    })
    if (!path) return
    const target = isTable ? name : request.tableName
    const options = { ...defaultFormatOptions(engine, target, format), header, nullText: nullAsText ? 'NULL' : '' }
    await task.run(async (taskId) => {
      const rows = isTable
        ? await call(
            'export:table',
            sessionId,
            {
              schema: request.schema,
              table: request.table,
              filters: hasFilters && onlyFiltered ? request.filters : [],
              orderBy: request.orderBy,
              options,
              includeCreate: format === 'sql' && includeCreate
            },
            path,
            taskId
          )
        : await call('export:rows', { columns: request.columns, rows: request.rows, options }, path)
      return `Exported ${rows.toLocaleString()} row${rows === 1 ? '' : 's'} to ${path}`
    })
  }

  return (
    <Modal
      title={`Export ${name}`}
      width={460}
      onClose={onClose}
      footer={
        <>
          <div className="flex-1" />
          <button className="btn" onClick={onClose}>
            {task.result ? 'Done' : 'Cancel'}
          </button>
          {!task.result && (
            <button className="btn btn-primary" disabled={task.running} onClick={() => void start()}>
              {task.running ? 'Exporting…' : 'Export…'}
            </button>
          )}
        </>
      }
    >
      <div className="space-y-4 text-xs">
        <div className="grid grid-cols-4 gap-2">
          {FORMATS.map((f) => (
            <button
              key={f.id}
              className={`rounded-lg border px-2 py-2 ${format === f.id && !pluginFormat ? 'border-accent bg-accent-soft' : 'border-line hover:bg-panel'}`}
              onClick={() => setFormat(f.id)}
            >
              {f.label}
            </button>
          ))}
          {exporters.map((x) => (
            <button
              key={`${x.plugin}:${x.id}`}
              className={`truncate rounded-lg border px-2 py-2 ${pluginFormat?.plugin === x.plugin && pluginFormat.id === x.id ? 'border-accent bg-accent-soft' : 'border-line hover:bg-panel'}`}
              title={`${x.title} (plugin ${x.plugin})`}
              onClick={() => setPluginFormat(x)}
            >
              {x.title}
            </button>
          ))}
        </div>

        <div className="space-y-2">
          {isTable && hasFilters && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={onlyFiltered} onChange={(e) => setOnlyFiltered(e.target.checked)} />
              Only rows matching the current filter
            </label>
          )}
          {!isTable && <div className="text-muted">{request.rows.length.toLocaleString()} rows from the query result.</div>}
          {pluginFormat && <div className="text-muted">Formatted by the {pluginFormat.plugin} plugin as .{pluginFormat.extension}.</div>}
          {!pluginFormat && (format === 'csv' || format === 'tsv') && (
            <>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> Header row
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={nullAsText} onChange={(e) => setNullAsText(e.target.checked)} /> Write NULL as the text NULL
                (otherwise an empty field)
              </label>
            </>
          )}
          {!pluginFormat && format === 'sql' && isTable && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={includeCreate} onChange={(e) => setIncludeCreate(e.target.checked)} /> Include CREATE TABLE
            </label>
          )}
        </div>

        {task.running && <ProgressBar done={task.done} total={task.total} />}
        <Outcome error={task.error} result={task.result} />
      </div>
    </Modal>
  )
}

// ---- import -----------------------------------------------------------------------------------

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

export function ImportModal({
  request,
  sessionId,
  onClose
}: {
  request: Extract<DialogRequest, { type: 'import' }>
  sessionId: string
  onClose: () => void
}) {
  const connection = useApp((s) => s.connection)
  const reloadTable = useApp((s) => s.reloadTable)
  const [columns, setColumns] = useState<ColumnInfo[]>([])
  const [path, setPath] = useState<string | null>(null)
  const [delimiter, setDelimiter] = useState('')
  const [header, setHeader] = useState(true)
  const [emptyAsNull, setEmptyAsNull] = useState(true)
  const [truncate, setTruncate] = useState(false)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [mapping, setMapping] = useState<Record<string, number>>({})
  const task = useTask()

  useEffect(() => {
    call('session:columns', sessionId, request.schema, request.table).then(setColumns).catch(() => setColumns([]))
  }, [sessionId, request.schema, request.table])

  // Re-read the file whenever parsing options change.
  useEffect(() => {
    if (!path) return
    call('import:preview', path, { delimiter: delimiter || undefined, header })
      .then((p) => {
        setPreview(p)
        setPreviewError(null)
      })
      .catch((err) => {
        setPreview(null)
        setPreviewError((err as Error).message)
      })
  }, [path, delimiter, header])

  // Match source columns to table columns by name, ignoring case and punctuation.
  useEffect(() => {
    if (!preview) return
    const bySource = new Map(preview.columns.map((c, i) => [normalize(c), i]))
    setMapping(Object.fromEntries(columns.flatMap((c) => (bySource.has(normalize(c.name)) ? [[c.name, bySource.get(normalize(c.name))!]] : []))))
  }, [preview, columns])

  const choose = async () => {
    const p = await call('dialog:openFile', {
      title: 'Import rows',
      filters: [
        { name: 'Data files', extensions: ['csv', 'tsv', 'txt', 'json'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (p) {
      task.reset()
      setPath(p)
    }
  }

  const mapped = useMemo(() => columns.filter((c) => mapping[c.name] !== undefined), [columns, mapping])
  const production = connection?.tag === 'production' || (connection && effectiveSafeMode(connection) === 'confirm')

  const start = async () => {
    if (!preview || !path) return
    if (truncate && !confirm(`Delete every existing row in ${request.table} before importing?`)) return
    const ok = await task.run(async (taskId) => {
      const rows = await call(
        'import:run',
        sessionId,
        {
          path,
          format: preview.format,
          delimiter: preview.delimiter,
          header,
          emptyAsNull,
          truncate,
          schema: request.schema,
          table: request.table,
          mapping: mapped.map((c) => ({ column: c.name, source: mapping[c.name] }))
        },
        taskId
      )
      return `Imported ${rows.toLocaleString()} row${rows === 1 ? '' : 's'} into ${request.table}.`
    })
    if (ok) reloadTable(request.schema, request.table)
  }

  return (
    <Modal
      title={`Import into ${request.table}`}
      width={720}
      onClose={onClose}
      footer={
        <>
          <div className="min-w-0 flex-1 text-xs text-faint">All rows go in one transaction; any error imports nothing.</div>
          <button className="btn" onClick={onClose}>
            {task.result ? 'Done' : 'Cancel'}
          </button>
          {!task.result && (
            <button
              className="btn btn-primary"
              style={production ? { background: 'var(--danger)', borderColor: 'var(--danger)' } : undefined}
              disabled={!preview || mapped.length === 0 || task.running}
              onClick={() => void start()}
            >
              {task.running
                ? 'Importing…'
                : `Import ${preview ? preview.totalRows.toLocaleString() : ''} rows${production && connection ? ` on ${connection.name}` : ''}`}
            </button>
          )}
        </>
      }
    >
      <div className="space-y-4 text-xs">
        <div className="flex items-center gap-2">
          <input className="field flex-1 font-mono" readOnly value={path ?? ''} placeholder="Choose a CSV, TSV or JSON file" />
          <button className="btn shrink-0" onClick={() => void choose()}>
            <FolderOpen size={13} /> Choose file
          </button>
        </div>

        {previewError && <div className="select-text text-danger">{previewError}</div>}

        {preview && (
          <>
            <div className="flex flex-wrap items-center gap-4">
              <span className="text-muted">
                {preview.format.toUpperCase()} · {preview.totalRows.toLocaleString()} rows · {preview.columns.length} columns
              </span>
              {preview.format !== 'json' && (
                <>
                  <label className="flex items-center gap-1.5">
                    Delimiter
                    <select className="field h-6 w-24 text-xs" value={delimiter} onChange={(e) => setDelimiter(e.target.value)}>
                      <option value="">Auto ({preview.delimiter === '\t' ? 'tab' : preview.delimiter})</option>
                      <option value=",">Comma</option>
                      <option value=";">Semicolon</option>
                      <option value={'\t'}>Tab</option>
                      <option value="|">Pipe</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> First row is a header
                  </label>
                </>
              )}
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={emptyAsNull} onChange={(e) => setEmptyAsNull(e.target.checked)} /> Empty values become NULL
              </label>
              <label className="flex items-center gap-1.5 text-danger">
                <input type="checkbox" checked={truncate} onChange={(e) => setTruncate(e.target.checked)} /> Delete existing rows first
              </label>
            </div>

            <div>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">Column mapping</div>
              <div className="grid max-h-56 grid-cols-2 gap-x-6 gap-y-1.5 overflow-y-auto">
                {columns.map((c) => (
                  <label key={c.name} className="flex items-center gap-2">
                    <span className="w-36 truncate font-mono" title={`${c.name} ${c.type}`}>
                      {c.name}
                    </span>
                    <select
                      className="field h-6 flex-1 text-xs"
                      value={mapping[c.name] ?? ''}
                      onChange={(e) =>
                        setMapping((m) => {
                          const next = { ...m }
                          if (e.target.value === '') delete next[c.name]
                          else next[c.name] = Number(e.target.value)
                          return next
                        })
                      }
                    >
                      <option value="">{c.defaultValue || c.isPrimaryKey ? '— default —' : '— skip (NULL) —'}</option>
                      {preview.columns.map((src, i) => (
                        <option key={i} value={i}>
                          {src}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </div>

            <div className="max-h-40 overflow-auto rounded-md border border-line">
              <table className="w-full border-collapse font-mono text-[11px]">
                <thead className="sticky top-0 bg-panel text-left text-faint">
                  <tr>
                    {preview.columns.map((c, i) => (
                      <th key={i} className="whitespace-nowrap border-b border-line px-2 py-1 font-medium">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.sample.slice(0, 8).map((r, i) => (
                    <tr key={i}>
                      {r.map((v, j) => (
                        <td key={j} className={`max-w-48 truncate border-b border-line px-2 py-1 ${v === null ? 'text-faint' : ''}`}>
                          {v === null ? 'NULL' : v}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {task.running && <ProgressBar done={task.done} total={task.total ?? preview?.totalRows ?? null} />}
        <Outcome error={task.error} result={task.result} />
      </div>
    </Modal>
  )
}
