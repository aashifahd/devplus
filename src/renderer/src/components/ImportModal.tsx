import { useEffect, useState } from 'react'
import { FolderOpen, Loader2 } from 'lucide-react'
import type { ImportCandidate } from '@shared/types'
import { ENGINES } from '@shared/engines'
import { call } from '../api'
import { useApp } from '../store'
import Modal from './Modal'

function target(c: ImportCandidate): string {
  const k = c.config
  if (!k) return ''
  if (k.filePath) return k.filePath
  return `${k.user ? `${k.user}@` : ''}${k.host}${k.port ? `:${k.port}` : ''}${k.database ? `/${k.database}` : ''}`
}

export default function ImportModal({ onClose }: { onClose: () => void }) {
  const loadConnections = useApp((s) => s.loadConnections)
  const setNotice = useApp((s) => s.setNotice)
  const [file, setFile] = useState<string | null | undefined>(undefined)
  const [items, setItems] = useState<ImportCandidate[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const read = async (path: string) => {
    setError(null)
    setFile(path)
    try {
      const list = await call('import:tableplusRead', path)
      setItems(list)
      // New, supported connections start ticked; look-alikes of existing ones don't.
      setPicked(new Set(list.filter((c) => c.config && !c.duplicateOf).map((c) => c.key)))
    } catch (err) {
      setItems(null)
      setError((err as Error).message)
    }
  }

  useEffect(() => {
    void call('import:tableplusFind').then((p) => (p ? void read(p) : setFile(null)))
  }, [])

  const choose = async () => {
    const p = await call('dialog:openFile', { title: 'TablePlus connections file', filters: [{ name: 'Property list', extensions: ['plist', 'json'] }] })
    if (p) await read(p)
  }

  const save = async () => {
    if (!items) return
    setSaving(true)
    try {
      const configs = items.filter((c) => c.config && picked.has(c.key)).map((c) => c.config!)
      const n = await call('import:save', configs)
      await loadConnections()
      setNotice(`Imported ${n} connection${n === 1 ? '' : 's'}. You'll be asked for passwords when you first connect.`)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const toggle = (key: string) => setPicked((s) => (s.has(key) ? new Set([...s].filter((k) => k !== key)) : new Set(s).add(key)))
  const count = items?.filter((c) => c.config && picked.has(c.key)).length ?? 0

  return (
    <Modal
      title="Import connections from TablePlus"
      width={720}
      onClose={onClose}
      footer={
        <>
          <div className="min-w-0 flex-1 truncate text-xs text-danger">{error}</div>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={count === 0 || saving} onClick={() => void save()}>
            {saving ? 'Importing…' : `Import ${count || ''}`.trim()}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-xs" data-testid="import-modal">
        <div className="text-muted">
          Hosts, users, databases, SSH settings, groups and colors are copied. Passwords are not: TablePlus keeps them in its own secure storage, and this app
          never reads it. You'll type each password once, on first connect.
        </div>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate rounded-md border border-line bg-panel px-2 py-1.5 font-mono text-[11px] text-muted" title={file ?? ''}>
            {file === undefined ? 'Looking for TablePlus…' : file ?? 'TablePlus connections not found on this computer.'}
          </div>
          <button className="btn h-7 shrink-0" onClick={() => void choose()}>
            <FolderOpen size={12} /> Choose file…
          </button>
        </div>

        {file === undefined && <Loader2 size={14} className="animate-spin text-muted" />}
        {items && items.length === 0 && <div className="text-muted">No connections in this file.</div>}
        {items && items.length > 0 && (
          <div className="max-h-80 divide-y divide-line overflow-y-auto rounded-md border border-line">
            {items.map((c) => (
              <label key={c.key} className={`flex items-start gap-3 px-3 py-2 ${c.config ? 'cursor-pointer hover:bg-panel' : 'opacity-60'}`}>
                <input type="checkbox" className="mt-0.5" disabled={!c.config} checked={picked.has(c.key)} onChange={() => toggle(c.key)} />
                <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: c.config?.color ?? 'var(--faint)' }} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-medium">{c.name}</span>
                    <span className="shrink-0 text-[11px] text-faint">{c.engine ? ENGINES[c.engine].label : c.driver}</span>
                    {c.config && c.config.tag !== 'local' && <span className="shrink-0 rounded bg-panel-2 px-1 text-[10px] uppercase text-muted">{c.config.tag}</span>}
                  </span>
                  <span className="block truncate font-mono text-[11px] text-muted">{target(c)}</span>
                  {(c.notes.length > 0 || c.duplicateOf) && (
                    <span className="block text-[11px] text-faint">{[...(c.duplicateOf ? ['already in your list'] : []), ...c.notes].join(' · ')}</span>
                  )}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
