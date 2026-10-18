import { existsSync } from 'node:fs'
import { release } from 'node:os'
import { join } from 'node:path'
import { app, shell } from 'electron'
import { REPO_URL, type AppInfo } from '@shared/app'
import { logsDir, recentLog } from './logs'

export function info(): AppInfo {
  return {
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    packaged: app.isPackaged
  }
}

export function openLogs() {
  void shell.openPath(logsDir())
}

/** The notices ship as an extra resource; from source they're generated into build/. */
export function openNotices() {
  const file = app.isPackaged ? join(process.resourcesPath, 'THIRD_PARTY_NOTICES.md') : join(app.getAppPath(), 'build', 'THIRD_PARTY_NOTICES.md')
  if (!existsSync(file)) throw new Error('Third-party notices not found. Run npm run notices to generate them.')
  void shell.openPath(file)
}

/**
 * Open a prefilled GitHub issue. Nothing is sent from the app: the browser shows the
 * report, including the redacted log excerpt, for the user to edit or discard.
 */
export function reportProblem(): string {
  const i = info()
  const env = [`App: ${i.name} ${i.version}${i.packaged ? '' : ' (from source)'}`, `OS: ${i.platform} ${i.osRelease} (${i.arch})`, `Electron: ${i.electron}`].join('\n')
  const errors = recentLog(200)
    .split('\n')
    .filter((l) => /\b(ERROR|WARN)\b/.test(l))
    .slice(-12)
    .join('\n')
    .slice(-2500)
  const params = new URLSearchParams({ template: 'bug_report.yml', env, ...(errors ? { log: errors } : {}) })
  const url = `${REPO_URL}/issues/new?${params}`
  void shell.openExternal(url)
  return url
}
