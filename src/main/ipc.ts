import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import * as ai from './ai'
import * as updater from './updater'
import * as appInfo from './appInfo'
import { log } from './logs'
import { findTablePlusFile, readTablePlus } from './importers/tableplus'
import { isReadStatement, splitStatements } from '@shared/sqlsplit'
import { TASK_EVENT, type Api, type Channel } from '@shared/api'
import type { ConnectionDraft, ConnectionSecrets, IpcResult, TaskEvent } from '@shared/types'
import * as store from './store'
import * as sessions from './sessions'
import { exportRows, previewImport } from './transfer'
import { createExamplePlugin, listPlugins, openPluginsFolder } from './plugins'
import { writeFileSync } from 'node:fs'

type Handlers = { [K in Channel]: (...args: Parameters<Api[K]>) => ReturnType<Api[K]> | Promise<ReturnType<Api[K]>> }

/** Fields the user left blank in the editor fall back to what is already in the keychain. */
function mergeSecrets(id: string, typed: ConnectionSecrets): ConnectionSecrets {
  const saved = store.getSecrets(id)
  const filled = Object.fromEntries(Object.entries(typed).filter(([, v]) => v)) as ConnectionSecrets
  return { ...saved, ...filled }
}

/** Re-read the connection so safe-mode changes made while connected apply at once. */
const latestConfig = (sessionId: string) =>
  store.listConnections().find((c) => c.id === sessions.connectionIdOf(sessionId))

/**
 * Automated UI tests can't click native file dialogs. When DBC_TEST_DIALOGS names a JSON
 * file ({ "open": path, "saveDir": dir }), dialogs answer from it instead. Unset in normal use.
 */
function testDialog(): { open?: string; saveDir?: string } | null {
  const file = process.env.DBC_TEST_DIALOGS
  if (!file) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Push progress and log lines for a long task to every window. */
function emit(event: TaskEvent) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(TASK_EVENT, event)
}
const progressOf = (taskId: string) => (done: number, total: number | null) => emit({ taskId, kind: 'progress', done, total })
const logOf = (taskId: string) => (line: string) => emit({ taskId, kind: 'log', line })

