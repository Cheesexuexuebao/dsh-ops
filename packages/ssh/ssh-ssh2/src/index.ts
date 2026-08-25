/**
 * `ssh2` Service Provider for the `ctx.ssh` transport seam.
 * Owns connection maps, reconnect, SFTP, PTY shells, and port forwards.
 * @module @deepseek-ai/dsh-ssh-ssh2
 */

import { randomUUID } from 'node:crypto'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { SshTransport } from '@deepseek-ai/dsh-ssh'
import type {
  SshAuth,
  SshConnectRequest,
  SshConnectionId,
  SshConnectionInfo,
  SshDirEntry,
  SshExecResult,
  SshPathStat,
  SshProxyHop,
  SshShellHandle,
} from '@deepseek-ai/dsh-ssh'
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2'

const KEEPALIVE_INTERVAL_MS = 20000
const KEEPALIVE_COUNT_MAX = 3
const CONNECT_RETRIES = 3
const RECONNECT_BASE_DELAY_MS = 1000
const RECONNECT_MAX_DELAY_MS = 30000
const RECONNECT_WAIT_MS = 30000
const MAX_EXEC_OUTPUT_BYTES = 64 * 1024
const S_IFMT = 0o170000
const S_IFDIR = 0o040000

interface ShellEntry {
  handle: SshShellHandle
  close(): void
}

interface TunnelRecord {
  id: string
  kind: 'local' | 'remote'
  bindAddr: string
  bindPort: number
  remoteHost: string
  remotePort: number
  targetHost?: string
  targetPort?: number
  server?: net.Server
  active: boolean
  bridgeInfo?: {
    kind: 'remote'
    bindAddr: string
    bindPort: number
    bridge: (info: { destIP: string; destPort: number }, accept: () => Duplex) => void
  }
}

interface ConnectionRecord {
  id: SshConnectionId
  client: Client | null
  hops: Client[]
  host: string
  port: number
  username: string
  name?: string
  sftp: SFTPWrapper | null
  tunnels: Map<string, TunnelRecord>
  shells: Set<ShellEntry>
  connectConfig: ConnectConfig
  proxyJump: readonly SshProxyHop[]
  dead: boolean
  closing: boolean
  reconnectTimer: ReturnType<typeof setTimeout> | null
  reconnectAttempts: number
  reconnectWaiters: Array<() => void>
}

export interface SshTunnelStartLocalRequest {
  connectionId: SshConnectionId
  bindAddr?: string
  bindPort?: number
  remoteHost: string
  remotePort: number
}

export interface SshTunnelStartRemoteRequest {
  connectionId: SshConnectionId
  bindAddr?: string
  bindPort?: number
  remoteHost: string
  remotePort: number
  targetHost: string
  targetPort: number
}

export interface SshTunnelStopRequest {
  connectionId: SshConnectionId
  tunnelId: string
}

export interface SshTunnelListRequest {
  connectionId: SshConnectionId
}

export interface SshTunnelInfo {
  tunnelId: string
  kind: 'local' | 'remote'
  bindAddr: string
  bindPort: number
  remoteHost: string
  remotePort: number
  active: boolean
  targetHost?: string
  targetPort?: number
}

function authToConnectFields(auth: SshAuth): Pick<ConnectConfig, 'password' | 'privateKey' | 'passphrase'> {
  if (auth.kind === 'password') return { password: auth.password }
  const fields: Pick<ConnectConfig, 'privateKey' | 'passphrase'> = { privateKey: auth.privateKey }
  if (auth.passphrase !== undefined) fields.passphrase = auth.passphrase
  return fields
}

function appendCapped(current: string, next: string, maxBytes: number): { text: string; truncated: boolean } {
  const existing = Buffer.byteLength(current, 'utf8')
  const incoming = Buffer.from(next, 'utf8')
  if (existing >= maxBytes) return { text: current, truncated: incoming.length > 0 }
  const remaining = maxBytes - existing
  if (incoming.length <= remaining) return { text: current + next, truncated: false }
  return { text: current + incoming.subarray(0, remaining).toString('utf8'), truncated: true }
}

