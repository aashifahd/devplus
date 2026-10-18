import JSON5 from 'json5'
import { Binary, Decimal128, Double, EJSON, Int32, Long, ObjectId, Timestamp } from 'bson'

/** A parsed line of Mongo shell input. */
export type MongoCommand =
  | { kind: 'show'; what: 'dbs' | 'collections' | 'users' }
  | { kind: 'use'; db: string }
  | { kind: 'db'; method: string; args: unknown[] }
  | { kind: 'collection'; collection: string; method: string; args: unknown[]; chain: { method: string; args: unknown[] }[] }

const HELPERS: Record<string, (inner: string) => string> = {
  ObjectId: (v) => `{"$oid":${quoted(v)}}`,
  ObjectID: (v) => `{"$oid":${quoted(v)}}`,
  ISODate: (v) => `{"$date":${v.trim() ? quoted(v) : JSON.stringify(new Date().toISOString())}}`,
  Date: (v) => `{"$date":${v.trim() ? quoted(v) : JSON.stringify(new Date().toISOString())}}`,
  NumberLong: (v) => `{"$numberLong":${quoted(v)}}`,
  NumberInt: (v) => `{"$numberInt":${quoted(v)}}`,
  NumberDecimal: (v) => `{"$numberDecimal":${quoted(v)}}`,
  UUID: (v) => `{"$uuid":${quoted(v)}}`
}

