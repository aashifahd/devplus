import { randomUUID } from 'node:crypto'
import { MongoClient, type Collection, type Db, type Document, type Filter } from 'mongodb'
import { ObjectId } from 'bson'
import type {
  AdminAction,
  CellValue,
  ChangeSet,
  ColumnDef,
  ConnectionConfig,
  ConnectionSecrets,
  RowChange,
  TableFilter,
  TableRequest,
  TreeNode
} from '@shared/types'
import type { DriverSession, Endpoint, RawStatementResult } from './types'
import { MAX_RESULT_ROWS } from './sql'
import { bsonType, parseCellValue, parseShell, toCell, toShell, type MongoCommand } from './mongoShell'

const SYSTEM_DBS = new Set(['admin', 'config', 'local'])
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Filter-bar values: shell syntax where it parses (31, true, ObjectId("…")), otherwise the text itself. */
const filterValue = (column: string, text: string): unknown => {
  if (column === '_id' && /^[0-9a-f]{24}$/i.test(text.trim())) return new ObjectId(text.trim())
  return parseCellValue(text)
}

function likeToRegex(pattern: string): RegExp {
  let re = ''
  for (const ch of pattern) re += ch === '%' ? '.*' : ch === '_' ? '.' : escapeRegex(ch)
  return new RegExp(`^${re}$`, 'i')
}

/** Translate the filter bar into a Mongo query document. */
export function toMongoFilter(filters: TableFilter[]): Filter<Document> {
  const and: Document[] = []
  for (const f of filters) {
    if (!f.column) continue
    const v = () => filterValue(f.column, f.value)
    switch (f.op) {
      case '=': and.push({ [f.column]: v() }); break
      case '!=': and.push({ [f.column]: { $ne: v() } }); break
      case '<': and.push({ [f.column]: { $lt: v() } }); break
      case '>': and.push({ [f.column]: { $gt: v() } }); break
      case '<=': and.push({ [f.column]: { $lte: v() } }); break
      case '>=': and.push({ [f.column]: { $gte: v() } }); break
      case 'contains': and.push({ [f.column]: { $regex: escapeRegex(f.value), $options: 'i' } }); break
      case 'not contains': and.push({ [f.column]: { $not: new RegExp(escapeRegex(f.value), 'i') } }); break
      case 'starts with': and.push({ [f.column]: { $regex: `^${escapeRegex(f.value)}`, $options: 'i' } }); break
      case 'like': and.push({ [f.column]: likeToRegex(f.value) }); break
      case 'in': and.push({ [f.column]: { $in: f.value.split(',').map((x) => filterValue(f.column, x.trim())) } }); break
      case 'is null': and.push({ [f.column]: null }); break
      case 'is not null': and.push({ [f.column]: { $ne: null } }); break
    }
  }
  return and.length === 0 ? {} : and.length === 1 ? and[0] : { $and: and }
}

/** Documents to a grid: _id first, then fields in first-seen order. */
function docsToRaw(docs: Document[], truncated = false): RawStatementResult {
  const keys: string[] = []
  if (docs.some((d) => '_id' in d)) keys.push('_id')
  for (const d of docs) for (const k of Object.keys(d)) if (!keys.includes(k)) keys.push(k)
  const types = keys.map((k) => bsonType(docs.find((d) => d[k] !== undefined && d[k] !== null)?.[k]))
  return {
    hasRows: true,
    columns: keys.map((k, i) => ({ name: k, type: types[i] })),
    rows: docs.map((d) => keys.map((k) => toCell(d[k]) as CellValue)),
    affected: null,
    command: '',
    truncated
  }
}

