import { create } from 'zustand'
import { useEffect, useMemo, useState } from 'react'
import type { CellValue, ColumnMeta } from '@shared/types'
import { effectiveSafeMode } from '@shared/types'
import { ENGINES } from '@shared/engines'
import { quoteIdent } from '@shared/formats'
import { isReadStatement } from '@shared/sqlsplit'
import { call } from '../api'
import { useApp } from '../store'
import { editorFor, insertIntoEditor, selectedText } from '../editorRegistry'
import { workerSource } from './prelude'

const CALL_TIMEOUT_MS = 10_000
const FORMAT_ROW_CAP = 5_000

export interface PluginInfo {
  id: string
  file: string
  status: 'loading' | 'ready' | 'error' | 'disabled'
  error?: string
  commands: { id: string; title: string }[]
  formatters: { id: string; title: string }[]
  exporters: { id: string; title: string; extension: string }[]
}

interface Live {
  worker: Worker
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>
  seq: number
}

const live = new Map<string, Live>()

export const usePlugins = create<{ plugins: PluginInfo[] }>(() => ({ plugins: [] }))

const patch = (id: string, p: Partial<PluginInfo>) =>
  usePlugins.setState((s) => ({ plugins: s.plugins.map((x) => (x.id === id ? { ...x, ...p } : x)) }))

/** Send a request into a plugin's worker; a plugin that doesn't answer in time is stopped. */
function invoke(pluginId: string, kind: string, payload: Record<string, unknown>): Promise<unknown> {
  const l = live.get(pluginId)
  if (!l) return Promise.reject(new Error(`Plugin ${pluginId} is not running.`))
  const callId = ++l.seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      l.pending.delete(callId)
      stop(pluginId, `Stopped after not responding for ${CALL_TIMEOUT_MS / 1000}s.`)
      reject(new Error(`Plugin ${pluginId} did not respond and was stopped.`))
    }, CALL_TIMEOUT_MS)
    l.pending.set(callId, { resolve, reject, timer })
    l.worker.postMessage({ type: 'invoke', callId, kind, ...payload })
  })
}

function stop(id: string, error?: string) {
  const l = live.get(id)
  if (!l) return
  l.worker.terminate()
  for (const p of l.pending.values()) clearTimeout(p.timer)
  live.delete(id)
  patch(id, { status: error ? 'error' : 'disabled', error })
}

/** The host side of devplus.*: everything a plugin can ask the app to do. */
async function handleCall(pluginId: string, method: string, args: unknown[]): Promise<unknown> {
  const app = useApp.getState()
  switch (method) {
    case 'notify':
      app.setNotice(`${pluginId}: ${String(args[0])}`)
      return null
    case 'insertText': {
      const ed = editorFor(app.activeTabId)
      if (ed) insertIntoEditor(ed, String(args[0]))
      else app.openQuery({ sql: String(args[0]) })
      return null
    }
    case 'getContext': {
      const tab = app.tabs.find((t) => t.id === app.activeTabId)
      const engine = app.connection?.engine
      const table = tab?.type === 'table' && engine
        ? { schema: tab.schema, name: tab.table, quoted: ENGINES[engine].language === 'sql' || engine === 'cassandra' ? `${quoteIdent(engine, tab.schema)}.${quoteIdent(engine, tab.table)}` : tab.table }
        : null
      return {
        engine: engine ?? null,
        language: engine ? ENGINES[engine].language : null,
        connection: app.connection?.name ?? null,
        database: app.session?.currentDatabase ?? null,
        table,
        selection: selectedText(editorFor(app.activeTabId))
      }
    }
    case 'runQuery': {
      const sql = String(args[0])
      if (!app.session || !app.connection) throw new Error('Not connected.')
      const mode = effectiveSafeMode(app.connection)
      if (!isReadStatement(sql, app.connection.engine)) {
        if (mode === 'readonly') throw new Error('This connection is read-only.')
        // Plugins get the same confirmation a person would on a guarded connection.
        if ((mode === 'confirm' || app.connection.tag === 'production') && !confirm(`Plugin "${pluginId}" wants to run:\n\n${sql}`)) {
          throw new Error('The user declined.')
        }
      }
      const res = await call('query:run', app.session.sessionId, sql)
      if (res.error) throw new Error(res.error.message)
      const first = res.results[0]
      return first ? { columns: first.columns, rows: first.rows, affected: first.affected } : { columns: [], rows: [], affected: null }
    }
    default:
      throw new Error(`Unknown method ${method}`)
  }
}

