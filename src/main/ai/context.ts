import type { CellValue, CompletionTable, Engine } from '@shared/types'
import type { AiRequest } from '@shared/ai'
import { ENGINES } from '@shared/engines'
import type { DriverSession } from '../drivers'

/** Roughly 40k tokens of schema; bigger databases send the most relevant tables first. */
const SCHEMA_CHAR_BUDGET = 160_000
const SAMPLE_TABLES = 8
const SAMPLE_ROWS = 3
const SAMPLE_CELL_CHARS = 60

const LANGUAGE_RULES: Record<string, string> = {
  sql: 'Write SQL in this engine\'s dialect. Quote identifiers only where the dialect needs it.',
  mongo:
    'Write MongoDB shell commands in the form db.collection.method(...): find, aggregate, countDocuments, insertOne, updateMany and so on. Use JSON-like documents.',
  redis: 'Write Redis commands, one per line, exactly as typed into redis-cli (for example HGETALL user:1).',
  cql: 'Write CQL. Remember Cassandra needs the partition key in WHERE clauses unless ALLOW FILTERING is acceptable; say so when you use it.',
  partiql: 'Write DynamoDB PartiQL statements (SELECT, INSERT, UPDATE, DELETE with double-quoted table names).'
}

/** Instructions shared by every request. Kept byte-stable so the schema after it can be cached. */
export function instructions(engine: Engine): string {
  const info = ENGINES[engine]
  return [
    'You are the query assistant inside a desktop database client. You help one user write, understand and fix queries against the database described below.',
    `The database engine is ${info.label}. ${LANGUAGE_RULES[info.language] ?? ''}`,
    'Rules:',
    '- Use only tables, collections and columns that appear in the schema. If what the user wants is not in the schema, say so instead of inventing names.',
    '- When you write a query, put it in exactly one fenced code block, after at most two sentences of explanation. The user inserts it into their editor and runs it themselves.',
    '- Prefer read-only queries. When the user asks for something that changes or deletes data, write it, but start with one sentence naming what it changes, and include a WHERE clause unless they clearly want every row.',
    '- Add a LIMIT (or the engine\'s equivalent) to exploratory SELECTs that could return a very large number of rows.',
    '- When explaining, be brief and concrete: what the query returns, then anything surprising or slow.'
  ].join('\n')
}

function mentions(text: string, t: CompletionTable): boolean {
  const name = t.name.toLowerCase()
  return name.length > 1 && text.includes(name)
}

function cell(v: CellValue): string {
  if (v === null) return 'NULL'
  const s = String(v)
  return s.length > SAMPLE_CELL_CHARS ? `${s.slice(0, SAMPLE_CELL_CHARS)}…` : s
}

/**
 * The schema block: every table with its columns, ordered so tables the user
 * mentioned come first, cut at a size budget. Sample rows only when allowed.
 */
export async function schemaContext(
  driver: DriverSession,
  engine: Engine,
  req: AiRequest,
  includeSampleRows: boolean
): Promise<{ text: string; omittedTables: number }> {
  const tables = await driver.completions()
  const haystack = `${req.prompt}\n${req.sql}\n${req.error ?? ''}`.toLowerCase()
  const ranked = [...tables].sort((a, b) => Number(mentions(haystack, b)) - Number(mentions(haystack, a)))

  const lines: string[] = []
  let used = 0
  let omitted = 0
  for (const t of ranked) {
    const line = `${t.kind === 'view' ? 'view ' : ''}${t.schema ? `${t.schema}.` : ''}${t.name}(${t.columns.map((c) => (c.type ? `${c.name} ${c.type}` : c.name)).join(', ')})`
    if (used + line.length > SCHEMA_CHAR_BUDGET) {
      omitted++
      continue
    }
    lines.push(line)
    used += line.length + 1
  }

  const parts = [
    `Server version: ${driver.serverVersion}`,
    `Current database: ${driver.currentDatabase() || '(default)'}`,
    `Schema (${tables.length} tables${omitted ? `, ${omitted} left out for size` : ''}):`,
    lines.join('\n') || '(no tables)'
  ]

  if (includeSampleRows) {
    const picks = ranked.filter((t) => t.kind === 'table').slice(0, SAMPLE_TABLES)
    const samples: string[] = []
    for (const t of picks) {
      try {
        const res = await driver.fetchTable({ schema: t.schema, table: t.name, limit: SAMPLE_ROWS, offset: 0, filters: [] })
        if (res.rows.length === 0) continue
        samples.push(`${t.schema ? `${t.schema}.` : ''}${t.name}: ${res.columns.map((c) => c.name).join(' | ')}`)
        for (const r of res.rows) samples.push(`  ${r.map(cell).join(' | ')}`)
      } catch {
        // A table we can't read just goes without samples.
      }
    }
    if (samples.length) parts.push('Sample rows (a few per table, values shortened):', samples.join('\n'))
  }

  return { text: parts.join('\n'), omittedTables: omitted }
}

/** The per-request message: the task, the user's words and the editor contents. */
export function userMessage(req: AiRequest): string {
  const sqlBlock = req.sql.trim() ? `\n\nQuery:\n\`\`\`\n${req.sql.trim()}\n\`\`\`` : ''
  const extra = req.prompt.trim()
  switch (req.task) {
    case 'generate':
      return `${extra}${sqlBlock ? `\n\nFor context, the editor currently contains:${sqlBlock}` : ''}`
    case 'explain':
      return `Explain this query.${sqlBlock}${extra ? `\n\n${extra}` : ''}`
    case 'fix':
      return `This query failed. Explain the cause in one or two sentences and give a corrected query.${sqlBlock}\n\nError:\n${req.error ?? '(no message)'}${extra ? `\n\n${extra}` : ''}`
  }
}
