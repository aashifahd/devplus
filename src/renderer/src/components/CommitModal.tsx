import { useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import type { ConnectionConfig } from '@shared/types'
import Modal from './Modal'

/** Shows the exact SQL a commit will run. In confirm mode this is the only way to commit. */
export default function CommitModal({
  statements,
  connection,
  onClose,
  onCommit,
  verb = 'Commit'
}: {
  statements: string[]
  connection: ConnectionConfig
  onClose: () => void
  onCommit: () => Promise<void>
  /** "Commit" for grid edits, "Run" for query editor scripts, "Apply" for schema and admin changes. */
  verb?: 'Commit' | 'Run' | 'Apply'
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const production = connection.tag === 'production'

  const commit = async () => {
    setBusy(true)
    setError(null)
    try {
      await onCommit()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal
      title={
        verb === 'Commit'
          ? `Review ${statements.length} change${statements.length === 1 ? '' : 's'}`
          : verb === 'Run'
            ? `Run ${statements.length} statement${statements.length === 1 ? '' : 's'} that change data?`
            : `Apply ${statements.length} statement${statements.length === 1 ? '' : 's'}?`
      }
      width={760}
      onClose={onClose}
      footer={
        <>
          <div className="min-w-0 flex-1 select-text text-xs text-danger">{error}</div>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            style={production ? { background: 'var(--danger)', borderColor: 'var(--danger)' } : undefined}
            disabled={busy || statements.length === 0}
            onClick={commit}
            autoFocus
          >
            {busy ? `${{ Commit: 'Committing', Run: 'Running', Apply: 'Applying' }[verb]}…` : production ? `${verb} on ${connection.name}` : verb}
          </button>
        </>
      }
    >
      {production && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          <ShieldAlert size={14} /> This is a production connection.
          {verb === 'Run' ? ' Each statement below commits on its own.' : ' The statements below run in one transaction where the engine allows.'}
        </div>
      )}
      <pre className="max-h-[50vh] select-text overflow-auto rounded-md border border-line bg-panel p-3 font-mono text-xs leading-relaxed">
        {statements.map((s) => `${s};`).join('\n')}
      </pre>
    </Modal>
  )
}
