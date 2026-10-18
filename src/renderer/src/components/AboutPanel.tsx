import { useEffect, useState } from 'react'
import { Bug, Download, ExternalLink, FileText, FolderOpen, Loader2, RefreshCw, RotateCw } from 'lucide-react'
import { REPO_URL, type AppInfo, type UpdateState } from '@shared/app'
import { call } from '../api'
import { useApp } from '../store'
import icon from '../../../../build/icon.png'

export function updateLabel(u: UpdateState | null): string {
  if (!u) return ''
  switch (u.status) {
    case 'unsupported':
      return u.message ?? 'Updates only work in installed builds.'
    case 'idle':
      return 'Not checked yet.'
    case 'checking':
      return 'Checking for updates…'
    case 'none':
      return 'You have the latest version.'
    case 'available':
      return `Version ${u.version} is available.`
    case 'downloading':
      return `Downloading ${u.version ?? 'update'}… ${u.percent ?? 0}%`
    case 'ready':
      return `Version ${u.version} is ready. Restart to finish updating.`
    case 'error':
      return `Update check failed: ${u.message ?? 'unknown error'}`
  }
}

/** Live update state from the main process. */
export function useUpdateState() {
  const [state, setState] = useState<UpdateState | null>(null)
  useEffect(() => {
    void call('updates:state').then(setState)
    return window.dbEvents.onApp((e) => e.type === 'update' && setState(e.state))
  }, [])
  return [state, setState] as const
}

export default function AboutPanel() {
  const { settings, updateSettings, setError } = useApp()
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [update, setUpdate] = useUpdateState()

  useEffect(() => {
    void call('app:info').then(setInfo)
  }, [])

  if (!settings || !info) return null
  const busy = update?.status === 'checking' || update?.status === 'downloading'
  const run = (p: Promise<unknown>) => p.catch((e) => setError((e as Error).message))

  return (
    <div className="space-y-5 text-xs">
      <div className="flex items-center gap-4">
        <img src={icon} alt="" className="h-14 w-14" />
        <div>
          <div className="text-base font-semibold">{info.name}</div>
          <div className="select-text text-muted">
            Version {info.version}
            {info.packaged ? '' : ' (running from source)'}
          </div>
          <div className="select-text text-[11px] text-faint">
            Electron {info.electron} · Chromium {info.chrome.split('.')[0]} · {info.platform} {info.arch}
          </div>
        </div>
      </div>

      <section className="space-y-2 rounded-md border border-line p-3">
        <div className="font-medium">Updates</div>
        <div className={update?.status === 'error' ? 'text-danger' : 'text-muted'} data-testid="update-status">
          {updateLabel(update)}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {update?.status === 'ready' ? (
            <button className="btn btn-primary h-7" onClick={() => void run(call('updates:install'))}>
              <RotateCw size={12} /> Restart and update
            </button>
          ) : update?.status === 'available' ? (
            <button className="btn btn-primary h-7" onClick={() => void run(call('updates:download').then(setUpdate))}>
              <Download size={12} /> Download {update.version}
            </button>
          ) : (
            <button className="btn h-7" disabled={!info.packaged || busy} onClick={() => void run(call('updates:check').then(setUpdate))}>
              {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Check for updates
            </button>
          )}
          <label className="flex items-center gap-1.5 text-muted">
            <input type="checkbox" checked={settings.updates.auto} onChange={(e) => void updateSettings({ updates: { auto: e.target.checked } })} />
            Check and download automatically
          </label>
        </div>
        <div className="text-[11px] text-faint">Updates come from the project's GitHub Releases page.</div>
      </section>

      <section className="space-y-2 rounded-md border border-line p-3">
        <div className="font-medium">Problems</div>
        <div className="text-muted">
          Errors are written to a log on this computer. Nothing is sent automatically: "Report a problem" opens a GitHub issue in your browser with your app
          version and recent errors (passwords and keys removed) for you to review first.
        </div>
        <div className="flex gap-2">
          <button className="btn h-7" onClick={() => void run(call('app:reportProblem'))}>
            <Bug size={12} /> Report a problem
          </button>
          <button className="btn h-7" onClick={() => void run(call('app:openLogs'))}>
            <FolderOpen size={12} /> Open logs folder
          </button>
        </div>
      </section>

      <section className="space-y-2">
        <div className="text-muted">
          Free and open source under the GNU General Public License, version 3 or later. Not affiliated with any database vendor.
        </div>
        <div className="flex gap-2">
          <a className="btn h-7" href={REPO_URL} target="_blank" rel="noreferrer">
            <ExternalLink size={12} /> Source code
          </a>
          <button className="btn h-7" onClick={() => void run(call('app:openNotices'))}>
            <FileText size={12} /> Third-party notices
          </button>
        </div>
      </section>
    </div>
  )
}
