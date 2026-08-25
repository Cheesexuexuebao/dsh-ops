# @deepseek-ai/dsh-ssh

English | [中文](README.zh.md)

Service Definition for the `ctx.ssh` transport seam: connect, non-interactive exec, SFTP, and interactive shells. Providers subclass {@link SshTransport} and register as `ctx.ssh`.

## Shape

- `ctx.ssh.connect(request)` / `disconnect(id)` — open or tear down a transport connection.
- `ctx.ssh.list()` / `setActive(id)` — live connection metadata and the preferred default id.
- `ctx.ssh.exec(id, command, opts?)` — non-interactive remote command.
- `ctx.ssh.realpath` / `stat` / `listDir` / `readFile` / `writeFile` / `mkdir` / `remove` / `rename` — remote filesystem over the connection.
- `ctx.ssh.openShell(id, { cols, rows })` — interactive PTY handle (`write` / `onData` / `resize` / `close`).

Load exactly one provider (for example `@deepseek-ai/dsh-ssh-ssh2`). Product plugins such as SSH ops inject `ssh` and must not open their own transport clients.

## Model Experience

### Transport seam

#### What the model sees

Nothing from this package alone. Tools and prompts belong to consumer plugins; this definition only owns the host-side transport contract.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of live requests: the package never touches a request prefix.

## Known Limitations and Deferred Work

- No provider ships in this package; a deployment must mount an implementation such as `dsh-ssh-ssh2`.
- Tunnel / port-forward primitives are not yet on the seam surface; consumers that need them temporarily keep provider-specific APIs until those methods land here.
