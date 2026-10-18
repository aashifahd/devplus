import type { Api, Channel } from '@shared/api'
import type { Bridge, Events } from '../../preload'

declare global {
  interface Window {
    db: Bridge
    dbEvents: Events
  }
}

/** Call the main process and turn an error result back into a thrown Error. */
export async function call<K extends Channel>(channel: K, ...args: Parameters<Api[K]>): Promise<ReturnType<Api[K]>> {
  const fn = window.db[channel] as (...a: unknown[]) => ReturnType<Bridge[K]>
  const res = await fn(...args)
  if (!res.ok) throw new Error(res.error)
  return res.data as ReturnType<Api[K]>
}

let taskSeq = 0
export const newTaskId = () => `task-${Date.now()}-${++taskSeq}`
