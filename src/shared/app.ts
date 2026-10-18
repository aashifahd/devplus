/** Pushed from main for app-wide events (currently update progress). */
export const APP_EVENT = 'app:event'

export const REPO_URL = 'https://github.com/aashifahd/devplus'

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  osRelease: string
  /** False when running from source (npm run dev / start). */
  packaged: boolean
}

export type UpdateStatus = 'unsupported' | 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error'

export interface UpdateState {
  status: UpdateStatus
  /** The newer version, once one is found. */
  version?: string
  percent?: number
  message?: string
  checkedAt?: number
}

export type AppEvent = { type: 'update'; state: UpdateState } | { type: 'servers'; states: import('./servers').ServerState[] }
