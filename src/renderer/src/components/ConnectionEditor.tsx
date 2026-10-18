import { useEffect, useState, type ReactNode } from 'react'
import { CheckCircle2, FolderOpen, XCircle } from 'lucide-react'
import { nanoid } from 'nanoid'
import { effectiveSafeMode, type ConnectionConfig, type ConnectionDraft, type Engine, type EnvTag, type SafeMode, type SslMode } from '@shared/types'
import { call } from '../api'
import { TAG_COLORS } from '../store'
import { ENGINE_ORDER, ENGINES } from '@shared/engines'
import Modal from './Modal'

const SWATCHES = ['#2f6fed', '#1f9d55', '#7c5cff', '#e08a12', '#d93a3a', '#0ea5a4', '#db2777', '#64748b']

function blank(engine: Engine): ConnectionDraft {
  return {
    id: nanoid(),
    name: '',
    engine,
    group: '',
    color: SWATCHES[0],
    tag: 'local',
    // Cloud engines take an account or endpoint rather than a local host.
    host: ENGINES[engine].fields.host && ENGINES[engine].fields.port ? '127.0.0.1' : '',
    port: ENGINES[engine].defaultPort,
    user: ENGINES[engine].defaultUser,
    database: '',
    filePath: '',
    ssl: { mode: 'prefer' },
    ssh: { enabled: false, host: '', port: 22, user: '', authMethod: 'key', privateKeyPath: '' },
    savePassword: true,
    safeMode: 'off',
    options: {},
    secrets: {}
  }
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid grid-cols-[110px_1fr] items-center gap-3">
      <span className="text-right text-xs text-muted">{label}</span>
      <div className="flex min-w-0 items-center gap-2">{children}</div>
    </label>
  )
}

function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="space-y-2.5 border-t border-line pt-4 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-faint">{title}</div>
        {right}
      </div>
      {children}
    </div>
  )
}

