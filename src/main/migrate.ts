import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/** Data folders used by earlier names of the app, newest first. */
const OLD_NAMES = ['DB Client']

/**
 * The data folder follows the product name, so after a rename the app would start empty.
 * Copy connections, settings, history, saved queries, boards and plugins across once.
 * The old folder is left as it was. Encrypted secrets usually carry over (DPAPI on Windows);
 * where the OS keychain is tied to the app name, the app simply asks for passwords again.
 */
export function migrateUserData(): string | null {
  const target = app.getPath('userData')
  if (existsSync(join(target, 'connections.json'))) return null
  for (const name of OLD_NAMES) {
    const source = join(app.getPath('appData'), name)
    if (source === target || !existsSync(join(source, 'connections.json'))) continue
    mkdirSync(target, { recursive: true })
    for (const f of readdirSync(source)) {
      if (f.endsWith('.json')) cpSync(join(source, f), join(target, f))
    }
    if (existsSync(join(source, 'plugins'))) cpSync(join(source, 'plugins'), join(target, 'plugins'), { recursive: true })
    return source
  }
  return null
}
