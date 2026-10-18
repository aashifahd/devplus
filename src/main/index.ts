import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { registerIpc } from './ipc'
import { closeAll } from './sessions'
import { initLogs, log } from './logs'
import { migrateUserData } from './migrate'
import { initUpdater } from './updater'
import { getSettings } from './store'
import * as servers from './servers'
import { initTray, startedHidden } from './tray'

// Before anything reads the data folder (logs included).
const migratedFrom = migrateUserData()
initLogs()
if (migratedFrom) log('info', 'main', `Copied existing data from ${migratedFrom}`)
if (process.platform === 'win32') app.setAppUserModelId('io.github.aashifahd.devplus')

function createWindow(show = true) {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'DevPlus',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#17181b' : '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.once('ready-to-show', () => show && win.show())

  // External links open in the browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

/** Bring the window back (from the tray), creating it if it was closed. */
function showWindow() {
  const win = BrowserWindow.getAllWindows()[0] ?? createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

app.whenReady().then(() => {
  registerIpc()
  // At login (--hidden) DevPlus starts in the tray to bring up auto-start servers.
  createWindow(!startedHidden())
  initUpdater(getSettings().updates.auto)
  initTray(showWindow)
  void servers.boot()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let quitting = false
app.on('before-quit', (e) => {
  void closeAll()
  // Local servers are separate processes and keep running unless the user asked otherwise.
  if (!quitting && !getSettings().servers.keepRunning && servers.runningCount() > 0) {
    e.preventDefault()
    quitting = true
    void servers.stopAll().finally(() => app.quit())
  }
})
