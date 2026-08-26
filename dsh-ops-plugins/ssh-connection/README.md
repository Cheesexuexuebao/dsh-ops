# dsh-ssh-connection

Owns SSH **transport mount** (`dsh-ssh-ssh2`), **Settings → SSH 资源**, and connect/disconnect around `ctx.ssh`.

`dsh-ssh-ops` is optional: terminal / SFTP / tunnels / DB. Connecting from resources dispatches `dsh-ssh-connection:connected`; ops opens the terminal if loaded.

## Profile order

```text
dsh-ssh-connection → dsh-ssh-ops (optional) → dsh-ssh-monitor (optional)
```

## Dev

```bash
npm run build
```

Install profile deps on **Windows** (not WSL), e.g. `file:D:/Project/.../ssh-connection`.
