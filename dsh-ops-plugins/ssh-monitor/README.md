# dsh-ssh-monitor

Host + browser DSH plugin: read-only remote metrics over `ctx.ssh`, with a sidebar drawer UI ported from `dsh-side-monitor`.

Disk/network not collected yet.

## Docker

Requires remote Docker socket (default `/var/run/docker.sock`) and `curl` on the SSH host. Read-only Docker Engine API calls run over SSH via `curl --unix-socket`.

Override the socket path in Cordis plugin config:

```yaml
- id: ssh-monitor
  config:
    dockerSocket: /run/docker.sock
```

When the socket or `curl` is missing, `containers` returns `available: false` gracefully.

## RPC

- Channel: `/ssh-monitor`
- Endpoints: `meta`, `overview`, `processes`, `containers`
- Needs an active SSH connection (via `dsh-ssh-ops` / `ctx.ssh`)

## Install (web profile example)

```json
"bundles": [..., "dsh-ssh-ops", "dsh-ssh-monitor"]
"dependencies": {
  "dsh-ssh-monitor": "link:.../packages/ops/ssh-monitor",
  "dsh-ssh-ops": "link:.../packages/ops/ssh-ops"
}
```

Disable `dsh-side-monitor` in the same profile while testing this plugin.

Restart Host after install. Connect SSH in the ops panel, then open **SSH 监控** in the sidebar footer.

## Dev

```bash
npm test
npm run check
```
