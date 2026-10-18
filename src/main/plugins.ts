import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, shell } from 'electron'

export interface PluginFile {
  id: string
  file: string
  source: string
  bytes: number
}

const MAX_PLUGIN_BYTES = 1024 * 1024

export const pluginsDir = () => {
  const d = join(app.getPath('userData'), 'plugins')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

/** Every .js file in the plugins folder; the renderer runs each in its own worker. */
export function listPlugins(): PluginFile[] {
  const dir = pluginsDir()
  return readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .flatMap((f) => {
      const file = join(dir, f)
      const bytes = statSync(file).size
      if (bytes > MAX_PLUGIN_BYTES) return [{ id: f.replace(/\.js$/, ''), file, source: '', bytes }]
      return [{ id: f.replace(/\.js$/, ''), file, source: readFileSync(file, 'utf8'), bytes }]
    })
}

export async function openPluginsFolder() {
  await shell.openPath(pluginsDir())
}

const EXAMPLE = `// Example plugin. Plugins run in a sandboxed worker: no DOM, no Node, no network.
// They talk to the app through the global \`devplus\` object.

devplus.registerCommand({
  id: 'insert-timestamp',
  title: 'Insert current timestamp',
  run: async () => {
    await devplus.insertText(new Date().toISOString())
  }
})

devplus.registerCommand({
  id: 'count-rows',
  title: 'Count rows in the open table',
  run: async () => {
    const ctx = await devplus.getContext()
    if (!ctx.table) return devplus.notify('Open a table first.')
    const result = await devplus.runQuery(\`SELECT COUNT(*) AS n FROM \${ctx.table.quoted}\`)
    await devplus.notify(\`\${ctx.table.name}: \${result.rows[0][0]} rows\`)
  }
})

// Show numeric columns named *_at, *_ts or *time as dates (Unix seconds or milliseconds).
devplus.registerCellFormatter({
  id: 'unix-time',
  title: 'Unix time as date',
  match: (column) => /(_at|_ts|time)$/i.test(column.name) && /int|number|numeric|long/i.test(column.type),
  format: (value) => {
    if (value === null || value === '') return null
    const n = Number(value)
    if (!Number.isFinite(n)) return String(value)
    return new Date(n > 1e12 ? n : n * 1000).toISOString().replace('T', ' ').replace('.000Z', 'Z')
  }
})

devplus.registerExporter({
  id: 'markdown',
  title: 'Markdown table',
  extension: 'md',
  export: (columns, rows) => {
    const esc = (v) => (v === null ? '' : String(v).replace(/\\|/g, '\\\\|').replace(/\\n/g, ' '))
    const head = '| ' + columns.map((c) => esc(c.name)).join(' | ') + ' |'
    const rule = '| ' + columns.map(() => '---').join(' | ') + ' |'
    return [head, rule, ...rows.map((r) => '| ' + r.map(esc).join(' | ') + ' |')].join('\\n') + '\\n'
  }
})
`

/** Write the example plugin unless one with that name already exists. */
export function createExamplePlugin(): string {
  const file = join(pluginsDir(), 'example.js')
  if (!existsSync(file)) writeFileSync(file, EXAMPLE, 'utf8')
  return 'example'
}
