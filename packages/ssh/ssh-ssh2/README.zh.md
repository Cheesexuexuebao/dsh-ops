# @deepseek-ai/dsh-ssh-ssh2

[English](README.md) | 中文

基于 npm `ssh2` 的 `ctx.ssh` Service Provider。在定义可用后挂载；产品插件 `inject` `ssh` 并经由本实现调用。

## 形态

- 通过继承 `@deepseek-ai/dsh-ssh` 的 `SshTransport` 注册为 `ctx.ssh`。
- 拥有活动连接表、SFTP 通道与 PTY shell（实现待迁移；方法目前会抛错）。
- 依赖 npm `ssh2`；该依赖不得进入 Definition 或产品包。

## 模型体验

### 提供方

#### 模型看到的内容

本包单独不贡献任何模型可见内容。面向模型的工具属于消费方插件。

#### Token 影响

每个请求的直接 token 为零。

#### KV Cache 影响

与实时请求无关：本包绝不触及请求前缀。

## 已知限制与暂缓事项

- 隧道辅助（`tunnelStartLocal` / `tunnelStartRemote` / `tunnelStop` / `tunnelList` / `forwardOut`）目前只在本具体提供方上，尚未进入抽象 `SshTransport` seam。
- 数据库工具仍在 `dsh-ssh-ops`，经 `forwardOut` 到达远端。
