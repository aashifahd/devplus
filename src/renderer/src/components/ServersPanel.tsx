import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Copy, FileText, FolderOpen, Loader2, Play, Plus, Plug, Server, Settings2, Square, Trash2 } from 'lucide-react'
import { SERVER_ENGINES, byVersionDesc, type ServerDraft, type ServerEngine, type ServerRelease, type ServerView } from '@shared/servers'
import { call } from '../api'
import { useApp } from '../store'
import { useTask } from '../useTask'
import Modal from './Modal'

const ENGINE_ORDER: ServerEngine[] = ['postgres', 'mysql', 'mariadb']
const BADGE: Record<ServerEngine, string> = { postgres: 'Pg', mysql: 'My', mariadb: 'Ma' }
const mb = (bytes: number) => `${Math.round(bytes / 1048576)} MB`

function StatusPill({ s }: { s: ServerView }) {
  const st = s.state.status
  const style =
    st === 'running' ? 'bg-ok/15 text-ok' : st === 'error' ? 'bg-danger/15 text-danger' : st === 'stopped' ? 'bg-panel-2 text-muted' : 'bg-accent-soft text-accent'
  const label = { running: 'Running', stopped: 'Stopped', starting: 'Starting…', stopping: 'Stopping…', error: 'Failed' }[st]
  return (
    <span className={`inline-flex items-center gap-1.5 rounded px-1.5 py-px text-[10px] font-semibold uppercase ${style}`} data-status={st}>
      {(st === 'starting' || st === 'stopping') && <Loader2 size={10} className="animate-spin" />}
      {st === 'running' && <span className="h-1.5 w-1.5 rounded-full bg-ok" />}
      {label}
    </span>
  )
}

