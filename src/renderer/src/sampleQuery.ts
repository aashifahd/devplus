import type { Engine } from '@shared/engines'
import { quoteIdent } from '@shared/formats'

/** A first-100-rows query for an object, in the engine's own query language. */
export function sampleQuery(engine: Engine, schema: string, name: string): string {
  const q = (s: string) => (engine === 'mssql' ? `[${s.replace(/]/g, ']]')}]` : quoteIdent(engine === 'bigquery' || engine === 'clickhouse' ? 'mysql' : 'postgres', s))
  switch (engine) {
    case 'mongodb':
      return `db.getCollection(${JSON.stringify(name)}).find({}).limit(100)`
    case 'redis':
      return `TYPE ${name}\nTTL ${name}\nMEMORY USAGE ${name}`
    case 'dynamodb':
      return `SELECT * FROM "${name.replace(/"/g, '""')}"`
    case 'mssql':
      return `SELECT TOP 100 * FROM ${q(schema)}.${q(name)};`
    case 'sqlite':
    case 'duckdb':
      return `SELECT * FROM ${q(name)} LIMIT 100;`
    default:
      return `SELECT * FROM ${q(schema)}.${q(name)} LIMIT 100;`
  }
}
