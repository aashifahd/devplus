import { readFileSync } from 'node:fs'
import net from 'node:net'
import { Client, type ConnectConfig } from 'ssh2'
import type { ConnectionConfig, ConnectionSecrets } from '@shared/types'
import type { Endpoint } from './drivers/types'

export interface Tunnel {
  endpoint: Endpoint
  close(): void
}

const WINDOWS_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'

function authConfig(cfg: ConnectionConfig, secrets: ConnectionSecrets): Partial<ConnectConfig> {
  const { ssh } = cfg
  switch (ssh.authMethod) {
    case 'password':
      return { password: secrets.sshPassword }
    case 'key':
      if (!ssh.privateKeyPath) throw new Error('Choose an SSH private key file.')
      return { privateKey: readFileSync(ssh.privateKeyPath), passphrase: secrets.sshPassphrase || undefined }
    case 'agent':
      return { agent: process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? WINDOWS_AGENT_PIPE : undefined) }
  }
}

/**
 * Open an SSH connection and a local listener on 127.0.0.1:<random> that forwards
 * every socket to the database host as seen from the SSH server.
 */
export function openTunnel(cfg: ConnectionConfig, secrets: ConnectionSecrets): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const ssh = new Client()
    let server: net.Server | undefined
    let settled = false

    const fail = (err: Error) => {
      server?.close()
      ssh.end()
      if (!settled) {
        settled = true
        reject(new Error(`SSH: ${err.message}`))
      }
    }

    ssh.on('error', fail)
    ssh.on('ready', () => {
      server = net.createServer((socket) => {
        ssh.forwardOut('127.0.0.1', 0, cfg.host || '127.0.0.1', cfg.port, (err, stream) => {
          if (err) {
            socket.destroy(err)
            return
          }
          socket.pipe(stream).pipe(socket)
          stream.on('error', () => socket.destroy())
          socket.on('error', () => stream.destroy())
        })
      })
      server.on('error', fail)
      server.listen(0, '127.0.0.1', () => {
        const { port } = server!.address() as net.AddressInfo
        settled = true
        resolve({
          endpoint: { host: '127.0.0.1', port },
          close: () => {
            server?.close()
            ssh.end()
          }
        })
      })
    })

    try {
      ssh.connect({
        host: cfg.ssh.host,
        port: cfg.ssh.port || 22,
        username: cfg.ssh.user,
        readyTimeout: 15000,
        keepaliveInterval: 30000,
        ...authConfig(cfg, secrets)
      })
    } catch (err) {
      fail(err as Error)
    }
  })
}
