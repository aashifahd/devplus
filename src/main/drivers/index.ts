import type { ConnectionConfig, ConnectionSecrets } from '@shared/types'
import type { DriverSession, Endpoint } from './types'
import { openPostgres } from './postgres'
import { openMysql } from './mysql'
import { openSqlite } from './sqlite'
import { openMssql } from './mssql'
import { openDuckdb } from './duckdb'
import { openClickhouse } from './clickhouse'
import { openSnowflake } from './snowflake'
import { openBigquery } from './bigquery'
import { openMongodb } from './mongodb'
import { openRedis } from './redis'
import { openCassandra } from './cassandra'
import { openDynamodb } from './dynamodb'

export type { DriverSession } from './types'

export function openDriver(cfg: ConnectionConfig, secrets: ConnectionSecrets, endpoint: Endpoint): Promise<DriverSession> {
  switch (cfg.engine) {
    case 'postgres':
      return openPostgres(cfg, secrets, endpoint)
    case 'mysql':
      return openMysql(cfg, secrets, endpoint)
    case 'sqlite':
      return openSqlite(cfg)
    case 'mssql':
      return openMssql(cfg, secrets, endpoint)
    case 'duckdb':
      return openDuckdb(cfg)
    case 'clickhouse':
      return openClickhouse(cfg, secrets, endpoint)
    case 'snowflake':
      return openSnowflake(cfg, secrets)
    case 'bigquery':
      return openBigquery(cfg)
    case 'mongodb':
      return openMongodb(cfg, secrets, endpoint)
    case 'redis':
      return openRedis(cfg, secrets, endpoint)
    case 'cassandra':
      return openCassandra(cfg, secrets, endpoint)
    case 'dynamodb':
      return openDynamodb(cfg, secrets)
  }
}
