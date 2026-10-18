import {
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ExecuteStatementCommand,
  ListTablesCommand,
  ScanCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  type TableDescription,
  type TransactWriteItem
} from '@aws-sdk/client-dynamodb'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'
import JSON5 from 'json5'
import type { AdminAction, CellValue, ChangeSet, ColumnDef, ConnectionConfig, ConnectionSecrets, EditValue, RowChange, TableRequest } from '@shared/types'
import type { DriverSession, RawStatementResult } from './types'
import { MAX_RESULT_ROWS } from './sql'

type Item = Record<string, unknown>

/** Numbers stay as their exact decimal text; DynamoDB numbers can exceed JS precision. */
const fromDynamo = (item: Record<string, AttributeValue>): Item => unmarshall(item, { wrapNumbers: (v: string) => ({ __n: v }) })

function cell(v: unknown): CellValue {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') return v
  if (typeof v === 'object' && v !== null && '__n' in v) return (v as { __n: string }).__n
  if (v instanceof Uint8Array) return `0x${Buffer.from(v).subarray(0, 64).toString('hex')}`
  if (v instanceof Set) return JSON.stringify([...v].map(cell))
  return JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && '__n' in x ? Number(x.__n) : x instanceof Set ? [...x] : x))
}

/** DynamoDB's one- and two-letter type codes, spelled out for column headers. */
const TYPE_LABELS: Record<string, string> = { S: 'string', N: 'number', B: 'binary', BOOL: 'bool', NULL: 'null', SS: 'string set', NS: 'number set', BS: 'binary set', L: 'list', M: 'map' }
const label = (code: string) => TYPE_LABELS[code] ?? code

const attrType = (v: unknown): string => {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'string') return 'S'
  if (typeof v === 'boolean') return 'BOOL'
  if (typeof v === 'object' && '__n' in (v as object)) return 'N'
  if (v instanceof Uint8Array) return 'B'
  if (v instanceof Set) return 'SS'
  if (Array.isArray(v)) return 'L'
  return 'M'
}

