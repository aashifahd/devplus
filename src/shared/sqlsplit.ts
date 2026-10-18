import type { Engine } from './engines'

export interface StatementSpan {
  /** Statement text without the trailing semicolon, trimmed. */
  text: string
  /** Offsets of the trimmed text within the source string. */
  start: number
  end: number
}

/** Per-dialect lexical rules for the SQL splitter. */
interface SqlLexicon {
  backslashEscapes: boolean
  backticks: boolean
  hashComments: boolean
  dollarQuotes: boolean
  /** MySQL executes /*! … *\/ comments, so they count as code. */
  executableComments: boolean
  /** CQL wraps several statements in BEGIN BATCH … APPLY BATCH. */
  batches: boolean
}

const LEXICON: Partial<Record<Engine, Partial<SqlLexicon>>> = {
  mysql: { backslashEscapes: true, backticks: true, hashComments: true, executableComments: true },
  sqlite: { backticks: true },
  postgres: { dollarQuotes: true },
  duckdb: { dollarQuotes: true },
  clickhouse: { backslashEscapes: true, backticks: true },
  snowflake: { backslashEscapes: true, dollarQuotes: true },
  bigquery: { backslashEscapes: true, backticks: true, hashComments: true },
  cassandra: { batches: true }
}

/**
 * Split a script into statements the way its engine expects:
 * Redis commands are one per line, SQL Server runs GO-separated batches,
 * Mongo shell code splits at top-level semicolons or a new `db.` line,
 * and every SQL dialect splits at semicolons outside strings, comments and blocks.
 */
export function splitStatements(sql: string, engine: Engine): StatementSpan[] {
  if (engine === 'redis') return splitLines(sql)
  if (engine === 'mssql') return splitBatches(sql)
  if (engine === 'mongodb') return splitMongo(sql)
  return splitSql(sql, { backslashEscapes: false, backticks: false, hashComments: false, dollarQuotes: false, executableComments: false, batches: false, ...LEXICON[engine] })
}

function span(sql: string, start: number, end: number): StatementSpan | null {
  const raw = sql.slice(start, end)
  const text = raw.trim()
  if (!text) return null
  const lead = raw.length - raw.trimStart().length
  return { text, start: start + lead, end: start + lead + text.length }
}

/** One command per line; blank lines and # comments are skipped. */
function splitLines(text: string): StatementSpan[] {
  const out: StatementSpan[] = []
  let offset = 0
  for (const line of text.split('\n')) {
    const s = span(text, offset, offset + line.length)
    if (s && !s.text.startsWith('#') && !s.text.startsWith('//')) out.push(s)
    offset += line.length + 1
  }
  return out
}

/** T-SQL batches separated by GO on its own line; each batch runs as one request. */
function splitBatches(text: string): StatementSpan[] {
  const out: StatementSpan[] = []
  const re = /^[ \t]*GO[ \t]*(?:\d+[ \t]*)?$/gim
  let start = 0
  for (const m of text.matchAll(re)) {
    const s = span(text, start, m.index!)
    if (s && hasCode(s.text)) out.push(s)
    start = m.index! + m[0].length
  }
  const last = span(text, start, text.length)
  if (last && hasCode(last.text)) out.push(last)
  return out
}

const hasCode = (s: string) => s.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim().length > 0

/** JavaScript-ish shell input: track strings, comments and bracket depth. */
function splitMongo(text: string): StatementSpan[] {
  const out: StatementSpan[] = []
  let depth = 0
  let start = 0
  let i = 0
  const push = (end: number) => {
    const s = span(text, start, end)
    if (s && hasCode(s.text.replace(/\/\/[^\n]*/g, ''))) out.push(s)
  }
  while (i < text.length) {
    const ch = text[i]
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      i = nl === -1 ? text.length : nl
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2)
      i = close === -1 ? text.length : close + 2
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      i++
      while (i < text.length && text[i] !== ch) i += text[i] === '\\' ? 2 : 1
      i++
      continue
    }
    if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1)
    else if (ch === ';' && depth === 0) {
      push(i)
      start = i + 1
    } else if (ch === '\n' && depth === 0 && /^\s*(db\.|use\s|show\s)/.test(text.slice(i + 1))) {
      // A new top-level command on the next line ends the current one.
      push(i)
      start = i + 1
    }
    i++
  }
  push(text.length)
  return out
}