export default function ServersPanel() {
  const connect = useApp((s) => s.connect)
  const loadConnections = useApp((s) => s.loadConnections)
  const setError = useApp((s) => s.setError)
  const [servers, setServers] = useState<ServerView[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [logsFor, setLogsFor] = useState<ServerView | null>(null)
  const [settingsFor, setSettingsFor] = useState<ServerView | null>(null)
  const [deleting, setDeleting] = useState<ServerView | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  // Servers create and remove their own connections, so the connection list is refreshed too.
  const reload = useCallback(
    () =>
      Promise.all([call('servers:list').then(setServers), loadConnections()]).catch((e) => setError((e as Error).message)),
    [setError, loadConnections]
  )

  useEffect(() => {
    void reload()
    // Status changes (including the tray and auto-start) arrive as app events.
    return window.dbEvents.onApp((e) => {
      if (e.type !== 'servers') return
      setServers((list) => list?.map((s) => ({ ...s, state: e.states.find((x) => x.id === s.id) ?? { id: s.id, status: 'stopped', pid: null } })) ?? list)
    })
  }, [reload])

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
      void reload()
    }
  }

  const open = (s: ServerView) =>
    act(s.id, async () => {
      if (s.state.status !== 'running') await call('servers:start', s.id)
      const conn = await call('servers:connection', s.id)
      await loadConnections()
      await connect(conn)
    })

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="servers-panel">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1 text-xs text-muted">
          Database servers running natively on this computer, listening on 127.0.0.1 only. They keep running when DevPlus closes.
        </div>
        <button className="btn btn-primary h-8" onClick={() => setCreating(true)}>
          <Plus size={14} /> New server
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {servers && servers.length === 0 && (
          <div className="mx-auto mt-20 max-w-sm text-center text-xs text-muted">
            <Server size={28} className="mx-auto mb-3 text-faint" />
            <p className="mb-1 text-sm text-fg">No local servers yet</p>
            <p>Run PostgreSQL, MySQL or MariaDB on this computer without Docker. DevPlus downloads the version you pick from its official source.</p>
            <button className="btn mt-4" onClick={() => setCreating(true)}>
              <Plus size={14} /> Create a server
            </button>
          </div>
        )}
        {servers?.map((s) => {
          const info = SERVER_ENGINES[s.engine]
          const running = s.state.status === 'running'
          const transitional = s.state.status === 'starting' || s.state.status === 'stopping' || busy === s.id
          return (
            <div key={s.id} className="group rounded-lg px-3 py-2.5 hover:bg-panel" data-server={s.name}>
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-white" style={{ background: info.color }}>
                  {BADGE[s.engine]}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{s.name}</span>
                    <StatusPill s={s} />
                    {s.autoStart && <span className="text-[10px] uppercase text-faint">auto-start</span>}
                  </div>
                  <div className="truncate text-xs text-muted">
                    {info.label} {s.version} · 127.0.0.1:{s.port} · user {info.user}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {running ? (
                    <button className="btn h-7 px-2" disabled={transitional} onClick={() => void act(s.id, () => call('servers:stop', s.id))} title="Stop">
                      <Square size={12} /> Stop
                    </button>
                  ) : (
                    <button className="btn h-7 px-2" disabled={transitional} onClick={() => void act(s.id, () => call('servers:start', s.id))} title="Start">
                      {transitional ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Start
                    </button>
                  )}
                  <button className="btn btn-primary h-7 px-2" disabled={transitional} onClick={() => void open(s)} title="Start if needed and open in DevPlus">
                    <Plug size={12} /> Connect
                  </button>
                  <button className="icon-btn" title="Logs" onClick={() => setLogsFor(s)}>
                    <FileText size={14} />
                  </button>
                  <button className="icon-btn" title="Settings" onClick={() => setSettingsFor(s)}>
                    <Settings2 size={14} />
                  </button>
                  <button className="icon-btn" title="Open data folder" onClick={() => void call('servers:open', s.id, 'data').catch((e) => setError((e as Error).message))}>
                    <FolderOpen size={14} />
                  </button>
                  <button className="icon-btn" title="Delete" disabled={transitional} onClick={() => setDeleting(s)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              {s.state.status === 'error' && s.state.message && (
                <div className="ml-12 mt-1.5 flex items-start gap-2 text-[11px]">
                  <pre className="min-w-0 flex-1 select-text whitespace-pre-wrap break-words font-mono text-danger">{s.state.message}</pre>
                  <button className="btn h-6 shrink-0 px-2" onClick={() => setLogsFor(s)}>
                    View log
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {creating && <NewServerModal onClose={() => setCreating(false)} onCreated={() => void reload()} />}
      {logsFor && <LogsModal server={logsFor} onClose={() => setLogsFor(null)} />}
      {settingsFor && <ServerSettingsModal server={settingsFor} onClose={() => setSettingsFor(null)} onSaved={() => void reload()} />}
      {deleting && <DeleteServerModal server={deleting} onClose={() => setDeleting(null)} onDeleted={() => void reload()} />}
    </div>
  )
}

function NewServerModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [catalog, setCatalog] = useState<{ releases: ServerRelease[]; installed: Record<ServerEngine, string[]> } | null>(null)
  const [draft, setDraft] = useState<ServerDraft>({ name: '', engine: 'postgres', version: '', port: 5432, autoStart: false, binlog: false })
  const task = useTask()

  useEffect(() => {
    void call('servers:catalog').then(setCatalog)
  }, [])

  const versions = useMemo(
    () => (catalog?.releases ?? []).filter((r) => r.engine === draft.engine).sort((a, b) => byVersionDesc(a.version, b.version)),
    [catalog, draft.engine]
  )

  // Pick the newest version and a free port whenever the engine changes.
  useEffect(() => {
    if (!versions.length) return
    setDraft((d) => ({ ...d, version: versions[0].version }))
    void call('servers:suggestPort', draft.engine).then((port) => setDraft((d) => ({ ...d, port })))
  }, [versions, draft.engine])

  const release = versions.find((r) => r.version === draft.version)
  const installed = catalog?.installed[draft.engine].includes(draft.version) ?? false
  const info = SERVER_ENGINES[draft.engine]

  const create = () =>
    void task
      .run(async (taskId) => {
        const s = await call('servers:create', draft, taskId)
        onCreated()
        return `${s.name} is running on port ${s.port}.`
      })
      .then((ok) => ok && onClose())

  const downloading = task.running && task.total !== null && task.done < task.total
  return (
    <Modal
      title="New local server"
      width={560}
      onClose={() => !task.running && onClose()}
      footer={
        <>
          <div className="min-w-0 flex-1 select-text truncate text-xs text-danger" title={task.error ?? ''}>
            {task.error?.split('\n')[0]}
          </div>
          <button className="btn" disabled={task.running} onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={task.running || !release || !draft.port} onClick={create}>
            {task.running ? (downloading ? 'Downloading…' : 'Starting…') : installed ? 'Create and start' : 'Download and start'}
          </button>
        </>
      }
    >
      <div className="space-y-4 text-xs" data-testid="new-server">
        <div className="grid grid-cols-3 gap-2">
          {ENGINE_ORDER.map((e) => (
            <button
              key={e}
              disabled={task.running}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-left ${draft.engine === e ? 'border-accent bg-accent-soft' : 'border-line hover:bg-panel'}`}
              onClick={() => setDraft((d) => ({ ...d, engine: e, binlog: false }))}
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-md text-[10px] font-bold text-white" style={{ background: SERVER_ENGINES[e].color }}>
                {BADGE[e]}
              </span>
              <span className="font-medium">{SERVER_ENGINES[e].label}</span>
            </button>
          ))}
        </div>

        <div className="grid grid-cols-[90px_1fr] items-center gap-x-3 gap-y-3">
          <span className="text-muted">Version</span>
          <select className="field" value={draft.version} disabled={task.running} onChange={(e) => setDraft((d) => ({ ...d, version: e.target.value }))}>
            {versions.map((r) => (
              <option key={r.version} value={r.version}>
                {info.label} {r.version} ({r.channel}){catalog?.installed[r.engine].includes(r.version) ? ' · downloaded' : ` · ${mb(r.bytes)}`}
              </option>
            ))}
          </select>
          <span className="text-muted">Name</span>
          <input className="field" value={draft.name} disabled={task.running} placeholder={`${info.label} ${draft.version}`} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
          <span className="text-muted">Port</span>
          <div className="flex items-center gap-2">
            <input className="field w-28" type="number" min={1024} max={65535} value={draft.port} disabled={task.running} onChange={(e) => setDraft((d) => ({ ...d, port: Number(e.target.value) }))} />
            {draft.port !== info.defaultPort && <span className="text-faint">{info.defaultPort} is in use on this computer</span>}
          </div>
          <span />
          <div className="space-y-1.5">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={draft.autoStart} disabled={task.running} onChange={(e) => setDraft((d) => ({ ...d, autoStart: e.target.checked }))} /> Start when DevPlus starts
            </label>
            {info.hasBinlog && (
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={draft.binlog} disabled={task.running} onChange={(e) => setDraft((d) => ({ ...d, binlog: e.target.checked }))} /> Binary log (needed for replication; off saves disk space)
              </label>
            )}
          </div>
        </div>

        <div className="rounded-md border border-line bg-panel p-2.5 text-[11px] text-muted">
          {installed
            ? 'This version is already downloaded.'
            : release && `Downloads ${mb(release.bytes)} once from ${new URL(release.url).host}, checked against its published SHA-256.`}{' '}
          The server listens on 127.0.0.1 only. User <code className="font-mono">{info.user}</code> has no password, which is fine for local development.
        </div>

        {task.running && (
          <div className="space-y-1">
            <div className="h-1.5 overflow-hidden rounded-full bg-panel-2">
              <div
                className={`h-full rounded-full bg-accent transition-[width] ${task.total ? '' : 'w-1/3 animate-pulse'}`}
                style={task.total ? { width: `${Math.min(100, (task.done / task.total) * 100)}%` } : undefined}
              />
            </div>
            <div className="text-[11px] tabular-nums text-muted">
              {downloading ? `Downloading ${mb(task.done)} of ${mb(task.total ?? 0)}` : installed || !task.total ? 'Initializing and starting…' : 'Unpacking, initializing and starting…'}
            </div>
          </div>
        )}
        {task.error && <pre className="max-h-32 select-text overflow-auto whitespace-pre-wrap rounded-md border border-line p-2 font-mono text-[11px] text-danger">{task.error}</pre>}
      </div>
    </Modal>
  )
}

function LogsModal({ server, onClose }: { server: ServerView; onClose: () => void }) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    let alive = true
    const load = () =>
      call('servers:logs', server.id)
        .then((t) => alive && setText(t))
        .catch(() => {})
    void load()
    const timer = setInterval(load, 1500)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [server.id])
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [text])
  return (
    <Modal
      title={`${server.name}: log`}
      width={820}
      onClose={onClose}
      footer={
        <>
          <div className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint" title={server.logPath}>
            {server.logPath}
          </div>
          <button className="btn" onClick={() => void navigator.clipboard.writeText(text)}>
            <Copy size={12} /> Copy
          </button>
          <button className="btn" onClick={() => void call('servers:open', server.id, 'log')}>
            Open log file
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <pre ref={ref} className="h-96 select-text overflow-auto whitespace-pre-wrap rounded-md border border-line bg-panel p-3 font-mono text-[11px] leading-relaxed" data-testid="server-log">
        {text || 'The log is empty. It fills in when the server starts.'}
      </pre>
    </Modal>
  )
}

function ServerSettingsModal({ server, onClose, onSaved }: { server: ServerView; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(server.name)
  const [port, setPort] = useState(server.port)
  const [autoStart, setAutoStart] = useState(server.autoStart)
  const [binlog, setBinlog] = useState(server.binlog)
  const [error, setError] = useState<string | null>(null)
  const running = server.state.status === 'running'
  const info = SERVER_ENGINES[server.engine]
  const needsRestart = running && binlog !== server.binlog

  const save = async (restart: boolean) => {
    try {
      await call('servers:update', server.id, { name, port, autoStart, binlog })
      if (restart) await call('servers:restart', server.id)
      onSaved()
      onClose()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <Modal
      title={`${server.name}: settings`}
      width={520}
      onClose={onClose}
      footer={
        <>
          <div className="min-w-0 flex-1 truncate text-xs text-danger">{error}</div>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void save(needsRestart)}>
            {needsRestart ? 'Save and restart' : 'Save'}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-3 text-xs">
        <span className="text-muted">Name</span>
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
        <span className="text-muted">Port</span>
        <div className="flex items-center gap-2">
          <input className="field w-28" type="number" min={1024} max={65535} value={port} disabled={running} onChange={(e) => setPort(Number(e.target.value))} />
          {running && <span className="text-faint">Stop the server to change its port.</span>}
        </div>
        <span className="text-muted">Version</span>
        <span>
          {info.label} {server.version}
        </span>
        <span />
        <div className="space-y-1.5">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} /> Start when DevPlus starts
          </label>
          {info.hasBinlog && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={binlog} onChange={(e) => setBinlog(e.target.checked)} /> Binary log
            </label>
          )}
        </div>
        <span className="text-muted">Files</span>
        <div className="flex gap-2">
          <button className="btn h-7" onClick={() => void call('servers:open', server.id, 'config').catch((e) => setError((e as Error).message))}>
            Open config file
          </button>
          <button className="btn h-7" onClick={() => void call('servers:open', server.id, 'data').catch((e) => setError((e as Error).message))}>
            Open data folder
          </button>
        </div>
        <span />
        <div className="text-[11px] text-faint">Changes to the config file apply after a restart. The port is managed here, not in the file.</div>
      </div>
    </Modal>
  )
}

function DeleteServerModal({ server, onClose, onDeleted }: { server: ServerView; onClose: () => void; onDeleted: () => void }) {
  const [deleteData, setDeleteData] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = async () => {
    setBusy(true)
    try {
      await call('servers:delete', server.id, deleteData)
      onDeleted()
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal
      title={`Delete ${server.name}?`}
      width={460}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <div className="min-w-0 flex-1 truncate text-xs text-danger">{error}</div>
          <button className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary bg-danger" disabled={busy} onClick={() => void remove()}>
            {busy ? 'Deleting…' : 'Delete server'}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-xs">
        <p>The server is stopped and removed from DevPlus, along with its connection.</p>
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-0.5" checked={deleteData} onChange={(e) => setDeleteData(e.target.checked)} />
          <span>
            Also delete its data folder
            <span className="block text-[11px] text-danger">Every database on this server is deleted permanently.</span>
          </span>
        </label>
        {!deleteData && <p className="text-[11px] text-muted">The data stays at {server.dataDir}.</p>}
      </div>
    </Modal>
  )
}