/** A grid cell back to the stored value: ObjectId("…") and other shell forms become BSON again. */
const fromCell = (v: CellValue): unknown => (typeof v === 'string' && /^(ObjectId|ISODate|NumberLong|NumberDecimal|UUID)\(/.test(v) ? parseCellValue(v) : v)

function mongoUri(cfg: ConnectionConfig, secrets: ConnectionSecrets, endpoint: Endpoint): string {
  if (cfg.options?.uri?.trim()) return cfg.options.uri.trim()
  const auth = cfg.user ? `${encodeURIComponent(cfg.user)}:${encodeURIComponent(secrets.password ?? '')}@` : ''
  const params = new URLSearchParams()
  if (cfg.user) params.set('authSource', cfg.options?.authSource?.trim() || 'admin')
  // A single host (or an SSH tunnel) must not be swapped for replica-set member names we can't reach.
  params.set('directConnection', 'true')
  if (cfg.ssl.mode === 'require' || cfg.ssl.mode === 'verify-full') params.set('tls', 'true')
  if (cfg.ssl.mode === 'require') params.set('tlsAllowInvalidCertificates', 'true')
  if (cfg.ssl.caPath) params.set('tlsCAFile', cfg.ssl.caPath)
  return `mongodb://${auth}${endpoint.host}:${endpoint.port}/?${params}`
}

export async function openMongodb(cfg: ConnectionConfig, secrets: ConnectionSecrets, endpoint: Endpoint): Promise<DriverSession> {
  const client = new MongoClient(mongoUri(cfg, secrets, endpoint), { appName: 'DevPlus', serverSelectionTimeoutMS: 15000 })
  await client.connect()
  const admin = client.db('admin')
  const info = await admin.command({ buildInfo: 1 })
  const hello = await admin.command({ hello: 1 })
  const replicaSet = Boolean(hello.setName)

  const listDbs = async (): Promise<string[]> => {
    try {
      const res = await admin.command({ listDatabases: 1, nameOnly: true })
      return (res.databases as { name: string }[]).map((d) => d.name).sort()
    } catch {
      // Users without listDatabases rights still see the database they connected to.
      return database ? [database] : []
    }
  }

  let database = cfg.database?.trim() || ''
  if (!database) database = (await listDbs()).find((d) => !SYSTEM_DBS.has(d)) ?? 'test'
  const db = (): Db => client.db(database)
  const coll = (name: string): Collection<Document> => db().collection(name)

  /** Every operation carries this comment so cancel() can find and kill it. */
  let runningTag: string | null = null
  const tagged = async <T>(fn: (comment: string) => Promise<T>): Promise<T> => {
    const tag = `devplus:${randomUUID()}`
    runningTag = tag
    try {
      return await fn(tag)
    } finally {
      runningTag = null
    }
  }

  const sample = async (name: string, n = 100) => coll(name).find({}, { limit: n }).toArray()

  const inferColumns = (docs: Document[]): ColumnDef[] => {
    const raw = docsToRaw(docs)
    return raw.columns.map((c) => {
      const present = docs.filter((d) => d[c.name] !== undefined && d[c.name] !== null).length
      return { name: c.name, type: c.type, nullable: c.name !== '_id' && present < docs.length, defaultValue: null, isPrimaryKey: c.name === '_id', autoIncrement: false, comment: null }
    })
  }

  const describe = (c: RowChange, collection: string): string => {
    const target = `db.getCollection(${JSON.stringify(collection)})`
    const keyOf = (k: Extract<RowChange, { key: unknown }>['key']) => toShell(Object.fromEntries(Object.entries(k.values).map(([f, v]) => [f, fromCell(v)])))
    switch (c.kind) {
      case 'update': {
        const set: Document = {}
        const unset: Document = {}
        for (const [f, v] of Object.entries(c.set)) {
          if (v === null) unset[f] = ''
          else set[f] = parseCellValue(v)
        }
        const update: Document = { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) }
        return `${target}.updateOne(${keyOf(c.key)}, ${toShell(update)})`
      }
      case 'insert':
        return `${target}.insertOne(${toShell(Object.fromEntries(Object.entries(c.values).map(([f, v]) => [f, v === null ? null : parseCellValue(v)])))})`
      case 'delete':
        return `${target}.deleteOne(${keyOf(c.key)})`
    }
  }

  const applyOne = async (c: RowChange, collection: string, session?: import('mongodb').ClientSession): Promise<number> => {
    const target = coll(collection)
    const filterOf = (k: Extract<RowChange, { key: unknown }>['key']): Document => {
      // Without _id the whole visible document is the key; Mongo then changes the first match.
      return Object.fromEntries(Object.entries(k.values).map(([f, v]) => [f, fromCell(v)]))
    }
    switch (c.kind) {
      case 'update': {
        const set: Document = {}
        const unset: Document = {}
        for (const [f, v] of Object.entries(c.set)) {
          if (v === null) unset[f] = ''
          else set[f] = parseCellValue(v)
        }
        const res = await target.updateOne(filterOf(c.key), { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { session })
        if (res.matchedCount !== 1) throw new Error('A document to update was not found (it may have been changed or deleted).')
        return 1
      }
      case 'insert':
        await target.insertOne(Object.fromEntries(Object.entries(c.values).map(([f, v]) => [f, v === null ? null : parseCellValue(v)])), { session })
        return 1
      case 'delete': {
        const res = await target.deleteOne(filterOf(c.key), { session })
        if (res.deletedCount !== 1) throw new Error('A document to delete was not found (it may have been changed or deleted).')
        return 1
      }
    }
  }

  /** Run one parsed shell command. */
  const execCommand = async (cmd: MongoCommand): Promise<RawStatementResult> => {
    const scalar = (name: string, value: unknown): RawStatementResult => ({
      hasRows: true,
      columns: [{ name, type: bsonType(value) }],
      rows: [[toCell(value) as CellValue]],
      affected: null,
      command: '',
      truncated: false
    })
    const done = (affected: number, command: string): RawStatementResult => ({ hasRows: false, columns: [], rows: [], affected, command, truncated: false })

    switch (cmd.kind) {
      case 'show':
        if (cmd.what === 'dbs') return docsToRaw((await listDbs()).map((name) => ({ name })))
        if (cmd.what === 'users') return docsToRaw(((await db().command({ usersInfo: 1 })).users as Document[]).map((u) => ({ user: u.user, db: u.db, roles: u.roles })))
        return docsToRaw((await db().listCollections({}, { nameOnly: true }).toArray()).map((c) => ({ name: c.name, type: c.type })))
      case 'use':
        database = cmd.db
        return done(0, `USE ${cmd.db}`)
      case 'db': {
        const [a, b] = cmd.args as [Document, Document]
        switch (cmd.method) {
          case 'runCommand':
          case 'adminCommand':
            return docsToRaw([await (cmd.method === 'adminCommand' ? admin : db()).command(a)])
          case 'getCollectionNames':
            return docsToRaw((await db().listCollections({}, { nameOnly: true }).toArray()).map((c) => ({ name: c.name })))
          case 'createCollection':
            await db().createCollection(String(a), (b ?? {}) as never)
            return done(0, 'CREATE COLLECTION')
          case 'stats':
            return docsToRaw([await db().command({ dbStats: 1 })])
          case 'dropDatabase':
            await db().dropDatabase()
            return done(0, 'DROP DATABASE')
          case 'getName':
            return scalar('name', database)
          default:
            throw new Error(`db.${cmd.method}() is not supported here; use db.runCommand({...}).`)
        }
      }
      case 'collection': {
        const c = coll(cmd.collection)
        const [a, b, o] = cmd.args as [Document, Document, Document]
        return tagged(async (comment) => {
          switch (cmd.method) {
            case 'find':
            case 'aggregate': {
              const cursor = cmd.method === 'find' ? c.find(a ?? {}, { projection: b, comment }) : c.aggregate((a as unknown as Document[]) ?? [], { ...(b ?? {}), comment })
              let limited = false
              let explain = false
              for (const step of cmd.chain) {
                const [x] = step.args as [Document & number]
                switch (step.method) {
                  case 'sort': (cursor as import('mongodb').FindCursor).sort(x); break
                  case 'limit': (cursor as import('mongodb').FindCursor).limit(Number(x)); limited = true; break
                  case 'skip': (cursor as import('mongodb').FindCursor).skip(Number(x)); break
                  case 'project':
                  case 'projection': (cursor as import('mongodb').FindCursor).project(x); break
                  case 'explain': explain = true; break
                  case 'count':
                    return scalar('count', await c.countDocuments(a ?? {}, { comment }))
                  case 'toArray':
                  case 'pretty':
                    break
                  default:
                    throw new Error(`.${step.method}() is not supported on a cursor here.`)
                }
              }
              if (explain) return docsToRaw([await cursor.explain('queryPlanner')])
              // Read one past the cap to know whether the result was cut.
              if (!limited && cmd.method === 'find') (cursor as import('mongodb').FindCursor).limit(MAX_RESULT_ROWS + 1)
              const docs: Document[] = []
              for await (const d of cursor) {
                docs.push(d)
                if (docs.length > MAX_RESULT_ROWS) break
              }
              await cursor.close()
              const truncated = docs.length > MAX_RESULT_ROWS
              return docsToRaw(truncated ? docs.slice(0, MAX_RESULT_ROWS) : docs, truncated)
            }
            case 'findOne': {
              const d = await c.findOne(a ?? {}, { projection: b, comment })
              return docsToRaw(d ? [d] : [])
            }
            case 'countDocuments':
            case 'count':
              return scalar('count', await c.countDocuments(a ?? {}, { comment }))
            case 'estimatedDocumentCount':
              return scalar('count', await c.estimatedDocumentCount({ comment }))
            case 'distinct':
              return docsToRaw((await c.distinct(String(a), b ?? {}, { comment })).map((value) => ({ value })))
            case 'insertOne': {
              const r = await c.insertOne(a, { comment })
              return { ...docsToRaw([{ insertedId: r.insertedId }]), affected: 1 }
            }
            case 'insertMany': {
              const r = await c.insertMany(a as unknown as Document[], { comment })
              return { ...done(r.insertedCount, 'INSERT') }
            }
            case 'updateOne':
            case 'updateMany':
            case 'replaceOne': {
              const r = cmd.method === 'replaceOne' ? await c.replaceOne(a, b, { ...(o ?? {}), comment }) : await c[cmd.method](a, b, { ...(o ?? {}), comment })
              return docsToRaw([{ matched: r.matchedCount, modified: r.modifiedCount, upserted: r.upsertedId ?? null }])
            }
            case 'deleteOne':
            case 'deleteMany': {
              const r = await c[cmd.method](a ?? {}, { comment })
              return done(r.deletedCount, 'DELETE')
            }
            case 'createIndex':
              return scalar('index', await c.createIndex(a, b ?? {}))
            case 'dropIndex':
              await c.dropIndex(a as unknown as string)
              return done(0, 'DROP INDEX')
            case 'getIndexes':
            case 'indexes':
              return docsToRaw(await c.indexes())
            case 'drop':
              await c.drop()
              return done(0, 'DROP')
            case 'stats':
              return docsToRaw([await db().command({ collStats: cmd.collection })])
            default:
              throw new Error(`.${cmd.method}() is not supported here.`)
          }
        })
      }
    }
  }

  return {
    serverVersion: `MongoDB ${info.version}${replicaSet ? ` · replica set ${hello.setName}` : ''}`,

    listDatabases: listDbs,
    currentDatabase: () => database,
    async switchDatabase(name) {
      database = name
    },

    async tree() {
      const cols = await db().listCollections({}, { nameOnly: false }).toArray()
      return [
        {
          kind: 'schema',
          name: database,
          schema: database,
          children: cols
            .filter((c) => !c.name.startsWith('system.'))
            .map((c) => ({ kind: c.type === 'view' ? 'view' : 'table', name: c.name, schema: database }) as TreeNode)
            .sort((a, b) => a.name.localeCompare(b.name))
        }
      ]
    },

    async columns(_schema, name) {
      return inferColumns(await sample(name))
    },

    async fetchTable(req: TableRequest) {
      const started = performance.now()
      const filter = toMongoFilter(req.filters)
      const docs = await tagged((comment) =>
        coll(req.table)
          .find(filter, { comment, skip: req.offset, limit: req.limit, ...(req.orderBy ? { sort: { [req.orderBy.column]: req.orderBy.dir === 'desc' ? -1 : 1 } } : {}) })
          .toArray()
      )
      const raw = docsToRaw(docs)
      const shown = `db.getCollection(${JSON.stringify(req.table)}).find(${toShell(filter)})${req.orderBy ? `.sort({ ${req.orderBy.column}: ${req.orderBy.dir === 'desc' ? -1 : 1} })` : ''}.skip(${req.offset}).limit(${req.limit})`
      return { columns: raw.columns, rows: raw.rows, durationMs: performance.now() - started, sql: shown }
    },

    async countTable(req) {
      const filter = toMongoFilter(req.filters)
      return Object.keys(filter).length ? coll(req.table).countDocuments(filter) : coll(req.table).estimatedDocumentCount()
    },

    changes: {
      preview: (set: ChangeSet) => set.changes.map((c) => describe(c, set.table)),
      async apply(set: ChangeSet) {
        // Transactions need a replica set; on a standalone server changes apply one by one.
        if (replicaSet) {
          const session = client.startSession()
          try {
            let n = 0
            await session.withTransaction(async () => {
              n = 0
              for (const c of set.changes) n += await applyOne(c, set.table, session)
            })
            return n
          } finally {
            await session.endSession()
          }
        }
        let n = 0
        for (const [i, c] of set.changes.entries()) {
          try {
            n += await applyOne(c, set.table)
          } catch (err) {
            const saved = i === 0 ? 'Nothing was saved.' : `The ${i} change${i === 1 ? '' : 's'} before it were saved (standalone servers have no transactions).`
            throw new Error(`${(err as Error).message} ${saved}`)
          }
        }
        return n
      }
    },

    async runStatement(text) {
      return execCommand(parseShell(text))
    },

    // Mongo has no read-only session; read-only connections are guarded by the command check before sending.
    withReadOnly: (fn) => fn(),

    canCancel: true,

    async cancel() {
      const tag = runningTag
      if (!tag) return
      const ops = await admin.command({ currentOp: 1, $or: [{ 'command.comment': tag }, { 'cursor.originatingCommand.comment': tag }] })
      for (const op of ops.inprog as Document[]) await admin.command({ killOp: 1, op: op.opid })
    },

    async completions() {
      const cols = (await db().listCollections({}, { nameOnly: true }).toArray()).filter((c) => !c.name.startsWith('system.')).slice(0, 100)
      const out = []
      for (const c of cols) {
        const docs = await sample(c.name, 20).catch(() => [])
        out.push({ schema: database, name: c.name, kind: 'table' as const, columns: inferColumns(docs).map((x) => ({ name: x.name, type: x.type })) })
      }
      return out
    },

    async explain(statement) {
      const cmd = parseShell(statement)
      if (cmd.kind !== 'collection' || (cmd.method !== 'find' && cmd.method !== 'aggregate')) throw new Error('Explain works on find() and aggregate().')
      const plan = await execCommand({ ...cmd, chain: [...cmd.chain.filter((c) => c.method !== 'explain'), { method: 'explain', args: [] }] })
      return plan
    },

    async structure(_schema, name) {
      const docs = await sample(name, 200)
      const columns = inferColumns(docs)
      const indexes = (await coll(name).indexes()).map((i) => ({
        name: String(i.name),
        columns: Object.keys(i.key ?? {}),
        unique: Boolean(i.unique) || i.name === '_id_',
        primary: i.name === '_id_',
        method: Object.values(i.key ?? {}).map(String).join(', '),
        definition: i.name === '_id_' ? null : `db.getCollection(${JSON.stringify(name)}).createIndex(${toShell(i.key)}${i.unique ? ', { unique: true }' : ''})`
      }))
      const info = (await db().listCollections({ name }).toArray())[0] as Document | undefined
      const options = info?.options && Object.keys(info.options).length ? `, ${toShell(info.options, false)}` : ''
      const ddl = [`db.createCollection(${JSON.stringify(name)}${options})`, ...indexes.map((i) => i.definition).filter(Boolean)].join('\n')
      return { schema: database, name, kind: info?.type === 'view' ? 'view' : 'table', columns, indexes, foreignKeys: [], triggers: [], ddl }
    },

    admin: {
      preview(action: AdminAction) {
        switch (action.kind) {
          case 'dropObject':
            return [`db.getCollection(${JSON.stringify(action.name)}).drop()`]
          case 'truncateTable':
            return [`db.getCollection(${JSON.stringify(action.name)}).deleteMany({})`]
          case 'createUser':
            return [`db.getSiblingDB(${JSON.stringify(action.superuser ? 'admin' : database)}).createUser({ user: ${JSON.stringify(action.name)}, pwd: "********", roles: [${action.superuser ? '"root"' : `{ role: "readWrite", db: ${JSON.stringify(database)} }`}] })`]
          case 'dropUser':
            return [`db.dropUser(${JSON.stringify(action.name)})`]
          default:
            throw new Error('Schema changes are not available for MongoDB.')
        }
      },
      async apply(action: AdminAction) {
        switch (action.kind) {
          case 'dropObject':
            await coll(action.name).drop()
            return
          case 'truncateTable':
            await coll(action.name).deleteMany({})
            return
          case 'createUser': {
            const target = action.superuser ? admin : db()
            await target.command({ createUser: action.name, pwd: action.password, roles: action.superuser ? ['root'] : [{ role: 'readWrite', db: database }] })
            return
          }
          case 'dropUser':
            await db().command({ dropUser: action.name }).catch(async () => admin.command({ dropUser: action.name }))
            return
          default:
            throw new Error('Schema changes are not available for MongoDB.')
        }
      }
    },

    async users() {
      const res = await db().command({ usersInfo: 1 }).catch(() => ({ users: [] }))
      const adminUsers = database === 'admin' ? [] : ((await admin.command({ usersInfo: 1 }).catch(() => ({ users: [] }))).users as Document[])
      return [...(res.users as Document[]), ...adminUsers].map((u) => ({
        name: String(u.user),
        host: String(u.db),
        attributes: (u.roles as Document[]).map((r) => `${r.role}@${r.db}`),
        memberOf: []
      }))
    },

    async processes() {
      const res = await admin.command({ currentOp: 1, $all: false })
      return (res.inprog as Document[]).map((op) => ({
        id: String(op.opid),
        user: op.effectiveUsers?.[0]?.user ?? null,
        database: op.ns ? String(op.ns).split('.')[0] : null,
        client: op.client ?? op.desc ?? null,
        state: op.active ? String(op.op ?? 'active') : 'idle',
        seconds: op.secs_running ?? (op.microsecs_running ? op.microsecs_running / 1e6 : null),
        query: op.command ? toShell(op.command) : null,
        self: Boolean(op.command?.currentOp)
      }))
    },

    async kill(id) {
      await admin.command({ killOp: 1, op: Number(id) })
    },

    async close() {
      await client.close().catch(() => {})
    }
  }
}