function splitSql(sql: string, lex: SqlLexicon): StatementSpan[] {
  const spans: StatementSpan[] = []
  let chunkStart = 0
  let code = false
  let compound = false
  let depth = 0
  let i = 0

  const push = (end: number) => {
    if (code) {
      const s = span(sql, chunkStart, end)
      if (s) spans.push(s)
    }
    code = false
    compound = false
    depth = 0
  }

  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]

    if ((ch === '-' && next === '-') || (ch === '/' && next === '/' && lex.batches)) {
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? sql.length : nl + 1
      continue
    }
    if (ch === '#' && lex.hashComments) {
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? sql.length : nl + 1
      continue
    }
    if (ch === '/' && next === '*') {
      if (lex.executableComments && (sql[i + 2] === '!' || sql[i + 2] === '+')) code = true
      const close = sql.indexOf('*/', i + 2)
      i = close === -1 ? sql.length : close + 2
      continue
    }
    if (ch === "'" || ch === '"' || (ch === '`' && lex.backticks)) {
      code = true
      i++
      while (i < sql.length) {
        if (lex.backslashEscapes && sql[i] === '\\') {
          i += 2
          continue
        }
        if (sql[i] === ch) {
          // A doubled quote is an escaped quote, not the end.
          if (sql[i + 1] === ch) {
            i += 2
            continue
          }
          break
        }
        i++
      }
      i++
      continue
    }
    if (ch === '$' && lex.dollarQuotes) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (m) {
        code = true
        const tag = m[0]
        const close = sql.indexOf(tag, i + tag.length)
        i = close === -1 ? sql.length : close + tag.length
        continue
      }
    }
    if (/[A-Za-z_]/.test(ch) && !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? '')) {
      // Trigger/routine bodies and CQL batches hold their own semicolons.
      if (!code) compound = COMPOUND.test(sql.slice(i, i + 300)) || (lex.batches && BATCH.test(sql.slice(i, i + 40)))
      code = true
      const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i))![0]
      i += word.length
      if (!compound) continue
      const upper = word.toUpperCase()
      const nextWord = (/^\s*([A-Za-z_]+)/.exec(sql.slice(i))?.[1] ?? '').toUpperCase()
      if (upper === 'BEGIN' && !TRANSACTION_WORDS.has(nextWord)) depth++
      else if (upper === 'CASE') depth++
      else if (upper === 'APPLY' && nextWord === 'BATCH') depth = Math.max(0, depth - 1)
      else if (upper === 'END' && !BLOCK_ENDS.has(nextWord)) {
        depth = Math.max(0, depth - 1)
        // "END CASE" closes the CASE itself; don't count that CASE as a new opener.
        if (nextWord === 'CASE') i = sql.indexOf(nextWord, i) + nextWord.length
      }
      continue
    }
    if (ch === ';' && depth === 0) {
      push(i)
      chunkStart = i + 1
      i++
      continue
    }
    if (!/\s/.test(ch)) code = true
    i++
  }
  push(sql.length)
  return spans
}

const COMPOUND =
  /^create\s+(or\s+replace\s+)?(definer\s*=\s*\S+\s+)?(temp(orary)?\s+)?(trigger|procedure|function|event)\b/i
const BATCH = /^begin\s+(unlogged\s+|counter\s+)?batch\b/i
const TRANSACTION_WORDS = new Set(['TRANSACTION', 'WORK', 'DEFERRED', 'IMMEDIATE', 'EXCLUSIVE'])
/** MySQL closes these with END IF / END LOOP etc.; their openers are not counted either. */
const BLOCK_ENDS = new Set(['IF', 'LOOP', 'WHILE', 'REPEAT'])

/** The statement containing `offset`, or the nearest one before it (cursor after a semicolon). */
export function statementAt(spans: StatementSpan[], offset: number): StatementSpan | undefined {
  let best: StatementSpan | undefined
  for (const s of spans) {
    if (offset >= s.start && offset <= s.end + 1) return s
    if (s.end < offset) best = s
  }
  return best ?? spans[0]
}

/** Strip leading comments so the first keyword can be inspected. */
function firstKeyword(sql: string): string {
  const stripped = sql.replace(/^(\s+|--[^\n]*\n?|#[^\n]*\n?|\/\/[^\n]*\n?|\/\*[\s\S]*?\*\/)+/, '')
  return (/^[A-Za-z]+/.exec(stripped)?.[0] ?? '').toLowerCase()
}

const READ_KEYWORDS = new Set(['select', 'with', 'show', 'explain', 'describe', 'desc', 'values', 'table'])

const REDIS_READS = new Set(
  (
    'get mget strlen getrange exists type ttl pttl keys scan dbsize info ping echo time lrange llen lindex ' +
    'hget hgetall hmget hkeys hvals hlen hexists hscan smembers scard sismember srandmember sscan zrange ' +
    'zrangebyscore zrevrange zcard zscore zrank zcount zscan xrange xrevrange xlen xinfo memory object ' +
    'client config slowlog pubsub command role lastsave bitcount getbit pfcount geopos geodist geosearch json.get'
  ).split(' ')
)

/** Mongo shell calls that never write (aggregate counts unless it ends in $out/$merge). */
const MONGO_READ = /^db\.(\w+\.)?(find|findOne|countDocuments|estimatedDocumentCount|count|distinct|aggregate|getIndexes|stats|getCollectionNames|listCollections|explain)\b/

/**
 * A conservative guess at whether a statement only reads. The servers enforce
 * read-only transactions where they can; this decides what to block or confirm up front.
 */
export function isReadStatement(sql: string, engine: Engine = 'postgres'): boolean {
  switch (engine) {
    case 'redis': {
      const cmd = sql.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
      // CONFIG SET and CLIENT KILL write; their read forms (CONFIG GET, CLIENT LIST) don't.
      if (cmd === 'config' || cmd === 'client') return /^\s*\S+\s+(get|list|info|getname|id)\b/i.test(sql)
      return REDIS_READS.has(cmd)
    }
    case 'mongodb': {
      const s = sql.trim()
      if (/^(show|use)\s/i.test(s)) return true
      return MONGO_READ.test(s.replace(/^db\.getCollection\(\s*(['"])[^'"]*\1\s*\)/, 'db.x')) && !/\$out|\$merge/.test(s)
    }
    case 'mssql':
      // A batch can hold anything; treat it as a read only when no writing keyword appears.
      return !/\b(insert|update|delete|merge|create|alter|drop|truncate|exec|execute|grant|revoke|deny|backup|restore|kill|dbcc|bulk|into)\b/i.test(
        sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'/g, ' ')
      )
    default: {
      const kw = firstKeyword(sql)
      if (kw === 'pragma') return !sql.includes('=')
      return READ_KEYWORDS.has(kw)
    }
  }
}
