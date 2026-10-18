import type { Engine, QueryResult } from '@shared/types'
import { defaultFormatOptions, formatAll, type ExportFormat } from '@shared/formats'
import type { MenuItem } from './ContextMenu'

const BINARY = /bytea|blob|binary/i

const LABELS: [ExportFormat, string][] = [
  ['tsv', 'TSV (for spreadsheets)'],
  ['csv', 'CSV'],
  ['json', 'JSON'],
  ['sql', 'SQL INSERT']
]

/** Context-menu entries that copy the given rows of a result in each export format. */
export function copyAsItems(result: QueryResult, rows: number[], engine: Engine, tableName: string): MenuItem[] {
  const picked = rows.filter((r) => r < result.rows.length).sort((a, b) => a - b)
  const label = picked.length === 1 ? 'row' : `${picked.length} rows`
  const binaryColumns = result.columns.flatMap((c, i) => (BINARY.test(c.type) ? [i] : []))
  return LABELS.map(([format, name]) => ({
    label: `Copy ${label} as ${name}`,
    disabled: picked.length === 0,
    onSelect: () => {
      const text = formatAll(
        result.columns,
        picked.map((r) => result.rows[r]),
        { ...defaultFormatOptions(engine, tableName || 'table_name', format), binaryColumns }
      )
      void navigator.clipboard.writeText(text)
    }
  }))
}