export default function ConnectionEditor({
  initial,
  onClose,
  onSaved
}: {
  initial: ConnectionConfig | null
  onClose: () => void
  onSaved: (saved: ConnectionConfig, connectNow: boolean) => void
}) {
  const [d, setD] = useState<ConnectionDraft>(() =>
    initial ? { ...initial, safeMode: effectiveSafeMode(initial), secrets: {} } : blank('postgres')
  )
  const [hasSavedPassword, setHasSavedPassword] = useState(false)
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (initial) call('connections:secrets', initial.id).then((s) => setHasSavedPassword(s.hasPassword))
  }, [initial])

  const patch = (p: Partial<ConnectionDraft>) => {
    setD((prev) => ({ ...prev, ...p }))
    setTest(null)
  }
  const patchSsh = (p: Partial<ConnectionDraft['ssh']>) => patch({ ssh: { ...d.ssh, ...p } })
  const patchSecrets = (p: Partial<ConnectionDraft['secrets']>) => patch({ secrets: { ...d.secrets, ...p } })

  const switchEngine = (engine: Engine) => {
    const fresh = blank(engine)
    const keepUser = d.user && d.user !== ENGINES[d.engine].defaultUser
    const keepHost = Boolean(ENGINES[engine].fields.port) === Boolean(ENGINES[d.engine].fields.port) && d.host
    patch({ engine, port: fresh.port, host: keepHost ? d.host : fresh.host, user: keepUser ? d.user : fresh.user, options: {} })
  }
  const patchOption = (key: string, value: string) => patch({ options: { ...d.options, [key]: value } })

  const finalDraft = (): ConnectionDraft => ({
    ...d,
    name:
      d.name.trim() ||
      (info.fields.file && !info.fields.host ? d.filePath?.split(/[\\/]/).pop() || d.database || info.label : d.host || info.label),
    group: d.group?.trim() || undefined
  })

  const runTest = async () => {
    setBusy(true)
    setTest(null)
    try {
      const version = await call('connections:test', finalDraft())
      setTest({ ok: true, message: `Connected: ${version}` })
    } catch (err) {
      setTest({ ok: false, message: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const save = async (connectNow: boolean) => {
    setBusy(true)
    try {
      const saved = await call('connections:save', finalDraft())
      onSaved(saved, connectNow)
    } catch (err) {
      setTest({ ok: false, message: (err as Error).message })
      setBusy(false)
    }
  }

  const browse = async (title: string, filters?: { name: string; extensions: string[] }[]) =>
    call('dialog:openFile', { title, filters })

  const info = ENGINES[d.engine]
  const f = info.fields
  const passwordPlaceholder = hasSavedPassword ? 'Saved in keychain (leave blank to keep)' : ''

  return (
    <Modal
      title={initial ? `Edit ${initial.name}` : 'New connection'}
      width={600}
      onClose={onClose}
      footer={
        <>
          <button className="btn" disabled={busy} onClick={runTest}>
            Test
          </button>
          <div className="min-w-0 flex-1 truncate text-xs" title={test?.message}>
            {test && (
              <span className={`inline-flex items-center gap-1 ${test.ok ? 'text-ok' : 'text-danger'}`}>
                {test.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />} {test.message}
              </span>
            )}
          </div>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy} onClick={() => save(false)}>
            Save
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => save(true)}>
            Connect
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-4 gap-1.5">
          {ENGINE_ORDER.map((e) => (
            <button
              key={e}
              className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-left ${
                d.engine === e ? 'border-accent bg-accent-soft' : 'border-line hover:bg-panel'
              }`}
              onClick={() => switchEngine(e)}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-panel-2 text-[10px] font-bold">{ENGINES[e].badge}</span>
              <span className="truncate text-xs font-medium">{ENGINES[e].label}</span>
            </button>
          ))}
        </div>

        <Section title="General">
          <Row label="Name">
            <input className="field" value={d.name} placeholder="My database" onChange={(e) => patch({ name: e.target.value })} />
          </Row>
          <Row label="Color">
            {SWATCHES.map((c) => (
              <button
                key={c}
                className={`h-5 w-5 rounded-full ${d.color === c ? 'ring-2 ring-accent ring-offset-2 ring-offset-bg' : ''}`}
                style={{ background: c }}
                onClick={(e) => {
                  e.preventDefault()
                  patch({ color: c })
                }}
                aria-label={c}
              />
            ))}
          </Row>
          <Row label="Tag">
            <select
              className="field w-40"
              value={d.tag}
              onChange={(e) => {
                const tag = e.target.value as EnvTag
                // Moving a connection to production turns on confirmation unless already stricter.
                patch({ tag, safeMode: tag === 'production' && d.safeMode === 'off' ? 'confirm' : d.safeMode })
              }}
            >
              {(Object.keys(TAG_COLORS) as EnvTag[]).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <span className="h-3 w-3 rounded-full" style={{ background: TAG_COLORS[d.tag] }} />
            <input
              className="field"
              value={d.group ?? ''}
              placeholder="Group (optional)"
              onChange={(e) => patch({ group: e.target.value })}
            />
          </Row>
          <Row label="Safe mode">
            <select
              className="field w-56"
              value={d.safeMode ?? 'off'}
              onChange={(e) => patch({ safeMode: e.target.value as SafeMode })}
            >
              <option value="off">Off: commit directly</option>
              <option value="confirm">Confirm: review SQL first</option>
              <option value="readonly">Read-only: no edits</option>
            </select>
          </Row>
        </Section>

        {f.file && (
          <Section title={f.file.label}>
            <Row label="Path">
              <input
                className="field"
                value={d.filePath ?? ''}
                placeholder={f.file.allowMemory ? ':memory: for a scratch database' : ''}
                onChange={(e) => patch({ filePath: e.target.value })}
              />
              <button
                className="btn shrink-0"
                onClick={async (e) => {
                  e.preventDefault()
                  const p = await browse(f.file ? f.file.label : 'Choose file', [
                    { name: info.label, extensions: f.file ? f.file.extensions : ['*'] },
                    { name: 'All files', extensions: ['*'] }
                  ])
                  if (p) patch({ filePath: p })
                }}
              >
                <FolderOpen size={14} /> Browse
              </button>
            </Row>
          </Section>
        )}

        {(f.host || f.user || f.password || f.database || info.options.length > 0) && (
          <>
            <Section title={f.file ? 'Settings' : 'Server'}>
              {f.host && (
                <Row label={f.host}>
                  <input
                    className="field"
                    value={d.host}
                    placeholder={d.engine === 'dynamodb' ? 'Optional, e.g. http://localhost:8000' : d.engine === 'snowflake' ? 'orgname-accountname' : ''}
                    onChange={(e) => patch({ host: e.target.value })}
                  />
                  {f.port && (
                    <>
                      <span className="text-xs text-muted">Port</span>
                      <input
                        className="field w-24"
                        inputMode="numeric"
                        value={d.port || ''}
                        onChange={(e) => patch({ port: Number(e.target.value.replace(/\D/g, '')) || 0 })}
                      />
                    </>
                  )}
                </Row>
              )}
              {f.user && (
                <Row label={f.user}>
                  <input className="field" value={d.user} onChange={(e) => patch({ user: e.target.value })} />
                </Row>
              )}
              {f.password && (
                <Row label={f.password}>
                  <input
                    className="field"
                    type="password"
                    value={d.secrets.password ?? ''}
                    placeholder={passwordPlaceholder}
                    onChange={(e) => patchSecrets({ password: e.target.value })}
                  />
                  <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted">
                    <input type="checkbox" checked={d.savePassword} onChange={(e) => patch({ savePassword: e.target.checked })} />
                    Save
                  </label>
                </Row>
              )}
              {f.database && (
                <Row label={f.database}>
                  <input
                    className="field"
                    value={d.database}
                    placeholder={d.engine === 'postgres' ? 'postgres' : d.engine === 'redis' ? '0' : d.engine === 'bigquery' ? 'my-project' : 'Optional'}
                    onChange={(e) => patch({ database: e.target.value })}
                  />
                </Row>
              )}
              {info.options.map((o) => (
                <Row key={o.key} label={o.label}>
                  {o.kind === 'select' ? (
                    <select className="field w-40" value={d.options?.[o.key] ?? o.choices?.[0] ?? ''} onChange={(e) => patchOption(o.key, e.target.value)}>
                      {o.choices?.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  ) : (
                    <input className="field" value={d.options?.[o.key] ?? ''} placeholder={o.placeholder} onChange={(e) => patchOption(o.key, e.target.value)} />
                  )}
                </Row>
              ))}
            </Section>
          </>
        )}

        {f.ssl && (
          <>
            <Section title="SSL / TLS">
              <Row label="Mode">
                <select
                  className="field w-40"
                  value={d.ssl.mode}
                  onChange={(e) => patch({ ssl: { ...d.ssl, mode: e.target.value as SslMode } })}
                >
                  <option value="disable">Disable</option>
                  <option value="prefer">Prefer</option>
                  <option value="require">Require</option>
                  <option value="verify-full">Verify full</option>
                </select>
              </Row>
              {d.ssl.mode === 'verify-full' && (
                <Row label="CA certificate">
                  <input
                    className="field"
                    value={d.ssl.caPath ?? ''}
                    placeholder="System trust store"
                    onChange={(e) => patch({ ssl: { ...d.ssl, caPath: e.target.value } })}
                  />
                  <button
                    className="btn shrink-0"
                    onClick={async (e) => {
                      e.preventDefault()
                      const p = await browse('Choose CA certificate')
                      if (p) patch({ ssl: { ...d.ssl, caPath: p } })
                    }}
                  >
                    <FolderOpen size={14} />
                  </button>
                </Row>
              )}
            </Section>

            <Section
              title="SSH tunnel"
              right={
                <label className="flex items-center gap-1.5 text-xs text-muted">
                  <input type="checkbox" checked={d.ssh.enabled} onChange={(e) => patchSsh({ enabled: e.target.checked })} />
                  Use SSH
                </label>
              }
            >
              {d.ssh.enabled && (
                <>
                  <Row label="SSH host">
                    <input className="field" value={d.ssh.host} onChange={(e) => patchSsh({ host: e.target.value })} />
                    <span className="text-xs text-muted">Port</span>
                    <input
                      className="field w-24"
                      inputMode="numeric"
                      value={d.ssh.port || ''}
                      onChange={(e) => patchSsh({ port: Number(e.target.value.replace(/\D/g, '')) || 0 })}
                    />
                  </Row>
                  <Row label="SSH user">
                    <input className="field" value={d.ssh.user} onChange={(e) => patchSsh({ user: e.target.value })} />
                  </Row>
                  <Row label="Auth">
                    <select
                      className="field w-40"
                      value={d.ssh.authMethod}
                      onChange={(e) => patchSsh({ authMethod: e.target.value as ConnectionDraft['ssh']['authMethod'] })}
                    >
                      <option value="key">Private key</option>
                      <option value="password">Password</option>
                      <option value="agent">SSH agent</option>
                    </select>
                  </Row>
                  {d.ssh.authMethod === 'password' && (
                    <Row label="SSH password">
                      <input
                        className="field"
                        type="password"
                        value={d.secrets.sshPassword ?? ''}
                        placeholder={initial ? 'Leave blank to keep saved' : ''}
                        onChange={(e) => patchSecrets({ sshPassword: e.target.value })}
                      />
                    </Row>
                  )}
                  {d.ssh.authMethod === 'key' && (
                    <>
                      <Row label="Private key">
                        <input
                          className="field"
                          value={d.ssh.privateKeyPath ?? ''}
                          placeholder="C:\Users\you\.ssh\id_ed25519"
                          onChange={(e) => patchSsh({ privateKeyPath: e.target.value })}
                        />
                        <button
                          className="btn shrink-0"
                          onClick={async (e) => {
                            e.preventDefault()
                            const p = await browse('Choose private key')
                            if (p) patchSsh({ privateKeyPath: p })
                          }}
                        >
                          <FolderOpen size={14} />
                        </button>
                      </Row>
                      <Row label="Passphrase">
                        <input
                          className="field"
                          type="password"
                          value={d.secrets.sshPassphrase ?? ''}
                          placeholder="Optional"
                          onChange={(e) => patchSecrets({ sshPassphrase: e.target.value })}
                        />
                      </Row>
                    </>
                  )}
                  <div className="pl-[122px] text-xs text-faint">
                    The database host above is resolved from the SSH server (often 127.0.0.1).
                  </div>
                </>
              )}
            </Section>
          </>
        )}
      </div>
    </Modal>
  )
}
