import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import type { BackupOptions, Engine, RestoreOptions, SslMode, ToolName } from '@shared/types'

export interface ToolConnection {
  engine: Engine
  host: string
  port: number
  user: string
  password?: string
  database: string
  ssl: { mode: SslMode; caPath?: string }
}

export type LogLine = (line: string) => void

const EXE = process.platform === 'win32' ? '.exe' : ''

/** Newest-first version directories under `root` that contain a bin folder. */
function versionedBins(root: string, prefix = ''): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((d) => d.startsWith(prefix))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((d) => join(root, d, 'bin'))
}

function candidateDirs(tool: ToolName): string[] {
  const pg = tool.startsWith('pg_') || tool === 'psql'
  const fromPath = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  if (process.platform === 'win32') {
    const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean) as string[]
    const extra = pg
      ? pf.flatMap((p) => versionedBins(join(p, 'PostgreSQL')))
      : pf.flatMap((p) => [...versionedBins(join(p, 'MySQL'), 'MySQL Server'), ...versionedBins(p, 'MariaDB')])
    return [...fromPath, ...extra]
  }
  const common = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
  const extra = pg
    ? ['/Applications/Postgres.app/Contents/Versions/latest/bin', ...versionedBins('/usr/lib/postgresql')]
    : ['/usr/local/mysql/bin', '/opt/homebrew/opt/mysql-client/bin']
  return [...fromPath, ...common, ...extra]
}

/** The user's configured path wins; otherwise search PATH and the usual install folders. */
export function findTool(tool: ToolName, override?: string): { path: string | null; custom: boolean } {
  if (override) return { path: existsSync(override) ? override : null, custom: true }
  for (const dir of candidateDirs(tool)) {
    const p = join(dir, tool + EXE)
    if (existsSync(p)) return { path: p, custom: false }
  }
  return { path: null, custom: false }
}

export function toolVersion(path: string): string | null {
  const res = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
  if (res.status !== 0) return null
  // Some clients echo their own path first ("C:\...\mysql.exe  Ver 8.4"); keep just the version text.
  return res.stdout.trim().split('\n')[0].replace(path, basename(path, EXE)).trim()
}

// ---- argument building --------------------------------------------------------------------

function pgEnv(c: ToolConnection): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGPASSWORD: c.password ?? '',
    PGSSLMODE: c.ssl.mode,
    ...(c.ssl.caPath ? { PGSSLROOTCERT: c.ssl.caPath } : {}),
    PGAPPNAME: 'DevPlus'
  }
}

const pgConnArgs = (c: ToolConnection) => ['-h', c.host, '-p', String(c.port), '-U', c.user, '-d', c.database || 'postgres', '--no-password']

