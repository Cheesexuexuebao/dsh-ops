# @deepseek-ai/dsh-ssh

[English](README.md) | 中文

`ctx.ssh` 传输 seam 的 Service Definition：连接、非交互 exec、SFTP 与交互式 shell。提供方继承 `SshTransport` 并注册为 `ctx.ssh`。

## 形态

- `ctx.ssh.connect(request)` / `disconnect(id)` — 打开或拆除传输连接。
- `ctx.ssh.list()` / `setActive(id)` — 活动连接元数据与默认连接 id。
- `ctx.ssh.exec(id, command, opts?)` — 非交互远程命令。
- `ctx.ssh.realpath` / `stat` / `listDir` / `readFile` / `writeFile` / `mkdir` / `remove` / `rename` — 经该连接的远程文件系统。
- `ctx.ssh.openShell(id, { cols, rows })` — 交互式 PTY 句柄（`write` / `onData` / `resize` / `close`）。

只加载一个提供方（例如 `@deepseek-ai/dsh-ssh-ssh2`）。SSH ops 等产品插件应 `inject` `ssh`，不得自行打开传输客户端。

## 模型体验

### 传输 seam

#### 模型看到的内容

本包单独不贡献任何模型可见内容。工具与提示词属于消费方插件；本定义只拥有宿主侧传输约定。

#### Token 影响

每个请求的直接 token 为零。

#### KV Cache 影响

与实时请求无关：本包绝不触及请求前缀。

## 已知限制与暂缓事项

- 本包不附带提供方；部署必须挂载实现，例如 `dsh-ssh-ssh2`。
- 隧道／端口转发原语尚未进入 seam 表面；需要它们的消费方在方法落地前可暂时使用提供方专用 API。
