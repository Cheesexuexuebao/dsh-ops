# @deepseek-ai/dsh-ssh-ssh2

English | [中文](README.zh.md)

`ssh2`-backed Service Provider for `ctx.ssh`. Mount after the definition is available; product plugins inject `ssh` and call through this implementation.

## Shape

- Registers as `ctx.ssh` by subclassing `@deepseek-ai/dsh-ssh`'s `SshTransport`.
- Owns the live connection table, SFTP channels, and PTY shells (implementation pending; methods currently throw).
- Depends on the npm `ssh2` package; keep that dependency out of definition and product packages.

## Model Experience

### Provider

#### What the model sees

Nothing from this package alone. Model-facing tools belong to consumer plugins.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of live requests: the package never touches a request prefix.

## Known Limitations and Deferred Work

- Tunnel helpers (`tunnelStartLocal` / `tunnelStartRemote` / `tunnelStop` / `tunnelList` / `forwardOut`) live on this concrete provider, not yet on the abstract `SshTransport` seam.
- Database tooling stays in `dsh-ssh-ops` and reaches the remote via `forwardOut`.