function startPlugin(id: string, file: string, source: string) {
  const blob = new Blob([workerSource(source)], { type: 'text/javascript' })
  const url = URL.createObjectURL(blob)
  const worker = new Worker(url, { name: `plugin:${id}` })
  URL.revokeObjectURL(url)
  const l: Live = { worker, pending: new Map(), seq: 0 }
  live.set(id, l)
  usePlugins.setState((s) => ({
    plugins: [...s.plugins.filter((p) => p.id !== id), { id, file, status: 'loading', commands: [], formatters: [], exporters: [] }]
  }))

  worker.onmessage = (e: MessageEvent) => {
    const m = e.data as Record<string, unknown>
    const current = usePlugins.getState().plugins.find((p) => p.id === id)
    switch (m.type) {
      case 'ready':
        patch(id, { status: 'ready' })
        break
      case 'error':
        stop(id, String(m.message))
        break
      case 'register': {
        const entry = { id: String(m.id), title: String(m.title) }
        if (m.kind === 'command') patch(id, { commands: [...(current?.commands ?? []).filter((c) => c.id !== entry.id), entry] })
        if (m.kind === 'formatter') patch(id, { formatters: [...(current?.formatters ?? []).filter((c) => c.id !== entry.id), entry] })
        if (m.kind === 'exporter') patch(id, { exporters: [...(current?.exporters ?? []).filter((c) => c.id !== entry.id), { ...entry, extension: String(m.extension) }] })
        break
      }
      case 'call':
        handleCall(id, String(m.method), (m.args as unknown[]) ?? []).then(
          (value) => worker.postMessage({ type: 'reply', id: m.id, value }),
          (err: Error) => worker.postMessage({ type: 'reply', id: m.id, error: err.message })
        )
        break
      case 'result': {
        const p = l.pending.get(Number(m.id))
        if (!p) break
        clearTimeout(p.timer)
        l.pending.delete(Number(m.id))
        if (m.error) p.reject(new Error(String(m.error)))
        else p.resolve(m.value)
        break
      }
    }
  }
  worker.onerror = (e) => {
    e.preventDefault()
    stop(id, e.message || 'The plugin failed to load (syntax error?).')
  }
}

/** (Re)load every plugin from disk, honouring the disabled list in settings. */
export async function loadPlugins() {
  for (const id of [...live.keys()]) stop(id)
  const files = await call('plugins:list')
  const disabled = new Set(useApp.getState().settings?.plugins.disabled ?? [])
  usePlugins.setState({ plugins: [] })
  for (const f of files) {
    if (disabled.has(f.id) || !f.source) {
      usePlugins.setState((s) => ({
        plugins: [...s.plugins, { id: f.id, file: f.file, status: f.source ? 'disabled' : 'error', error: f.source ? undefined : 'File is larger than 1 MB.', commands: [], formatters: [], exporters: [] }]
      }))
      continue
    }
    startPlugin(f.id, f.file, f.source)
  }
}

export interface PluginCommand {
  id: string
  plugin: string
  title: string
  run: () => void
}

export function usePluginCommands(): PluginCommand[] {
  const plugins = usePlugins((s) => s.plugins)
  return useMemo(
    () =>
      plugins
        .filter((p) => p.status === 'ready')
        .flatMap((p) =>
          p.commands.map((c) => ({
            id: `${p.id}:${c.id}`,
            plugin: p.id,
            title: c.title,
            run: () => {
              invoke(p.id, 'command', { id: c.id }).catch((err: Error) => useApp.getState().setError(`${p.id}: ${err.message}`))
            }
          }))
        ),
    [plugins]
  )
}

export function usePluginExporters() {
  const plugins = usePlugins((s) => s.plugins)
  return useMemo(() => plugins.filter((p) => p.status === 'ready').flatMap((p) => p.exporters.map((x) => ({ ...x, plugin: p.id }))), [plugins])
}

export async function runExporter(plugin: string, exporter: string, columns: ColumnMeta[], rows: CellValue[][]): Promise<string> {
  return String(await invoke(plugin, 'export', { id: exporter, columns, rows }))
}

/**
 * Ask every running formatter which result columns it handles, then format those columns.
 * Returns display overrides by column index; raw values stay untouched for copying and editing.
 */
export async function formatColumns(result: { columns: ColumnMeta[]; rows: CellValue[][] }): Promise<Map<number, (string | null)[]>> {
  const out = new Map<number, (string | null)[]>()
  const plugins = usePlugins.getState().plugins.filter((p) => p.status === 'ready' && p.formatters.length > 0)
  for (const p of plugins) {
    const matches = (await invoke(p.id, 'match', { columns: result.columns }).catch(() => ({}))) as Record<string, number[]>
    for (const [formatterId, cols] of Object.entries(matches)) {
      for (const col of cols) {
        if (out.has(col)) continue
        const values = result.rows.slice(0, FORMAT_ROW_CAP).map((r) => r[col])
        const formatted = (await invoke(p.id, 'format', { id: formatterId, values }).catch(() => null)) as (string | null)[] | null
        if (formatted) out.set(col, formatted)
      }
    }
  }
  return out
}

export const hasFormatters = () => usePlugins.getState().plugins.some((p) => p.status === 'ready' && p.formatters.length > 0)

/** Plugin display text for a result's columns; undefined while formatting or when nothing matches. */
export function useDisplayOverrides(result: { columns: ColumnMeta[]; rows: CellValue[][] } | null | undefined | false) {
  const plugins = usePlugins((s) => s.plugins)
  const [overrides, setOverrides] = useState<Map<number, (string | null)[]>>()
  useEffect(() => {
    let alive = true
    setOverrides(undefined)
    if (!result || !hasFormatters()) return
    formatColumns(result)
      .then((m) => alive && setOverrides(m.size ? m : undefined))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [result, plugins])
  return overrides
}
