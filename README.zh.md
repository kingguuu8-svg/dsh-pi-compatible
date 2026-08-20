# dsh-pi-compatible

[English](README.md) | 中文

本项目提供两个**仅面向 Full Access** 的 DeepSeek Harness Agent Preset，核心工具契约永久冻结到 `@earendil-works/pi-coding-agent 0.84.2`。

- **Pi-compatible Core**：只向模型暴露七个小写核心工具：`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`。
- **Pi-compatible Plus**：在 Core 基础上增加显式的 DSH-backed Web、Task、Todo、Plan、Think、Slash 和压缩能力。

两个 preset 继续使用 DSH 的文件系统、子进程、附件、会话、取消、模型路由和工具展示 seam。产品只针对 `danger-full-access` 权限预设设计和测试，不为更窄权限实现申请升级或审批重试流程。

## 产品契约

### Core 工具

| 工具 | Pi-compatible 行为 |
|---|---|
| `read(path, offset?, limit?)` | 最多保留开头 2,000 行或 50 KiB，支持 offset 续读；整文件安全上限为 64 MiB；文本与 PNG/JPEG/GIF/WebP/BMP 图片最终受 DSH attachment 能力约束 |
| `bash(command, timeout?)` | 每次启动新的真实 Bash，不保留状态；无默认超时；输出保留尾部，截断时写入私有完整日志 |
| `edit(path, edits[])` | 所有编辑匹配同一份原文件；要求唯一且不重叠；支持 Pi 风格标点模糊匹配；保留 BOM 与 CRLF/LF；一次带版本守卫的原子写入 |
| `write(path, content)` | 通过 DSH 完整写入 UTF-8 文件；DSH 本地文件系统自动创建缺失的父目录 |
| `grep(...)` | 使用 ripgrep JSON 输出；默认 100 个匹配；单行最多 500 字符；支持 context、glob、literal 和大小写选项 |
| `find(pattern, path?, limit?)` | 使用 fd；默认 1,000 个结果；遵循 `.gitignore`；返回相对路径 |
| `ls(path?, limit?)` | 只列一个目录；包含点文件；忽略大小写排序；目录后加 `/`；默认 500 项 |

七个工具默认全部可见。这里有意不同于 Pi 0.84.2 默认只激活 `read`、`bash`、`edit`、`write` 四个工具的行为，因为本项目不复刻 Pi 的动态工具激活机制。

### Plus 扩展

`pi-compatible-plus` 额外注册：

- `WebFetch`
- `WebSearch`
- `Task`
- `TodoWrite`
- `ExitPlanMode`
- `Think`
- `SlashCommand`
- `/plan`
- `/compact`
- DSH 基础压缩和工具结果裁剪

这些是 DSH-backed 扩展，不属于 Pi 0.84.2 七工具 Core。

## 安装

安装到 DSH Web Profile：

```bash
dsh plugin --profile web add kingguuu8-svg/dsh-pi-compatible
```

也可以安装本地仓库：

```bash
dsh plugin --profile web add .
```

Bundle 会同时安装：

```text
${DSH_HOME:-~/.dsh}/.agent-presets/pi-compatible/
${DSH_HOME:-~/.dsh}/.agent-presets/pi-compatible-plus/
```

安装器是幂等的：目标 preset 文件完整存在时默认不覆盖。升级时可在 Profile Patch 的 Bundle 行设置 `force: true`，覆盖打包文件。强制执行 `0.1.x → 0.2.0` 迁移时还会删除 Core 目录中已知的旧版包内模块；无关的用户文件会保留。

安装后新建会话，选择 **Pi-compatible Core** 或 **Pi-compatible Plus**。

## 运行参数

| 环境变量 | 含义 |
|---|---|
| `PI_COMPAT_BASH_PATH` | 真实 Bash 的绝对路径 |
| `PI_COMPAT_FD_PATH` | `fd` 的绝对路径 |
| `PI_COMPAT_RG_PATH` | `rg` 的绝对路径 |
| `PI_COMPAT_OFFLINE=1` | 禁止下载 fd/rg |
| `PI_OFFLINE=1` | 同样禁止下载 fd/rg 的 Pi 兼容变量 |
| `DSH_HOME` | DSH Home，以及私有 `pi-compatible/bin` 缓存根目录 |

Windows 下优先解析 Program Files 中的 Git Bash，然后才查找 PATH。系统不会把 PowerShell 静默伪装成 `bash`。

`fd` 和 `rg` 的解析顺序：

1. 环境变量指定的绝对路径；
2. PATH 中的系统可执行文件；
3. `<DSH_HOME>/pi-compatible/bin` 中的缓存；
4. 最新兼容 GitHub Release，除非启用了离线模式。

GitHub 提供 SHA-256 Asset Digest 时会执行校验。下载和解压目录只对当前用户开放。

## Persona 定制

默认 Persona 保持简短、直接、动手执行。需要定制时，请复制 preset 为新的 ID，再编辑副本的 `agent.cordis.yml`。工具兼容性是稳定产品契约，Persona 文本不是。

## 兼容性边界

- Pi 基线永久冻结为 `0.84.2`。
- 高保真范围是 Schema 和关键行为，不要求错误文案或 Pi TUI 渲染逐字一致。
- DSH 负责路径授权、文件原子发布、进程树取消、附件、会话和 GUI 工具卡片。
- Core 能识别 BMP，但 DSH rc.6/rc.7 attachment 不接收 BMP，因此返回转换说明，不生成图片块。
- Pi 会把大图缩放到最大 2,000×2,000；DSH attachment seam 没有缩放操作，因此保存原图，并在工具结果中披露偏差。
- 文本 `read` 在整文件超过 64 MiB 时会在解码前拒绝；Grep context 展开会跳过超过 10 MiB 的文件，防止单次调用耗尽常驻 DSH Host 内存。
- Windows 是正式发布阻断平台；POSIX 仅保持尽可能可移植。
- preset 挂载时不会主动拒绝更窄的 DSH 权限模式。其他模式不受支持；Host 拒绝会被直接报告，模型也会被明确要求不要申请权限升级。

## 开发与验证

```bash
npm run check
npm test
npm run test:integration
```

- 单元测试使用最小 DSH seam mock，不需要 LLM API Key。
- `test:integration` 使用全局安装的 DSH rc.6 本地文件系统和子进程包，执行真实 Git Bash，并验证下载或缓存后的 fd、ripgrep。
- 真实 DSH Web Host 另通过 `session.create` 创建空白 Core/Plus 会话验证挂载，不需要发送模型请求。

## 信任说明

用户 preset 是 Cordis Composition，权限等于它加载的插件。本项目有意只支持 Full Access，可执行任意 Bash 命令，并修改 Host 进程允许访问的文件。安装第三方 Bundle 前请审阅源码。

## License

MIT。Pi 0.84.2 行为参考和许可说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
