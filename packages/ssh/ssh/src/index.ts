/**
 * Service Definition for the `ctx.ssh` capability seam: connect, exec, SFTP,
 * and optional interactive shells. Providers subclass {@link SshTransport}.
 * @module @deepseek-ai/dsh-ssh
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  SshConnectRequest,
  SshConnectionId,
  SshConnectionInfo,
  SshDirEntry,
  SshExecResult,
  SshPathStat,
  SshShellHandle,
} from './types.ts'

export type {
  SshAuth,
  SshConnectRequest,
  SshConnectionId,
  SshConnectionInfo,
  SshDirEntry,
  SshExecResult,
  SshPathStat,
  SshProxyHop,
  SshShellHandle,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    ssh: SshTransport
  }
}

/**
 * Abstract SSH transport. Subclass, implement the abstract methods, and load
 * the subclass as a plugin — it registers as `ctx.ssh` (one implementation per
 * context; a second mount fails as Cordis duplicate-service behavior).
 */
export abstract class SshTransport extends Service {
  constructor(ctx: Context) {
    super(ctx, 'ssh')
  }

  /** Open a connection and return its id. */
  abstract connect(request: SshConnectRequest): Promise<SshConnectionId>

  /** Tear down a connection and its derived channels. */
  abstract disconnect(id: SshConnectionId): Promise<void>

  /** List live connections and the active id (if any). */
  abstract list(): Promise<{
    connections: readonly SshConnectionInfo[]
    activeId: SshConnectionId | null
  }>

  /** Mark which connection subsequent defaulted calls should prefer. */
  abstract setActive(id: SshConnectionId | null): void

  /** Run a non-interactive command on a connection. */
  abstract exec(
    id: SshConnectionId,
    command: string,
    opts?: { timeoutMs?: number },
  ): Promise<SshExecResult>

  /**
   * Canonicalize a remote path. This is the uniqueness canon for workspace
   * and attach checks when the execution world is SSH.
   */
  abstract realpath(id: SshConnectionId, path: string): Promise<string>

  abstract stat(id: SshConnectionId, path: string): Promise<SshPathStat>

  abstract listDir(id: SshConnectionId, path: string): Promise<readonly SshDirEntry[]>

  abstract readFile(id: SshConnectionId, path: string): Promise<Uint8Array>

  abstract writeFile(id: SshConnectionId, path: string, data: Uint8Array): Promise<void>

  abstract mkdir(id: SshConnectionId, path: string): Promise<void>

  abstract remove(id: SshConnectionId, path: string): Promise<void>

  abstract rename(id: SshConnectionId, from: string, to: string): Promise<void>

  /** Open an interactive PTY shell on an existing connection. */
  abstract openShell(
    id: SshConnectionId,
    opts: { cols: number; rows: number },
  ): Promise<SshShellHandle>
}