function isDirectoryMode(mode: number | undefined): boolean {
  return mode !== undefined && (mode & S_IFMT) === S_IFDIR
}

/**
 * ssh2-backed transport. Mount as a Cordis plugin to occupy `ctx.ssh`.
 */
export default class SshSsh2Transport extends SshTransport {
  private readonly connections = new Map<SshConnectionId, ConnectionRecord>()
  private activeConnectionId: SshConnectionId | null = null

  constructor(ctx: Context) {
    super(ctx)
    ctx.effect(() => () => {
      for (const conn of this.connections.values()) {
        conn.closing = true
        if (conn.reconnectTimer !== null) clearTimeout(conn.reconnectTimer)
        for (const shell of [...conn.shells]) {
          try { shell.close() } catch { /* ignore */ }
        }
        conn.shells.clear()
        for (const tunnel of conn.tunnels.values()) {
          try {
            if (tunnel.kind === 'local') tunnel.server?.close()
            else if (tunnel.bridgeInfo?.bridge && conn.client) {
              conn.client.removeListener('tcp connection', tunnel.bridgeInfo.bridge)
            }
          } catch { /* ignore */ }
        }
        try { conn.client?.end() } catch { /* ignore */ }
        for (const hop of conn.hops) {
          try { hop.end() } catch { /* ignore */ }
        }
      }
      this.connections.clear()
      this.activeConnectionId = null
    }, 'ssh-ssh2: cleanup')
  }

