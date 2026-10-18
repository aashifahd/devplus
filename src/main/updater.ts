import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { APP_EVENT, type AppEvent, type UpdateState } from '@shared/app'
import { log } from './logs'

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
const FIRST_CHECK_MS = 20_000

let state: UpdateState = { status: 'idle' }
let timer: ReturnType<typeof setInterval> | null = null

function set(next: UpdateState) {
  state = next
  const event: AppEvent = { type: 'update', state }
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(APP_EVENT, event)
}

export const updateState = () => state

/** Installed builds check GitHub Releases; running from source never updates itself. */
export function initUpdater(auto: boolean) {
  if (!app.isPackaged) {
    state = { status: 'unsupported', message: 'Updates only work in installed builds.' }
    return
  }
  autoUpdater.logger = {
    info: (m: unknown) => log('info', 'updater', String(m)),
    warn: (m: unknown) => log('warn', 'updater', String(m)),
    error: (m: unknown) => log('error', 'updater', String(m)),
    debug: () => {}
  }
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.disableWebInstaller = true
  // Test-only: point at a local folder of release files instead of GitHub (DBC_UPDATE_URL=http://127.0.0.1:port/).
  if (process.env.DBC_UPDATE_URL) autoUpdater.setFeedURL({ provider: 'generic', url: process.env.DBC_UPDATE_URL })
  autoUpdater.on('checking-for-update', () => set({ ...state, status: 'checking', message: undefined }))
  autoUpdater.on('update-not-available', () => set({ status: 'none', checkedAt: Date.now() }))
  autoUpdater.on('update-available', (info) => set({ status: autoUpdater.autoDownload ? 'downloading' : 'available', version: info.version, percent: 0, checkedAt: Date.now() }))
  autoUpdater.on('download-progress', (p) => set({ ...state, status: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version, checkedAt: Date.now() }))
  autoUpdater.on('error', (err) => set({ ...state, status: 'error', message: err?.message ?? String(err) }))
  setAuto(auto)
}

/** Turn background checks (and automatic downloads) on or off. */
export function setAuto(auto: boolean) {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = auto
  if (timer) clearInterval(timer)
  timer = null
  if (auto) {
    setTimeout(() => void check(), FIRST_CHECK_MS)
    timer = setInterval(() => void check(), CHECK_EVERY_MS)
  }
}

export async function check(): Promise<UpdateState> {
  if (!app.isPackaged) return state
  if (state.status === 'downloading' || state.status === 'ready') return state
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    set({ ...state, status: 'error', message: (err as Error).message })
  }
  return state
}

export async function download(): Promise<UpdateState> {
  if (state.status !== 'available') return state
  set({ ...state, status: 'downloading', percent: 0 })
  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    set({ ...state, status: 'error', message: (err as Error).message })
  }
  return state
}

export function install() {
  if (state.status === 'ready') autoUpdater.quitAndInstall(true, true)
}
