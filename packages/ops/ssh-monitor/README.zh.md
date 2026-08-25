# dsh-ssh-monitor

Host + 浏览器：经 `ctx.ssh` 只读采集远端指标；侧栏 UI 从 `dsh-side-monitor` 移植并适配。

磁盘/网络尚未采集。

## Docker

远端需有 Docker socket（默认 `/var/run/docker.sock`）及 `curl`。经 SSH 以 `curl --unix-socket` 只读调用 Docker Engine API。

在 Cordis 插件配置中可覆盖 socket 路径：

```yaml
- id: ssh-monitor
  config:
    dockerSocket: /run/docker.sock
```

socket 或 `curl` 不可用时，`containers` 会优雅返回 `available: false`。

## RPC

- 通道：`/ssh-monitor`
- 端点：`meta`、`overview`、`processes`、`containers`
- 需要活跃 SSH 连接（`dsh-ssh-ops` / `ctx.ssh`）

## 安装（web profile 示例）

把 `dsh-side-monitor` 从 bundles / dependencies 去掉，换成 `dsh-ssh-monitor`，然后重启 Host。

SSH 面板连上机器后，侧栏底部打开 **SSH 监控**。

## 开发

```bash
npm test
npm run check
```
