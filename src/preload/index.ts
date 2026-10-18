import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS, TASK_EVENT, type Api, type Channel } from '@shared/api'
import { APP_EVENT, type AppEvent } from '@shared/app'
import type { IpcResult, TaskEvent } from '@shared/types'

type Bridge = { [K in Channel]: (...args: Parameters<Api[K]>) => Promise<IpcResult<ReturnType<Api[K]>>> }

const bridge = Object.fromEntries(
  CHANNELS.map((channel) => [channel, (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)])
) as Bridge

contextBridge.exposeInMainWorld('db', bridge)

const events = {
  /** Subscribe to progress and log lines from long tasks; returns an unsubscribe function. */
  onTask(cb: (e: TaskEvent) => void): () => void {
    const listener = (_: unknown, e: TaskEvent) => cb(e)
    ipcRenderer.on(TASK_EVENT, listener)
    return () => ipcRenderer.removeListener(TASK_EVENT, listener)
  },
  /** App-wide events such as update progress; returns an unsubscribe function. */
  onApp(cb: (e: AppEvent) => void): () => void {
    const listener = (_: unknown, e: AppEvent) => cb(e)
    ipcRenderer.on(APP_EVENT, listener)
    return () => ipcRenderer.removeListener(APP_EVENT, listener)
  }
}
contextBridge.exposeInMainWorld('dbEvents', events)

export type { Bridge }
export type Events = typeof events
