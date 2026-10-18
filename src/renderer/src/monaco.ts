import { isDark } from './theme'
import * as monaco from 'monaco-editor'
import { format, type SqlLanguage } from 'sql-formatter'
import type { CompletionTable, Engine } from '@shared/types'
import { splitStatements, statementAt } from '@shared/sqlsplit'
import { ENGINES } from '@shared/engines'

// SQL needs no language worker; every label gets the plain editor worker.
self.MonacoEnvironment = {
  getWorker: () =>
    new Worker(new URL('../../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url), {
      type: 'module'
    })
}

/** Per-editor context the global providers look up by model URI. */
interface ModelContext {
  engine: Engine
  tables: CompletionTable[]
}
const contexts = new Map<string, ModelContext>()

export function setModelContext(model: monaco.editor.ITextModel, ctx: ModelContext) {
  contexts.set(model.uri.toString(), ctx)
}

export function dropModelContext(model: monaco.editor.ITextModel) {
  contexts.delete(model.uri.toString())
}

const FORMATTER_LANGUAGE: Partial<Record<Engine, SqlLanguage>> = {
  postgres: 'postgresql',
  mysql: 'mysql',
  sqlite: 'sqlite',
  mssql: 'transactsql',
  duckdb: 'duckdb',
  clickhouse: 'clickhouse',
  snowflake: 'snowflake',
  bigquery: 'bigquery',
  cassandra: 'sql',
  dynamodb: 'sql'
}

/** Format SQL for its dialect; engines without SQL get their text back untouched. */
export function formatSql(sql: string, engine: Engine): string {
  const language = FORMATTER_LANGUAGE[engine]
  if (!language) return sql
  return format(sql, { language, keywordCase: 'upper', tabWidth: 2, linesBetweenQueries: 1 })
}

/** Monaco language id for an engine's query editor. */
export function editorLanguage(engine: Engine): string {
  const lang = ENGINES[engine].language
  return lang === 'mongo' ? 'javascript' : lang === 'redis' ? 'redis' : 'sql'
}

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'ILIKE', 'BETWEEN', 'EXISTS',
  'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL JOIN', 'CROSS JOIN', 'ON', 'USING', 'AS',
  'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'DISTINCT', 'UNION', 'UNION ALL', 'ASC', 'DESC',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'RETURNING', 'WITH', 'CASE', 'WHEN', 'THEN',
  'ELSE', 'END', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'CREATE INDEX', 'PRIMARY KEY', 'FOREIGN KEY',
  'REFERENCES', 'DEFAULT', 'BEGIN', 'COMMIT', 'ROLLBACK', 'EXPLAIN', 'TRUNCATE'
]
const FUNCTIONS = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NULLIF', 'CAST', 'LOWER', 'UPPER', 'LENGTH', 'NOW', 'CONCAT', 'ROUND']

const unquote = (s: string) => s.replace(/^["`[]|["`\]]$/g, '')

/** Table names and aliases mentioned after FROM / JOIN / UPDATE / INTO in a statement. */
function referencedTables(statement: string): { name: string; alias?: string }[] {
  const out: { name: string; alias?: string }[] = []
  const re = /\b(?:from|join|update|into)\s+((?:[\w"`]+\.)?[\w"`]+)(?:\s+(?:as\s+)?(?!where|on|join|left|right|inner|full|cross|set|group|order|limit|using|values)(\w+))?/gi
  for (const m of statement.matchAll(re)) {
    const name = unquote(m[1].split('.').pop() ?? m[1])
    out.push({ name, alias: m[2] })
  }
  return out
}

let registered = false

/** Register themes and SQL providers once for the whole app. */
export function setupMonaco() {
  if (registered) return
  registered = true

  monaco.editor.defineTheme('dbc-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: { 'editor.background': '#17181b', 'editorGutter.background': '#17181b', 'editor.lineHighlightBackground': '#1e1f23' }
  })
  monaco.editor.defineTheme('dbc-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: { 'editor.background': '#ffffff', 'editor.lineHighlightBackground': '#f6f6f7' }
  })

  monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.', ' '],
    provideCompletionItems(model, position) {
      const ctx = contexts.get(model.uri.toString())
      const word = model.getWordUntilPosition(position)
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
      const K = monaco.languages.CompletionItemKind
      if (!ctx) return { suggestions: [] }

      const text = model.getValue()
      const offset = model.getOffsetAt(position)
      const statement = statementAt(splitStatements(text, ctx.engine), offset)?.text ?? text
      const refs = referencedTables(statement)
      const byName = new Map(ctx.tables.map((t) => [t.name.toLowerCase(), t]))

      // "alias." or "table." -> only that table's columns.
      const before = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1)
      const qualifier = /([\w"`]+)\.$/.exec(before)?.[1]
      if (qualifier) {
        const q = unquote(qualifier).toLowerCase()
        const target = refs.find((r) => r.alias?.toLowerCase() === q)?.name ?? q
        const table = byName.get(target.toLowerCase())
        const schemaTables = ctx.tables.filter((t) => t.schema.toLowerCase() === q)
        return {
          suggestions: [
            ...(table?.columns ?? []).map((c) => ({ label: c.name, kind: K.Field, detail: c.type, insertText: c.name, range })),
            ...schemaTables.map((t) => ({ label: t.name, kind: K.Struct, detail: t.kind, insertText: t.name, range }))
          ]
        }
      }

      // Columns of tables used in this statement rank first, then tables, keywords, functions.
      const seen = new Set<string>()
      const columns = refs.flatMap((r) =>
        (byName.get(r.name.toLowerCase())?.columns ?? []).flatMap((c) => {
          if (seen.has(c.name)) return []
          seen.add(c.name)
          return [{ label: c.name, kind: K.Field, detail: `${r.name} · ${c.type}`, insertText: c.name, range, sortText: `0${c.name}` }]
        })
      )
      const tables = ctx.tables.map((t) => ({
        label: t.name,
        kind: t.kind === 'view' ? K.Interface : K.Struct,
        detail: `${t.schema} · ${t.kind}`,
        insertText: t.name,
        range,
        sortText: `1${t.name}`
      }))
      const keywords = KEYWORDS.map((k) => ({ label: k, kind: K.Keyword, insertText: k, range, sortText: `2${k}` }))
      const fns = FUNCTIONS.map((f) => ({
        label: `${f}()`,
        kind: K.Function,
        insertText: `${f}($0)`,
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        range,
        sortText: `3${f}`
      }))
      return { suggestions: [...columns, ...tables, ...keywords, ...fns] }
    }
  })

  const formatRange = (model: monaco.editor.ITextModel, range: monaco.IRange) => {
    const engine = contexts.get(model.uri.toString())?.engine ?? 'postgres'
    try {
      return [{ range, text: formatSql(model.getValueInRange(range), engine) }]
    } catch {
      // Unparseable SQL is left as typed rather than mangled.
      return []
    }
  }
  monaco.languages.registerDocumentFormattingEditProvider('sql', {
    provideDocumentFormattingEdits: (model) => formatRange(model, model.getFullModelRange())
  })
  monaco.languages.registerDocumentRangeFormattingEditProvider('sql', {
    provideDocumentRangeFormattingEdits: (model, range) => formatRange(model, range)
  })
}

export function currentTheme() {
  return isDark() ? 'dbc-dark' : 'dbc-light'
}

export { monaco }