/** pg_dump table patterns are case-folded unless quoted, so always quote both parts. */
function pgTablePattern(qualified: string): string {
  const dot = qualified.indexOf('.')
  const [schema, table] = dot > 0 ? [qualified.slice(0, dot), qualified.slice(dot + 1)] : ['public', qualified]
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`
  return `${q(schema)}.${q(table)}`
}

/**
 * MySQL tools read the password from an option file so it never appears in the
 * process list. The file is private to this user and removed when the tool exits.
 */
function mysqlOptionFile(c: ToolConnection): string {
  const file = join(tmpdir(), `devplus-${randomUUID()}.cnf`)
  const escaped = (c.password ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  writeFileSync(file, `[client]\npassword="${escaped}"\n`, { mode: 0o600 })
  return file
}

function mysqlSslArgs(c: ToolConnection, mariadb: boolean): string[] {
  const ca = c.ssl.caPath ? [`--ssl-ca=${c.ssl.caPath}`] : []
  if (mariadb) {
    if (c.ssl.mode === 'disable') return ['--skip-ssl']
    if (c.ssl.mode === 'require') return ['--ssl', ...ca]
    if (c.ssl.mode === 'verify-full') return ['--ssl', '--ssl-verify-server-cert', ...ca]
    return []
  }
  const mode = { disable: 'DISABLED', prefer: 'PREFERRED', require: 'REQUIRED', 'verify-full': 'VERIFY_IDENTITY' }[c.ssl.mode]
  return [`--ssl-mode=${mode}`, ...ca]
}

const mysqlConnArgs = (c: ToolConnection, optionFile: string, mariadb: boolean) => [
  // Must come first, or the client ignores it.
  `--defaults-extra-file=${optionFile}`,
  '-h',
  c.host,
  '-P',
  String(c.port),
  '-u',
  c.user,
  '--protocol=TCP',
  ...mysqlSslArgs(c, mariadb)
]

const isMariaDbTool = (path: string) => /mariadb/i.test(toolVersion(path) ?? '')

// ---- process runner ---------------------------------------------------------------------

interface RunOptions {
  env?: NodeJS.ProcessEnv
  /** Pipe this file into the tool's stdin. */
  input?: string
  /** Write the tool's stdout to this file. */
  output?: string
  onLog: LogLine
}

/** Run a tool, streaming stderr to the log. Rejects with the tail of stderr on failure. */
async function runTool(path: string, args: string[], o: RunOptions): Promise<void> {
  if (o.input && !existsSync(o.input)) throw new Error(`File not found: ${o.input}`)
  const child = spawn(path, args, { env: o.env ?? process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const tail: string[] = []
  let partial = ''
  const onText = (chunk: Buffer) => {
    const lines = (partial + chunk.toString('utf8')).split(/\r?\n/)
    partial = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      o.onLog(line)
      tail.push(line)
      if (tail.length > 12) tail.shift()
    }
  }
  child.stderr.on('data', onText)

  const out = o.output ? createWriteStream(o.output) : null
  if (out) child.stdout.pipe(out)
  else child.stdout.on('data', onText)

  // An unreadable input must fail the run; otherwise the tool sees an empty script and "succeeds".
  let inputError: Error | null = null
  if (o.input) {
    createReadStream(o.input)
      .on('error', (e) => {
        inputError = e
        child.kill()
      })
      .pipe(child.stdin)
  } else child.stdin.end()
  child.stdin.on('error', () => {
    // The tool may exit early (bad password) and close stdin; the exit code reports why.
  })

  const [code] = (await Promise.race([once(child, 'close'), once(child, 'error').then(([e]) => Promise.reject(e))])) as [number | null]
  if (partial.trim()) {
    o.onLog(partial)
    tail.push(partial)
  }
  if (out) {
    if (!out.writableFinished) await once(out, 'finish').catch(() => {})
  }
  if (inputError) throw new Error(`Could not read ${o.input}: ${(inputError as Error).message}`)
  if (code !== 0) {
    if (o.output) rmSync(o.output, { force: true })
    const reason = tail.filter((l) => !/^\s*(pg_dump|pg_restore|mysqldump): (reading|dumping|saving|processing|creating|executing|last built-in)/i.test(l))
    throw new Error(reason.slice(-4).join('\n') || `The tool exited with code ${code}.`)
  }
}

// ---- backup / restore ------------------------------------------------------------------------

export async function backup(
  tools: Partial<Record<ToolName, string | null>>,
  c: ToolConnection,
  o: BackupOptions,
  outPath: string,
  onLog: LogLine
): Promise<{ bytes: number }> {
  if (c.engine === 'postgres') {
    const tool = tools.pg_dump
    if (!tool) throw new Error('pg_dump was not found. Install the PostgreSQL client tools or set its path.')
    const args = [
      ...pgConnArgs(c),
      '--verbose',
      '-F',
      o.format === 'custom' ? 'c' : 'p',
      ...(o.content === 'schema' ? ['--schema-only'] : o.content === 'data' ? ['--data-only'] : []),
      ...(o.clean && o.format === 'plain' && o.content !== 'data' ? ['--clean', '--if-exists'] : []),
      ...(o.noOwner ? ['--no-owner', '--no-privileges'] : []),
      ...o.tables.flatMap((t) => ['-t', pgTablePattern(t)])
    ]
    await runTool(tool, args, { env: pgEnv(c), output: outPath, onLog })
  } else if (c.engine === 'mysql') {
    const tool = tools.mysqldump
    if (!tool) throw new Error('mysqldump was not found. Install the MySQL client tools or set its path.')
    if (!c.database) throw new Error('Choose a database to back up.')
    const optionFile = mysqlOptionFile(c)
    try {
      const args = [
        ...mysqlConnArgs(c, optionFile, isMariaDbTool(tool)),
        '--verbose',
        ...(o.content === 'schema' ? ['--no-data'] : o.content === 'data' ? ['--no-create-info', '--skip-triggers'] : []),
        ...(o.routines && o.content !== 'data' ? ['--routines', '--events'] : []),
        ...(o.singleTransaction ? ['--single-transaction'] : []),
        c.database,
        ...o.tables
      ]
      await runTool(tool, args, { output: outPath, onLog })
    } finally {
      rmSync(optionFile, { force: true })
    }
  } else {
    throw new Error('SQLite backups are made in-app.')
  }
  return { bytes: statSync(outPath).size }
}

/** pg_dump custom archives start with this magic; anything else is treated as SQL text. */
export function isPgArchive(path: string): boolean {
  const buf = Buffer.alloc(5)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buf, 0, 5, 0)
  } finally {
    closeSync(fd)
  }
  return buf.toString('latin1') === 'PGDMP'
}

export async function restore(
  tools: Partial<Record<ToolName, string | null>>,
  c: ToolConnection,
  o: RestoreOptions,
  inPath: string,
  onLog: LogLine
): Promise<void> {
  if (!existsSync(inPath)) throw new Error(`File not found: ${inPath}`)
  if (c.engine === 'postgres') {
    if (isPgArchive(inPath)) {
      const tool = tools.pg_restore
      if (!tool) throw new Error('pg_restore was not found. Install the PostgreSQL client tools or set its path.')
      const args = [
        ...pgConnArgs(c),
        '--verbose',
        ...(o.clean ? ['--clean', '--if-exists'] : []),
        ...(o.noOwner ? ['--no-owner', '--no-privileges'] : []),
        ...(o.singleTransaction ? ['--single-transaction'] : []),
        ...(o.stopOnError ? ['--exit-on-error'] : [])
      ]
      await runTool(tool, args, { env: pgEnv(c), input: inPath, onLog })
    } else {
      const tool = tools.psql
      if (!tool) throw new Error('psql was not found. Install the PostgreSQL client tools or set its path.')
      const args = [
        ...pgConnArgs(c),
        '-X',
        '-q',
        ...(o.stopOnError ? ['-v', 'ON_ERROR_STOP=1'] : []),
        ...(o.singleTransaction ? ['--single-transaction'] : [])
      ]
      await runTool(tool, args, { env: pgEnv(c), input: inPath, onLog })
    }
  } else if (c.engine === 'mysql') {
    const tool = tools.mysql
    if (!tool) throw new Error('The mysql client was not found. Install the MySQL client tools or set its path.')
    if (!c.database) throw new Error('Choose a database to restore into.')
    const optionFile = mysqlOptionFile(c)
    try {
      const args = [...mysqlConnArgs(c, optionFile, isMariaDbTool(tool)), ...(o.stopOnError ? [] : ['--force']), c.database]
      await runTool(tool, args, { input: inPath, onLog })
    } finally {
      rmSync(optionFile, { force: true })
    }
  } else {
    throw new Error('Restore a SQLite backup by opening the file as a connection, or run a .sql file.')
  }
}

export const TOOLS_FOR: Partial<Record<Engine, ToolName[]>> = {
  postgres: ['pg_dump', 'pg_restore', 'psql'],
  mysql: ['mysqldump', 'mysql']
}
