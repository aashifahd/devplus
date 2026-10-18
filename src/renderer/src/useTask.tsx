import { useCallback, useEffect, useRef, useState } from 'react'
import { newTaskId } from './api'

export interface TaskState {
  running: boolean
  done: number
  total: number | null
  log: string[]
  error: string | null
  /** Message shown after a successful run. */
  result: string | null
}

const idle: TaskState = { running: false, done: 0, total: null, log: [], error: null, result: null }
const LOG_LIMIT = 400

/**
 * Track one long main-process task: progress and log lines arrive as events tagged
 * with the task id this hook hands to `run`.
 */
export function useTask() {
  const [state, setState] = useState<TaskState>(idle)
  const taskId = useRef<string | null>(null)

  useEffect(
    () =>
      window.dbEvents.onTask((e) => {
        if (e.taskId !== taskId.current) return
        setState((s) =>
          e.kind === 'progress'
            ? { ...s, done: e.done ?? s.done, total: e.total ?? s.total }
            : { ...s, log: [...s.log, e.line ?? ''].slice(-LOG_LIMIT) }
        )
      }),
    []
  )

  const run = useCallback(async (work: (taskId: string) => Promise<string>) => {
    const id = newTaskId()
    taskId.current = id
    setState({ ...idle, running: true })
    try {
      const result = await work(id)
      setState((s) => ({ ...s, running: false, result }))
      return true
    } catch (err) {
      setState((s) => ({ ...s, running: false, error: (err as Error).message }))
      return false
    }
  }, [])

  const reset = useCallback(() => setState(idle), [])

  return { ...state, run, reset }
}

export function ProgressBar({ done, total }: { done: number; total: number | null }) {
  const pct = total ? Math.min(100, (done / total) * 100) : null
  return (
    <div className="space-y-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-panel-2">
        <div
          className={`h-full rounded-full bg-accent transition-[width] ${pct === null ? 'w-1/3 animate-pulse' : ''}`}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
      <div className="text-[11px] text-muted tabular-nums">
        {done.toLocaleString()}
        {total !== null && ` of ${total.toLocaleString()}`}
      </div>
    </div>
  )
}
