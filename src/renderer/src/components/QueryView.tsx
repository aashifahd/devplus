import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CompactSelection, type GridSelection } from '@glideapps/glide-data-grid'
import { AlignLeft, Bookmark, CircleStop, Download, History, ListTree, Map as MapIcon, Play, PlayCircle, Save, Sparkles, Trash2, X } from 'lucide-react'
import { effectiveSafeMode, type Engine, type HistoryEntry, type RunResult, type SavedQuery } from '@shared/types'
import { isReadStatement, splitStatements, statementAt } from '@shared/sqlsplit'
import { call } from '../api'
import { currentTheme, dropModelContext, editorLanguage, monaco, setModelContext, setupMonaco } from '../monaco'
import { caps, ENGINES } from '@shared/engines'
import { useApp, type QueryTab } from '../store'
import CommitModal from './CommitModal'
import DataGrid from './DataGrid'
import Modal from './Modal'
import ContextMenu from './ContextMenu'
import { copyAsItems } from './copyAs'
import AiPanel from './AiPanel'
import MapView from './MapView'
import { detectGeo } from '@shared/geo'
import { keyFor, type ActionId } from '@shared/settings'
import { displayCombo, toMonacoKey } from '../keymap'
import { THEME_EVENT } from '../theme'
import { insertIntoEditor, registerEditor } from '../editorRegistry'
import { useDisplayOverrides } from '../plugins/host'

type ResultView = number | 'messages'

const DDL = /^\s*(create|alter|drop|rename|truncate)\b/i

function resultLabel(r: RunResult['results'][number], i: number) {
  if (r.hasRows) {
    const n = r.rows.length
    return `Result ${i + 1} · ${n.toLocaleString()}${r.truncated ? '+' : ''} row${n === 1 && !r.truncated ? '' : 's'}`
  }
  return `Query ${i + 1} · ${r.affected ?? 0} affected`
}

