import { useEffect, useState, type ReactNode } from 'react'
import { FolderOpen, Plus, RefreshCw } from 'lucide-react'
import { ACTIONS, keyFor, type ActionId, type ThemeMode } from '@shared/settings'
import { call } from '../api'
import { useApp } from '../store'
import { comboFromEvent, comboText, displayCombo } from '../keymap'
import { ACCENTS } from '../theme'
import { loadPlugins, usePlugins } from '../plugins/host'
import Modal from './Modal'
import AiSettingsPanel from './AiSettingsPanel'
import AboutPanel from './AboutPanel'

export type Section = 'appearance' | 'keyboard' | 'ai' | 'plugins' | 'about'

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[150px_1fr] items-center gap-4 py-2">
      <div>
        <div className="text-xs">{label}</div>
        {hint && <div className="text-[11px] text-faint">{hint}</div>}
      </div>
      <div className="flex min-w-0 items-center gap-2">{children}</div>
    </div>
  )
}

function Appearance() {
  const { settings, updateSettings } = useApp()
  if (!settings) return null
  const ui = settings.ui
  return (
    <div className="divide-y divide-line">
      <Row label="Theme">
        {(['system', 'light', 'dark'] as ThemeMode[]).map((t) => (
          <button key={t} className={`btn h-7 capitalize ${ui.theme === t ? 'border-accent text-accent' : ''}`} onClick={() => void updateSettings({ ui: { theme: t } })}>
            {t}
          </button>
        ))}
      </Row>
      <Row label="Accent color">
        {ACCENTS.map((c) => (
          <button
            key={c}
            aria-label={c}
            className={`h-6 w-6 rounded-full ${ui.accent === c ? 'ring-2 ring-fg ring-offset-2 ring-offset-bg' : ''}`}
            style={{ background: c }}
            onClick={() => void updateSettings({ ui: { accent: c } })}
          />
        ))}
        <input type="color" className="h-7 w-10 cursor-pointer rounded border border-line bg-bg" value={ui.accent} onChange={(e) => void updateSettings({ ui: { accent: e.target.value } })} />
      </Row>
      <Row label="Editor font size">
        <input type="range" min={10} max={22} value={ui.editorFontSize} onChange={(e) => void updateSettings({ ui: { editorFontSize: Number(e.target.value) } })} />
        <span className="w-10 text-xs tabular-nums text-muted">{ui.editorFontSize}px</span>
      </Row>
      <Row label="Grid font size">
        <input type="range" min={10} max={18} value={ui.gridFontSize} onChange={(e) => void updateSettings({ ui: { gridFontSize: Number(e.target.value) } })} />
        <span className="w-10 text-xs tabular-nums text-muted">{ui.gridFontSize}px</span>
      </Row>
      <Row label="Row density">
        {(['compact', 'regular', 'comfortable'] as const).map((d) => (
          <button key={d} className={`btn h-7 capitalize ${ui.density === d ? 'border-accent text-accent' : ''}`} onClick={() => void updateSettings({ ui: { density: d } })}>
            {d}
          </button>
        ))}
      </Row>
    </div>
  )
}

