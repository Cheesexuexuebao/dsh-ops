# dsh-ops-plugins

DeepSeek Harness 运维二次开发插件（旁路目录，**不**加入 `pnpm-workspace` / 官方 `packages/*/*` 门禁）。

本目录位于仓库根下：

```text
deepseek-harness/
  packages/          # 官方 monorepo 包
  dsh-ops-plugins/   # 本目录：运维产品插件
```

**个性化改了什么（新增 / 屏蔽）：** 见 [个性化功能清单.md](./个性化功能清单.md)。

## 插件

| 目录 | 包名 | 说明 |
|------|------|------|
| `ssh-connection` | `dsh-ssh-connection` | SSH 连接、资源、侧栏当前连接 |
| `ssh-ops` | `dsh-ssh-ops` | 终端 / SFTP / 隧道 / 数据库 |
| `ssh-monitor` | `dsh-ssh-monitor` | 远端监控与 Docker |
| `ops-workspace` | `dsh-ops-workspace` | 固定 `~/.dsh/dsh-ops` 工作区；禁用动态 Cordis 自扩展；锁定标准模式 |
| `ops-skin` | `dsh-ops-skin` | 青色科技风皮肤（单主题、节点环品牌） |

SSH 传输契约包 `@deepseek-ai/dsh-ssh` / `dsh-ssh-ssh2` 在 harness 的 `packages/ssh/`。

## 安装到 web profile

**不要**把 `C:\Users\<你>\.dsh\profiles\web\package.json` 提交到 GitHub：那是本机 profile，`file:` 路径因人而异。

在 **Windows PowerShell**（路径随仓库位置解析）：

```powershell
cd <你的克隆目录>\deepseek-harness\dsh-ops-plugins
.\scripts\setup-web-profile.ps1
```

或手动：

```powershell
$root = "<你的克隆目录>\deepseek-harness\dsh-ops-plugins"
dsh plugin --profile web add $root\ssh-connection
dsh plugin --profile web add $root\ssh-ops
dsh plugin --profile web add $root\ssh-monitor
dsh plugin --profile web add $root\ops-workspace
dsh plugin --profile web add $root\ops-skin
```

建议顺序：connection → ops / monitor → ops-workspace → ops-skin。

`profiles/web/package.json.example` 仅作结构参考；DSH 实际读取 `~/.dsh/profiles/web/`。
