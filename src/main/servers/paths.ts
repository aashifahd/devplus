import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { ServerEngine } from '@shared/servers'

/** Everything for local servers lives under <userData>/servers. */
const root = () => join(app.getPath('userData'), 'servers')

const ensure = (p: string) => {
  mkdirSync(p, { recursive: true })
  return p
}

export const binDir = (engine: ServerEngine, version: string) => join(root(), 'bin', engine, version)
export const downloadsDir = () => ensure(join(root(), 'downloads'))
export const instanceDir = (id: string) => join(root(), 'instances', id)
export const dataDir = (id: string) => join(instanceDir(id), 'data')
export const logPath = (id: string) => join(instanceDir(id), 'server.log')
export const myIniPath = (id: string) => join(instanceDir(id), 'my.ini')
export const pidPath = (id: string) => join(instanceDir(id), 'server.pid')
export const ensureDir = ensure
