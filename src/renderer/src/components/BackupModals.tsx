import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, FolderOpen, Lock, RotateCcw, XCircle } from 'lucide-react'
import { effectiveSafeMode, type BackupOptions, type RestoreOptions, type ToolStatus } from '@shared/types'
import { call } from '../api'
import { useApp } from '../store'
import { ProgressBar, useTask, type TaskState } from '../useTask'
import Modal from './Modal'

const today = () => new Date().toISOString().slice(0, 10)

function ToolList({ sessionId }: { sessionId: string }) {
  const [tools, setTools] = useState<ToolStatus[]>([])
  const load = useCallback(() => {
    call('tools:status', sessionId).then(setTools).catch(() => setTools([]))
  }, [sessionId])
  useEffect(load, [load])

  const choose = async (t: ToolStatus) => {
    const p = await call('dialog:openFile', { title: `Locate ${t.name}` })
    if (p) {
      await call('tools:setPath', t.name, p)
      load()
    }
  }

  if (tools.length === 0) return null
  return (
    <div className="space-y-1 rounded-md border border-line bg-panel p-2">
      {tools.map((t) => (
        <div key={t.name} className="flex items-center gap-2">
          {t.path ? <CheckCircle2 size={12} className="shrink-0 text-ok" /> : <XCircle size={12} className="shrink-0 text-danger" />}
          <span className="w-20 shrink-0 font-mono">{t.name}</span>
          <span className="min-w-0 flex-1 truncate text-muted" title={t.path ?? ''}>
            {t.path ? (t.version ?? t.path) : 'Not found. Install the client tools or locate it.'}
          </span>
          {t.custom && (
            <button className="icon-btn" title="Use auto-detected path" onClick={() => void call('tools:setPath', t.name, null).then(load)}>
              <RotateCcw size={11} />
            </button>
          )}
          <button className="btn h-6 shrink-0 px-2" onClick={() => void choose(t)}>
            Locate…
          </button>
        </div>
      ))}
    </div>
  )
}

/** Tool output, auto-scrolled to the latest line. */
function LogPanel({ task }: { task: TaskState }) {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    ref.current?.scrollTo(0, ref.current.scrollHeight)
  }, [task.log.length])
  if (task.log.length === 0 && !task.running) return null
  return (
    <pre ref={ref} className="h-32 select-text overflow-auto rounded-md border border-line bg-panel p-2 font-mono text-[11px] leading-snug text-muted">
      {task.log.join('\n') || 'Starting…'}
    </pre>
  )
}

function Outcome({ task }: { task: TaskState }) {
  if (task.error) return <div className="select-text whitespace-pre-wrap text-danger">{task.error}</div>
  if (task.result) return <div className="select-text text-ok">{task.result}</div>
  return null
}

const check = (label: string, value: boolean, set: (v: boolean) => void, hint?: string) => (
  <label className="flex items-center gap-2" title={hint}>
    <input type="checkbox" checked={value} onChange={(e) => set(e.target.checked)} /> {label}
  </label>
)

// ---- backup -----------------------------------------------------------------------------------