/** INSERT target for an exported result: the one table a SELECT reads from, if there is exactly one. */
function sourceTable(sql: string): string {
  const tables = [...sql.matchAll(/\b(?:from|join)\s+((?:[\w"`]+\.)?[\w"`]+)/gi)].map((m) => m[1].split('.').pop()!.replace(/["`]/g, ''))
  return new Set(tables).size === 1 ? tables[0] : 'query_result'
}

function timeLabel(at: number) {
  const d = new Date(at)
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString()
}

export default function QueryView({ sessionId, tab, active }: { sessionId: string; tab: QueryTab; active: boolean }) {
  const connection = useApp((s) => s.connection)
  const completions = useApp((s) => s.completions)
  const updateQueryTab = useApp((s) => s.updateQueryTab)
  const openQuery = useApp((s) => s.openQuery)
  const setDirty = useApp((s) => s.setDirty)
  const setAppError = useApp((s) => s.setError)
  const openDialog = useApp((s) => s.openDialog)
  const [gridSelection, setGridSelection] = useState<GridSelection>({ columns: CompactSelection.empty(), rows: CompactSelection.empty() })
  const [menu, setMenu] = useState<{ row: number; col: number; x: number; y: number } | null>(null)

  const hostRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const decorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const savedTextRef = useRef(tab.initialSql ?? '')

  const [engine, setEngine] = useState<Engine>(connection?.engine ?? 'postgres')
  const [canCancel, setCanCancel] = useState(false)
  const [running, setRunning] = useState(false)
  const [run, setRun] = useState<RunResult | null>(null)
  const [view, setView] = useState<ResultView>(0)
  const [panel, setPanel] = useState<'history' | 'saved' | 'ai' | null>(null)
  const [aiSeed, setAiSeed] = useState<{ text: string; n: number } | null>(null)
  const [lastError, setLastError] = useState<{ sql: string; message: string } | null>(null)
  const settings = useApp((s) => s.settings)
  const aiPrompt = useApp((s) => s.aiPrompt)
  const keyLabel = (id: ActionId) => displayCombo(keyFor(settings, id))
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [saved, setSaved] = useState<SavedQuery[]>([])
  const [confirmRun, setConfirmRun] = useState<{ statements: string[]; sql: string; base: number } | null>(null)
  const [naming, setNaming] = useState(false)
  const [split, setSplit] = useState(0.45)

  const safeMode = connection ? effectiveSafeMode(connection) : 'off'

  // ---- editor lifecycle -------------------------------------------------------

  useEffect(() => {
    setupMonaco()
    const model = monaco.editor.createModel(tab.initialSql ?? '', editorLanguage(connection?.engine ?? 'postgres'))
    const editor = monaco.editor.create(hostRef.current!, {
      model,
      theme: currentTheme(),
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: useApp.getState().settings?.ui.editorFontSize ?? 13,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'Consolas',
      scrollBeyondLastLine: false,
      tabSize: 2,
      renderLineHighlight: 'line',
      fixedOverflowWidgets: true,
      padding: { top: 8 },
      quickSuggestions: { other: true, comments: false, strings: false }
    })
    editorRef.current = editor
    decorationsRef.current = editor.createDecorationsCollection()

    const onTheme = () => monaco.editor.setTheme(currentTheme())
    window.addEventListener(THEME_EVENT, onTheme)
    const unregister = registerEditor(tab.id, editor)

    const sub = model.onDidChangeContent(() => {
      const text = model.getValue().trim()
      setDirty(tab.id, text !== '' && text !== savedTextRef.current.trim() ? 1 : 0)
      monaco.editor.setModelMarkers(model, 'run', [])
    })

    return () => {
      window.removeEventListener(THEME_EVENT, onTheme)
      unregister()
      sub.dispose()
      dropModelContext(model)
      editor.dispose()
      model.dispose()
    }
    // The editor is created once per tab; later prop changes flow through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    call('query:capabilities', sessionId)
      .then((c) => {
        setEngine(c.engine)
        setCanCancel(c.canCancel)
      })
      .catch(() => {})
  }, [sessionId])

  useEffect(() => {
    const model = editorRef.current?.getModel()
    if (model) setModelContext(model, { engine, tables: completions })
  }, [engine, completions])

  useEffect(() => {
    if (active) editorRef.current?.focus()
  }, [active])

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize: settings?.ui.editorFontSize ?? 13 })
  }, [settings?.ui.editorFontSize])

  // "Ask AI" from the palette (or another tab) lands here with optional starting text.
  useEffect(() => {
    if (aiPrompt?.tabId !== tab.id) return
    setPanel('ai')
    setAiSeed((s) => ({ text: aiPrompt.text, n: (s?.n ?? 0) + 1 }))
    useApp.setState({ aiPrompt: null })
  }, [aiPrompt, tab.id])

  // ---- side panel data ----------------------------------------------------------

  const loadHistory = useCallback(() => {
    if (connection) call('history:list', connection.id).then(setHistory).catch(() => {})
  }, [connection])
  const loadSaved = useCallback(() => {
    if (connection) call('saved:list', connection.id).then(setSaved).catch(() => {})
  }, [connection])

  useEffect(() => {
    if (panel === 'history') loadHistory()
    if (panel === 'saved') loadSaved()
  }, [panel, loadHistory, loadSaved])

  // ---- running ------------------------------------------------------------------

  /** Selection if any, else the statement under the cursor (or the whole script). */
  const pickTarget = (mode: 'current' | 'all'): { sql: string; base: number } | null => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model) return null
    const text = model.getValue()
    if (mode === 'all') return { sql: text, base: 0 }
    const sel = editor.getSelection()
    if (sel && !sel.isEmpty()) {
      return { sql: model.getValueInRange(sel), base: model.getOffsetAt(sel.getStartPosition()) }
    }
    const offset = model.getOffsetAt(editor.getPosition() ?? { lineNumber: 1, column: 1 })
    const span = statementAt(splitStatements(text, engine), offset)
    return span ? { sql: span.text, base: span.start } : null
  }

  const markRange = (base: number, length: number, className: string) => {
    const model = editorRef.current?.getModel()
    if (!model) return
    const start = model.getPositionAt(base)
    const end = model.getPositionAt(base + length)
    decorationsRef.current?.set([
      {
        range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
        options: { className, isWholeLine: false }
      }
    ])
  }

  const showError = (res: RunResult, base: number) => {
    const model = editorRef.current?.getModel()
    if (!model || !res.error) return
    const { error } = res
    const from = base + (error.position ?? error.start)
    const to = error.position !== null ? from + 1 : base + error.end
    const a = model.getPositionAt(from)
    const b = model.getPositionAt(Math.max(to, from + 1))
    monaco.editor.setModelMarkers(model, 'run', [
      {
        severity: monaco.MarkerSeverity.Error,
        message: error.message,
        startLineNumber: a.lineNumber,
        startColumn: a.column,
        endLineNumber: b.lineNumber,
        endColumn: error.position !== null ? model.getWordAtPosition(a)?.endColumn ?? b.column : b.column
      }
    ])
  }

  const finish = (res: RunResult, base: number, sql: string) => {
    setRun(res)
    if (res.error) {
      setView('messages')
      showError(res, base)
      const failed = sql.slice(res.error.start, res.error.end).trim() || sql
      setLastError({ sql: failed, message: res.error.message })
    } else {
      setLastError(null)
      // Land on the last result set; that is usually the one being looked for.
      const lastRows = res.results.map((r, i) => (r.hasRows ? i : -1)).filter((i) => i >= 0).pop()
      setView(lastRows ?? 0)
    }
  }

  const doRun = async (sql: string, base: number) => {
    setConfirmRun(null)
    setRunning(true)
    markRange(base, sql.length, 'dbc-running')
    try {
      const res = await call('query:run', sessionId, sql)
      finish(res, base, sql)
      if (splitStatements(sql, engine).some((s) => DDL.test(s.text))) void useApp.getState().refreshTree()
      if (panel === 'history') loadHistory()
    } catch (err) {
      setAppError((err as Error).message)
    } finally {
      setRunning(false)
      decorationsRef.current?.clear()
    }
  }

  const execute = (mode: 'current' | 'all') => {
    if (running) return
    const target = pickTarget(mode)
    if (!target || !target.sql.trim()) return
    const spans = splitStatements(target.sql, engine)
    if (spans.length === 0) return
    const writes = spans.filter((s) => !isReadStatement(s.text, engine))
    if (safeMode === 'confirm' && writes.length > 0) {
      setConfirmRun({ statements: writes.map((s) => s.text), ...target })
      return
    }
    void doRun(target.sql, target.base)
  }

  const explain = async () => {
    if (running) return
    const target = pickTarget('current')
    if (!target || !target.sql.trim()) return
    setRunning(true)
    try {
      finish(await call('query:explain', sessionId, target.sql), target.base, target.sql)
    } catch (err) {
      setAppError((err as Error).message)
    } finally {
      setRunning(false)
    }
  }

  const cancel = () => {
    call('query:cancel', sessionId).catch((err) => setAppError((err as Error).message))
  }

  const formatDoc = () => {
    const editor = editorRef.current
    if (!editor) return
    const sel = editor.getSelection()
    const action = sel && !sel.isEmpty() ? 'editor.action.formatSelection' : 'editor.action.formatDocument'
    void editor.getAction(action)?.run()
  }

  // ---- saving -------------------------------------------------------------------

  const persist = async (name: string) => {
    const sql = editorRef.current?.getValue() ?? ''
    if (!connection) return
    const q = await call('saved:save', { id: tab.savedId, connectionId: connection.id, name, sql })
    savedTextRef.current = sql
    setDirty(tab.id, 0)
    updateQueryTab(tab.id, { title: q.name, savedId: q.id })
    if (panel === 'saved') loadSaved()
  }

  const save = () => {
    if (tab.savedId) persist(tab.title).catch((err) => setAppError((err as Error).message))
    else setNaming(true)
  }

  const loadSql = (sql: string) => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model) return
    // An edit (not setValue) so Ctrl+Z brings back what was there.
    editor.pushUndoStop()
    editor.executeEdits('history', [{ range: model.getFullModelRange(), text: sql }])
    editor.pushUndoStop()
    editor.focus()
  }

  const openAi = () => {
    setPanel('ai')
    setAiSeed((s) => ({ text: '', n: (s?.n ?? 0) + 1 }))
  }

  /** The selection, or the statement at the cursor, for the AI panel. */
  const aiSql = () => pickTarget('current')?.sql ?? ''

  const insertAi = (code: string, mode: 'insert' | 'replace') => {
    const editor = editorRef.current
    if (!editor) return
    if (mode === 'replace') loadSql(code)
    else insertIntoEditor(editor, code)
  }

  // Monaco keybindings call through refs so they always see current state.
  const actions = useRef({ execute, explain, save, formatDoc, openAi })
  actions.current = { execute, explain, save, formatDoc, openAi }

  // Bound from the keymap, and re-bound whenever the user changes a shortcut.
  const editorKeys = (['query.run', 'query.runAll', 'query.explain', 'query.save', 'query.format', 'query.ai'] as const).map((id) => keyFor(settings, id))
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const bind = (id: ActionId) => {
      const k = toMonacoKey(keyFor(useApp.getState().settings, id), monaco.KeyMod, monaco.KeyCode as unknown as Record<string, number>)
      return k === null ? [] : [k]
    }
    const disposables = [
      editor.addAction({ id: 'dbc.run', label: 'Run statement', keybindings: bind('query.run'), run: () => actions.current.execute('current') }),
      editor.addAction({ id: 'dbc.runAll', label: 'Run all', keybindings: bind('query.runAll'), run: () => actions.current.execute('all') }),
      editor.addAction({ id: 'dbc.explain', label: 'Explain statement', keybindings: bind('query.explain'), run: () => void actions.current.explain() }),
      editor.addAction({ id: 'dbc.save', label: 'Save query', keybindings: bind('query.save'), run: () => actions.current.save() }),
      editor.addAction({ id: 'dbc.format', label: 'Format SQL', keybindings: bind('query.format'), run: () => actions.current.formatDoc() }),
      editor.addAction({ id: 'dbc.ai', label: 'Ask AI', keybindings: bind('query.ai'), run: () => actions.current.openAi() })
    ]
    return () => disposables.forEach((d) => d.dispose())
  }, [editorKeys.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- results ------------------------------------------------------------------

  const current = run && typeof view === 'number' ? run.results[view] : undefined
  const gridResult = useMemo(
    () => current && current.hasRows && { columns: current.columns, rows: current.rows, durationMs: current.durationMs, sql: current.sql },
    [current]
  )
  const displayOverrides = useDisplayOverrides(gridResult)
  const geoSources = useMemo(() => (gridResult ? detectGeo(gridResult.columns, gridResult.rows) : []), [gridResult])
  const [showMap, setShowMap] = useState(false)

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault()
    const box = containerRef.current!.getBoundingClientRect()
    const move = (ev: MouseEvent) => setSplit(Math.min(0.85, Math.max(0.15, (ev.clientY - box.top) / box.height)))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line bg-panel px-2 text-xs">
          <button className="btn btn-primary h-6 px-2" disabled={running} onClick={() => execute('current')} title={`Run selection or the statement at the cursor (${keyLabel('query.run')})`}>
            <Play size={12} /> Run
          </button>
          <button className="btn h-6 px-2" disabled={running} onClick={() => execute('all')} title={`Run all (${keyLabel('query.runAll')})`}>
            <PlayCircle size={12} /> Run all
          </button>
          {caps(engine).explain && (
          <button className="btn h-6 px-2" disabled={running} onClick={() => void explain()} title={`Explain statement (${keyLabel('query.explain')})`}>
            <ListTree size={12} /> Explain
          </button>
        )}
          {running && canCancel && (
            <button className="btn h-6 px-2 text-danger" onClick={cancel} title="Cancel the running query">
              <CircleStop size={12} /> Cancel
            </button>
          )}
          {ENGINES[engine].language !== 'mongo' && ENGINES[engine].language !== 'redis' && (
          <button className="btn h-6 px-2" onClick={formatDoc} title={`Format (${keyLabel('query.format')})`}>
            <AlignLeft size={12} /> Format
          </button>
        )}
          <button className="btn h-6 px-2" onClick={save} title={`Save query (${keyLabel('query.save')})`}>
            <Save size={12} /> Save
          </button>
          {running && <span className="ml-2 text-muted">Running…</span>}
          <div className="flex-1" />
          <button
            className={`btn h-6 px-2 ${panel === 'ai' ? 'border-accent text-accent' : ''}`}
            onClick={() => (panel === 'ai' ? setPanel(null) : openAi())}
            title={`AI assistant (${keyLabel('query.ai')})`}
          >
            <Sparkles size={12} /> Ask AI
          </button>
          <button
            className={`btn h-6 px-2 ${panel === 'history' ? 'border-accent text-accent' : ''}`}
            onClick={() => setPanel(panel === 'history' ? null : 'history')}
          >
            <History size={12} /> History
          </button>
          <button
            className={`btn h-6 px-2 ${panel === 'saved' ? 'border-accent text-accent' : ''}`}
            onClick={() => setPanel(panel === 'saved' ? null : 'saved')}
          >
            <Bookmark size={12} /> Saved
          </button>
        </div>

        <div ref={containerRef} className="flex min-h-0 flex-1 flex-col">
          <div ref={hostRef} className="min-h-0" style={{ flexBasis: `${split * 100}%`, flexGrow: 0, flexShrink: 0 }} />
          <div className="h-1 shrink-0 cursor-row-resize border-y border-line bg-panel hover:bg-accent-soft" onMouseDown={startDrag} />

          <div className="flex min-h-0 flex-1 flex-col">
            {run ? (
              <>
                <div className="flex h-8 shrink-0 items-center gap-px overflow-x-auto border-b border-line bg-panel px-1 text-xs">
                  {run.results.map((r, i) => (
                    <button
                      key={i}
                      className={`h-7 whitespace-nowrap rounded px-2 ${view === i ? 'bg-bg text-fg shadow-sm' : 'text-muted hover:bg-panel-2'}`}
                      onClick={() => setView(i)}
                    >
                      {resultLabel(r, i)}
                    </button>
                  ))}
                  {run.error && (
                    <button
                      className={`h-7 whitespace-nowrap rounded px-2 text-danger ${view === 'messages' ? 'bg-bg shadow-sm' : 'hover:bg-panel-2'}`}
                      onClick={() => setView('messages')}
                    >
                      Error
                    </button>
                  )}
                  <div className="flex-1" />
                  {geoSources.length > 0 && (
                    <button className={`btn mr-1 h-6 px-2 ${showMap ? 'border-accent text-accent' : ''}`} onClick={() => setShowMap(!showMap)} title="Show locations on a map">
                      <MapIcon size={12} /> Map
                    </button>
                  )}
                  {current?.hasRows && gridResult && (
                    <button
                      className="btn mr-1 h-6 px-2"
                      title="Export this result"
                      onClick={() =>
                        openDialog({
                          type: 'exportRows',
                          name: tab.title.replace(/\W+/g, '_') || 'result',
                          tableName: sourceTable(current.sql),
                          columns: current.columns,
                          rows: current.rows
                        })
                      }
                    >
                      <Download size={12} /> Export
                    </button>
                  )}
                  <span className="whitespace-nowrap px-2 text-faint">{run.durationMs.toFixed(0)} ms total</span>
                </div>

                <div className="relative min-h-0 flex-1">
                  {view === 'messages' && run.error ? (
                    <div className="h-full select-text overflow-auto p-4 text-xs">
                      <div className="font-medium text-danger">
                        Statement {run.error.statementIndex + 1} failed: {run.error.message}
                      </div>
                      {run.results.length > 0 && (
                        <div className="mt-2 text-muted">
                          {run.results.length} earlier statement{run.results.length === 1 ? '' : 's'} ran and committed.
                        </div>
                      )}
                    </div>
                  ) : current?.hasRows && gridResult ? (
                    <div className="flex h-full flex-col">
                      {current.truncated && (
                        <div className="shrink-0 border-b border-line bg-accent-soft px-3 py-1 text-xs text-accent">
                          Showing the first {current.rows.length.toLocaleString()} rows. Add a LIMIT to see a specific range.
                        </div>
                      )}
                      <div className="min-h-0 flex-1">
                        {showMap && geoSources.length > 0 ? (
                          <MapView columns={gridResult.columns} rows={gridResult.rows} sources={geoSources} />
                        ) : current.columns.length > 0 ? (
                          <DataGrid
                            result={gridResult}
                            rowOffset={0}
                            selection={gridSelection}
                            onSelectionChange={setGridSelection}
                            onCellMenu={(row, col, x, y) => setMenu({ row, col, x, y })}
                            displayOverrides={displayOverrides}
                          />
                        ) : (
                          <div className="p-4 text-xs text-muted">The statement returned no columns.</div>
                        )}
                      </div>
                    </div>
                  ) : current ? (
                    <div className="select-text p-4 text-xs">
                      <div>
                        {current.command || 'Statement'} ran: {current.affected ?? 0} row{current.affected === 1 ? '' : 's'} affected
                        <span className="text-faint"> · {current.durationMs.toFixed(0)} ms</span>
                      </div>
                      <pre className="mt-2 whitespace-pre-wrap font-mono text-faint">{current.sql}</pre>
                    </div>
                  ) : (
                    <div className="p-4 text-xs text-muted">Nothing to run.</div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-xs text-muted">
                {keyLabel('query.run')} runs the statement at the cursor · {keyLabel('query.runAll')} runs everything · {keyLabel('query.ai')} asks AI
              </div>
            )}
          </div>
        </div>
      </div>

      {panel === 'ai' && (
        <AiPanel sessionId={sessionId} seed={aiSeed} getSql={aiSql} lastError={lastError} onInsert={insertAi} onClose={() => setPanel(null)} />
      )}

      {panel && panel !== 'ai' && (
        <aside className="flex w-72 shrink-0 flex-col border-l border-line bg-panel text-xs">
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3 font-medium">
            {panel === 'history' ? 'History' : 'Saved queries'}
            <div className="flex items-center gap-1">
              {panel === 'history' && history.length > 0 && (
                <button
                  className="btn h-6 px-2"
                  onClick={() => connection && call('history:clear', connection.id).then(loadHistory)}
                >
                  Clear
                </button>
              )}
              <button className="icon-btn" onClick={() => setPanel(null)} aria-label="Close panel">
                <X size={13} />
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {panel === 'history' &&
              (history.length === 0 ? (
                <div className="p-4 text-center text-muted">No queries run yet.</div>
              ) : (
                history.map((h) => (
                  <button
                    key={h.id}
                    className="block w-full border-b border-line px-3 py-2 text-left hover:bg-panel-2"
                    onClick={() => loadSql(h.sql)}
                    title="Load into the editor (Ctrl+Z to undo)"
                  >
                    <div className="mb-1 flex items-center gap-2 text-[11px] text-faint">
                      <span className={`h-1.5 w-1.5 rounded-full ${h.ok ? 'bg-ok' : 'bg-danger'}`} />
                      {timeLabel(h.at)} · {h.durationMs.toFixed(0)} ms
                    </div>
                    <div className="line-clamp-3 whitespace-pre-wrap break-all font-mono text-[11px]">{h.sql}</div>
                  </button>
                ))
              ))}
            {panel === 'saved' &&
              (saved.length === 0 ? (
                <div className="p-4 text-center text-muted">Save a query with {keyLabel('query.save')} to keep it here.</div>
              ) : (
                saved.map((q) => (
                  <div key={q.id} className="group flex items-start gap-2 border-b border-line px-3 py-2 hover:bg-panel-2">
                    <button
                      className="min-w-0 flex-1 text-left"
                      onClick={() => openQuery({ title: q.name, sql: q.sql, savedId: q.id })}
                      title="Open in a new tab"
                    >
                      <div className="truncate font-medium">{q.name}</div>
                      <div className="line-clamp-2 whitespace-pre-wrap break-all font-mono text-[11px] text-faint">{q.sql}</div>
                    </button>
                    <button
                      className="icon-btn invisible group-hover:visible"
                      title="Delete saved query"
                      onClick={() => {
                        if (confirm(`Delete saved query "${q.name}"?`)) call('saved:delete', q.id).then(loadSaved)
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))
              ))}
          </div>
        </aside>
      )}

      {menu && gridResult && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={(() => {
            const value = gridResult.rows[menu.row]?.[menu.col]
            const selected = gridSelection.rows.toArray()
            const range = gridSelection.current?.range
            const fromRange = range ? Array.from({ length: range.height }, (_, i) => range.y + i) : []
            const rows = selected.includes(menu.row) ? selected : fromRange.includes(menu.row) ? fromRange : [menu.row]
            return [
              { label: 'Copy value', onSelect: () => void navigator.clipboard.writeText(value === null || value === undefined ? '' : String(value)) },
              ...copyAsItems(gridResult, rows, engine, 'table_name')
            ]
          })()}
        />
      )}

      {confirmRun && connection && (
        <CommitModal
          verb="Run"
          statements={confirmRun.statements}
          connection={connection}
          onClose={() => setConfirmRun(null)}
          onCommit={() => doRun(confirmRun.sql, confirmRun.base)}
        />
      )}

      {naming && (
        <SaveQueryModal
          initial={tab.title}
          onClose={() => setNaming(false)}
          onSave={async (name) => {
            await persist(name)
            setNaming(false)
          }}
        />
      )}
    </div>
  )
}

function SaveQueryModal({
  initial,
  onClose,
  onSave
}: {
  initial: string
  onClose: () => void
  onSave: (name: string) => Promise<void>
}) {
  const [name, setName] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const submit = () => {
    if (!name.trim()) return
    onSave(name.trim()).catch((err) => setError((err as Error).message))
  }
  return (
    <Modal
      title="Save query"
      width={380}
      onClose={onClose}
      footer={
        <>
          <div className="min-w-0 flex-1 text-xs text-danger">{error}</div>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!name.trim()} onClick={submit}>
            Save
          </button>
        </>
      }
    >
      <input
        className="field"
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        onFocus={(e) => e.target.select()}
      />
    </Modal>
  )
}