const handlers: Handlers = {
  'connections:list': () => store.listConnections(),

  'connections:save': (draft: ConnectionDraft) =>
    store.saveConnection({ ...draft, secrets: mergeSecrets(draft.id, draft.secrets) }),

  'connections:delete': (id) => store.deleteConnection(id),

  'connections:secrets': (id) => ({ hasPassword: Boolean(store.getSecrets(id).password) }),

  'connections:test': (draft) => {
    const { secrets, ...cfg } = draft
    return sessions.testConnection(cfg, mergeSecrets(draft.id, secrets))
  },

  'session:open': (connectionId, override) => {
    const cfg = store.getConnection(connectionId)
    return sessions.openSession(cfg, { ...store.getSecrets(connectionId), ...override })
  },

  'session:close': (id) => sessions.closeSession(id),
  'session:switchDb': (id, name) => sessions.switchDatabase(id, name),
  'session:tree': (id) => sessions.getDriver(id).tree(),
  'session:columns': (id, schema, table) => sessions.getDriver(id).columns(schema, table),
  'session:fetch': (id, req) => sessions.getDriver(id).fetchTable(req),
  'session:count': (id, req) => sessions.getDriver(id).countTable(req),
  'session:previewChanges': (id, set) => sessions.previewChanges(id, set),
  'session:applyChanges': (id, set) => sessions.applyChanges(id, set, latestConfig(id)),

  'query:run': async (id, sql) => {
    const res = await sessions.runScript(id, sql, latestConfig(id))
    store.addHistory({
      connectionId: sessions.connectionIdOf(id),
      sql: sql.trim(),
      at: Date.now(),
      durationMs: res.durationMs,
      ok: res.error === null,
      statements: res.results.length + (res.error ? 1 : 0)
    })
    return res
  },
  'query:explain': (id, statement) => sessions.explain(id, statement, latestConfig(id)),
  'query:cancel': (id) => sessions.cancel(id),
  'query:capabilities': (id) => ({ canCancel: sessions.canCancel(id), engine: sessions.engineOf(id) }),
  'query:completions': (id) => sessions.completions(id),
  'structure:get': (id, schema, table) => sessions.structure(id, schema, table),
  'structure:routine': (id, node) => sessions.routineDefinition(id, node),
  'admin:users': (id) => sessions.users(id),
  'admin:processes': (id) => sessions.processes(id),
  'admin:kill': (id, pid, mode) => sessions.kill(id, pid, mode, latestConfig(id)),
  'admin:preview': (id, action) => sessions.previewAdmin(id, action),
  'admin:apply': (id, action) => sessions.applyAdmin(id, action, latestConfig(id)),
  'export:table': (id, req, path, taskId) => sessions.exportTable(id, req, path, progressOf(taskId)),
  'export:rows': (data, path) => exportRows(data.columns, data.rows, data.options, path),
  'import:preview': (path, opts) => previewImport(path, opts),
  'import:run': (id, spec, taskId) => sessions.importIntoTable(id, spec, latestConfig(id), progressOf(taskId)),
  'import:sqlFile': (id, path, taskId) => sessions.runSqlFile(id, path, latestConfig(id), progressOf(taskId)),
  'tools:status': (id) => sessions.toolStatus(id, store.getSettings()),
  'tools:setPath': (name, path) => store.setToolPath(name, path),
  'backup:run': (id, opts, path, taskId) => sessions.backup(id, opts, path, store.getSettings(), logOf(taskId)),
  'restore:run': (id, opts, path, taskId) => sessions.restore(id, opts, path, store.getSettings(), latestConfig(id), logOf(taskId)),
  'settings:get': () => store.getSettings(),
  'settings:update': (patch) => {
    const next = store.updateSettings(patch)
    if (patch.updates?.auto !== undefined) updater.setAuto(next.updates.auto)
    return next
  },
  'ai:setKey': (provider, key) => store.setAiKey(provider, key),
  'ai:keyStatus': () => store.aiKeyStatus(),
  'metrics:list': (connectionId) => store.listBoards(connectionId),
  'metrics:save': (board) => store.saveBoard(board),
  'metrics:delete': (id) => store.deleteBoard(id),
  // Dashboard queries: read-only, and kept out of the query history so refreshes don't flood it.
  'metrics:run': (id, sql) => {
    const engine = sessions.engineOf(id)
    if (!splitStatements(sql, engine).every((s) => isReadStatement(s.text, engine))) {
      throw new Error('Dashboard widgets only run read-only queries.')
    }
    return sessions.runScript(id, sql, latestConfig(id))
  },
  'schema:erd': (sessionId, schema, taskId) => sessions.erd(sessionId, schema, progressOf(taskId)),
  'ai:ask': (req) => ai.ask(req, (text) => emit({ taskId: req.taskId, kind: 'delta', text })),
  'ai:cancel': (taskId) => ai.cancel(taskId),
  'ai:test': (req) => ai.test(req),
  'plugins:list': () => listPlugins(),
  'plugins:openFolder': () => openPluginsFolder(),
  'plugins:createExample': () => createExamplePlugin(),
  // Only called with a path the user just picked in a save dialog (plugin exporters).
  'files:writeText': (path, text) => {
    writeFileSync(path, text, 'utf8')
    return text.length
  },
  'import:tableplusFind': () => findTablePlusFile(),
  'import:tableplusRead': (path) => readTablePlus(path, store.listConnections()),
  // Imported connections never carry secrets; passwords are asked for on first connect.
  'import:save': (configs) => {
    for (const c of configs) store.saveConnection({ ...c, savePassword: false, secrets: {} })
    return configs.length
  },
  'app:info': () => appInfo.info(),
  'app:openLogs': () => appInfo.openLogs(),
  'app:openNotices': () => appInfo.openNotices(),
  'app:logError': (message, stack) => log('error', 'renderer', message, stack),
  'app:reportProblem': () => appInfo.reportProblem(),
  'updates:state': () => updater.updateState(),
  'updates:check': () => updater.check(),
  'updates:download': () => updater.download(),
  'updates:install': () => updater.install(),
  'history:list': (connectionId) => store.listHistory(connectionId),
  'history:clear': (connectionId) => store.clearHistory(connectionId),
  'saved:list': (connectionId) => store.listSaved(connectionId),
  'saved:save': (q) => store.saveQuery(q),
  'saved:delete': (id) => store.deleteSaved(id),

  'dialog:openFile': async (opts) => {
    const fake = testDialog()
    if (fake) return fake.open ?? null
    const win = BrowserWindow.getFocusedWindow()
    const res = win
      ? await dialog.showOpenDialog(win, { title: opts.title, filters: opts.filters, properties: ['openFile'] })
      : await dialog.showOpenDialog({ title: opts.title, filters: opts.filters, properties: ['openFile'] })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  },

  'dialog:saveFile': async (opts) => {
    const fake = testDialog()
    if (fake?.saveDir) return join(fake.saveDir, basename(opts.defaultPath ?? 'export'))
    const win = BrowserWindow.getFocusedWindow()
    const options = { title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters }
    const res = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    return res.canceled ? null : (res.filePath ?? null)
  }
}

/**
 * Errors are returned as values: Electron rewrites thrown errors into
 * "Error invoking remote method", which hides the driver's message.
 */
export function registerIpc() {
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (_event, ...args): Promise<IpcResult<unknown>> => {
      try {
        return { ok: true, data: await (handler as (...a: unknown[]) => unknown)(...args) }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, error: message || 'Unknown error' }
      }
    })
  }
}
