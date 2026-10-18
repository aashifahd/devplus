import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app, crashReporter } from 'electron'

const MAX_BYTES = 1_000_000

export const logsDir = () => {
  const d = join(app.getPath('userData'), 'logs')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}
const logFile = () => join(logsDir(), 'app.log')

/** Keep secrets out of the log even when they turn up in an error message. */
export function redact(text: string): string {
  return text
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)[^@\s]+@/gi, '$1***@')
    .replace(/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s;&,]+)/gi, '$1$2***')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, 'sk-***')
}

export type Level = 'info' | 'warn' | 'error'

export function log(level: Level, source: 'main' | 'renderer' | 'updater', message: string, detail?: string) {
  try {
    const file = logFile()
    if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, join(logsDir(), 'app.old.log'))
    const line = `${new Date().toISOString()} ${level.toUpperCase()} [${source}] ${redact(message)}${detail ? `\n${redact(detail)}` : ''}\n`
    appendFileSync(file, line, 'utf8')
  } catch {
    // Logging must never take the app down.
  }
}

/** The last lines of the log, for "Report a problem". */
export function recentLog(lines = 40): string {
  try {
    return readFileSync(logFile(), 'utf8').trimEnd().split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
}

const describe = (err: unknown) => (err instanceof Error ? { message: err.message, stack: err.stack } : { message: String(err), stack: undefined })

export function initLogs() {
  // Native crash dumps stay on this machine (in the crashDumps folder); nothing is uploaded.
  crashReporter.start({ uploadToServer: false })
  process.on('uncaughtException', (err) => {
    const { message, stack } = describe(err)
    log('error', 'main', `Uncaught exception: ${message}`, stack)
  })
  process.on('unhandledRejection', (reason) => {
    const { message, stack } = describe(reason)
    log('error', 'main', `Unhandled rejection: ${message}`, stack)
  })
  app.on('render-process-gone', (_e, _wc, details) => log('error', 'main', `Window process gone: ${details.reason} (exit code ${details.exitCode})`))
  app.on('child-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit') log('warn', 'main', `${details.type} process gone: ${details.reason} (exit code ${details.exitCode})`)
  })
  log('info', 'main', `Started ${app.getName()} ${app.getVersion()} on ${process.platform} ${process.arch}, Electron ${process.versions.electron}`)
}
