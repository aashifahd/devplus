import { spawn, execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import type { LocalServer } from '@shared/servers'
import { binDir } from './paths'
import { dataDir, logPath, myIniPath, pidPath } from './paths'
import { exe, hasExe } from './binaries'

const run = promisify(execFile)
const fwd = (p: string) => p.replace(/\\/g, '/')

/** Quote one argument for a Windows command line (CommandLineToArgvW rules). */
export const winQuote = (a: string) => (/[\s"]/.test(a) ? `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"` : a)

/**
 * Start a long-running server so it is NOT a child of DevPlus. On Windows a child inherits every
 * inheritable handle of its parent (Chromium's sockets and pipes included) and keeps them open
 * after DevPlus exits. Win32_Process.Create starts it from the WMI service instead: nothing is
 * inherited, it runs hidden, and it outlives the app.
 */
async function launchDetached(file: string, args: string[], cwd: string): Promise<void> {
  if (process.platform !== 'win32') {
    spawn(file, args, { cwd, detached: true, stdio: 'ignore' }).unref()
    return
  }
  const script = [
    '$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }',
    '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:DEVPLUS_CMD; CurrentDirectory = $env:DEVPLUS_CWD; ProcessStartupInformation = $si }',
    'if ($r.ReturnValue -ne 0) { Write-Error "Win32_Process.Create returned $($r.ReturnValue)"; exit 1 }'
  ].join('; ')
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true,
    env: { ...process.env, DEVPLUS_CMD: [file, ...args].map(winQuote).join(' '), DEVPLUS_CWD: cwd }
  })
}

/** How DevPlus drives one server engine. All servers listen on 127.0.0.1 only. */
export interface EngineDriver {
  /** Create the data directory on first start. */
  initialize(s: LocalServer): Promise<void>
  /** Start in the background; resolves once the process is launched (readiness is checked by the caller). */
  start(s: LocalServer): Promise<void>
  /** Ask the server to shut down cleanly. */
  stop(s: LocalServer): Promise<void>
  /** The server's process id from its pid file, if any. */
  pid(s: LocalServer): number | null
  configPath(s: LocalServer): string
}

function readPid(file: string): number | null {
  try {
    const n = Number(readFileSync(file, 'utf8').split(/\r?\n/)[0].trim())
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

const postgres: EngineDriver = {
  async initialize(s) {
    const data = dataDir(s.id)
    if (existsSync(`${data}/PG_VERSION`)) return
    // Local development defaults: trust on localhost, UTF-8, C locale (no OS locale surprises).
    await run(exe('postgres', s.version, 'initdb'), ['-D', data, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--locale=C'], { windowsHide: true, maxBuffer: 8 << 20 })
  },
  async start(s) {
    // pg_ctl launches postgres with a restricted token, so it also works from an admin session,
    // and the server keeps running after DevPlus exits.
    await launchDetached(
      exe('postgres', s.version, 'pg_ctl'),
      ['start', '-D', dataDir(s.id), '-l', logPath(s.id), '-o', `-p ${s.port} -c listen_addresses=127.0.0.1`, '-W'],
      dataDir(s.id)
    )
  },
  async stop(s) {
    await run(exe('postgres', s.version, 'pg_ctl'), ['stop', '-D', dataDir(s.id), '-m', 'fast', '-w', '-t', '30'], { windowsHide: true })
  },
  pid: (s) => readPid(`${dataDir(s.id)}/postmaster.pid`),
  configPath: (s) => `${dataDir(s.id)}/postgresql.conf`
}

function writeMyIni(s: LocalServer) {
  const isMaria = s.engine === 'mariadb'
  const lines = [
    '# Written by DevPlus. Settings below [mysqld] apply on the next restart; port is managed in DevPlus.',
    '[mysqld]',
    `basedir=${fwd(binDir(s.engine, s.version))}`,
    `datadir=${fwd(dataDir(s.id))}`,
    `port=${s.port}`,
    'bind-address=127.0.0.1',
    `log-error=${fwd(logPath(s.id))}`,
    `pid-file=${fwd(pidPath(s.id))}`,
    'character-set-server=utf8mb4',
    // MySQL's X protocol listens on 33060 by default, which would clash between instances.
    ...(isMaria ? [] : ['mysqlx=OFF']),
    ...(s.binlog ? ['log-bin=binlog', 'server-id=1'] : isMaria ? [] : ['disable_log_bin']),
    '',
    '[client]',
    `port=${s.port}`,
    'host=127.0.0.1',
    ''
  ]
  // Keep anything the user added after DevPlus's block.
  const path = myIniPath(s.id)
  const extra = existsSync(path) ? readFileSync(path, 'utf8').split('# --- your settings ---')[1] ?? '' : ''
  writeFileSync(path, `${lines.join('\n')}# --- your settings ---${extra || '\n'}`)
}

/** MariaDB renamed its programs (mysqld -> mariadbd); support both layouts. */
const pick = (s: LocalServer, ...names: string[]) => {
  const name = names.find((n) => hasExe(s.engine, s.version, n))
  if (!name) throw new Error(`${names[0]} is missing from ${s.engine} ${s.version}. Reinstall that version.`)
  return exe(s.engine, s.version, name)
}

const mysqlFamily: EngineDriver = {
  async initialize(s) {
    writeMyIni(s)
    const data = dataDir(s.id)
    if (existsSync(`${data}/mysql`)) return
    if (s.engine === 'mysql') {
      // root@localhost without a password: a local development server.
      await run(pick(s, 'mysqld'), [`--defaults-file=${myIniPath(s.id)}`, '--initialize-insecure'], { windowsHide: true, maxBuffer: 8 << 20 })
    } else {
      await run(pick(s, 'mariadb-install-db', 'mysql_install_db'), [`--datadir=${data}`], { windowsHide: true, maxBuffer: 8 << 20 })
    }
  },
  async start(s) {
    writeMyIni(s)
    const server = s.engine === 'mariadb' ? pick(s, 'mariadbd', 'mysqld') : pick(s, 'mysqld')
    // Output goes to log-error in my.ini.
    await launchDetached(server, [`--defaults-file=${myIniPath(s.id)}`], dataDir(s.id))
  },
  async stop(s) {
    const admin = s.engine === 'mariadb' ? pick(s, 'mariadb-admin', 'mysqladmin') : pick(s, 'mysqladmin')
    await run(admin, ['-u', 'root', '-h', '127.0.0.1', '-P', String(s.port), '--connect-timeout=5', 'shutdown'], { windowsHide: true })
  },
  pid: (s) => readPid(pidPath(s.id)),
  configPath: (s) => myIniPath(s.id)
}

export const DRIVERS: Record<LocalServer['engine'], EngineDriver> = { postgres, mysql: mysqlFamily, mariadb: mysqlFamily }