  async connect(request: SshConnectRequest): Promise<SshConnectionId> {
    const id = request.name ? `${request.name}-${randomUUID().slice(0, 8)}` : randomUUID()
    const connectConfig: ConnectConfig = {
      host: request.host,
      port: request.port,
      username: request.username,
      readyTimeout: request.readyTimeout ?? 20000,
      keepaliveInterval: request.keepaliveInterval ?? KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: request.keepaliveCountMax ?? KEEPALIVE_COUNT_MAX,
      ...authToConnectFields(request.auth),
    }
    const record: ConnectionRecord = {
      id,
      client: null,
      hops: [],
      host: request.host,
      port: request.port,
      username: request.username,
      ...(request.name !== undefined ? { name: request.name } : {}),
      sftp: null,
      tunnels: new Map(),
      shells: new Set(),
      connectConfig,
      proxyJump: request.proxyJump ?? [],
      dead: true,
      closing: false,
      reconnectTimer: null,
      reconnectAttempts: 0,
      reconnectWaiters: [],
    }
    this.connections.set(id, record)
    try {
      await this.connectClient(record)
    } catch (error) {
      this.connections.delete(id)
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${request.username}@${request.host}:${request.port}: ${message}`)
    }
    this.attachTransportHandlers(record)
    this.activeConnectionId = id
    return id
  }

  async disconnect(id: SshConnectionId): Promise<void> {
    const conn = this.connections.get(id)
    if (conn === undefined) throw new Error(`connection "${id}" does not exist`)
    conn.closing = true
    if (conn.reconnectTimer !== null) {
      clearTimeout(conn.reconnectTimer)
      conn.reconnectTimer = null
    }
    for (const shell of [...conn.shells]) {
      try { shell.close() } catch { /* ignore */ }
    }
    conn.shells.clear()
    for (const tunnel of [...conn.tunnels.values()]) {
      try {
        if (tunnel.kind === 'local') {
          await new Promise<void>((resolve) => { tunnel.server?.close(() => resolve()) ?? resolve() })
        } else if (tunnel.bridgeInfo?.bridge && conn.client) {
          conn.client.removeListener('tcp connection', tunnel.bridgeInfo.bridge)
          await new Promise<void>((resolve) => {
            conn.client?.unforwardIn(tunnel.bindAddr, tunnel.bindPort, () => resolve())
          })
        }
      } catch { /* ignore */ }
    }
    conn.tunnels.clear()
    this.connections.delete(id)
    if (this.activeConnectionId === id) this.activeConnectionId = null
    try { conn.client?.end() } catch { /* ignore */ }
    for (const hop of conn.hops) {
      try { hop.end() } catch { /* ignore */ }
    }
    conn.hops = []
  }

  async list(): Promise<{ connections: readonly SshConnectionInfo[]; activeId: SshConnectionId | null }> {
    const connections: SshConnectionInfo[] = []
    for (const c of this.connections.values()) {
      connections.push(c.name !== undefined
        ? { id: c.id, host: c.host, port: c.port, username: c.username, name: c.name }
        : { id: c.id, host: c.host, port: c.port, username: c.username })
    }
    return { connections, activeId: this.activeConnectionId }
  }

  setActive(id: SshConnectionId | null): void {
    if (id !== null && !this.connections.has(id)) {
      throw new Error(`connection "${id}" does not exist`)
    }
    this.activeConnectionId = id
  }

  async exec(
    id: SshConnectionId,
    command: string,
    opts?: { timeoutMs?: number },
  ): Promise<SshExecResult> {
    const conn = this.requireRecord(id)
    if (!(await this.ensureAlive(conn))) {
      throw new Error(`connection "${id}" is down and could not be re-established`)
    }
    const timeoutMs = opts?.timeoutMs ?? 30000
    return this.execOnce(conn, command, timeoutMs, false)
  }

  private async execOnce(
    conn: ConnectionRecord,
    command: string,
    timeoutMs: number,
    retried: boolean,
  ): Promise<SshExecResult> {
    let stdout = ''
    let stderr = ''
    let exitCode = 0
    let truncated = false
    let timedOut = false
    try {
      const client = conn.client
      if (!client) throw new Error('no client')
      const stream = await new Promise<ClientChannel>((resolve, reject) => {
        client.exec(command, { pty: false }, (error, s) => {
          if (error) reject(error)
          else resolve(s)
        })
      })
      const timer = setTimeout(() => {
        timedOut = true
        try { stream.close() } catch { /* ignore */ }
      }, timeoutMs)
      await new Promise<void>((resolve) => {
        stream.on('data', (chunk: Buffer | string) => {
          const result = appendCapped(stdout, chunk.toString('utf8'), MAX_EXEC_OUTPUT_BYTES)
          stdout = result.text
          truncated ||= result.truncated
        })
        stream.stderr.on('data', (chunk: Buffer | string) => {
          const result = appendCapped(stderr, chunk.toString('utf8'), MAX_EXEC_OUTPUT_BYTES)
          stderr = result.text
          truncated ||= result.truncated
        })
        stream.on('close', (code: number | null) => {
          clearTimeout(timer)
          exitCode = typeof code === 'number' ? code : timedOut ? 124 : 1
          resolve()
        })
        stream.on('error', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    } catch (error) {
      if (!retried && conn.dead && (await this.ensureAlive(conn))) {
        return this.execOnce(conn, command, timeoutMs, true)
      }
      throw error instanceof Error ? error : new Error(String(error))
    }
    return {
      exitCode,
      stdout,
      stderr,
      ...(timedOut ? { timedOut: true } : {}),
      ...(truncated ? { truncated: true } : {}),
    }
  }

  async realpath(id: SshConnectionId, path: string): Promise<string> {
    const sftp = await this.requireSftp(id)
    if (typeof sftp.realpath === 'function') {
      return new Promise((resolve, reject) => {
        sftp.realpath(path, (error, absolute) => {
          if (error) reject(error)
          else resolve(absolute)
        })
      })
    }
    return path
  }

  async stat(id: SshConnectionId, path: string): Promise<SshPathStat> {
    const sftp = await this.requireSftp(id)
    const attrs = await new Promise<{ mode?: number; size?: number; mtime?: number }>((resolve, reject) => {
      sftp.stat(path, (error, a) => {
        if (error) reject(error)
        else resolve(a)
      })
    })
    return {
      path,
      isDirectory: isDirectoryMode(attrs.mode),
      ...(attrs.size !== undefined ? { size: attrs.size } : {}),
      ...(attrs.mtime !== undefined ? { mtimeMs: attrs.mtime * 1000 } : {}),
    }
  }

  async listDir(id: SshConnectionId, path: string): Promise<readonly SshDirEntry[]> {
    const sftp = await this.requireSftp(id)
    const entries = await new Promise<Array<{ filename: string; attrs: { mode?: number; size?: number; mtime?: number } }>>((resolve, reject) => {
      sftp.readdir(path, (error, list) => {
        if (error) reject(error)
        else resolve(list)
      })
    })
    return entries.map((entry) => ({
      name: entry.filename,
      isDirectory: isDirectoryMode(entry.attrs.mode),
      ...(entry.attrs.size !== undefined ? { size: entry.attrs.size } : {}),
      ...(entry.attrs.mtime !== undefined ? { mtimeMs: entry.attrs.mtime * 1000 } : {}),
    }))
  }

  async readFile(id: SshConnectionId, path: string): Promise<Uint8Array> {
    const sftp = await this.requireSftp(id)
    const chunks: Buffer[] = []
    const stream = sftp.createReadStream(path)
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      stream.on('end', () => resolve())
      stream.on('error', reject)
    })
    return new Uint8Array(Buffer.concat(chunks))
  }

  async writeFile(id: SshConnectionId, path: string, data: Uint8Array): Promise<void> {
    const sftp = await this.requireSftp(id)
    const buf = Buffer.from(data)
    await new Promise<void>((resolve, reject) => {
      const stream = sftp.createWriteStream(path)
      stream.on('close', () => resolve())
      stream.on('error', reject)
      stream.end(buf)
    })
  }

  async mkdir(id: SshConnectionId, path: string): Promise<void> {
    const sftp = await this.requireSftp(id)
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(path, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  async remove(id: SshConnectionId, path: string): Promise<void> {
    const sftp = await this.requireSftp(id)
    const isDir = await new Promise<boolean>((resolve, reject) => {
      sftp.stat(path, (error, attrs) => {
        if (error) reject(error)
        else resolve(isDirectoryMode(attrs.mode))
      })
    })
    await new Promise<void>((resolve, reject) => {
      const fn = isDir ? sftp.rmdir.bind(sftp) : sftp.unlink.bind(sftp)
      fn(path, (error: Error | undefined | null) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  async rename(id: SshConnectionId, from: string, to: string): Promise<void> {
    const sftp = await this.requireSftp(id)
    await new Promise<void>((resolve, reject) => {
      sftp.rename(from, to, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  async openShell(
    id: SshConnectionId,
    opts: { cols: number; rows: number },
  ): Promise<SshShellHandle> {
    const conn = this.requireRecord(id)
    if (!(await this.ensureAlive(conn))) {
      throw new Error(`connection "${id}" is down and could not be re-established`)
    }
    const client = conn.client
    if (!client) throw new Error(`connection "${id}" has no client`)
    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      client.shell({ term: 'xterm-256color', cols: opts.cols, rows: opts.rows }, (error, s) => {
        if (error) reject(error)
        else resolve(s)
      })
    })

    const dataListeners = new Set<(chunk: string) => void>()
    const closeListeners = new Set<() => void>()
    let closed = false
    let entry: ShellEntry

    const notifyClose = (): void => {
      if (closed) return
      closed = true
      conn.shells.delete(entry)
      for (const listener of [...closeListeners]) {
        try { listener() } catch { /* ignore */ }
      }
      dataListeners.clear()
      closeListeners.clear()
    }

    const handle: SshShellHandle = {
      write(data: string): void {
        if (closed) throw new Error('shell is closed')
        stream.write(data)
      },
      resize(cols: number, rows: number): void {
        if (closed) throw new Error('shell is closed')
        stream.setWindow(rows, cols, 0, 0)
      },
      close(): void {
        if (closed) return
        try { stream.end() } catch { /* ignore */ }
        notifyClose()
      },
      onData(listener: (chunk: string) => void): () => void {
        dataListeners.add(listener)
        return () => { dataListeners.delete(listener) }
      },
      onClose(listener: () => void): () => void {
        closeListeners.add(listener)
        return () => { closeListeners.delete(listener) }
      },
    }

    entry = {
      handle,
      close: () => handle.close(),
    }
    conn.shells.add(entry)

    stream.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString('utf8')
      for (const listener of [...dataListeners]) {
        try { listener(text) } catch { /* ignore */ }
      }
    })
    stream.on('close', () => notifyClose())
    stream.on('error', () => notifyClose())

    this.activeConnectionId = id
    return handle
  }

  /**
   * Open a direct-tcpip channel through the SSH connection (ssh2 forwardOut).
   * Used by db-ops tunnels without exposing the raw Client.
   */
  async forwardOut(
    id: SshConnectionId,
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
  ): Promise<Duplex> {
    const conn = this.requireRecord(id)
    if (!(await this.ensureAlive(conn))) {
      throw new Error(`connection "${id}" is down and could not be re-established`)
    }
    const client = conn.client
    if (!client) throw new Error(`connection "${id}" has no client`)
    return new Promise((resolve, reject) => {
      client.forwardOut(srcIP, srcPort, dstIP, dstPort, (error, stream) => {
        if (error) reject(error)
        else resolve(stream)
      })
    })
  }

  async tunnelStartLocal(request: SshTunnelStartLocalRequest): Promise<SshTunnelInfo> {
    const conn = this.requireRecord(request.connectionId)
    if (!(await this.ensureAlive(conn))) {
      throw new Error(`connection "${conn.id}" is down and could not be re-established`)
    }
    const tunnelId = `tun-${randomUUID().slice(0, 8)}`
    const bindAddr = request.bindAddr ?? '127.0.0.1'
    const bindPort = request.bindPort ?? 0
    const server = net.createServer((socket) => {
      const client = conn.client
      if (!client) {
        socket.destroy()
        return
      }
      client.forwardOut(bindAddr, bindPort, request.remoteHost, request.remotePort, (error, stream) => {
        if (error) {
          socket.destroy()
          return
        }
        socket.pipe(stream).pipe(socket)
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(bindPort, bindAddr, () => resolve())
    })
    const address = server.address()
    const actualPort = typeof address === 'object' && address !== null ? address.port : bindPort
    conn.tunnels.set(tunnelId, {
      id: tunnelId,
      kind: 'local',
      bindAddr,
      bindPort: actualPort,
      remoteHost: request.remoteHost,
      remotePort: request.remotePort,
      server,
      active: true,
    })
    return {
      tunnelId,
      kind: 'local',
      bindAddr,
      bindPort: actualPort,
      remoteHost: request.remoteHost,
      remotePort: request.remotePort,
      active: true,
    }
  }

  async tunnelStartRemote(request: SshTunnelStartRemoteRequest): Promise<SshTunnelInfo> {
    const conn = this.requireRecord(request.connectionId)
    if (!(await this.ensureAlive(conn))) {
      throw new Error(`connection "${conn.id}" is down and could not be re-established`)
    }
    const client = conn.client
    if (!client) throw new Error(`connection "${conn.id}" has no client`)
    const tunnelId = `tun-${randomUUID().slice(0, 8)}`
    const bindAddr = request.bindAddr ?? '127.0.0.1'
    const bindPort = request.bindPort ?? 0
    await new Promise<number>((resolve, reject) => {
      client.forwardIn(bindAddr, bindPort, (error, port) => {
        if (error) reject(error)
        else resolve(port)
      })
    })
    const bridge = (info: { destIP: string; destPort: number }, accept: () => Duplex): void => {
      if (info.destIP !== bindAddr || info.destPort !== bindPort) return
      const stream = accept()
      const socket = net.connect(request.targetPort, request.targetHost)
      socket.on('error', () => stream.destroy())
      stream.on('error', () => socket.destroy())
      stream.pipe(socket).pipe(stream)
    }
    client.prependListener('tcp connection', bridge)
    const bridgeInfo = { kind: 'remote' as const, bindAddr, bindPort, bridge }
    conn.tunnels.set(tunnelId, {
      id: tunnelId,
      kind: 'remote',
      bindAddr,
      bindPort,
      remoteHost: request.remoteHost,
      remotePort: request.remotePort,
      targetHost: request.targetHost,
      targetPort: request.targetPort,
      active: true,
      bridgeInfo,
    })
    return {
      tunnelId,
      kind: 'remote',
      bindAddr,
      bindPort,
      remoteHost: request.remoteHost,
      remotePort: request.remotePort,
      targetHost: request.targetHost,
      targetPort: request.targetPort,
      active: true,
    }
  }

  async tunnelStop(request: SshTunnelStopRequest): Promise<{ tunnelId: string; stopped: true }> {
    const conn = this.requireRecord(request.connectionId)
    const tunnel = conn.tunnels.get(request.tunnelId)
    if (tunnel === undefined) {
      throw new Error(`tunnel "${request.tunnelId}" does not exist on this connection`)
    }
    if (tunnel.kind === 'local') {
      await new Promise<void>((resolve) => { tunnel.server?.close(() => resolve()) ?? resolve() })
    } else {
      if (tunnel.bridgeInfo?.bridge && conn.client) {
        conn.client.removeListener('tcp connection', tunnel.bridgeInfo.bridge)
      }
      await new Promise<void>((resolve) => {
        conn.client?.unforwardIn(tunnel.bindAddr, tunnel.bindPort, () => resolve())
      })
    }
    conn.tunnels.delete(request.tunnelId)
    return { tunnelId: request.tunnelId, stopped: true }
  }

  async tunnelList(request: SshTunnelListRequest): Promise<{ tunnels: SshTunnelInfo[] }> {
    const conn = this.requireRecord(request.connectionId)
    const tunnels = [...conn.tunnels.values()].map((t) => {
      const entry: SshTunnelInfo = {
        tunnelId: t.id,
        kind: t.kind,
        bindAddr: t.bindAddr,
        bindPort: t.bindPort,
        remoteHost: t.remoteHost,
        remotePort: t.remotePort,
        active: t.active,
      }
      if (t.targetHost !== undefined) entry.targetHost = t.targetHost
      if (t.targetPort !== undefined) entry.targetPort = t.targetPort
      return entry
    })
    return { tunnels }
  }

  private requireRecord(id: SshConnectionId): ConnectionRecord {
    const conn = this.connections.get(id)
    if (conn === undefined) throw new Error(`connection "${id}" does not exist`)
    return conn
  }

  private async connectClient(record: ConnectionRecord, retries = CONNECT_RETRIES): Promise<void> {
    let lastError: unknown = null
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (record.closing) throw new Error(`connection "${record.id}" was closed`)
      let sock: Duplex | undefined
      if (record.proxyJump.length > 0) {
        try {
          const chain = await this.connectChain(record.proxyJump, record.connectConfig.host!, record.connectConfig.port ?? 22)
          record.hops = chain.hops
          sock = chain.sock
        } catch (error) {
          lastError = error
          if (attempt >= retries) break
          await this.sleep(Math.min(2000, 500 * 2 ** attempt))
          continue
        }
      }
      const client = new Client()
      record.client = client
      try {
        await new Promise<void>((resolve, reject) => {
          client.once('ready', () => resolve())
          client.once('error', reject)
          const config: ConnectConfig = { ...record.connectConfig }
          if (sock !== undefined) config.sock = sock
          client.connect(config)
        })
        record.dead = false
        record.reconnectAttempts = 0
        return
      } catch (error) {
        lastError = error
        for (const hop of record.hops) {
          try { hop.end() } catch { /* ignore */ }
        }
        record.hops = []
        const message = String(error instanceof Error ? error.message : error)
        const transient = /reset|timeout|timed out|kex|handshake|socket|ECONN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN/i.test(message)
          && !/authenticat|permission|denied/i.test(message)
        if (!transient || attempt >= retries) break
        await this.sleep(Math.min(2000, 500 * 2 ** attempt))
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError ?? 'connection failed')
    throw new Error(message)
  }

  private async connectChain(
    proxyJump: readonly SshProxyHop[],
    targetHost: string,
    targetPort: number,
  ): Promise<{ hops: Client[]; sock: Duplex }> {
    const hops: Client[] = []
    let sock: Duplex | undefined
    for (let index = 0; index < proxyJump.length; index += 1) {
      const hopConfig = proxyJump[index]!
      const hopConnectConfig: ConnectConfig = {
        host: hopConfig.host,
        port: hopConfig.port ?? 22,
        username: hopConfig.username,
        readyTimeout: hopConfig.readyTimeout ?? 20000,
        ...authToConnectFields(hopConfig.auth),
      }
      if (sock !== undefined) hopConnectConfig.sock = sock
      const hopClient = new Client()
      try {
        await new Promise<void>((resolve, reject) => {
          hopClient.once('ready', () => resolve())
          hopClient.once('error', reject)
          hopClient.connect(hopConnectConfig)
        })
      } catch (error) {
        for (const h of hops) {
          try { h.end() } catch { /* ignore */ }
        }
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`proxyJump hop ${index + 1} (${hopConnectConfig.username}@${hopConnectConfig.host}:${hopConnectConfig.port}): ${message}`)
      }
      hops.push(hopClient)
      const next = index + 1 < proxyJump.length ? proxyJump[index + 1]! : null
      const nextHost = next !== null ? next.host : targetHost
      const nextPort = next !== null ? (next.port ?? 22) : targetPort
      sock = await new Promise<Duplex>((resolve, reject) => {
        hopClient.forwardOut('127.0.0.1', 0, nextHost, nextPort, (error, stream) => {
          if (error) {
            for (const h of hops) {
              try { h.end() } catch { /* ignore */ }
            }
            reject(new Error(`proxyJump hop ${index + 1} forwardOut to ${nextHost}:${nextPort}: ${error.message}`))
          } else {
            resolve(stream)
          }
        })
      })
    }
    if (sock === undefined) throw new Error('proxyJump chain produced no socket')
    return { hops, sock }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private attachTransportHandlers(record: ConnectionRecord): void {
    const client = record.client
    if (!client) return
    client.on('error', (error) => this.handleTransportLoss(record, client, error))
    client.on('close', () => this.handleTransportLoss(record, client, null))
  }

  private handleTransportLoss(record: ConnectionRecord, client: Client, _error: Error | null): void {
    if (record.closing || record.client !== client || record.dead) return
    record.dead = true
    record.sftp = null
    for (const shell of [...record.shells]) {
      try { shell.close() } catch { /* ignore */ }
    }
    record.shells.clear()
    for (const tunnel of record.tunnels.values()) tunnel.active = false
    this.scheduleReconnect(record)
  }

  private scheduleReconnect(record: ConnectionRecord): void {
    if (record.closing || !record.dead || record.reconnectTimer !== null) return
    const delay = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_BASE_DELAY_MS * 2 ** Math.min(record.reconnectAttempts, 5),
    )
    record.reconnectAttempts += 1
    record.reconnectTimer = setTimeout(async () => {
      record.reconnectTimer = null
      if (record.closing || !record.dead) return
      try {
        await this.connectClient(record, 0)
      } catch {
        this.scheduleReconnect(record)
        return
      }
      this.attachTransportHandlers(record)
      for (const tunnel of record.tunnels.values()) {
        if (tunnel.kind === 'remote' && tunnel.bridgeInfo?.bridge && record.client) {
          record.client.prependListener('tcp connection', tunnel.bridgeInfo.bridge)
        }
        tunnel.active = true
      }
      const waiters = record.reconnectWaiters.splice(0)
      for (const waiter of waiters) waiter()
    }, delay)
  }

  private ensureAlive(record: ConnectionRecord, timeoutMs = RECONNECT_WAIT_MS): Promise<boolean> {
    if (record.closing) return Promise.resolve(false)
    if (!record.dead) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      record.reconnectWaiters.push(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  private async requireSftp(id: SshConnectionId, retried = false): Promise<SFTPWrapper> {
    const connection = this.requireRecord(id)
    if (connection.sftp !== null) return connection.sftp
    if (!(await this.ensureAlive(connection))) {
      throw new Error(`connection "${connection.id}" is down and could not be re-established`)
    }
    const client = connection.client
    if (!client) throw new Error(`connection "${connection.id}" has no client`)
    try {
      const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
        client.sftp((error, s) => {
          if (error) reject(error)
          else resolve(s)
        })
      })
      connection.sftp = sftp
      return sftp
    } catch (error) {
      if (!retried && connection.dead && (await this.ensureAlive(connection))) {
        return this.requireSftp(id, true)
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`could not open SFTP subsystem: ${message}`)
    }
  }
}
