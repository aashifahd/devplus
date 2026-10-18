import { readFileSync } from 'node:fs'
import Redis from 'ioredis'
import type { AdminAction, CellValue, ChangeSet, ColumnDef, ConnectionConfig, ConnectionSecrets, RowChange, TableRequest, TreeNode } from '@shared/types'
import type { DriverSession, Endpoint } from './types'
import { MAX_RESULT_ROWS } from './sql'

/** The tree entry that opens the key browser rather than a single key. */
export const ALL_KEYS = '*'
const PREVIEW = 200

type KeyType = 'string' | 'hash' | 'list' | 'set' | 'zset' | 'stream' | 'ReJSON-RL' | 'none'

const COLUMNS: Record<string, { name: string; type: string; pk?: boolean }[]> = {
  browser: [
    { name: 'key', type: 'key', pk: true },
    { name: 'type', type: 'type' },
    { name: 'ttl', type: 'seconds' },
    { name: 'size', type: 'int' },
    { name: 'value', type: 'preview' }
  ],
  string: [{ name: 'value', type: 'string', pk: true }],
  hash: [
    { name: 'field', type: 'string', pk: true },
    { name: 'value', type: 'string' }
  ],
  list: [
    { name: 'index', type: 'int', pk: true },
    { name: 'value', type: 'string' }
  ],
  set: [{ name: 'member', type: 'string', pk: true }],
  zset: [
    { name: 'member', type: 'string', pk: true },
    { name: 'score', type: 'double' }
  ],
  stream: [
    { name: 'id', type: 'string', pk: true },
    { name: 'fields', type: 'json' }
  ],
  'ReJSON-RL': [{ name: 'value', type: 'json', pk: true }],
  none: [{ name: 'value', type: 'string' }]
}

/** Split a command line into arguments, honouring "double" and 'single' quotes and \ escapes. */
export function parseCommandLine(line: string): string[] {
  const args: string[] = []
  let cur = ''
  let quote: string | null = null
  let started = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < line.length) {
        const n = line[++i]
        cur += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n
      } else if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started) args.push(cur)
      cur = ''
      started = false
    } else {
      cur += ch
      started = true
    }
  }
  if (quote) throw new Error('Unclosed quote.')
  if (started) args.push(cur)
  return args
}

/** SCAN MATCH pattern from the filter bar; only the key name can be filtered in Redis. */
function keyPattern(req: TableRequest): string {
  const escape = (s: string) => s.replace(/[*?[\]\\]/g, (c) => `\\${c}`)
  let pattern = '*'
  for (const f of req.filters) {
    if (f.column !== 'key') throw new Error('Redis can only filter keys by name.')
    switch (f.op) {
      case 'contains': pattern = `*${escape(f.value)}*`; break
      case 'starts with': pattern = `${escape(f.value)}*`; break
      case '=': pattern = escape(f.value); break
      case 'like': pattern = f.value.replace(/%/g, '*').replace(/_/g, '?'); break
      default: throw new Error(`Key filters support contains, starts with, = and like (not "${f.op}").`)
    }
  }
  return pattern
}

const cellOf = (v: unknown): CellValue => (v === null || v === undefined ? null : typeof v === 'number' ? v : Array.isArray(v) ? JSON.stringify(v) : String(v))

