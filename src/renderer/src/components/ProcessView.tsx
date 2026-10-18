import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { ProcessInfo } from '@shared/types'
import { call } from '../api'
import { useApp } from '../store'

const IDLE = /^(idle|sleep)/i

function duration(seconds: number | null) {
  if (seconds === null) return ''
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

export default function ProcessView({ sessionId, active }: { sessionId: string; active: boolean }) {
  const setAppError = useApp((s) => s.setError)
  const [rows, setRows] = useState<ProcessInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [auto, setAuto] = useState(true)
  const [hideIdle, setHideIdle] = useState(true)

  const load = useCallback(async () => {
    try {
      setRows(await call('admin:processes', sessionId))
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [sessionId])

  useEffect(() => {
    void load()
  }, [load])

  // Poll only while the tab is visible, so a background tab costs nothing.
  useEffect(() => {
    if (!auto || !active) return
    const t = setInterval(() => void load(), 2000)
    return () => clearInterval(t)
  }, [auto, active, load])

  const signal = async (p: ProcessInfo, mode: 'cancel' | 'terminate') => {
    const verb = mode === 'cancel' ? 'Cancel the running query of' : 'Terminate'
    if (!confirm(`${verb} process ${p.id}${p.user ? ` (${p.user})` : ''}?`)) return
    try {
      await call('admin:kill', sessionId, p.id, mode)
      await load()
    } catch (err) {
      setAppError((err as Error).message)
    }
  }

  const visible = hideIdle ? rows.filter((r) => r.self || !IDLE.test(r.state ?? '')) : rows

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
        <span className="font-medium">Processes</span>
        <span className="text-faint">
          {visible.length} of {rows.length}
        </span>
        <div className="flex-1" />
        <label className="flex items-center gap-1.5 text-muted">
          <input type="checkbox" checked={hideIdle} onChange={(e) => setHideIdle(e.target.checked)} /> Hide idle
        </label>
        <label className="flex items-center gap-1.5 text-muted">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Refresh every 2s
        </label>
        <button className="icon-btn" title="Refresh now" onClick={() => void load()}>
          <RefreshCw size={13} />
        </button>
      </div>
      {error && <div className="select-text border-b border-line px-3 py-2 text-danger">{error}</div>}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-panel text-left text-[11px] text-faint">
            <tr>
              {['ID', 'User', 'Database', 'Client', 'State', 'Time', 'Query', ''].map((h) => (
                <th key={h} className="border-b border-line px-3 py-1.5 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => (
              <tr key={p.id} className="group align-top hover:bg-panel">
                <td className="border-b border-line px-3 py-1.5 font-mono">{p.id}</td>
                <td className="border-b border-line px-3 py-1.5">{p.user}</td>
                <td className="border-b border-line px-3 py-1.5">{p.database}</td>
                <td className="border-b border-line px-3 py-1.5 font-mono text-muted">{p.client}</td>
                <td className="border-b border-line px-3 py-1.5">
                  {p.state}
                  {p.self && <span className="ml-2 whitespace-nowrap rounded bg-accent-soft px-1.5 py-px text-accent">this app</span>}
                </td>
                <td className="whitespace-nowrap border-b border-line px-3 py-1.5 tabular-nums">{duration(p.seconds)}</td>
                <td className="max-w-xl border-b border-line px-3 py-1.5">
                  <div className="line-clamp-2 select-text break-all font-mono text-[11px] text-muted" title={p.query ?? ''}>
                    {p.query}
                  </div>
                </td>
                <td className="whitespace-nowrap border-b border-line px-3 py-1.5 text-right">
                  {!p.self && (
                    <span className="invisible inline-flex gap-1 group-hover:visible">
                      <button className="btn h-6 px-2" onClick={() => void signal(p, 'cancel')}>
                        Cancel query
                      </button>
                      <button className="btn h-6 px-2 text-danger" onClick={() => void signal(p, 'terminate')}>
                        Kill
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
