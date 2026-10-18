export type Engine =
  | 'postgres'
  | 'mysql'
  | 'sqlite'
  | 'mssql'
  | 'duckdb'
  | 'clickhouse'
  | 'snowflake'
  | 'bigquery'
  | 'mongodb'
  | 'redis'
  | 'cassandra'
  | 'dynamodb'

/** What the query editor speaks for this engine. */
export type QueryLanguage = 'sql' | 'mongo' | 'redis' | 'cql' | 'partiql'

export interface EngineCapabilities {
  /** Inline grid editing (update, insert, delete). */
  edit: boolean
  /** Server-side filter bar on table tabs. */
  filters: boolean
  /** Structure tab (columns, indexes, keys). */
  structure: boolean
  /** Table designer: create and alter tables. */
  ddl: boolean
  truncate: boolean
  drop: boolean
  importRows: boolean
  routines: boolean
  users: boolean
  processes: boolean
  backup: boolean
  restore: boolean
  cancel: boolean
  explain: boolean
  /** The database picker in the header. */
  databases: boolean
}

export interface OptionField {
  key: string
  label: string
  placeholder?: string
  kind?: 'text' | 'select' | 'checkbox'
  choices?: string[]
}

export interface EngineInfo {
  label: string
  /** Two-letter badge on the connection list. */
  badge: string
  language: QueryLanguage
  defaultPort: number
  defaultUser: string
  /** Which connection fields apply, with engine-specific labels where useful. */
  fields: {
    host: string | false
    port: boolean
    user: string | false
    password: string | false
    database: string | false
    /** A local file: the database itself (SQLite, DuckDB) or a credential (BigQuery key). */
    file: { label: string; extensions: string[]; allowMemory?: boolean } | false
    ssh: boolean
    ssl: boolean
  }
  options: OptionField[]
  /** What the tree calls a schema-level container and the objects inside it. */
  schemaLabel: string
  objectLabel: string
  caps: EngineCapabilities
}

const SQL_FULL: EngineCapabilities = {
  edit: true,
  filters: true,
  structure: true,
  ddl: true,
  truncate: true,
  drop: true,
  importRows: true,
  routines: true,
  users: true,
  processes: true,
  backup: true,
  restore: true,
  cancel: true,
  explain: true,
  databases: true
}

const NETWORK = { host: 'Host', port: true, user: 'User', password: 'Password', ssh: true, ssl: true }

