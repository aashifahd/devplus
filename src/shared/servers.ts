import type { Engine } from './engines'

/** Database servers DevPlus can install and run locally. */
export type ServerEngine = 'postgres' | 'mysql' | 'mariadb'

/** One downloadable server build, from the generated catalog. */
export interface ServerRelease {
  engine: ServerEngine
  version: string
  channel: 'Latest' | 'Supported' | 'LTS' | 'Innovation'
  platform: 'win32-x64'
  /** Official download URL (HTTPS). */
  url: string
  file: string
  bytes: number
  /** The download must match this exactly. */
  sha256: string
}

export interface LocalServer {
  id: string
  name: string
  engine: ServerEngine
  version: string
  port: number
  /** Start when DevPlus starts. */
  autoStart: boolean
  /** MySQL/MariaDB: write the binary log (off saves disk space on a dev machine). */
  binlog: boolean
  /** The DevPlus connection that opens this server. */
  connectionId: string
  createdAt: number
}

export type ServerStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

export interface ServerState {
  id: string
  status: ServerStatus
  pid: number | null
  /** Why it stopped or failed, from the server log when possible. */
  message?: string
}

export type ServerView = LocalServer & { state: ServerState; dataDir: string; configPath: string; logPath: string }

export interface ServerDraft {
  name: string
  engine: ServerEngine
  version: string
  port: number
  autoStart: boolean
  binlog: boolean
}

export interface ServerEngineInfo {
  label: string
  defaultPort: number
  /** Superuser created at initialization (local trust / empty password). */
  user: string
  /** Which DevPlus client engine connects to it. */
  client: Engine
  /** Database to connect to by default. */
  database: string
  color: string
  hasBinlog: boolean
}

export const SERVER_ENGINES: Record<ServerEngine, ServerEngineInfo> = {
  postgres: { label: 'PostgreSQL', defaultPort: 5432, user: 'postgres', client: 'postgres', database: 'postgres', color: '#336791', hasBinlog: false },
  mysql: { label: 'MySQL', defaultPort: 3306, user: 'root', client: 'mysql', database: '', color: '#e48e00', hasBinlog: true },
  mariadb: { label: 'MariaDB', defaultPort: 3306, user: 'root', client: 'mysql', database: '', color: '#c0765a', hasBinlog: true }
}

export interface ServerSettings {
  /** Leave servers running when DevPlus quits (they are separate processes). */
  keepRunning: boolean
  /** Open DevPlus in the tray at login, starting servers marked auto-start. */
  startOnLogin: boolean
}

export const DEFAULT_SERVER_SETTINGS: ServerSettings = { keepRunning: true, startOnLogin: false }

/** Compare versions like 18.6 and 9.7.2 numerically, newest first. */
export const byVersionDesc = (a: string, b: string) => {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0)
    if (d) return d
  }
  return 0
}
