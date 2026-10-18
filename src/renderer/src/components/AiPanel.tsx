import { Fragment, useEffect, useRef, useState } from 'react'
import { BookOpen, CircleStop, Copy, CornerDownLeft, Replace, Settings, Sparkles, Wrench, X } from 'lucide-react'
import type { AiResult, AiTask } from '@shared/ai'
import { PROVIDER_LABELS } from '@shared/ai'
import { call, newTaskId } from '../api'
import { useApp } from '../store'

interface Turn {
  id: string
  task: AiTask
  prompt: string
  text: string
  status: 'running' | 'done' | 'error'
  error?: string
  result?: AiResult
}

const TASK_LABEL: Record<AiTask, string> = { generate: 'Ask', explain: 'Explain query', fix: 'Fix error' }

/** Prose and fenced code, in order, so each code block gets its own buttons. */
function pieces(text: string): { code: boolean; body: string }[] {
  const out: { code: boolean; body: string }[] = []
  const re = /```[^\n`]*\n?([\s\S]*?)(```|$)/g
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ code: false, body: text.slice(last, m.index) })
    out.push({ code: true, body: m[1].replace(/\n$/, '') })
    last = m.index + m[0].length
    if (m[0].length === 0) break
  }
  if (last < text.length) out.push({ code: false, body: text.slice(last) })
  return out.filter((p) => p.code || p.body.trim())
}

export default function AiPanel({
  sessionId,
  seed,
  getSql,
  lastError,
  onInsert,
  onClose
}: {
  sessionId: string
  /** Text to start the prompt with, e.g. from the command palette. */
  seed: { text: string; n: number } | null
  /** The selection, or the statement at the cursor. */
  getSql: () => string
  lastError: { sql: string; message: string } | null
  onInsert: (code: string, mode: 'insert' | 'replace') => void
  onClose: () => void
}) {
  const settings = useApp((s) => s.settings)
  const setOverlay = useApp((s) => s.setOverlay)
  const [prompt, setPrompt] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const runningId = turns.find((t) => t.status === 'running')?.id ?? null

  const provider = settings?.ai.provider ?? 'anthropic'
  useEffect(() => {
    void call('ai:keyStatus').then((k) => setHasKey(k[provider]))
  }, [provider, settings])

  useEffect(() => {
    if (seed) setPrompt(seed.text)
    inputRef.current?.focus()
  }, [seed])

  // Streamed text arrives as task events tagged with the turn's id.
  useEffect(
    () =>
      window.dbEvents.onTask((e) => {
        if (e.kind !== 'delta' || !e.text) return
        setTurns((ts) => ts.map((t) => (t.id === e.taskId && t.status === 'running' ? { ...t, text: t.text + e.text } : t)))
      }),
    []
  )

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns])

  // Stop a reply that is still streaming when the panel closes.
  const runningRef = useRef(runningId)
  runningRef.current = runningId
  useEffect(() => () => void (runningRef.current && call('ai:cancel', runningRef.current)), [])

  const ask = async (task: AiTask) => {
    if (runningId) return
    const sql = task === 'fix' ? lastError?.sql ?? '' : getSql()
    if (task === 'generate' && !prompt.trim()) return
    if (task === 'explain' && !sql.trim()) return
    const id = newTaskId()
    const text = prompt.trim()
    setTurns((ts) => [...ts, { id, task, prompt: text, text: '', status: 'running' }])
    setPrompt('')
    try {
      const result = await call('ai:ask', { taskId: id, sessionId, task, prompt: text, sql, error: task === 'fix' ? lastError?.message : undefined })
      setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, text: result.text, status: 'done', result } : t)))
    } catch (err) {
      setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, status: 'error', error: (err as Error).message } : t)))
    }
  }

  const needsKey = provider !== 'compatible' && hasKey === false

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-line bg-panel text-xs" data-testid="ai-panel">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3 font-medium">
        <span className="flex items-center gap-1.5">
          <Sparkles size={13} className="text-accent" /> AI assistant
        </span>
        <div className="flex items-center gap-1">
          {turns.length > 0 && !runningId && (
            <button className="btn h-6 px-2" onClick={() => setTurns([])}>
              Clear
            </button>
          )}
          <button className="icon-btn" onClick={() => setOverlay('settings')} aria-label="AI settings" title="AI settings">
            <Settings size={13} />
          </button>
          <button className="icon-btn" onClick={onClose} aria-label="Close panel">
            <X size={13} />
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {needsKey && (
          <div className="rounded-md border border-line bg-bg p-3">
            <div className="mb-2">Add a {PROVIDER_LABELS[provider]} API key to use the assistant.</div>
            <button className="btn h-7" onClick={() => setOverlay('settings')}>
              <Settings size={12} /> Open AI settings
            </button>
          </div>
        )}
        {turns.length === 0 && !needsKey && (
          <div className="space-y-2 text-muted">
            <p>Describe the data you want and get a query back, or explain and fix the query in the editor.</p>
            <p className="text-faint">
              The schema (table and column names) goes to {PROVIDER_LABELS[provider]}
              {settings?.ai.includeSampleRows ? ', with a few sample rows' : ''}. Queries are inserted for you to review; nothing runs on its own.
            </p>
          </div>
        )}
        {turns.map((t) => (
          <div key={t.id} className="space-y-1.5">
            <div className="flex items-start gap-2">
              <span className="shrink-0 rounded bg-panel-2 px-1.5 py-px text-[10px] uppercase tracking-wide text-muted">{TASK_LABEL[t.task]}</span>
              {t.prompt && <span className="min-w-0 select-text whitespace-pre-wrap break-words">{t.prompt}</span>}
            </div>
            <div className="rounded-md border border-line bg-bg p-2.5">
              {t.status === 'running' && !t.text && <div className="animate-pulse text-muted">Thinking…</div>}
              {pieces(t.text).map((p, i) =>
                p.code ? (
                  <div key={i} className="my-2 overflow-hidden rounded border border-line">
                    <pre className="max-h-64 select-text overflow-auto bg-panel p-2 font-mono text-[11px] leading-relaxed">{p.body}</pre>
                    {t.status !== 'running' && (
                      <div className="flex gap-1 border-t border-line bg-panel px-1.5 py-1">
                        <button className="btn h-6 px-2" title="Insert at the cursor (replaces the selection)" onClick={() => onInsert(p.body, 'insert')}>
                          <CornerDownLeft size={11} /> Insert
                        </button>
                        <button className="btn h-6 px-2" title="Replace everything in the editor (Ctrl+Z to undo)" onClick={() => onInsert(p.body, 'replace')}>
                          <Replace size={11} /> Replace all
                        </button>
                        <button className="btn h-6 px-2" title="Copy" onClick={() => void navigator.clipboard.writeText(p.body)}>
                          <Copy size={11} />
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <Fragment key={i}>
                    <div className="select-text whitespace-pre-wrap break-words leading-relaxed">{p.body.trim()}</div>
                  </Fragment>
                )
              )}
              {t.status === 'error' && <div className="select-text text-danger">{t.error}</div>}
              {t.result && (
                <div className="mt-2 text-[10px] text-faint">
                  {t.result.model}
                  {t.result.usage &&
                    ` · ${t.result.usage.inputTokens.toLocaleString()} in / ${t.result.usage.outputTokens.toLocaleString()} out${
                      t.result.usage.cacheReadTokens ? ` (${t.result.usage.cacheReadTokens.toLocaleString()} cached)` : ''
                    }`}
                  {t.result.omittedTables > 0 && ` · ${t.result.omittedTables} tables left out of the schema for size`}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="shrink-0 border-t border-line p-2">
        <textarea
          ref={inputRef}
          className="field h-auto min-h-[64px] resize-none py-1.5 leading-snug"
          rows={3}
          value={prompt}
          placeholder="Ask for a query, e.g. top 10 customers by revenue this year"
          disabled={needsKey}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void ask('generate')
            }
          }}
        />
        <div className="mt-1.5 flex items-center gap-1">
          {runningId ? (
            <button className="btn h-6 px-2 text-danger" onClick={() => void call('ai:cancel', runningId)}>
              <CircleStop size={12} /> Stop
            </button>
          ) : (
            <button className="btn btn-primary h-6 px-2" disabled={needsKey || !prompt.trim()} onClick={() => void ask('generate')}>
              <Sparkles size={12} /> Ask
            </button>
          )}
          <button className="btn h-6 px-2" disabled={needsKey || Boolean(runningId)} onClick={() => void ask('explain')} title="Explain the selection or the statement at the cursor">
            <BookOpen size={12} /> Explain
          </button>
          {lastError && (
            <button className="btn h-6 px-2" disabled={needsKey || Boolean(runningId)} onClick={() => void ask('fix')} title={`Fix: ${lastError.message}`}>
              <Wrench size={12} /> Fix error
            </button>
          )}
          <span className="ml-auto text-[10px] text-faint">Enter to send</span>
        </div>
      </div>
    </aside>
  )
}
