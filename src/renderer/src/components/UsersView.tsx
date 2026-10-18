import { useCallback, useEffect, useState } from 'react'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { AdminAction, UserInfo } from '@shared/types'
import { call } from '../api'
import { useApp } from '../store'
import CommitModal from './CommitModal'
import Modal from './Modal'

export default function UsersView({ sessionId }: { sessionId: string }) {
  const connection = useApp((s) => s.connection)
  const [users, setUsers] = useState<UserInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [review, setReview] = useState<{ statements: string[]; action: AdminAction } | null>(null)
  const mysql = connection?.engine === 'mysql'

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setUsers(await call('admin:users', sessionId))
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    void load()
  }, [load])

  const ask = async (action: AdminAction) => {
    try {
      setReview({ statements: await call('admin:preview', sessionId, action), action })
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <span className="font-medium">{mysql ? 'Users' : 'Roles'}</span>
        <span className="text-faint">{users.length}</span>
        <div className="flex-1" />
        <button className="icon-btn" title="Refresh" onClick={() => void load()}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
        <button className="btn btn-primary h-7" onClick={() => setCreating(true)}>
          <Plus size={12} /> New {mysql ? 'user' : 'role'}
        </button>
      </div>
      {error && <div className="select-text border-b border-line px-3 py-2 text-danger">{error}</div>}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-panel text-left text-[11px] text-faint">
            <tr>
              <th className="border-b border-line px-3 py-1.5">Name</th>
              {mysql && <th className="border-b border-line px-3 py-1.5">Host</th>}
              <th className="border-b border-line px-3 py-1.5">Attributes</th>
              <th className="border-b border-line px-3 py-1.5">Member of</th>
              <th className="w-10 border-b border-line" />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={`${u.name}@${u.host ?? ''}`} className="group hover:bg-panel">
                <td className="border-b border-line px-3 py-1.5 font-mono">{u.name}</td>
                {mysql && <td className="border-b border-line px-3 py-1.5 font-mono text-muted">{u.host}</td>}
                <td className="border-b border-line px-3 py-1.5">
                  <div className="flex flex-wrap gap-1">
                    {u.attributes.map((a) => (
                      <span key={a} className={`rounded px-1.5 py-px ${a === 'superuser' ? 'bg-danger/15 text-danger' : 'bg-panel-2 text-muted'}`}>
                        {a}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="border-b border-line px-3 py-1.5 text-muted">{u.memberOf.join(', ')}</td>
                <td className="border-b border-line px-2 py-1.5 text-right">
                  <button
                    className="icon-btn invisible group-hover:visible"
                    title={`Drop ${u.name}`}
                    onClick={() => void ask({ kind: 'dropUser', name: u.name, host: u.host ?? undefined })}
                  >
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {creating && (
        <CreateUserModal
          mysql={mysql}
          onClose={() => setCreating(false)}
          onSubmit={async (action) => {
            setCreating(false)
            await ask(action)
          }}
        />
      )}

      {review && connection && (
        <CommitModal
          verb="Apply"
          statements={review.statements}
          connection={connection}
          onClose={() => setReview(null)}
          onCommit={async () => {
            await call('admin:apply', sessionId, review.action)
            setReview(null)
            await load()
          }}
        />
      )}
    </div>
  )
}

function CreateUserModal({
  mysql,
  onClose,
  onSubmit
}: {
  mysql: boolean
  onClose: () => void
  onSubmit: (action: AdminAction) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [host, setHost] = useState('%')
  const [login, setLogin] = useState(true)
  const [superuser, setSuperuser] = useState(false)
  const [createDb, setCreateDb] = useState(false)
  const [createRole, setCreateRole] = useState(false)

  const submit = () =>
    onSubmit({ kind: 'createUser', name: name.trim(), password, host: mysql ? host : undefined, login, superuser, createDb, createRole })

  const check = (label: string, value: boolean, set: (v: boolean) => void) => (
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={value} onChange={(e) => set(e.target.checked)} /> {label}
    </label>
  )

  return (
    <Modal
      title={mysql ? 'New user' : 'New role'}
      width={420}
      onClose={onClose}
      footer={
        <>
          <div className="flex-1 text-xs text-faint">The SQL is shown before anything runs.</div>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!name.trim()} onClick={() => void submit()}>
            Review
          </button>
        </>
      }
    >
      <div className="space-y-3 text-xs">
        <label className="block">
          <div className="mb-1 text-muted">Name</div>
          <input className="field font-mono" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {mysql && (
          <label className="block">
            <div className="mb-1 text-muted">Host (% means any)</div>
            <input className="field font-mono" value={host} onChange={(e) => setHost(e.target.value)} />
          </label>
        )}
        <label className="block">
          <div className="mb-1 text-muted">Password</div>
          <input className="field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {!mysql && (
          <div className="grid grid-cols-2 gap-2 pt-1">
            {check('Can log in', login, setLogin)}
            {check('Superuser', superuser, setSuperuser)}
            {check('Create databases', createDb, setCreateDb)}
            {check('Create roles', createRole, setCreateRole)}
          </div>
        )}
      </div>
    </Modal>
  )
}
