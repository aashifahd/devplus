import { useEffect, useState } from 'react'
import { Check, KeyRound, Loader2 } from 'lucide-react'
import { DEFAULT_MODELS, type AiProvider } from '@shared/settings'
import { MODEL_SUGGESTIONS, PROVIDER_LABELS } from '@shared/ai'
import { call } from '../api'
import { useApp } from '../store'

export default function AiSettingsPanel() {
  const { settings, updateSettings } = useApp()
  const [keys, setKeys] = useState<Record<AiProvider, boolean> | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [test, setTest] = useState<{ running: boolean; ok?: boolean; message?: string }>({ running: false })

  useEffect(() => {
    void call('ai:keyStatus').then(setKeys)
  }, [])

  if (!settings) return null
  const ai = settings.ai
  const hasKey = keys?.[ai.provider] ?? false
  const needsKey = ai.provider !== 'compatible'

  const setProvider = (provider: AiProvider) => {
    setKeyDraft('')
    setTest({ running: false })
    void updateSettings({ ai: { provider, model: DEFAULT_MODELS[provider] } })
  }

  const saveKey = async (value: string | null) => {
    await call('ai:setKey', ai.provider, value)
    setKeyDraft('')
    setKeys(await call('ai:keyStatus'))
    setTest({ running: false })
  }

  const runTest = async () => {
    setTest({ running: true })
    try {
      const message = await call('ai:test', { provider: ai.provider, model: ai.model, baseUrl: ai.baseUrl })
      setTest({ running: false, ok: true, message })
    } catch (err) {
      setTest({ running: false, ok: false, message: (err as Error).message })
    }
  }

  return (
    <div className="space-y-4 text-xs">
      <div className="text-muted">
        Text to SQL, query explanations and error fixes in the query editor. Bring your own key: requests go straight from this computer to the provider
        you choose. Answers are inserted into the editor for you to review; nothing runs on its own.
      </div>

      <div className="grid grid-cols-[150px_1fr] items-center gap-x-4 gap-y-3">
        <span>Provider</span>
        <select className="field h-7" value={ai.provider} onChange={(e) => setProvider(e.target.value as AiProvider)}>
          {(Object.keys(PROVIDER_LABELS) as AiProvider[]).map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABELS[p]}
            </option>
          ))}
        </select>

        <span>Model</span>
        <div>
          <input
            className="field h-7 w-full font-mono"
            list="ai-models"
            value={ai.model}
            spellCheck={false}
            onChange={(e) => void updateSettings({ ai: { model: e.target.value } })}
          />
          <datalist id="ai-models">
            {MODEL_SUGGESTIONS[ai.provider].map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>

        {ai.provider === 'compatible' && (
          <>
            <span>Server address</span>
            <input
              className="field h-7 font-mono"
              value={ai.baseUrl}
              spellCheck={false}
              placeholder="http://localhost:11434/v1"
              onChange={(e) => void updateSettings({ ai: { baseUrl: e.target.value } })}
            />
          </>
        )}

        <span>
          API key
          {!needsKey && <span className="block text-[11px] text-faint">Optional for local servers</span>}
        </span>
        <div className="flex items-center gap-2">
          <input
            className="field h-7 min-w-0 flex-1 font-mono"
            type="password"
            value={keyDraft}
            placeholder={hasKey ? 'Saved. Type a new key to replace it.' : 'Paste your key'}
            onChange={(e) => setKeyDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && keyDraft.trim() && void saveKey(keyDraft.trim())}
          />
          <button className="btn h-7" disabled={!keyDraft.trim()} onClick={() => void saveKey(keyDraft.trim())}>
            <KeyRound size={12} /> Save
          </button>
          {hasKey && (
            <button className="btn h-7" onClick={() => void saveKey(null)}>
              Remove
            </button>
          )}
        </div>

        <span />
        <div className="flex items-center gap-2">
          <button className="btn h-7" disabled={test.running || (needsKey && !hasKey)} onClick={() => void runTest()}>
            {test.running ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Test connection
          </button>
          {test.message && <span className={`min-w-0 select-text ${test.ok ? 'text-ok' : 'text-danger'}`}>{test.message}</span>}
        </div>
      </div>

      <div className="rounded-md border border-line p-3">
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-0.5" checked={ai.includeSampleRows} onChange={(e) => void updateSettings({ ai: { includeSampleRows: e.target.checked } })} />
          <span>
            Send a few sample rows with the schema
            <span className="block text-[11px] text-faint">
              Off by default: only table names, column names and types are sent. Sample rows help with value formats, but they are real data from your
              database.
            </span>
          </span>
        </label>
      </div>
      <div className="text-[11px] text-faint">Keys are encrypted with your operating system's keychain and never leave this computer except in requests to the provider.</div>
    </div>
  )
}
