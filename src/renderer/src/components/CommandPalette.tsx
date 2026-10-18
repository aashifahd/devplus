import { useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { caps } from '@shared/engines'
import { keyFor, type ActionId } from '@shared/settings'
import { useApp } from '../store'
import { call } from '../api'
import { displayCombo } from '../keymap'
import { usePluginCommands } from '../plugins/host'

export interface Command {
  id: string
  title: string
  group: string
  action?: ActionId
  run: () => void
}

/** Subsequence match with a score that favours word starts and contiguous runs. */
function score(query: string, text: string): number {
  if (!query) return 1
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (t.includes(q)) return 100 - t.indexOf(q)
  let ti = 0
  let total = 0
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found < 0) return 0
    total += found === ti ? 3 : /[\s:./_-]/.test(t[found - 1] ?? ' ') ? 2 : 1
    ti = found + 1
  }
  return total
}

export default function CommandPalette({ onClose }: { onClose: () => void }) {
  const app = useApp()
  const pluginCommands = usePluginCommands()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const commands = useMemo<Command[]>(() => {
    const out: Command[] = []
    const settings = app.settings
    const cycle = { system: 'light', light: 'dark', dark: 'system' } as const
    out.push(
      { id: 'settings', title: 'Open settings', group: 'App', action: 'app.settings', run: () => app.setOverlay('settings') },
      {
        id: 'theme',
        title: `Switch theme (now ${settings?.ui.theme ?? 'system'})`,
        group: 'App',
        run: () => void app.updateSettings({ ui: { theme: cycle[settings?.ui.theme ?? 'system'] } })
      },
      { id: 'about', title: 'About and updates', group: 'App', run: () => useApp.setState({ overlay: 'settings', settingsSection: 'about' }) },
      { id: 'updates', title: 'Check for updates', group: 'App', run: () => (void call('updates:check').catch(() => {}), useApp.setState({ overlay: 'settings', settingsSection: 'about' })) },
      { id: 'report', title: 'Report a problem', group: 'App', run: () => void call('app:reportProblem').catch((e) => app.setError((e as Error).message)) },
      { id: 'logs', title: 'Open logs folder', group: 'App', run: () => void call('app:openLogs') }
    )
    if (app.session && app.connection) {
      const c = caps(app.connection.engine)
      const schema = app.tree.find((n) => n.kind === 'schema')?.name
      out.push(
        { id: 'query', title: 'New SQL query', group: 'Workspace', action: 'tab.newQuery', run: () => app.openQuery() },
        { id: 'ai', title: 'Ask AI…', group: 'Workspace', action: 'query.ai', run: () => app.askAi('') },
        { id: 'refresh', title: 'Refresh schema', group: 'Workspace', run: () => void app.refreshTree() },
        { id: 'metrics', title: 'New metrics board', group: 'Workspace', run: () => app.openMetrics(`board-${Date.now()}`, 'Metrics') },
        { id: 'disconnect', title: 'Close connection', group: 'Workspace', run: () => void app.disconnect() }
      )
      if (app.activeTabId) out.push({ id: 'close', title: 'Close tab', group: 'Workspace', action: 'tab.close', run: () => app.closeTab(app.activeTabId!) })
      if (c.ddl && schema) out.push({ id: 'new-table', title: 'New table…', group: 'Workspace', run: () => app.openNewTable(schema) })
      if (c.structure && schema) {
        for (const s of app.tree.filter((n) => n.kind === 'schema')) {
          out.push({ id: `erd:${s.name}`, title: `ER diagram: ${s.name}`, group: 'Workspace', run: () => app.openErd(s.name) })
        }
      }
      if (c.users) out.push({ id: 'users', title: 'Users and roles', group: 'Workspace', run: () => app.openTool('users') })
      if (c.processes) out.push({ id: 'processes', title: 'Process list', group: 'Workspace', run: () => app.openTool('processes') })
      if (c.backup) out.push({ id: 'backup', title: 'Back up…', group: 'Workspace', run: () => app.openDialog({ type: 'backup' }) })
      if (c.restore) out.push({ id: 'restore', title: 'Restore or run a SQL file…', group: 'Workspace', run: () => app.openDialog({ type: 'restore' }) })
      if (c.databases) {
        for (const db of app.session.databases.filter((d) => d !== app.session!.currentDatabase)) {
          out.push({ id: `db:${db}`, title: `Use database ${db}`, group: 'Databases', run: () => void app.switchDatabase(db) })
        }
      }
      for (const s of app.tree) {
        for (const n of s.children ?? []) {
          if (n.kind === 'table' || n.kind === 'view') {
            out.push({ id: `open:${n.schema}.${n.name}`, title: `${n.name}`, group: `Open ${s.name}`, run: () => app.openTable(n) })
          }
        }
      }
    }
    for (const p of pluginCommands) out.push({ id: `plugin:${p.id}`, title: p.title, group: `Plugin: ${p.plugin}`, run: p.run })
    return out
  }, [app, pluginCommands])

  const results = useMemo(
    () =>
      commands
        .map((c) => ({ c, s: score(query, `${c.title} ${c.group}`) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 60)
        .map((x) => x.c),
    [commands, query]
  )

  useEffect(() => setIndex(0), [query])
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const run = (c: Command | undefined) => {
    if (!c) return
    onClose()
    c.run()
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/30 pt-[12vh]" onMouseDown={onClose}>
      <div className="flex h-fit max-h-[60vh] w-[560px] flex-col overflow-hidden rounded-xl border border-line bg-bg shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search size={14} className="text-faint" />
          <input
            className="h-11 flex-1 bg-transparent text-sm outline-none"
            autoFocus
            placeholder="Type a command or a table name"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIndex((i) => Math.min(results.length - 1, i + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIndex((i) => Math.max(0, i - 1))
              } else if (e.key === 'Enter') {
                run(results[index])
              } else if (e.key === 'Escape') {
                onClose()
              }
            }}
          />
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1 text-xs">
          {results.length === 0 && <div className="px-4 py-6 text-center text-muted">No matching commands</div>}
          {results.map((c, i) => (
            <button
              key={c.id}
              data-index={i}
              className={`flex w-full items-center gap-3 px-4 py-2 text-left ${i === index ? 'bg-accent text-white' : 'hover:bg-panel'}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => run(c)}
            >
              <span className="min-w-0 flex-1 truncate">{c.title}</span>
              <span className={`shrink-0 text-[10px] ${i === index ? 'text-white/70' : 'text-faint'}`}>{c.group}</span>
              {c.action && <kbd className={`shrink-0 rounded border px-1.5 py-px text-[10px] ${i === index ? 'border-white/40' : 'border-line text-muted'}`}>{displayCombo(keyFor(app.settings, c.action))}</kbd>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
