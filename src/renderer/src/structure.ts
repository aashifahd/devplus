import type { ColumnDef, ForeignKeyDef, IndexDef, SchemaOp } from '@shared/types'

/** Editable rows keep the introspected original so the diff knows what changed. */
export interface DraftColumn {
  key: string
  orig?: ColumnDef
  col: ColumnDef
  dropped: boolean
}

export interface DraftIndex {
  key: string
  orig?: IndexDef
  name: string
  /** Comma-separated while editing. */
  columns: string
  unique: boolean
  dropped: boolean
}

export interface DraftForeignKey {
  key: string
  orig?: ForeignKeyDef
  fk: ForeignKeyDef
  /** Comma-separated while editing. */
  columns: string
  refColumns: string
  dropped: boolean
}

let seq = 0
export const newKey = () => `k${++seq}`

export const blankColumn = (): ColumnDef => ({
  name: '',
  type: '',
  nullable: true,
  defaultValue: null,
  isPrimaryKey: false,
  autoIncrement: false,
  comment: null
})

export const splitList = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

const sameColumn = (a: ColumnDef, b: ColumnDef) =>
  a.name === b.name &&
  a.type === b.type &&
  a.nullable === b.nullable &&
  (a.defaultValue ?? '') === (b.defaultValue ?? '') &&
  (a.comment ?? '') === (b.comment ?? '')

export function columnState(c: DraftColumn): 'new' | 'dropped' | 'changed' | 'same' {
  if (c.dropped) return 'dropped'
  if (!c.orig) return 'new'
  return sameColumn(c.orig, c.col) ? 'same' : 'changed'
}

/** Normalize what the user typed: blank defaults and comments mean "none". */
function clean(c: ColumnDef): ColumnDef {
  return {
    ...c,
    name: c.name.trim(),
    type: c.type.trim(),
    defaultValue: c.defaultValue?.trim() ? c.defaultValue.trim() : null,
    comment: c.comment?.trim() ? c.comment.trim() : null
  }
}

/** Turn the designer state into schema operations. The main process orders them safely. */
export function buildOps(opts: {
  creating: boolean
  originalName: string
  name: string
  columns: DraftColumn[]
  indexes: DraftIndex[]
  foreignKeys: DraftForeignKey[]
}): SchemaOp[] {
  const ops: SchemaOp[] = []
  const fkOf = (f: DraftForeignKey): ForeignKeyDef => ({
    ...f.fk,
    columns: splitList(f.columns),
    refColumns: splitList(f.refColumns)
  })

  if (opts.creating) {
    ops.push({
      op: 'createTable',
      columns: opts.columns.filter((c) => !c.dropped).map((c) => clean(c.col)),
      foreignKeys: opts.foreignKeys.filter((f) => !f.dropped).map(fkOf)
    })
  } else {
    for (const f of opts.foreignKeys) if (f.orig && f.dropped) ops.push({ op: 'dropForeignKey', name: f.orig.name })
    for (const i of opts.indexes) if (i.orig && i.dropped) ops.push({ op: 'dropIndex', name: i.orig.name })
    for (const c of opts.columns) {
      const state = columnState(c)
      if (state === 'dropped' && c.orig) ops.push({ op: 'dropColumn', name: c.orig.name })
      if (state === 'changed') ops.push({ op: 'alterColumn', from: c.orig!, to: clean(c.col) })
      if (state === 'new') ops.push({ op: 'addColumn', column: clean(c.col) })
    }
    for (const f of opts.foreignKeys) if (!f.orig && !f.dropped) ops.push({ op: 'addForeignKey', fk: fkOf(f) })
    if (opts.name.trim() && opts.name.trim() !== opts.originalName) ops.push({ op: 'renameTable', to: opts.name.trim() })
  }
  for (const i of opts.indexes) {
    if (!i.orig && !i.dropped) ops.push({ op: 'addIndex', index: { name: i.name, columns: splitList(i.columns), unique: i.unique } })
  }
  return ops
}

/** Common types offered in the type field; anything else can still be typed. */
export const TYPE_SUGGESTIONS: Record<string, string[]> = {
  postgres: ['integer', 'bigint', 'smallint', 'serial', 'bigserial', 'numeric(10,2)', 'real', 'double precision', 'boolean', 'text', 'varchar(255)', 'char(1)', 'uuid', 'date', 'time', 'timestamp', 'timestamptz', 'interval', 'json', 'jsonb', 'bytea', 'inet'],
  mysql: ['int', 'bigint', 'smallint', 'tinyint(1)', 'decimal(10,2)', 'float', 'double', 'varchar(255)', 'char(36)', 'text', 'mediumtext', 'longtext', 'date', 'datetime', 'timestamp', 'time', 'json', 'blob', 'enum()'],
  sqlite: ['INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC', 'BOOLEAN', 'DATETIME']
}