/** Grid text to an attribute value: key attributes use their declared type, others are inferred. */
function toAttr(value: EditValue | CellValue, declared?: string): AttributeValue {
  if (value === null) return { NULL: true }
  const s = String(value)
  if (declared === 'S') return { S: s }
  if (declared === 'N') return { N: s }
  if (declared === 'B') return { B: Buffer.from(s.replace(/^0x/i, ''), 'hex') }
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s.trim())) return { N: s.trim() }
  if (s === 'true' || s === 'false') return { BOOL: s === 'true' }
  if (/^[[{]/.test(s.trim())) {
    try {
      return marshall({ v: JSON5.parse(s) }, { removeUndefinedValues: true }).v
    } catch {
      // Not JSON after all: keep the text.
    }
  }
  return { S: s }
}

/** PartiQL-ish rendering of an attribute value, for change previews. */
function show(a: AttributeValue): string {
  if ('S' in a && a.S !== undefined) return `'${a.S.replace(/'/g, "''")}'`
  if ('N' in a && a.N !== undefined) return a.N
  if ('BOOL' in a && a.BOOL !== undefined) return String(a.BOOL)
  if ('NULL' in a) return 'NULL'
  if ('B' in a && a.B) return `0x${Buffer.from(a.B).toString('hex')}`
  return JSON.stringify(unmarshall({ v: a }).v)
}

export async function openDynamodb(cfg: ConnectionConfig, secrets: ConnectionSecrets): Promise<DriverSession> {
  const region = cfg.options?.region?.trim() || 'us-east-1'
  const endpoint = cfg.host?.trim() || undefined
  const client = new DynamoDBClient({
    region,
    endpoint,
    credentials: cfg.user ? { accessKeyId: cfg.user, secretAccessKey: secrets.password ?? '' } : undefined,
    maxAttempts: 2
  })
  // Fails fast on bad credentials or an unreachable endpoint.
  await client.send(new ListTablesCommand({ Limit: 1 }))

  const describeCache = new Map<string, TableDescription>()
  const describe = async (table: string, fresh = false) => {
    if (!fresh && describeCache.has(table)) return describeCache.get(table)!
    const res = await client.send(new DescribeTableCommand({ TableName: table }))
    describeCache.set(table, res.Table!)
    return res.Table!
  }
  const keyInfo = async (table: string) => {
    const t = await describe(table)
    const defs = new Map((t.AttributeDefinitions ?? []).map((d) => [d.AttributeName!, d.AttributeType!]))
    const keys = (t.KeySchema ?? []).map((k) => ({ name: k.AttributeName!, role: k.KeyType!, type: defs.get(k.AttributeName!) ?? 'S' }))
    return { keys, defs }
  }

  const listTables = async () => {
    const out: string[] = []
    let start: string | undefined
    do {
      const res = await client.send(new ListTablesCommand({ ExclusiveStartTableName: start, Limit: 100 }))
      out.push(...(res.TableNames ?? []))
      start = res.LastEvaluatedTableName
    } while (start)
    return out.sort()
  }

  /** Scan until `want` items are collected (Scan's Limit counts evaluated items per page). */
  const scan = async (table: string, want: number): Promise<Item[]> => {
    const items: Item[] = []
    let start: Record<string, AttributeValue> | undefined
    do {
      const res = await client.send(new ScanCommand({ TableName: table, ExclusiveStartKey: start, Limit: Math.min(1000, want - items.length) }))
      items.push(...(res.Items ?? []).map(fromDynamo))
      start = res.LastEvaluatedKey
    } while (start && items.length < want)
    return items
  }

  const itemsToRaw = (items: Item[], keyNames: string[] = [], truncated = false): RawStatementResult => {
    const names = [...keyNames]
    for (const it of items) for (const k of Object.keys(it)) if (!names.includes(k)) names.push(k)
    return {
      hasRows: true,
      columns: names.map((n) => ({ name: n, type: label(attrType(items.find((it) => it[n] !== undefined)?.[n])) })),
      rows: items.map((it) => names.map((n) => cell(it[n]))),
      affected: null,
      command: '',
      truncated
    }
  }

  /** One transaction item per change; conditions make missing or duplicate rows fail instead of silently upserting. */
  const transactItem = async (c: RowChange, table: string): Promise<{ item: TransactWriteItem; preview: string }> => {
    const { keys, defs } = await keyInfo(table)
    const t = `"${table.replace(/"/g, '""')}"`
    const keyOf = (values: Record<string, CellValue>) => Object.fromEntries(keys.map((k) => [k.name, toAttr(values[k.name] ?? null, k.type)]))
    const where = (key: Record<string, AttributeValue>) => keys.map((k) => `"${k.name}" = ${show(key[k.name])}`).join(' AND ')
    const exists = `attribute_exists(#k0)`
    const names = { '#k0': keys[0].name }
    switch (c.kind) {
      case 'update': {
        const key = keyOf(c.key.values)
        const sets: string[] = []
        const removes: string[] = []
        const exprNames: Record<string, string> = { ...names }
        const exprValues: Record<string, AttributeValue> = {}
        Object.entries(c.set).forEach(([col, v], i) => {
          if (keys.some((k) => k.name === col)) throw new Error(`"${col}" is part of the key; delete the item and add a new one instead.`)
          exprNames[`#a${i}`] = col
          if (v === null) removes.push(`#a${i}`)
          else {
            exprValues[`:v${i}`] = toAttr(v, defs.get(col))
            sets.push(`#a${i} = :v${i}`)
          }
        })
        const expr = [sets.length ? `SET ${sets.join(', ')}` : '', removes.length ? `REMOVE ${removes.join(', ')}` : ''].filter(Boolean).join(' ')
        const setParts = Object.entries(c.set).filter(([, v]) => v !== null).map(([col, v]) => `"${col}" = ${show(toAttr(v, defs.get(col)))}`)
        const removeParts = Object.entries(c.set).filter(([, v]) => v === null).map(([col]) => `"${col}"`)
        const previewSets = [setParts.length ? `SET ${setParts.join(', ')}` : '', removeParts.length ? `REMOVE ${removeParts.join(', ')}` : ''].filter(Boolean).join(' ')
        return {
          item: { Update: { TableName: table, Key: key, UpdateExpression: expr, ConditionExpression: exists, ExpressionAttributeNames: exprNames, ...(Object.keys(exprValues).length ? { ExpressionAttributeValues: exprValues } : {}) } },
          preview: `UPDATE ${t} ${previewSets} WHERE ${where(key)}`
        }
      }
      case 'insert': {
        const item = Object.fromEntries(Object.entries(c.values).filter(([, v]) => v !== null).map(([col, v]) => [col, toAttr(v, defs.get(col))]))
        for (const k of keys) if (!item[k.name]) throw new Error(`New items need the key attribute "${k.name}".`)
        return {
          item: { Put: { TableName: table, Item: item, ConditionExpression: 'attribute_not_exists(#k0)', ExpressionAttributeNames: names } },
          preview: `INSERT INTO ${t} VALUE {${Object.entries(item).map(([k, v]) => `'${k}': ${show(v)}`).join(', ')}}`
        }
      }
      case 'delete': {
        const key = keyOf(c.key.values)
        return { item: { Delete: { TableName: table, Key: key, ConditionExpression: exists, ExpressionAttributeNames: names } }, preview: `DELETE FROM ${t} WHERE ${where(key)}` }
      }
    }
  }

  let running: AbortController | null = null

  return {
    serverVersion: `DynamoDB · ${region}${endpoint ? ` (${endpoint})` : ''}`,

    listDatabases: async () => [region],
    currentDatabase: () => region,
    async switchDatabase() {
      throw new Error('Open another connection to use a different region.')
    },

    async tree() {
      return [{ kind: 'schema', name: region, schema: region, children: (await listTables()).map((name) => ({ kind: 'table' as const, name, schema: region })) }]
    },

    columns: (_schema, table) => describeColumns(table),

    async fetchTable(req: TableRequest) {
      if (req.filters.length) throw new Error('DynamoDB filters run as a scan; use PartiQL in the query editor (SELECT … WHERE …).')
      const started = performance.now()
      const { keys } = await keyInfo(req.table)
      const items = (await scan(req.table, req.offset + req.limit)).slice(req.offset)
      const raw = itemsToRaw(items, keys.map((k) => k.name))
      if (req.orderBy) {
        // Scans have no order; sort the page that was read.
        const i = raw.columns.findIndex((c) => c.name === req.orderBy!.column)
        raw.rows.sort((a, b) => {
          const x = a[i] ?? ''
          const y = b[i] ?? ''
          const cmp = String(x).localeCompare(String(y), undefined, { numeric: true })
          return req.orderBy!.dir === 'desc' ? -cmp : cmp
        })
      }
      return { columns: raw.columns, rows: raw.rows, durationMs: performance.now() - started, sql: `Scan "${req.table}" (${req.offset}–${req.offset + req.limit})${req.orderBy ? ' · page sorted locally' : ''}` }
    },

    async countTable(req) {
      const t = await describe(req.table, true)
      // ItemCount refreshes about every six hours; small tables get an exact scan count instead.
      if ((t.ItemCount ?? 0) > 10_000) return t.ItemCount!
      let count = 0
      let start: Record<string, AttributeValue> | undefined
      do {
        const res = await client.send(new ScanCommand({ TableName: req.table, Select: 'COUNT', ExclusiveStartKey: start }))
        count += res.Count ?? 0
        start = res.LastEvaluatedKey
      } while (start)
      return count
    },

    changes: {
      async preview(set: ChangeSet) {
        return Promise.all(set.changes.map(async (c) => (await transactItem(c, set.table)).preview))
      },
      async apply(set: ChangeSet) {
        if (set.changes.length > 100) throw new Error('DynamoDB transactions hold at most 100 changes; commit in smaller batches.')
        const items = await Promise.all(set.changes.map(async (c) => (await transactItem(c, set.table)).item))
        try {
          await client.send(new TransactWriteItemsCommand({ TransactItems: items }))
        } catch (err) {
          const e = err as { name?: string; message?: string }
          if (e.name === 'TransactionCanceledException') {
            throw new Error(`Nothing was saved: an item was changed, deleted or already exists (${e.message ?? 'condition failed'}).`)
          }
          throw err
        }
        return items.length
      }
    },

    async runStatement(statement) {
      const items: Item[] = []
      let next: string | undefined
      running = new AbortController()
      try {
        do {
          const res = await client.send(new ExecuteStatementCommand({ Statement: statement, NextToken: next }), { abortSignal: running.signal })
          items.push(...(res.Items ?? []).map(fromDynamo))
          next = res.NextToken
        } while (next && items.length <= MAX_RESULT_ROWS && /^\s*select\b/i.test(statement))
      } finally {
        running = null
      }
      if (!/^\s*select\b/i.test(statement)) return { hasRows: false, columns: [], rows: [], affected: null, command: statement.trim().split(/\s+/)[0].toUpperCase(), truncated: false }
      const truncated = items.length > MAX_RESULT_ROWS || Boolean(next)
      return itemsToRaw(items.slice(0, MAX_RESULT_ROWS), [], truncated)
    },

    // PartiQL has no read-only mode; read-only connections are guarded by the statement check before sending.
    withReadOnly: (fn) => fn(),

    canCancel: false,
    async cancel() {
      running?.abort()
    },

    async completions() {
      const tables = (await listTables()).slice(0, 100)
      const out = []
      for (const name of tables) {
        const { keys, defs } = await keyInfo(name).catch(() => ({ keys: [], defs: new Map<string, string>() }))
        out.push({ schema: region, name, kind: 'table' as const, columns: [...new Set([...keys.map((k) => k.name), ...defs.keys()])].map((n) => ({ name: n, type: defs.get(n) ?? '' })) })
      }
      return out
    },

    async structure(_schema, table) {
      const t = await describe(table, true)
      const { keys } = await keyInfo(table)
      const columns = await describeColumns(table)
      const indexes = [
        { name: 'PRIMARY', columns: keys.map((k) => k.name), unique: true, primary: true, method: keys.map((k) => `${k.name} (${k.role})`).join(', '), definition: null },
        ...(t.GlobalSecondaryIndexes ?? []).map((g) => ({ name: g.IndexName!, columns: (g.KeySchema ?? []).map((k) => k.AttributeName!), unique: false, primary: false, method: `GSI · ${g.Projection?.ProjectionType ?? ''}`, definition: null })),
        ...(t.LocalSecondaryIndexes ?? []).map((l) => ({ name: l.IndexName!, columns: (l.KeySchema ?? []).map((k) => k.AttributeName!), unique: false, primary: false, method: `LSI · ${l.Projection?.ProjectionType ?? ''}`, definition: null }))
      ]
      const create = {
        TableName: t.TableName,
        KeySchema: t.KeySchema,
        AttributeDefinitions: t.AttributeDefinitions,
        BillingMode: t.BillingModeSummary?.BillingMode ?? 'PROVISIONED',
        ...(t.ProvisionedThroughput?.ReadCapacityUnits ? { ProvisionedThroughput: { ReadCapacityUnits: t.ProvisionedThroughput.ReadCapacityUnits, WriteCapacityUnits: t.ProvisionedThroughput.WriteCapacityUnits } } : {}),
        ...(t.GlobalSecondaryIndexes?.length ? { GlobalSecondaryIndexes: t.GlobalSecondaryIndexes.map((g) => ({ IndexName: g.IndexName, KeySchema: g.KeySchema, Projection: g.Projection })) } : {}),
        ...(t.StreamSpecification ? { StreamSpecification: t.StreamSpecification } : {})
      }
      return { schema: region, name: table, kind: 'table', columns, indexes, foreignKeys: [], triggers: [], ddl: `// aws dynamodb create-table --cli-input-json\n${JSON.stringify(create, null, 2)}` }
    },

    admin: {
      preview(action: AdminAction) {
        if (action.kind === 'dropObject') return [`DeleteTable { TableName: "${action.name}" }`]
        throw new Error('Only deleting a table is available for DynamoDB here.')
      },
      async apply(action: AdminAction) {
        if (action.kind !== 'dropObject') throw new Error('Only deleting a table is available for DynamoDB here.')
        await client.send(new DeleteTableCommand({ TableName: action.name }))
        describeCache.delete(action.name)
      }
    },

    async close() {
      client.destroy()
    }
  }

  /** Key attributes first (with their declared types), then attributes seen in a sample of items. */
  async function describeColumns(table: string): Promise<ColumnDef[]> {
    const { keys, defs } = await keyInfo(table)
    const raw = itemsToRaw(await scan(table, 50), keys.map((k) => k.name))
    return raw.columns.map((c) => {
      const key = keys.find((k) => k.name === c.name)
      return { name: c.name, type: key ? label(key.type) : defs.has(c.name) ? label(defs.get(c.name)!) : c.type, nullable: !key, defaultValue: null, isPrimaryKey: Boolean(key), autoIncrement: false, comment: key ? (key.role === 'HASH' ? 'partition key' : 'sort key') : null }
    })
  }
}