/** The helper's argument as a JSON string, whether it was written quoted or bare. */
function quoted(inner: string): string {
  const t = inner.trim()
  if (/^(['"]).*\1$/s.test(t)) return JSON.stringify(t.slice(1, -1))
  return JSON.stringify(t)
}

/** Index just past the bracket that closes the one at `open` (strings and regexes respected). */
function matchBracket(text: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
  const stack = [pairs[text[open]]]
  let i = open + 1
  while (i < text.length && stack.length) {
    const ch = text[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      i++
      while (i < text.length && text[i] !== ch) i += text[i] === '\\' ? 2 : 1
    } else if (pairs[ch]) stack.push(pairs[ch])
    else if (ch === stack[stack.length - 1]) stack.pop()
    i++
  }
  if (stack.length) throw new Error('Unbalanced brackets.')
  return i
}

/**
 * Turn shell syntax into Extended JSON text that JSON5 can parse: ObjectId("..") becomes
 * {"$oid": ".."}, /re/i becomes a $regularExpression, and so on. Strings pass through untouched.
 */
export function shellToEjsonText(src: string): string {
  let out = ''
  let i = 0
  let lastSignificant = ''
  while (i < src.length) {
    const ch = src[i]
    if (ch === '"' || ch === "'") {
      const start = i
      i++
      while (i < src.length && src[i] !== ch) i += src[i] === '\\' ? 2 : 1
      i++
      out += src.slice(start, i)
      lastSignificant = ch
      continue
    }
    // A regex literal can only start where a value can.
    if (ch === '/' && src[i + 1] !== '/' && src[i + 1] !== '*' && (lastSignificant === '' || '(,[{:'.includes(lastSignificant))) {
      let j = i + 1
      let inClass = false
      while (j < src.length && (src[j] !== '/' || inClass)) {
        if (src[j] === '\\') j++
        else if (src[j] === '[') inClass = true
        else if (src[j] === ']') inClass = false
        j++
      }
      const pattern = src.slice(i + 1, j)
      const flags = /^[a-z]*/.exec(src.slice(j + 1))![0]
      out += `{"$regularExpression":{"pattern":${JSON.stringify(pattern)},"options":${JSON.stringify(flags)}}}`
      i = j + 1 + flags.length
      lastSignificant = '}'
      continue
    }
    const ident = /^(new\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(src.slice(i))
    if (ident && HELPERS[ident[2]] && !/[\w$.]/.test(src[i - 1] ?? '')) {
      const open = i + ident[0].length - 1
      const close = matchBracket(src, open)
      out += HELPERS[ident[2]](src.slice(open + 1, close - 1))
      i = close
      lastSignificant = '}'
      continue
    }
    out += ch
    if (!/\s/.test(ch)) lastSignificant = ch
    i++
  }
  return out
}

/** Parse a comma-separated argument list into BSON-typed values. */
export function parseArgs(text: string): unknown[] {
  if (!text.trim()) return []
  const json = JSON5.parse(`[${shellToEjsonText(text)}]`)
  return EJSON.deserialize(json as never, { relaxed: false }) as unknown as unknown[]
}

/** A value typed into a grid cell: shell/JSON syntax if it parses ("46", "true", "{a:1}"), else the raw string. */
export function parseCellValue(text: string): unknown {
  try {
    const [v] = parseArgs(text)
    return v
  } catch {
    return text
  }
}

export function parseShell(input: string): MongoCommand {
  const text = input.trim().replace(/;\s*$/, '')
  const show = /^show\s+(dbs|databases|collections|tables|users)$/i.exec(text)
  if (show) {
    const w = show[1].toLowerCase()
    return { kind: 'show', what: w === 'databases' || w === 'dbs' ? 'dbs' : w === 'users' ? 'users' : 'collections' }
  }
  const use = /^use\s+([\w.-]+)$/i.exec(text)
  if (use) return { kind: 'use', db: use[1] }
  if (!/^db\b/.test(text)) throw new Error('Commands start with db. (for example db.users.find({})), show dbs, show collections or use <db>.')

  // Read db.a.b(...).c(...) as a list of property names, each with call arguments if called.
  const parts: { name: string; args?: string }[] = []
  let i = 2
  while (i < text.length) {
    const rest = text.slice(i)
    const ws = /^\s*/.exec(rest)![0].length
    i += ws
    if (text[i] === '.') {
      const m = /^\.\s*([A-Za-z_$][\w$]*)/.exec(text.slice(i))
      if (!m) throw new Error(`Unexpected input near "${text.slice(i, i + 20)}".`)
      parts.push({ name: m[1] })
      i += m[0].length
    } else if (text[i] === '[') {
      const close = matchBracket(text, i)
      parts.push({ name: String(JSON5.parse(text.slice(i + 1, close - 1))) })
      i = close
    } else if (text[i] === '(') {
      const close = matchBracket(text, i)
      if (!parts.length) throw new Error('Unexpected "(".')
      parts[parts.length - 1].args = text.slice(i + 1, close - 1)
      i = close
    } else if (i < text.length) {
      throw new Error(`Unexpected input near "${text.slice(i, i + 20)}".`)
    }
  }
  if (!parts.length) throw new Error('Nothing to run after db.')

  let collection: string
  let rest: typeof parts
  if (parts[0].name === 'getCollection' && parts[0].args !== undefined) {
    collection = String(parseArgs(parts[0].args)[0])
    rest = parts.slice(1)
  } else if (parts[0].args !== undefined) {
    return { kind: 'db', method: parts[0].name, args: parseArgs(parts[0].args) }
  } else {
    // Collection names may contain dots (db.system.users); everything up to the first call is the name.
    const firstCall = parts.findIndex((p) => p.args !== undefined)
    if (firstCall <= 0) throw new Error('Call a method on the collection, for example db.users.find({}).')
    collection = parts.slice(0, firstCall).map((p) => p.name).join('.')
    rest = parts.slice(firstCall)
  }
  if (!rest.length || rest[0].args === undefined) throw new Error(`Call a method on ${collection}, for example .find({}).`)
  const [method, ...chain] = rest
  return {
    kind: 'collection',
    collection,
    method: method.name,
    args: parseArgs(method.args ?? ''),
    chain: chain.map((c) => {
      if (c.args === undefined) throw new Error(`.${c.name} must be called, for example .${c.name}().`)
      return { method: c.name, args: parseArgs(c.args) }
    })
  }
}

const SAFE_KEY = /^[A-Za-z_$][\w$]*$/

/** Render a BSON value the way the shell prints it, for grid cells and change previews. */
export function toShell(v: unknown, compact = true): string {
  if (v === null || v === undefined) return 'null'
  if (v instanceof ObjectId) return `ObjectId("${v.toHexString()}")`
  if (v instanceof Date) return `ISODate("${Number.isNaN(v.getTime()) ? 'invalid' : v.toISOString()}")`
  if (v instanceof Long) return `NumberLong("${v.toString()}")`
  if (v instanceof Decimal128) return `NumberDecimal("${v.toString()}")`
  if (v instanceof Int32 || v instanceof Double) return String(v.valueOf())
  if (v instanceof Timestamp) return `Timestamp(${v.high}, ${v.low})`
  if (v instanceof Binary) return v.sub_type === 4 ? `UUID("${v.toUUID().toHexString()}")` : `BinData(${v.sub_type}, "${Buffer.from(v.buffer).toString('base64')}")`
  if (v instanceof RegExp) return String(v)
  if (Array.isArray(v)) return `[${v.map((x) => toShell(x, compact)).join(compact ? ', ' : ', ')}]`
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (o._bsontype === 'BSONRegExp') return `/${String(o.pattern)}/${String(o.options)}`
    const entries = Object.entries(o).map(([k, x]) => `${SAFE_KEY.test(k) ? k : JSON.stringify(k)}: ${toShell(x, compact)}`)
    return `{ ${entries.join(', ')} }`
  }
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'bigint') return `NumberLong("${v}")`
  return String(v)
}

/** Grid cell for a document field: scalars stay scalars, BSON types and nesting use shell syntax. */
export function toCell(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v)
  if (v instanceof Int32 || v instanceof Double) return v.valueOf()
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString()
  return toShell(v)
}

/** Type label for a field value in result headers and inferred structure. */
export function bsonType(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (v instanceof ObjectId) return 'objectId'
  if (v instanceof Date) return 'date'
  if (v instanceof Long) return 'long'
  if (v instanceof Decimal128) return 'decimal'
  if (v instanceof Int32) return 'int'
  if (v instanceof Double) return 'double'
  if (v instanceof Binary) return 'binData'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double'
  if (typeof v === 'object') return 'object'
  return typeof v
}