export function BackupModal({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { connection, session, tree } = useApp()
  const engine = connection?.engine ?? 'postgres'
  const [o, setO] = useState<BackupOptions>({
    format: 'plain',
    content: 'all',
    tables: [],
    clean: true,
    noOwner: true,
    routines: true,
    singleTransaction: true
  })
  const [allTables, setAllTables] = useState(true)
  const task = useTask()
  const patch = (p: Partial<BackupOptions>) => setO((x) => ({ ...x, ...p }))

  const tables = tree.flatMap((s) => (s.children ?? []).filter((c) => c.kind === 'table').map((c) => (engine === 'postgres' ? `${c.schema}.${c.name}` : c.name)))
  const db = session?.currentDatabase || connection?.name || 'backup'
  const ext = engine === 'sqlite' ? 'sqlite' : o.format === 'custom' ? 'dump' : 'sql'

  const start = async () => {
    const path = await call('dialog:saveFile', { title: 'Save backup', defaultPath: `${db}-${today()}.${ext}` })
    if (!path) return
    await task.run(async (taskId) => {
      const { bytes } = await call('backup:run', sessionId, { ...o, tables: allTables ? [] : o.tables }, path, taskId)
      return `Saved ${(bytes / 1024).toFixed(bytes > 10240 ? 0 : 1)} KB to ${path}`
    })
  }

  return (
    <Modal
      title={`Back up ${db}`}
      width={560}
      onClose={onClose}
      footer={
        <>
          <div className="flex-1" />
          <button className="btn" onClick={onClose}>
            {task.result ? 'Done' : 'Cancel'}
          </button>
          {!task.result && (
            <button className="btn btn-primary" disabled={task.running || (!allTables && o.tables.length === 0)} onClick={() => void start()}>
              {task.running ? 'Backing up…' : 'Back up…'}
            </button>
          )}
        </>
      }
    >
      <div className="space-y-4 text-xs">
        {engine === 'sqlite' ? (
          <div className="text-muted">Writes a compact, consistent copy of the database file (VACUUM INTO).</div>
        ) : (
          <>
            <ToolList sessionId={sessionId} />
            <div className="grid grid-cols-2 gap-4">
              {engine === 'postgres' && (
                <label className="block">
                  <div className="mb-1 text-muted">Format</div>
                  <select className="field h-7 text-xs" value={o.format} onChange={(e) => patch({ format: e.target.value as BackupOptions['format'] })}>
                    <option value="plain">Plain SQL (.sql)</option>
                    <option value="custom">Custom archive (.dump, for pg_restore)</option>
                  </select>
                </label>
              )}
              <label className="block">
                <div className="mb-1 text-muted">Content</div>
                <select className="field h-7 text-xs" value={o.content} onChange={(e) => patch({ content: e.target.value as BackupOptions['content'] })}>
                  <option value="all">Structure and data</option>
                  <option value="schema">Structure only</option>
                  <option value="data">Data only</option>
                </select>
              </label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {engine === 'postgres' && (
                <>
                  {check('Drop objects before creating (--clean)', o.clean, (v) => patch({ clean: v }), 'Plain format only')}
                  {check('Skip owners and grants', o.noOwner, (v) => patch({ noOwner: v }), 'Restores under any user')}
                </>
              )}
              {engine === 'mysql' && (
                <>
                  {check('Include routines and events', o.routines, (v) => patch({ routines: v }))}
                  {check('Consistent snapshot (--single-transaction)', o.singleTransaction, (v) => patch({ singleTransaction: v }))}
                </>
              )}
            </div>
            <div>
              {check('All tables', allTables, setAllTables)}
              {!allTables && (
                <div className="mt-2 grid max-h-36 grid-cols-2 gap-1 overflow-y-auto rounded-md border border-line p-2">
                  {tables.map((t) => (
                    <label key={t} className="flex items-center gap-2 font-mono">
                      <input
                        type="checkbox"
                        checked={o.tables.includes(t)}
                        onChange={(e) => patch({ tables: e.target.checked ? [...o.tables, t] : o.tables.filter((x) => x !== t) })}
                      />
                      <span className="truncate">{t}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
        <LogPanel task={task} />
        <Outcome task={task} />
      </div>
    </Modal>
  )
}

// ---- restore ----------------------------------------------------------------------------------

export function RestoreModal({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { connection, session, refreshTree, reloadAllTables } = useApp()
  const engine = connection?.engine ?? 'postgres'
  const readOnly = connection ? effectiveSafeMode(connection) === 'readonly' : false
  const [path, setPath] = useState<string | null>(null)
  // SQLite has no external tool, so it always runs the file in-app.
  const [useApp_, setUseApp] = useState(engine === 'sqlite')
  const [o, setO] = useState<RestoreOptions>({ clean: false, noOwner: true, singleTransaction: false, stopOnError: true })
  const task = useTask()
  const patch = (p: Partial<RestoreOptions>) => setO((x) => ({ ...x, ...p }))
  const db = session?.currentDatabase || connection?.name || ''

  const choose = async () => {
    const p = await call('dialog:openFile', {
      title: 'Choose a backup or SQL file',
      filters: [
        { name: 'Backups', extensions: ['sql', 'dump', 'backup', 'gz'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (p) {
      task.reset()
      setPath(p)
    }
  }

  const start = async () => {
    if (!path) return
    if (!confirm(`Run ${path.split(/[\\/]/).pop()} against ${db} on ${connection?.name}? This can overwrite existing data.`)) return
    const ok = await task.run(async (taskId) => {
      if (useApp_) {
        const r = await call('import:sqlFile', sessionId, path, taskId)
        return `Ran ${r.statements.toLocaleString()} statements in ${(r.durationMs / 1000).toFixed(1)} s.`
      }
      await call('restore:run', sessionId, o, path, taskId)
      return `Restored into ${db}.`
    })
    if (ok) {
      void refreshTree()
      reloadAllTables()
    }
  }

  return (
    <Modal
      title={`Restore into ${db}`}
      width={560}
      onClose={onClose}
      footer={
        <>
          <div className="flex-1" />
          <button className="btn" onClick={onClose}>
            {task.result ? 'Done' : 'Cancel'}
          </button>
          {!task.result && (
            <button
              className="btn btn-primary"
              style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }}
              disabled={!path || task.running || readOnly}
              onClick={() => void start()}
            >
              {task.running ? 'Restoring…' : 'Restore'}
            </button>
          )}
        </>
      }
    >
      <div className="space-y-4 text-xs">
        {readOnly && (
          <div className="flex items-center gap-2 text-muted">
            <Lock size={12} /> This connection is read-only.
          </div>
        )}
        <div className="flex items-center gap-2">
          <input className="field flex-1 font-mono" readOnly value={path ?? ''} placeholder="Choose a .sql file or a pg_dump archive" />
          <button className="btn shrink-0" onClick={() => void choose()}>
            <FolderOpen size={13} /> Choose file
          </button>
        </div>

        {engine !== 'sqlite' && (
          <div className="space-y-2">
            <label className="flex items-center gap-2">
              <input type="radio" checked={!useApp_} onChange={() => setUseApp(false)} />
              Use {engine === 'postgres' ? 'psql / pg_restore' : 'the mysql client'} (handles full dumps)
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={useApp_} onChange={() => setUseApp(true)} />
              Run the SQL in the app (no tools needed; plain scripts only)
            </label>
          </div>
        )}

        {!useApp_ && (
          <>
            <ToolList sessionId={sessionId} />
            <div className="grid grid-cols-2 gap-2">
              {check('Stop at the first error', o.stopOnError, (v) => patch({ stopOnError: v }))}
              {engine === 'postgres' && (
                <>
                  {check('All or nothing (single transaction)', o.singleTransaction, (v) => patch({ singleTransaction: v }))}
                  {check('Drop objects first (archives)', o.clean, (v) => patch({ clean: v }), 'pg_restore --clean --if-exists')}
                  {check('Skip owners and grants (archives)', o.noOwner, (v) => patch({ noOwner: v }))}
                </>
              )}
            </div>
          </>
        )}

        {task.running && useApp_ && <ProgressBar done={task.done} total={task.total} />}
        {!useApp_ && <LogPanel task={task} />}
        <Outcome task={task} />
      </div>
    </Modal>
  )
}
