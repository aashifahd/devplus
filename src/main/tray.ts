import { app, Menu, nativeImage, Tray } from 'electron'
import { SERVER_ENGINES } from '@shared/servers'
import icon from '../../build/icon.png?asset'
import { log } from './logs'
import * as servers from './servers'

let tray: Tray | null = null
let showWindow: () => void = () => {}

/** Started at login with --hidden: live in the tray until opened. */
export const startedHidden = () => process.argv.includes('--hidden')

function rebuild() {
  const list = servers.list()
  if (!tray) {
    if (list.length === 0 && !startedHidden()) return
    tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }))
    tray.setToolTip('DevPlus')
    tray.on('click', () => showWindow())
  }
  const running = list.filter((s) => s.state.status === 'running').length
  tray.setToolTip(list.length ? `DevPlus: ${running} of ${list.length} servers running` : 'DevPlus')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open DevPlus', click: () => showWindow() },
      { type: 'separator' },
      ...(list.length
        ? list.map((s) => {
            const busy = s.state.status === 'starting' || s.state.status === 'stopping'
            const on = s.state.status === 'running'
            return {
              label: `${on ? '●' : '○'}  ${s.name}  (${SERVER_ENGINES[s.engine].label} ${s.version}, port ${s.port})`,
              enabled: !busy,
              click: () => void (on ? servers.stop(s.id) : servers.start(s.id)).catch(() => {})
            }
          })
        : [{ label: 'No local servers', enabled: false }]),
      { type: 'separator' },
      { label: 'Quit DevPlus', click: () => app.quit() }
    ])
  )
}

export function initTray(open: () => void) {
  showWindow = open
  servers.onChange(rebuild)
  rebuild()
}

/** Open DevPlus (in the tray) when the user signs in. Only meaningful for installed builds. */
export function applyLoginItem(enabled: boolean) {
  if (!app.isPackaged) {
    log('info', 'main', `Start on login ${enabled ? 'enabled' : 'disabled'} (ignored when running from source)`)
    return
  }
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] })
}
