import { useState } from 'react'
import type { ConnectionConfig, ConnectionSecrets } from '@shared/types'
import Modal from './Modal'
import { ENGINES } from '@shared/engines'

export default function PasswordPrompt({
  connection,
  onClose,
  onSubmit
}: {
  connection: ConnectionConfig
  onClose: () => void
  onSubmit: (secrets: ConnectionSecrets) => Promise<void>
}) {
  const [password, setPassword] = useState('')
  const [sshPassword, setSshPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const needsSsh = connection.ssh.enabled && connection.ssh.authMethod === 'password'

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await onSubmit({ password, sshPassword: needsSsh ? sshPassword : undefined })
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`Connect to ${connection.name}`}
      width={380}
      onClose={onClose}
      footer={
        <>
          <div className="flex-1" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label className="block">
          <div className="mb-1 text-xs text-muted">
            {ENGINES[connection.engine].fields.password || 'Password'}
            {connection.user ? ` for ${connection.user}` : ''}
          </div>
          <input className="field" type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {needsSsh && (
          <label className="block">
            <div className="mb-1 text-xs text-muted">SSH password for {connection.ssh.user}</div>
            <input className="field" type="password" value={sshPassword} onChange={(e) => setSshPassword(e.target.value)} />
          </label>
        )}
        {error && <div className="select-text text-xs text-danger">{error}</div>}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
