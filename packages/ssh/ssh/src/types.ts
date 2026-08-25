/**
 * Shared types for the `ctx.ssh` transport seam.
 * @module @deepseek-ai/dsh-ssh/types
 */

/** Opaque id for one live SSH transport connection. */
export type SshConnectionId = string

/** How the client authenticates to the remote sshd. */
export type SshAuth =
  | { readonly kind: 'password'; readonly password: string }
  | { readonly kind: 'key'; readonly privateKey: string; readonly passphrase?: string }

/** One ProxyJump hop (inline auth; not a bare host string). */
export interface SshProxyHop {
  readonly host: string
  readonly port?: number
  readonly username: string
  readonly auth: SshAuth
  readonly readyTimeout?: number
}

/** Request to open a new SSH connection. */
export interface SshConnectRequest {
  readonly host: string
  readonly port: number
  readonly username: string
  readonly auth: SshAuth
  /** Optional display name; may influence generated connection ids. */
  readonly name?: string
  readonly readyTimeout?: number
  readonly keepaliveInterval?: number
  readonly keepaliveCountMax?: number
  /** Optional ProxyJump hop list, applied before the target. */
  readonly proxyJump?: readonly SshProxyHop[]
}

/** Public metadata for a live connection (never includes secrets). */
export interface SshConnectionInfo {
  readonly id: SshConnectionId
  readonly host: string
  readonly port: number
  readonly username: string
  readonly name?: string
}

/** Result of a non-interactive remote command. */
export interface SshExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut?: boolean
  readonly truncated?: boolean
}

/** Directory or file metadata from the remote filesystem. */
export interface SshPathStat {
  /** Canonical remote path after provider realpath. */
  readonly path: string
  readonly isDirectory: boolean
  readonly size?: number
  readonly mtimeMs?: number
}

/** One entry from a remote directory listing. */
export interface SshDirEntry {
  readonly name: string
  readonly isDirectory: boolean
  readonly size?: number
  readonly mtimeMs?: number
}

/** Interactive shell channel opened on an existing connection. */
export interface SshShellHandle {
  write(data: string): void
  resize(cols: number, rows: number): void
  close(): void
  /** Subscribe to PTY output; returns an unsubscribe function. */
  onData(listener: (chunk: string) => void): () => void
  /** Subscribe to channel close; returns an unsubscribe function. */
  onClose(listener: () => void): () => void
}