function Keyboard() {
  const { settings, updateSettings } = useApp()
  const [capturing, setCapturing] = useState<ActionId | null>(null)

  useEffect(() => {
    if (!capturing) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setCapturing(null)
        return
      }
      const combo = comboFromEvent(e)
      if (!combo) return
      void updateSettings({ keymap: { [capturing]: comboText(combo) } })
      setCapturing(null)
    }
    // Capture phase, so no other shortcut handler fires while recording.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing, updateSettings])

  if (!settings) return null
  const scopeLabel = { global: 'Everywhere', editor: 'Query editor', table: 'Table' }
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs text-muted">
        Click a shortcut, then press the new keys (Esc cancels).
        <button className="btn h-7" onClick={() => void updateSettings({ keymap: Object.fromEntries(ACTIONS.map((a) => [a.id, a.defaultKey])) })}>
          Reset all
        </button>
      </div>
      <div className="divide-y divide-line rounded-md border border-line">
        {ACTIONS.map((a) => {
          const key = keyFor(settings, a.id)
          // Same keys in the same scope (or with a global action) would fight each other.
          const clash = ACTIONS.find((b) => b.id !== a.id && keyFor(settings, b.id).toLowerCase() === key.toLowerCase() && (b.scope === a.scope || b.scope === 'global' || a.scope === 'global'))
          return (
            <div key={a.id} className="flex items-center gap-3 px-3 py-1.5 text-xs">
              <span className="min-w-0 flex-1">{a.label}</span>
              <span className="w-24 text-[11px] text-faint">{scopeLabel[a.scope]}</span>
              {clash && <span className="text-[11px] text-danger">Also: {clash.label}</span>}
              <button className={`btn h-7 w-36 justify-center font-mono text-[11px] ${capturing === a.id ? 'border-accent text-accent' : ''}`} onClick={() => setCapturing(a.id)}>
                {capturing === a.id ? 'Press keys…' : displayCombo(key)}
              </button>
              <button className="btn h-7 px-2" disabled={key === a.defaultKey} onClick={() => void updateSettings({ keymap: { [a.id]: a.defaultKey } })}>
                Reset
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Plugins() {
  const { settings, updateSettings, setError } = useApp()
  const plugins = usePlugins((s) => s.plugins)
  if (!settings) return null
  const disabled = new Set(settings.plugins.disabled)

  const toggle = async (id: string) => {
    const next = disabled.has(id) ? [...disabled].filter((x) => x !== id) : [...disabled, id]
    await updateSettings({ plugins: { disabled: next } })
    await loadPlugins()
  }

  return (
    <div className="space-y-3 text-xs">
      <div className="text-muted">
        Plugins are .js files in the plugins folder. Each runs in its own sandboxed worker with no file, network or Node access, and talks to the app
        through <code className="font-mono">devplus</code>: commands for the palette, cell formatters and exporters.
      </div>
      <div className="flex gap-2">
        <button className="btn h-7" onClick={() => void call('plugins:openFolder')}>
          <FolderOpen size={12} /> Open plugins folder
        </button>
        <button className="btn h-7" onClick={() => void call('plugins:createExample').then(loadPlugins).catch((e) => setError((e as Error).message))}>
          <Plus size={12} /> Add example plugin
        </button>
        <button className="btn h-7" onClick={() => void loadPlugins()}>
          <RefreshCw size={12} /> Reload
        </button>
      </div>
      {plugins.length === 0 ? (
        <div className="rounded-md border border-dashed border-line p-6 text-center text-muted">No plugins installed.</div>
      ) : (
        <div className="divide-y divide-line rounded-md border border-line">
          {plugins.map((p) => (
            <div key={p.id} className="flex items-start gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{p.id}</span>
                  <span
                    className={`rounded px-1.5 py-px text-[10px] ${
                      p.status === 'ready' ? 'bg-ok/15 text-ok' : p.status === 'error' ? 'bg-danger/15 text-danger' : 'bg-panel-2 text-muted'
                    }`}
                  >
                    {p.status}
                  </span>
                </div>
                <div className="truncate text-[11px] text-faint" title={p.file}>
                  {p.file}
                </div>
                {p.error && <div className="mt-1 line-clamp-3 select-text whitespace-pre-wrap font-mono text-[11px] text-danger">{p.error}</div>}
                {p.status === 'ready' && (
                  <div className="mt-1 text-[11px] text-muted">
                    {[
                      p.commands.length && `${p.commands.length} command${p.commands.length > 1 ? 's' : ''}`,
                      p.formatters.length && `${p.formatters.length} formatter${p.formatters.length > 1 ? 's' : ''}`,
                      p.exporters.length && `${p.exporters.length} exporter${p.exporters.length > 1 ? 's' : ''}`
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'Registered nothing'}
                  </div>
                )}
              </div>
              <label className="flex shrink-0 items-center gap-1.5 text-muted">
                <input type="checkbox" checked={!disabled.has(p.id)} onChange={() => void toggle(p.id)} /> Enabled
              </label>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function SettingsModal({ onClose, initial = 'appearance' }: { onClose: () => void; initial?: Section }) {
  const [section, setSection] = useState<Section>(initial)
  const sections: [Section, string][] = [
    ['appearance', 'Appearance'],
    ['keyboard', 'Keyboard'],
    ['ai', 'AI assistant'],
    ['plugins', 'Plugins'],
    ['about', 'About']
  ]
  return (
    <Modal title="Settings" width={760} onClose={onClose}>
      <div className="flex min-h-[420px] gap-5">
        <nav className="w-36 shrink-0 space-y-0.5 text-xs">
          {sections.map(([id, label]) => (
            <button key={id} className={`block w-full rounded-md px-3 py-1.5 text-left ${section === id ? 'bg-accent text-white' : 'hover:bg-panel'}`} onClick={() => setSection(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          {section === 'appearance' && <Appearance />}
          {section === 'keyboard' && <Keyboard />}
          {section === 'ai' && <AiSettingsPanel />}
          {section === 'plugins' && <Plugins />}
          {section === 'about' && <AboutPanel />}
        </div>
      </div>
    </Modal>
  )
}
