import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Copy, FileCode2, KeyRound, Lock, Plus, RotateCcw, Trash2 } from 'lucide-react'
import {
  effectiveSafeMode,
  FK_ACTIONS,
  type AdminAction,
  type Engine,
  type FkAction,
  type TableStructure
} from '@shared/types'
import { call } from '../api'
import {
  blankColumn,
  buildOps,
  columnState,
  newKey,
  TYPE_SUGGESTIONS,
  type DraftColumn,
  type DraftForeignKey,
  type DraftIndex
} from '../structure'
import { useApp } from '../store'
import { ENGINES } from '@shared/engines'
import CommitModal from './CommitModal'

const ROW_TINT = {
  new: 'bg-ok/10',
  changed: 'bg-[rgba(224,138,18,0.14)]',
  dropped: 'bg-danger/10 line-through text-faint',
  same: ''
}

function Section({ title, count, action, children }: { title: string; count?: number; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-faint">{title}</h3>
        {count !== undefined && <span className="text-[11px] text-faint">{count}</span>}
        <div className="flex-1" />
        {action}
      </div>
      {children}
    </section>
  )
}

const cell = 'border-b border-line px-2 py-1 align-middle'
const input = 'field h-7 text-xs font-mono'

export default function StructureView({
  sessionId,
  engine,
  schema: initialSchema,
  table,
  kind,
  onApplied
}: {
  sessionId: string
  engine: Engine
  schema: string
  /** null opens the designer for a new table. */
  table: string | null
  kind: 'table' | 'view'
  onApplied: (schema: string, name: string) => void
}) {
  const connection = useApp((s) => s.connection)
  const completions = useApp((s) => s.completions)
  const tree = useApp((s) => s.tree)
  const openQuery = useApp((s) => s.openQuery)
  const refreshTree = useApp((s) => s.refreshTree)

  const creating = table === null
  const [structure, setStructure] = useState<TableStructure | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [schema, setSchema] = useState(initialSchema)
  const [name, setName] = useState(table ?? '')
  const [columns, setColumns] = useState<DraftColumn[]>([])
  const [indexes, setIndexes] = useState<DraftIndex[]>([])
  const [fks, setFks] = useState<DraftForeignKey[]>([])
  const [review, setReview] = useState<{ statements: string[]; action: AdminAction } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const readOnlyConn = connection ? effectiveSafeMode(connection) === 'readonly' : false
  const editable = kind === 'table' && !readOnlyConn && ENGINES[engine].caps.ddl

  const reset = useCallback((st: TableStructure | null) => {
    setName(st?.name ?? '')
    setColumns(
      st
        ? st.columns.map((c) => ({ key: newKey(), orig: c, col: { ...c }, dropped: false }))
        : [{ key: newKey(), col: { ...blankColumn(), name: 'id', type: engine === 'sqlite' ? 'INTEGER' : engine === 'mysql' ? 'int' : 'integer', nullable: false, isPrimaryKey: true, autoIncrement: true }, dropped: false }]
    )
    setIndexes(
      (st?.indexes ?? []).map((i) => ({ key: newKey(), orig: i, name: i.name, columns: i.columns.join(', '), unique: i.unique, dropped: false }))
    )
    setFks(
      (st?.foreignKeys ?? []).map((f) => ({
        key: newKey(),
        orig: f,
        fk: { ...f },
        columns: f.columns.join(', '),
        refColumns: f.refColumns.join(', '),
        dropped: false
      }))
    )
    setActionError(null)
  }, [engine])

  const load = useCallback(async () => {
    if (creating) {
      reset(null)
      return
    }
    try {
      const st = await call('structure:get', sessionId, initialSchema, table!)
      setStructure(st)
      setLoadError(null)
      reset(st)
    } catch (err) {
      setLoadError((err as Error).message)
    }
  }, [creating, sessionId, initialSchema, table, reset])

  useEffect(() => {
    void load()
  }, [load])

  const ops = useMemo(
    () => buildOps({ creating, originalName: table ?? '', name, columns, indexes, foreignKeys: fks }),
    [creating, table, name, columns, indexes, fks]
  )
  const pendingCount = creating ? (name.trim() ? 1 : 0) : ops.length

  const patchColumn = (key: string, patch: Partial<DraftColumn['col']>) =>
    setColumns((cs) => cs.map((c) => (c.key === key ? { ...c, col: { ...c.col, ...patch } } : c)))

  const toggleDropColumn = (c: DraftColumn) =>
    c.orig
      ? setColumns((cs) => cs.map((x) => (x.key === c.key ? { ...x, dropped: !x.dropped } : x)))
      : setColumns((cs) => cs.filter((x) => x.key !== c.key))

  const startApply = async () => {
    setActionError(null)
    if (creating && !name.trim()) {
      setActionError('Give the table a name.')
      return
    }
    const action: AdminAction = { kind: 'schemaChange', change: { schema, table: creating ? name.trim() : table!, ops } }
    try {
      setReview({ statements: await call('admin:preview', sessionId, action), action })
    } catch (err) {
      setActionError((err as Error).message)
    }
  }

  const apply = async () => {
    if (!review) return
    await call('admin:apply', sessionId, review.action)
    setReview(null)
    void refreshTree()
    const finalName = creating ? name.trim() : (ops.find((o) => o.op === 'renameTable') as { to: string } | undefined)?.to ?? table!
    if (creating || finalName !== table) onApplied(schema, finalName)
    else await load()
  }

  const columnNames = columns.filter((c) => !c.dropped && c.col.name).map((c) => c.col.name)
  const schemas = tree.filter((n) => n.kind === 'schema').map((n) => n.name)
  const showComment = engine !== 'sqlite'
  const sqliteAlterLimits = engine === 'sqlite' && !creating

  if (loadError) return <div className="select-text p-6 font-mono text-xs text-danger">{loadError}</div>
  if (!creating && !structure) return <div className="p-6 text-xs text-muted">Loading structure…</div>

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 text-xs">
        {creating && engine === 'postgres' && (
          <select className="field h-7 w-36 text-xs" value={schema} onChange={(e) => setSchema(e.target.value)} title="Schema">
            {schemas.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        )}
        <input
          className="field h-7 w-64 font-mono text-xs"
          value={name}
          placeholder="table_name"
          disabled={!editable}
          onChange={(e) => setName(e.target.value)}
          title={creating ? 'Table name' : 'Rename table'}
          autoFocus={creating}
        />
        {!editable && (
          <span className="inline-flex items-center gap-1 text-faint">
            <Lock size={12} /> {kind === 'view' ? 'Views are defined by their SQL' : readOnlyConn ? 'Read-only connection' : `${ENGINES[engine].label} structure is read-only here`}
          </span>
        )}
        <div className="flex-1" />
        {actionError && <span className="max-w-md truncate text-danger" title={actionError}>{actionError}</span>}
        {editable && pendingCount > 0 && !creating && (
          <span className="rounded bg-accent-soft px-2 py-0.5 font-medium text-accent">
            {pendingCount} change{pendingCount === 1 ? '' : 's'}
          </span>
        )}
        {editable && !creating && (
          <button className="btn h-7" disabled={pendingCount === 0} onClick={() => reset(structure)}>
            Discard
          </button>
        )}
        {editable && (
          <button className="btn btn-primary h-7" disabled={!creating && pendingCount === 0} onClick={() => void startApply()}>
            {creating ? 'Review & create' : 'Review & apply'}
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-4 text-xs">
        {sqliteAlterLimits && (
          <div className="mb-4 rounded-md border border-line bg-panel px-3 py-2 text-muted">
            SQLite can add, rename and drop columns in place. Changing a column's type, nullability or default, or
            its foreign keys, means recreating the table.
          </div>
        )}

        <Section
          title="Columns"
          count={columns.length}
          action={
            editable && (
              <button className="btn h-6 px-2" onClick={() => setColumns((cs) => [...cs, { key: newKey(), col: blankColumn(), dropped: false }])}>
                <Plus size={12} /> Column
              </button>
            )
          }
        >
          <datalist id={`types-${engine}`}>
            {TYPE_SUGGESTIONS[engine].map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <table className="w-full border-collapse">
            <thead className="text-left text-[11px] text-faint">
              <tr>
                <th className={`${cell} w-8`} />
                <th className={cell}>Name</th>
                <th className={cell}>Type</th>
                <th className={`${cell} w-16 text-center`}>Null</th>
                <th className={cell}>Default</th>
                <th className={`${cell} w-16 text-center`}>Auto</th>
                {showComment && <th className={cell}>Comment</th>}
                <th className={`${cell} w-10`} />
              </tr>
            </thead>
            <tbody>
              {columns.map((c) => {
                const state = columnState(c)
                const isNew = !c.orig
                const lockedAttr = !editable || c.dropped || (sqliteAlterLimits && !isNew)
                return (
                  <tr key={c.key} className={ROW_TINT[state]}>
                    <td className={`${cell} text-center`}>
                      {creating ? (
                        <input
                          type="checkbox"
                          title="Primary key"
                          checked={c.col.isPrimaryKey}
                          onChange={(e) => patchColumn(c.key, { isPrimaryKey: e.target.checked, nullable: e.target.checked ? false : c.col.nullable })}
                        />
                      ) : (
                        c.col.isPrimaryKey && <KeyRound size={12} className="mx-auto text-accent" aria-label="Primary key" />
                      )}
                    </td>
                    <td className={cell}>
                      <input className={input} value={c.col.name} disabled={!editable || c.dropped} placeholder="column" onChange={(e) => patchColumn(c.key, { name: e.target.value })} />
                    </td>
                    <td className={cell}>
                      <input
                        className={input}
                        list={`types-${engine}`}
                        value={c.col.type}
                        disabled={lockedAttr}
                        placeholder="type"
                        onChange={(e) => patchColumn(c.key, { type: e.target.value })}
                      />
                    </td>
                    <td className={`${cell} text-center`}>
                      <input type="checkbox" checked={c.col.nullable} disabled={lockedAttr || c.col.isPrimaryKey} onChange={(e) => patchColumn(c.key, { nullable: e.target.checked })} />
                    </td>
                    <td className={cell}>
                      <input
                        className={input}
                        value={c.col.defaultValue ?? ''}
                        disabled={lockedAttr}
                        placeholder="NULL"
                        title="A SQL expression: 'text', 0, now()"
                        onChange={(e) => patchColumn(c.key, { defaultValue: e.target.value })}
                      />
                    </td>
                    <td className={`${cell} text-center`}>
                      <input
                        type="checkbox"
                        checked={c.col.autoIncrement}
                        disabled={!editable || !isNew}
                        title={isNew ? 'Auto increment' : 'Set when the column is created'}
                        onChange={(e) => patchColumn(c.key, { autoIncrement: e.target.checked })}
                      />
                    </td>
                    {showComment && (
                      <td className={cell}>
                        <input className={input} value={c.col.comment ?? ''} disabled={!editable || c.dropped} onChange={(e) => patchColumn(c.key, { comment: e.target.value })} />
                      </td>
                    )}
                    <td className={`${cell} text-right`}>
                      {editable && (
                        <button className="icon-btn" title={c.dropped ? 'Keep column' : isNew ? 'Remove' : 'Drop column'} onClick={() => toggleDropColumn(c)}>
                          {c.dropped ? <RotateCcw size={12} /> : <Trash2 size={12} />}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Section>

        {kind === 'table' && (
          <Section
            title="Indexes"
            count={indexes.length}
            action={
              editable && (
                <button
                  className="btn h-6 px-2"
                  onClick={() =>
                    setIndexes((xs) => [...xs, { key: newKey(), name: `${name || 'table'}_idx${xs.length + 1}`, columns: '', unique: false, dropped: false }])
                  }
                >
                  <Plus size={12} /> Index
                </button>
              )
            }
          >
            {indexes.length === 0 ? (
              <div className="text-faint">No indexes.</div>
            ) : (
              <table className="w-full border-collapse">
                <thead className="text-left text-[11px] text-faint">
                  <tr>
                    <th className={cell}>Name</th>
                    <th className={cell}>Columns</th>
                    <th className={`${cell} w-16 text-center`}>Unique</th>
                    <th className={cell}>Definition</th>
                    <th className={`${cell} w-10`} />
                  </tr>
                </thead>
                <tbody>
                  {indexes.map((ix) => {
                    const isNew = !ix.orig
                    return (
                      <tr key={ix.key} className={ix.dropped ? ROW_TINT.dropped : isNew ? ROW_TINT.new : ''}>
                        <td className={cell}>
                          {isNew ? (
                            <input className={input} value={ix.name} onChange={(e) => setIndexes((xs) => xs.map((x) => (x.key === ix.key ? { ...x, name: e.target.value } : x)))} />
                          ) : (
                            <span className="font-mono">{ix.name}{ix.orig?.primary && <span className="ml-2 text-accent">primary</span>}</span>
                          )}
                        </td>
                        <td className={cell}>
                          {isNew ? (
                            <input
                              className={input}
                              value={ix.columns}
                              placeholder={columnNames.slice(0, 2).join(', ') || 'col_a, col_b'}
                              onChange={(e) => setIndexes((xs) => xs.map((x) => (x.key === ix.key ? { ...x, columns: e.target.value } : x)))}
                            />
                          ) : (
                            <span className="font-mono">{ix.columns}</span>
                          )}
                        </td>
                        <td className={`${cell} text-center`}>
                          <input
                            type="checkbox"
                            checked={ix.unique}
                            disabled={!isNew}
                            onChange={(e) => setIndexes((xs) => xs.map((x) => (x.key === ix.key ? { ...x, unique: e.target.checked } : x)))}
                          />
                        </td>
                        <td className={`${cell} max-w-sm truncate font-mono text-faint`} title={ix.orig?.definition ?? ''}>
                          {ix.orig?.definition ?? ix.orig?.method ?? ''}
                        </td>
                        <td className={`${cell} text-right`}>
                          {editable && !ix.orig?.primary && (
                            <button
                              className="icon-btn"
                              title={ix.dropped ? 'Keep index' : isNew ? 'Remove' : 'Drop index'}
                              onClick={() =>
                                isNew
                                  ? setIndexes((xs) => xs.filter((x) => x.key !== ix.key))
                                  : setIndexes((xs) => xs.map((x) => (x.key === ix.key ? { ...x, dropped: !x.dropped } : x)))
                              }
                            >
                              {ix.dropped ? <RotateCcw size={12} /> : <Trash2 size={12} />}
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </Section>
        )}

        {kind === 'table' && (
          <Section
            title="Foreign keys"
            count={fks.length}
            action={
              editable &&
              (creating || engine !== 'sqlite') && (
                <button
                  className="btn h-6 px-2"
                  onClick={() =>
                    setFks((xs) => [
                      ...xs,
                      {
                        key: newKey(),
                        fk: { name: `${name || 'table'}_fk${xs.length + 1}`, columns: [], refSchema: schema, refTable: '', refColumns: [], onUpdate: 'NO ACTION', onDelete: 'NO ACTION' },
                        columns: '',
                        refColumns: '',
                        dropped: false
                      }
                    ])
                  }
                >
                  <Plus size={12} /> Foreign key
                </button>
              )
            }
          >
            {fks.length === 0 ? (
              <div className="text-faint">No foreign keys.</div>
            ) : (
              <table className="w-full border-collapse">
                <thead className="text-left text-[11px] text-faint">
                  <tr>
                    <th className={cell}>Name</th>
                    <th className={cell}>Columns</th>
                    <th className={cell}>References</th>
                    <th className={cell}>Ref columns</th>
                    <th className={cell}>On update</th>
                    <th className={cell}>On delete</th>
                    <th className={`${cell} w-10`} />
                  </tr>
                </thead>
                <tbody>
                  {fks.map((f) => {
                    const isNew = !f.orig
                    const patch = (p: Partial<DraftForeignKey>) => setFks((xs) => xs.map((x) => (x.key === f.key ? { ...x, ...p } : x)))
                    const patchFk = (p: Partial<DraftForeignKey['fk']>) => patch({ fk: { ...f.fk, ...p } })
                    return (
                      <tr key={f.key} className={f.dropped ? ROW_TINT.dropped : isNew ? ROW_TINT.new : ''}>
                        <td className={cell}>
                          {isNew ? <input className={input} value={f.fk.name} onChange={(e) => patchFk({ name: e.target.value })} /> : <span className="font-mono">{f.fk.name}</span>}
                        </td>
                        <td className={cell}>
                          {isNew ? <input className={input} value={f.columns} placeholder="person_id" onChange={(e) => patch({ columns: e.target.value })} /> : <span className="font-mono">{f.columns}</span>}
                        </td>
                        <td className={cell}>
                          {isNew ? (
                            <select className={input} value={f.fk.refTable} onChange={(e) => patchFk({ refTable: e.target.value })}>
                              <option value="">Choose table…</option>
                              {completions
                                .filter((t) => t.kind === 'table' && (engine !== 'postgres' || t.schema === schema))
                                .map((t) => (
                                  <option key={`${t.schema}.${t.name}`} value={t.name}>
                                    {t.name}
                                  </option>
                                ))}
                            </select>
                          ) : (
                            <span className="font-mono">{f.fk.refTable}</span>
                          )}
                        </td>
                        <td className={cell}>
                          {isNew ? (
                            <input
                              className={input}
                              value={f.refColumns}
                              placeholder={completions.find((t) => t.name === f.fk.refTable)?.columns[0]?.name ?? 'id'}
                              onChange={(e) => patch({ refColumns: e.target.value })}
                            />
                          ) : (
                            <span className="font-mono">{f.refColumns}</span>
                          )}
                        </td>
                        {(['onUpdate', 'onDelete'] as const).map((field) => (
                          <td key={field} className={cell}>
                            {isNew ? (
                              <select className={input} value={f.fk[field]} onChange={(e) => patchFk({ [field]: e.target.value as FkAction })}>
                                {FK_ACTIONS.map((a) => (
                                  <option key={a}>{a}</option>
                                ))}
                              </select>
                            ) : (
                              <span className="text-muted">{f.fk[field]}</span>
                            )}
                          </td>
                        ))}
                        <td className={`${cell} text-right`}>
                          {editable && (isNew || engine !== 'sqlite') && (
                            <button
                              className="icon-btn"
                              title={f.dropped ? 'Keep foreign key' : isNew ? 'Remove' : 'Drop foreign key'}
                              onClick={() => (isNew ? setFks((xs) => xs.filter((x) => x.key !== f.key)) : patch({ dropped: !f.dropped }))}
                            >
                              {f.dropped ? <RotateCcw size={12} /> : <Trash2 size={12} />}
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </Section>
        )}

        {structure && kind === 'table' && (
          <Section title="Triggers" count={structure.triggers.length}>
            {structure.triggers.length === 0 ? (
              <div className="text-faint">No triggers.</div>
            ) : (
              <table className="w-full border-collapse">
                <tbody>
                  {structure.triggers.map((t) => (
                    <tr key={t.name}>
                      <td className={`${cell} font-mono`}>{t.name}</td>
                      <td className={`${cell} text-muted`}>
                        {t.timing} {t.events}
                      </td>
                      <td className={`${cell} text-right`}>
                        <button className="btn h-6 px-2" onClick={() => openQuery({ title: t.name, sql: t.definition })}>
                          <FileCode2 size={12} /> Open
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
        )}

        {structure && (
          <Section
            title="DDL"
            action={
              <div className="flex gap-1">
                <button className="btn h-6 px-2" onClick={() => navigator.clipboard.writeText(structure.ddl)}>
                  <Copy size={12} /> Copy
                </button>
                <button className="btn h-6 px-2" onClick={() => openQuery({ title: `${structure.name} DDL`, sql: structure.ddl })}>
                  <FileCode2 size={12} /> Open in SQL editor
                </button>
              </div>
            }
          >
            <pre className="select-text overflow-auto whitespace-pre-wrap rounded-md border border-line bg-panel p-3 font-mono text-[11px] leading-relaxed">
              {structure.ddl}
            </pre>
          </Section>
        )}
      </div>

      {review && connection && (
        <CommitModal verb="Apply" statements={review.statements} connection={connection} onClose={() => setReview(null)} onCommit={apply} />
      )}
    </div>
  )
}
