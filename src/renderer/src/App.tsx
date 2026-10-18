import { useEffect, useState } from 'react'
import { RotateCw, X } from 'lucide-react'
import { call } from './api'
import { useUpdateState } from './components/AboutPanel'
import { useApp } from './store'
import { useShortcut } from './keymap'
import { watchSystemTheme } from './theme'
import Welcome from './components/Welcome'
import Workspace from './components/Workspace'
import CommandPalette from './components/CommandPalette'
import SettingsModal from './components/SettingsModal'
import { loadPlugins } from './plugins/host'

export default function App() {
  const session = useApp((s) => s.session)
  const error = useApp((s) => s.error)
  const overlay = useApp((s) => s.overlay)
  const notice = useApp((s) => s.notice)
  const settingsLoaded = useApp((s) => s.settings !== null)
  const setError = useApp((s) => s.setError)
  const setOverlay = useApp((s) => s.setOverlay)
  const loadConnections = useApp((s) => s.loadConnections)
  const loadSettings = useApp((s) => s.loadSettings)

  useEffect(() => {
    loadConnections().catch((err) => setError((err as Error).message))
    loadSettings().catch((err) => setError((err as Error).message))
    return watchSystemTheme(() => useApp.getState().settings?.ui)
  }, [loadConnections, loadSettings, setError])

  // Plugins start once settings say which ones are disabled.
  useEffect(() => {
    if (settingsLoaded) loadPlugins().catch((err) => setError(`Plugins: ${(err as Error).message}`))
  }, [settingsLoaded, setError])

  // Renderer errors go to the local log so "Report a problem" can include them.
  useEffect(() => {
    const onError = (e: ErrorEvent) => void call('app:logError', e.message, e.error instanceof Error ? e.error.stack : undefined).catch(() => {})
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason
      void call('app:logError', `Unhandled rejection: ${r instanceof Error ? r.message : String(r)}`, r instanceof Error ? r.stack : undefined).catch(() => {})
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  const [update] = useUpdateState()
  const [updateDismissed, setUpdateDismissed] = useState<string | null>(null)
  const settingsSection = useApp((s) => s.settingsSection)

  useShortcut('app.commandPalette', () => setOverlay(overlay === 'palette' ? null : 'palette'))
  useShortcut('app.settings', () => setOverlay('settings'))

  return (
    <div className="h-full">
      {session ? <Workspace /> : <Welcome />}
      {overlay === 'palette' && <CommandPalette onClose={() => setOverlay(null)} />}
      {overlay === 'settings' && <SettingsModal initial={settingsSection} onClose={() => useApp.setState({ overlay: null, settingsSection: 'appearance' })} />}
      {update?.status === 'ready' && updateDismissed !== update.version && (
        <div className="fixed bottom-4 left-4 z-50 flex items-center gap-3 rounded-lg border border-line bg-panel px-4 py-2.5 text-xs shadow-lg" data-testid="update-banner">
          <span>Version {update.version} is ready.</span>
          <button className="btn btn-primary h-7" onClick={() => void call('updates:install')}>
            <RotateCw size={12} /> Restart to update
          </button>
          <button className="icon-btn" onClick={() => setUpdateDismissed(update.version ?? '')} aria-label="Later">
            <X size={13} />
          </button>
        </div>
      )}
      {notice && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 select-text rounded-lg border border-line bg-panel px-4 py-2.5 text-xs shadow-lg">{notice}</div>
      )}
      {error && (
        <div className="fixed bottom-4 right-4 z-50 flex max-w-md items-start gap-3 rounded-lg border border-line bg-panel px-4 py-3 shadow-lg">
          <div className="min-w-0 flex-1 select-text break-words text-danger">{error}</div>
          <button className="icon-btn shrink-0" onClick={() => setError(null)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