export const ENGINES: Record<Engine, EngineInfo> = {
  postgres: {
    label: 'PostgreSQL',
    badge: 'Pg',
    language: 'sql',
    defaultPort: 5432,
    defaultUser: 'postgres',
    fields: { ...NETWORK, database: 'Database', file: false },
    options: [],
    schemaLabel: 'schema',
    objectLabel: 'table',
    caps: SQL_FULL
  },
  mysql: {
    label: 'MySQL / MariaDB',
    badge: 'My',
    language: 'sql',
    defaultPort: 3306,
    defaultUser: 'root',
    fields: { ...NETWORK, database: 'Database', file: false },
    options: [],
    schemaLabel: 'database',
    objectLabel: 'table',
    caps: SQL_FULL
  },
  sqlite: {
    label: 'SQLite',
    badge: 'Sl',
    language: 'sql',
    defaultPort: 0,
    defaultUser: '',
    fields: { host: false, port: false, user: false, password: false, database: false, file: { label: 'Database file', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] }, ssh: false, ssl: false },
    options: [],
    schemaLabel: 'schema',
    objectLabel: 'table',
    caps: { ...SQL_FULL, routines: false, users: false, processes: false, cancel: false }
  },
  mssql: {
    label: 'SQL Server',
    badge: 'Ms',
    language: 'sql',
    defaultPort: 1433,
    defaultUser: 'sa',
    fields: { ...NETWORK, database: 'Database', file: false },
    options: [{ key: 'instance', label: 'Instance', placeholder: 'Optional, e.g. SQLEXPRESS' }],
    schemaLabel: 'schema',
    objectLabel: 'table',
    caps: { ...SQL_FULL, backup: false, restore: false }
  },
  duckdb: {
    label: 'DuckDB',
    badge: 'Dk',
    language: 'sql',
    defaultPort: 0,
    defaultUser: '',
    fields: { host: false, port: false, user: false, password: false, database: false, file: { label: 'Database file', extensions: ['duckdb', 'db', 'ddb'], allowMemory: true }, ssh: false, ssl: false },
    options: [],
    schemaLabel: 'schema',
    objectLabel: 'table',
    caps: { ...SQL_FULL, routines: false, users: false, processes: false, backup: false, restore: false }
  },
  clickhouse: {
    label: 'ClickHouse',
    badge: 'Ch',
    language: 'sql',
    defaultPort: 8123,
    defaultUser: 'default',
    fields: { ...NETWORK, database: 'Database', file: false },
    options: [{ key: 'protocol', label: 'Protocol', kind: 'select', choices: ['http', 'https'] }],
    schemaLabel: 'database',
    objectLabel: 'table',
    // Row updates are asynchronous mutations in ClickHouse, so inline editing stays off.
    caps: { ...SQL_FULL, edit: false, ddl: false, importRows: false, routines: false, backup: false, restore: false, explain: true }
  },
  snowflake: {
    label: 'Snowflake',
    badge: 'Sf',
    language: 'sql',
    defaultPort: 443,
    defaultUser: '',
    fields: { host: 'Account', port: false, user: 'User', password: 'Password', database: 'Database', file: false, ssh: false, ssl: false },
    options: [
      { key: 'warehouse', label: 'Warehouse' },
      { key: 'role', label: 'Role', placeholder: 'Optional' }
    ],
    schemaLabel: 'schema',
    objectLabel: 'table',
    caps: { ...SQL_FULL, ddl: false, importRows: false, routines: false, users: false, processes: false, backup: false, restore: false }
  },
  bigquery: {
    label: 'BigQuery',
    badge: 'Bq',
    language: 'sql',
    defaultPort: 0,
    defaultUser: '',
    fields: { host: false, port: false, user: false, password: false, database: 'Project ID', file: { label: 'Service account key (JSON)', extensions: ['json'] }, ssh: false, ssl: false },
    options: [
      { key: 'location', label: 'Location', placeholder: 'Optional, e.g. US or europe-west2' },
      { key: 'endpoint', label: 'API endpoint', placeholder: 'Optional, for emulators' }
    ],
    schemaLabel: 'dataset',
    objectLabel: 'table',
    // DML on BigQuery costs money and has no primary keys; keep the grid read-only.
    caps: { ...SQL_FULL, edit: false, ddl: false, truncate: false, importRows: false, routines: false, users: false, processes: false, backup: false, restore: false, databases: false }
  },
  mongodb: {
    label: 'MongoDB',
    badge: 'Mg',
    language: 'mongo',
    defaultPort: 27017,
    defaultUser: '',
    fields: { ...NETWORK, database: 'Database', file: false, ssl: true },
    options: [
      { key: 'authSource', label: 'Auth database', placeholder: 'admin' },
      { key: 'uri', label: 'Connection string', placeholder: 'Optional mongodb:// or mongodb+srv:// (overrides the fields above)' }
    ],
    schemaLabel: 'database',
    objectLabel: 'collection',
    caps: { ...SQL_FULL, ddl: false, truncate: true, importRows: false, routines: false, backup: false, restore: false, explain: true }
  },
  redis: {
    label: 'Redis',
    badge: 'Rd',
    language: 'redis',
    defaultPort: 6379,
    defaultUser: '',
    fields: { ...NETWORK, user: 'User (ACL)', database: 'Database number', file: false },
    options: [{ key: 'scanLimit', label: 'Keys to list', placeholder: '1000' }],
    schemaLabel: 'database',
    objectLabel: 'key',
    caps: { ...SQL_FULL, filters: false, structure: false, ddl: false, truncate: false, importRows: false, routines: false, users: false, backup: false, restore: false, explain: false, cancel: false }
  },
  cassandra: {
    label: 'Cassandra / ScyllaDB',
    badge: 'Cs',
    language: 'cql',
    defaultPort: 9042,
    defaultUser: '',
    fields: { ...NETWORK, host: 'Hosts (comma-separated)', database: 'Keyspace', file: false },
    options: [{ key: 'localDataCenter', label: 'Local data center', placeholder: 'datacenter1' }],
    schemaLabel: 'keyspace',
    objectLabel: 'table',
    caps: { ...SQL_FULL, filters: false, ddl: false, importRows: false, routines: false, users: false, processes: false, backup: false, restore: false, explain: false, cancel: false }
  },
  dynamodb: {
    label: 'DynamoDB',
    badge: 'Dy',
    language: 'partiql',
    defaultPort: 0,
    defaultUser: '',
    fields: { host: 'Endpoint', port: false, user: 'Access key ID', password: 'Secret access key', database: false, file: false, ssh: false, ssl: false },
    options: [{ key: 'region', label: 'Region', placeholder: 'us-east-1' }],
    schemaLabel: 'region',
    objectLabel: 'table',
    caps: { ...SQL_FULL, filters: false, ddl: false, truncate: false, importRows: false, routines: false, users: false, processes: false, backup: false, restore: false, explain: false, cancel: false, databases: false }
  }
}

export const ENGINE_ORDER: Engine[] = ['postgres', 'mysql', 'sqlite', 'mssql', 'duckdb', 'clickhouse', 'snowflake', 'bigquery', 'mongodb', 'redis', 'cassandra', 'dynamodb']

export const caps = (engine: Engine) => ENGINES[engine].caps

/** Engines that speak a SQL dialect handled by the shared SQL builder. */
export const isSqlFamily = (engine: Engine) => ENGINES[engine].language === 'sql' || engine === 'cassandra'