export async function openRedis(cfg: ConnectionConfig, secrets: ConnectionSecrets, endpoint: Endpoint): Promise<DriverSession> {
  let db = Number.parseInt(cfg.database || '0', 10) || 0
  const scanLimit = Number.parseInt(cfg.options?.scanLimit || '1000', 10) || 1000
  const tls = cfg.ssl.mode === 'require' || cfg.ssl.mode === 'verify-full'
    ? { rejectUnauthorized: cfg.ssl.mode === 'verify-full', ...(cfg.ssl.caPath ? { ca: readFileSync(cfg.ssl.caPath, 'utf8') } : {}) }
    : undefined
  const redis = new Redis({
    host: endpoint.host,
    port: endpoint.port,
    username: cfg.user || undefined,
    password: secrets.password || undefined,
    db,
    tls,
    lazyConnect: true,
    connectTimeout: 15000,
    maxRetriesPerRequest: 1,
    connectionName: 'devplus'
  })
  redis.on('error', () => {
    // Connection errors surface through the failing command; avoid unhandled-event crashes.
  })
  await redis.connect()

  const infoText = String(await redis.info('server'))
  const version = /redis_version:([^\r\n]+)/.exec(infoText)?.[1] ?? ''
  const flavour = /valkey/i.test(infoText) ? 'Valkey' : 'Redis'

  const typeOf = async (key: string) => String(await redis.type(key)) as KeyType

  /** SCAN until `want` matching keys are collected (or the scan cap is hit). */
  const scanKeys = async (pattern: string, want: number): Promise<string[]> => {
    const keys: string[] = []
    let cursor = '0'
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000)
      keys.push(...batch)
      cursor = next
    } while (cursor !== '0' && keys.length < want)
    return keys
  }

  const sizeOf = (type: KeyType, key: string): Promise<number> => {
    switch (type) {
      case 'string': return redis.strlen(key)
      case 'hash': return redis.hlen(key)
      case 'list': return redis.llen(key)
      case 'set': return redis.scard(key)
      case 'zset': return redis.zcard(key)
      case 'stream': return redis.xlen(key)
      default: return Promise.resolve(0)
    }
  }

  const previewOf = async (type: KeyType, key: string): Promise<string> => {
    const clip = (s: string) => (s.length > PREVIEW ? `${s.slice(0, PREVIEW)}…` : s)
    switch (type) {
      case 'string': return clip(String((await redis.getrange(key, 0, PREVIEW)) ?? ''))
      case 'hash': return clip(JSON.stringify(Object.fromEntries((await redis.hscan(key, '0', 'COUNT', 10))[1].reduce<[string, string][]>((acc, v, i, a) => (i % 2 ? acc : [...acc, [v, a[i + 1]]]), []))))
      case 'list': return clip(JSON.stringify(await redis.lrange(key, 0, 9)))
      case 'set': return clip(JSON.stringify((await redis.sscan(key, '0', 'COUNT', 10))[1]))
      case 'zset': return clip(JSON.stringify(await redis.zrange(key, '0', '9')))
      case 'stream': return clip(JSON.stringify(await redis.xrange(key, '-', '+', 'COUNT', 3)))
      case 'ReJSON-RL': return clip(String(await redis.call('JSON.GET', key)))
      default: return ''
    }
  }

  /** Rows for one key, depending on its type. Paging uses native ranges where the type has an order. */
  const keyRows = async (key: string, offset: number, limit: number): Promise<{ type: KeyType; rows: CellValue[][] }> => {
    const type = await typeOf(key)
    switch (type) {
      case 'string':
        return { type, rows: [[await redis.get(key)]] }
      case 'hash': {
        const all = await redis.hgetall(key)
        return { type, rows: Object.entries(all).slice(offset, offset + limit).map(([f, v]) => [f, v]) }
      }
      case 'list':
        return { type, rows: (await redis.lrange(key, offset, offset + limit - 1)).map((v, i) => [offset + i, v]) }
      case 'set':
        return { type, rows: (await redis.smembers(key)).sort().slice(offset, offset + limit).map((m) => [m]) }
      case 'zset': {
        const flat = await redis.zrange(key, String(offset), String(offset + limit - 1), 'WITHSCORES')
        const rows: CellValue[][] = []
        for (let i = 0; i < flat.length; i += 2) rows.push([flat[i], Number(flat[i + 1])])
        return { type, rows }
      }
      case 'stream': {
        const entries = (await redis.xrange(key, '-', '+', 'COUNT', offset + limit)).slice(offset)
        return { type, rows: entries.map(([id, fields]) => [id, JSON.stringify(Object.fromEntries(fields.reduce<[string, string][]>((acc, v, i, a) => (i % 2 ? acc : [...acc, [v, a[i + 1]]]), [])))]) }
      }
      case 'ReJSON-RL':
        return { type, rows: [[String(await redis.call('JSON.GET', key))]] }
      default:
        return { type: 'none', rows: [] }
    }
  }

  const describe = (c: RowChange, table: string, type: KeyType | 'browser'): string[] => {
    const q = (s: unknown) => JSON.stringify(String(s))
    if (type === 'browser') {
      const key = c.kind === 'insert' ? c.values.key : String(c.key.values.key)
      if (c.kind === 'delete') return [`DEL ${q(key)}`]
      if (c.kind === 'insert') return [`SET ${q(c.values.key)} ${q(c.values.value ?? '')}`]
      const out: string[] = []
      if ('value' in c.set) out.push(`SET ${q(key)} ${q(c.set.value ?? '')} KEEPTTL`)
      if ('ttl' in c.set) out.push(c.set.ttl === null || Number(c.set.ttl) < 0 ? `PERSIST ${q(key)}` : `EXPIRE ${q(key)} ${Number(c.set.ttl)}`)
      if ('key' in c.set && c.set.key) out.push(`RENAMENX ${q(key)} ${q(c.set.key)}`)
      return out
    }
    const k = q(table)
    switch (type) {
      case 'string':
        return c.kind === 'update' ? [`SET ${k} ${q(c.set.value ?? '')} KEEPTTL`] : c.kind === 'delete' ? [`DEL ${k}`] : [`SET ${k} ${q(c.values.value ?? '')}`]
      case 'hash':
        if (c.kind === 'delete') return [`HDEL ${k} ${q(c.key.values.field)}`]
        if (c.kind === 'insert') return [`HSET ${k} ${q(c.values.field ?? '')} ${q(c.values.value ?? '')}`]
        return 'field' in c.set
          ? [`HDEL ${k} ${q(c.key.values.field)}`, `HSET ${k} ${q(c.set.field)} ${q(c.set.value ?? '')}`]
          : [`HSET ${k} ${q(c.key.values.field)} ${q(c.set.value ?? '')}`]
      case 'list':
        if (c.kind === 'insert') return [`RPUSH ${k} ${q(c.values.value ?? '')}`]
        // Lists have no stable member identity; delete by marking the slot and removing the marker.
        if (c.kind === 'delete') return [`LSET ${k} ${Number(c.key.values.index)} "__devplus_deleted__"`, `LREM ${k} 1 "__devplus_deleted__"`]
        return [`LSET ${k} ${Number(c.key.values.index)} ${q(c.set.value ?? '')}`]
      case 'set':
        if (c.kind === 'insert') return [`SADD ${k} ${q(c.values.member ?? '')}`]
        if (c.kind === 'delete') return [`SREM ${k} ${q(c.key.values.member)}`]
        return [`SREM ${k} ${q(c.key.values.member)}`, `SADD ${k} ${q(c.set.member ?? '')}`]
      case 'zset':
        if (c.kind === 'insert') return [`ZADD ${k} ${Number(c.values.score ?? 0)} ${q(c.values.member ?? '')}`]
        if (c.kind === 'delete') return [`ZREM ${k} ${q(c.key.values.member)}`]
        return 'member' in c.set
          ? [`ZREM ${k} ${q(c.key.values.member)}`, `ZADD ${k} ${Number(c.set.score ?? 0)} ${q(c.set.member)}`]
          : [`ZADD ${k} XX ${Number(c.set.score ?? 0)} ${q(c.key.values.member)}`]
      default:
        throw new Error(`Editing ${type} values is not supported; use the command editor.`)
    }
  }

  const tableType = async (table: string): Promise<KeyType | 'browser'> => (table === ALL_KEYS ? 'browser' : typeOf(table))

  return {
    serverVersion: `${flavour} ${version}`,

    async listDatabases() {
      try {
        const [, n] = (await redis.config('GET', 'databases')) as string[]
        return Array.from({ length: Number(n) || 16 }, (_, i) => String(i))
      } catch {
        // Managed Redis often blocks CONFIG; the standard sixteen is a reasonable guess.
        return Array.from({ length: 16 }, (_, i) => String(i))
      }
    },

    currentDatabase: () => String(db),

    async switchDatabase(name) {
      const n = Number.parseInt(name, 10)
      if (!Number.isInteger(n) || n < 0) throw new Error('Redis databases are numbered 0, 1, 2…')
      await redis.select(n)
      db = n
    },

    async tree() {
      const keys = (await scanKeys('*', scanLimit)).slice(0, scanLimit).sort()
      return [
        {
          kind: 'schema',
          name: `db${db}`,
          schema: String(db),
          children: [{ kind: 'table', name: ALL_KEYS, schema: String(db) } as TreeNode, ...keys.map((k) => ({ kind: 'table', name: k, schema: String(db) }) as TreeNode)]
        }
      ]
    },

    async columns(_schema, table) {
      const type = await tableType(table)
      return (COLUMNS[type] ?? COLUMNS.none).map((c) => ({ name: c.name, type: c.type, nullable: !c.pk, defaultValue: null, isPrimaryKey: Boolean(c.pk), autoIncrement: false, comment: null }) satisfies ColumnDef)
    },

    async fetchTable(req: TableRequest) {
      const started = performance.now()
      if (req.table === ALL_KEYS) {
        const pattern = keyPattern(req)
        let keys = await scanKeys(pattern, Math.max(req.offset + req.limit, scanLimit))
        if (req.orderBy?.column === 'key') keys.sort((a, b) => (req.orderBy!.dir === 'desc' ? b.localeCompare(a) : a.localeCompare(b)))
        keys = keys.slice(req.offset, req.offset + req.limit)
        const rows: CellValue[][] = []
        for (const key of keys) {
          const type = await typeOf(key)
          const [ttl, size, preview] = await Promise.all([redis.ttl(key), sizeOf(type, key), previewOf(type, key)])
          rows.push([key, type, ttl, size, preview])
        }
        return { columns: COLUMNS.browser.map(({ name, type }) => ({ name, type })), rows, durationMs: performance.now() - started, sql: `SCAN 0 MATCH ${pattern} COUNT 1000` }
      }
      if (req.filters.length) throw new Error('Filters apply to the key browser only.')
      const { type, rows } = await keyRows(req.table, req.offset, req.limit)
      return { columns: (COLUMNS[type] ?? COLUMNS.none).map(({ name, type: t }) => ({ name, type: t })), rows, durationMs: performance.now() - started, sql: `TYPE ${req.table} → ${type}` }
    },

    async countTable(req) {
      if (req.table === ALL_KEYS) return req.filters.length ? (await scanKeys(keyPattern(req), 100_000)).length : redis.dbsize()
      const type = await typeOf(req.table)
      return type === 'string' || type === 'ReJSON-RL' ? 1 : sizeOf(type, req.table)
    },

    changes: {
      async preview(set: ChangeSet) {
        const type = await tableType(set.table)
        return set.changes.flatMap((c) => describe(c, set.table, type))
      },
      async apply(set: ChangeSet) {
        const type = await tableType(set.table)
        const commands = set.changes.flatMap((c) => describe(c, set.table, type)).map(parseCommandLine)
        // MULTI/EXEC applies the whole set atomically.
        const tx = redis.multi()
        for (const [cmd, ...args] of commands) tx.call(cmd, ...args)
        const results = (await tx.exec()) ?? []
        const failed = results.find(([err]) => err)
        if (failed) throw failed[0]
        return set.changes.length
      }
    },

    async runStatement(line) {
      const [cmd, ...args] = parseCommandLine(line)
      if (!cmd) return { hasRows: false, columns: [], rows: [], affected: null, command: '', truncated: false }
      const upper = cmd.toUpperCase()
      if (upper === 'SELECT') db = Number(args[0]) || 0
      if (upper === 'MONITOR' || upper === 'SUBSCRIBE' || upper === 'PSUBSCRIBE') throw new Error(`${upper} streams forever and can't run in the editor.`)
      let result = await redis.call(cmd, ...args)
      // RESP3 maps arrive as objects and score pairs as nested [member, score] arrays: show both as two columns.
      if (result && typeof result === 'object' && !Array.isArray(result) && !Buffer.isBuffer(result)) {
        result = Object.entries(result as Record<string, unknown>)
      }
      if (Array.isArray(result) && result.length > 0 && result.every((x) => Array.isArray(x) && x.length === 2 && !Array.isArray(x[0]))) {
        const truncated = result.length > MAX_RESULT_ROWS
        const rows = (truncated ? result.slice(0, MAX_RESULT_ROWS) : result).map((x) => [cellOf((x as unknown[])[0]), cellOf((x as unknown[])[1])])
        const second = /WITHSCORES/i.test(line) ? 'score' : 'value'
        return { hasRows: true, columns: [{ name: second === 'score' ? 'member' : 'field', type: 'string' }, { name: second, type: 'string' }], rows, affected: null, command: upper, truncated }
      }
      const pairs = /^(HGETALL|CONFIG|XINFO|HRANDFIELD|ZRANGE|ZREVRANGE|ZRANGEBYSCORE)$/i.test(upper) && args.some((a) => /^withscores$/i.test(a) || upper === 'HGETALL' || upper === 'CONFIG')
      if (Array.isArray(result)) {
        const truncated = result.length > MAX_RESULT_ROWS * (pairs ? 2 : 1)
        const items = truncated ? result.slice(0, MAX_RESULT_ROWS * (pairs ? 2 : 1)) : result
        if (pairs) {
          const rows: CellValue[][] = []
          for (let i = 0; i < items.length; i += 2) rows.push([cellOf(items[i]), cellOf(items[i + 1])])
          return { hasRows: true, columns: [{ name: 'field', type: 'string' }, { name: 'value', type: 'string' }], rows, affected: null, command: upper, truncated }
        }
        return { hasRows: true, columns: [{ name: '#', type: 'int' }, { name: 'value', type: 'string' }], rows: items.map((v, i) => [i + 1, cellOf(v)]), affected: null, command: upper, truncated }
      }
      return { hasRows: true, columns: [{ name: 'result', type: typeof result === 'number' ? 'int' : 'string' }], rows: [[cellOf(result)]], affected: null, command: upper, truncated: false }
    },

    // Redis has no read-only mode per command; read-only connections are guarded before sending.
    withReadOnly: (fn) => fn(),

    canCancel: false,
    async cancel() {
      throw new Error('Redis commands cannot be cancelled.')
    },

    completions: async () => [],

    admin: {
      preview(action: AdminAction) {
        if (action.kind === 'dropObject' && action.name !== ALL_KEYS) return [`DEL ${JSON.stringify(action.name)}`]
        throw new Error('Only deleting a key is available for Redis here; use the command editor for anything else.')
      },
      async apply(action: AdminAction) {
        if (action.kind === 'dropObject' && action.name !== ALL_KEYS) {
          await redis.del(action.name)
          return
        }
        throw new Error('Only deleting a key is available for Redis here.')
      }
    },

    async processes() {
      const self = await redis.client('ID')
      const lines = String(await redis.client('LIST')).trim().split('\n')
      return lines.map((line) => {
        const f = Object.fromEntries(line.trim().split(' ').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]))
        return {
          id: f.id,
          user: f.user ?? null,
          database: f.db ?? null,
          client: f.addr ?? null,
          state: Number(f.idle) > 0 ? `idle ${f.idle}s` : 'active',
          seconds: Number(f.age),
          query: f.cmd ?? null,
          self: Number(f.id) === Number(self)
        }
      })
    },

    async kill(id) {
      await redis.client('KILL', 'ID', id)
    },

    async close() {
      redis.disconnect()
    }
  }
}
