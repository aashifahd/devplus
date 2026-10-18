import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { registerIpc } from './ipc'
import { closeAll } from './sessions'
import { initLogs, log } from './logs'
import { migrateUserData } from './migrate'
import { initUpdater } from './updater'
import { getSettings } from './store'

// Before anything reads the data folder (logs included).
const migratedFrom = migrateUserData()
initLogs()
if (migratedFrom) log('info', 'main', `Copied existing data from ${migratedFrom}`)
if (process.platform === 'win32') app.setAppUserModelId('io.github.aashifahd.devplus')

function createWindow() {
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

  win.once('ready-to-show', () => win.show())

  // External links open in the browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  initUpdater(getSettings().updates.auto)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void closeAll()
})
