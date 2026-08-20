# Pi-compatible Presets 产品需求文档（PRD）

> 状态：Implemented v1.0  
> 产品版本：`dsh-pi-compatible 0.2.0`  
> Pi 基线：`@earendil-works/pi-coding-agent 0.84.2`，永久冻结  
> DSH 基线：`0.1.0-rc.6`，同时参考并验证 rc.7 seam 兼容性  
> 正式支持平台：Windows  
> 权限前提：`danger-full-access`

---

## 1. 产品定义

Pi-compatible 是一套面向 DeepSeek Harness 的 Full Access Coding Agent Preset。产品参考 Pi coding-agent 0.84.2 的工具实现，在 DSH 中提供高保真的七工具契约，同时保留 DSH 对文件系统、进程、附件、会话、取消、模型路由和 GUI 展示的宿主所有权。

产品不复制 Pi 的完整 Agent 内核、TUI 或动态工具激活机制。兼容承诺集中在：

1. 工具名称与参数 Schema；
2. 关键文件、Shell、搜索与截断语义；
3. 对模型决策有影响的成功、失败和续读行为；
4. DSH Full Access 环境中的可靠执行。

---

## 2. 用户原始需求

用户只使用 DSH `danger-full-access`，希望制定一套参考 Pi Agent 工具实现的 preset。产品应优先满足用户本人的 Windows 本地开发工作流，同时保持可公开安装和审阅。

由此确定：

- 不为 `read-only` 或 `workspace-write` 设计兼容流程；
- 不实现权限申请、审批升级或自动重试；
- 不把 PowerShell 静默伪装成 Bash；
- 不因 Full Access 而放弃 DSH 的会话、进程、文件和 UI seam；
- 工具层高保真，Persona 和 DSH 扩展层可定制。

---

## 3. 产品目标

### 3.1 P0 目标

1. 默认暴露 Pi 0.84.2 的全部七个内置工具；
2. 工具 Schema 与关键行为兼容 Pi 0.84.2；
3. Windows 下执行真实 Git Bash；
4. `find` 使用 fd，`grep` 使用 ripgrep；
5. 文件编辑保留 BOM、CRLF/LF，并原子提交；
6. Core 与 Plus 工具目录严格分离；
7. 一个 Bundle 同时安装两个 preset；
8. 通过 DSH rc.6 真实文件系统、子进程和 Web Host mount 验证。

### 3.2 长期目标

1. 保持 Pi 0.84.2 契约稳定，不滚动追随 Pi 最新版；
2. 新能力以 Plus 扩展或新 preset 提供，不污染 Core；
3. 保持 POSIX 可移植性，但 Windows 始终是发布阻断平台；
4. 维护中英双语安装和使用文档。

---

## 4. 非目标

本产品不承诺：

1. Pi 全部系统提示、TUI、会话内核或动态工具激活机制；
2. 错误文案和 UI 渲染逐字节一致；
3. 持久 Shell、后台 Shell 或 KillShell；
4. Code Mode/PTC；
5. 受限权限模式兼容；
6. 模型路由、凭据或审批系统；
7. 把 DSH attachment 不支持的 BMP 强行作为图片块发送；
8. 自动修改用户复制后定制的 Persona；
9. 对未来 Pi 版本保持兼容。

---

## 5. 产品形态

一个 npm Bundle 安装两个 preset。

### 5.1 Pi-compatible Core

ID：`pi-compatible`

模型可见工具恰好为：

```text
read
bash
edit
write
grep
find
ls
```

Core 同时加载：

- 简短可复制定制的 Persona；
- DSH Agent Instructions，包括 `AGENTS.md`；
- Native 工具呈现；
- DSH 基础 Compaction；
- `/compact`；
- Tool Result Pruner。

Compaction 和工作区指令不会增加模型可见工具，因此不破坏七工具 Core 定义。

### 5.2 Pi-compatible Plus

ID：`pi-compatible-plus`

Plus 包含 Core 全部能力，并额外注册：

```text
WebFetch
WebSearch
Task
TodoWrite
ExitPlanMode
Think
SlashCommand
```

以及：

```text
/plan
/compact
DSH Compaction
```

这些能力必须在文档和系统提示中明确标记为 DSH-backed 扩展，不得宣称属于 Pi 0.84.2 Core。

---

## 6. 核心设计原则

### 6.1 冻结基线

兼容权威来源固定为：

```text
@earendil-works/pi-coding-agent 0.84.2
```

本产品线不自动升级 Pi 基线。若未来需要跟随新版 Pi，应建立新产品线、主版本或独立 preset。

### 6.2 七工具全部可见

Pi 0.84.2 默认只激活 `read`、`bash`、`edit`、`write`，但内置工具总数为七个。本产品默认暴露全部七个，因为 DSH 不复刻 Pi 的动态工具激活机制。

这是明确的产品差异，不是缺陷。

### 6.3 DSH 与 Pi 的职责分层

DSH 负责：

- 路径解析和授权；
- 文件原子发布和版本守卫；
- 子进程创建、进程树取消和退出；
- Attachment 存储；
- Session、Model Route、工具卡片和日志；
- Host Plane 服务。

Preset 负责：

- 工具 Schema；
- 参数校验；
- Pi 截断算法；
- Bash 查找和调用约定；
- 编辑匹配、BOM、换行和批量语义；
- fd/rg 发现和安装；
- 模型可见结果格式；
- Core/Plus 工具目录边界。

### 6.4 Full Access-only

- 产品只在 `danger-full-access` 下设计和测试；
- preset 不在 mount 时强制拒绝其他权限；
- 系统提示明确要求模型不要请求权限升级；
- Host Policy 更窄时，工具直接报告 Host 拒绝或能力限制；
- 其他权限模式的行为不构成兼容承诺。

---

## 7. Persona 与指令

### 7.1 默认 Persona

默认 Persona 应保持简短：

- 身份为 Pi-compatible Coding Agent；
- 注入当前模型名和工作目录；
- 风格直接、简洁、动手执行；
- 优先检查仓库、运行命令和精确编辑；
- 只报告用户需要的信息。

### 7.2 Persona 定制

Persona 不属于稳定兼容契约。深度定制流程为：

1. 复制 Core 或 Plus 为新 preset ID；
2. 编辑副本的 `agent.cordis.yml`；
3. 保留核心工具模块不变。

不提供全局 `PI_COMPAT_PERSONA` 环境变量，避免同一进程内两个 preset 的身份被隐式同时改变。

### 7.3 工作区指令

Core 和 Plus 均加载 DSH Agent Instructions，最大读取量为 65,536 字节。

---

## 8. 核心工具需求

## 8.1 `read`

### Schema

```text
read(path, offset?, limit?)
```

- `path`：必填字符串；
- `offset`：可选 number，1 起始；
- `limit`：可选 number。

### 文本行为

1. 只读取普通文件；
2. `offset` 超过文件尾时明确失败；
3. 用户 `limit` 选出窗口后，仍应用 2,000 行和 50 KiB 双重上限；
4. 使用 Head Truncation，只返回完整行；
5. 首行超过 50 KiB 时不返回半行，并提示通过 Bash 分块读取；
6. 截断时给出下一次 `offset`；
7. 文本整文件超过 64 MiB 时，在解码前拒绝并提示使用 Bash 分块；
8. 成功后发出 DSH `fs/observed`。

### 图片行为

识别扩展名：

```text
png jpg jpeg gif webp bmp
```

- PNG/JPEG/GIF/WebP 通过 DSH attachment seam；
- 当前模型支持图片时返回图片块；
- 当前模型不支持图片时返回明确说明，不把图片块送入模型；
- BMP 被识别，但 DSH rc.6/rc.7 不接受 `image/bmp`，因此返回转换说明；
- DSH attachment 无图片缩放接口，大图保持原尺寸，并在结果中披露与 Pi 2,000×2,000 缩放行为的差异；
- 媒体扩展名与真实字节不一致时拒绝。

## 8.2 `bash`

### Schema

```text
bash(command, timeout?)
```

- `command`：必填字符串；
- `timeout`：可选 number，单位秒；
- 不设置默认超时；
- 最大值受 Node Timer 上限 `2,147,483,647 ms` 约束。

### Shell 行为

1. 每次调用创建新的真实 Bash 进程；
2. 调用之间不保留 `cd`、环境变量或 Shell 状态；
3. 不提供后台任务 API；
4. Windows 优先解析 Program Files 中的 Git Bash；
5. 其次解析 PATH 中的 Bash；
6. 旧式 Windows/WSL Bash 使用 stdin 传递命令；
7. 不得静默使用 PowerShell。

### 执行行为

- 使用 DSH `ctx.subprocess`；
- 当前会话 cwd 作为进程 cwd；
- stdout 和 stderr 按到达顺序合并；
- DSH 负责进程树取消；
- timeout 和 abort 必须终止进程树；
- 非零退出码形成错误结果；
- 成功且无输出返回 `(no output)`。

### 输出行为

- 保留最后 2,000 行或 50 KiB；
- 单个末行超过上限时允许保留该行尾部；
- 截断时写入私有临时完整日志；
- 默认完整日志上限为 64 MiB；
- 工具结果包含完整日志路径。

## 8.3 `edit`

### Schema

```text
edit(path, edits[{ oldText, newText }])
```

### 行为

1. `edits` 至少一项，默认最多 64 项；
2. 所有 `oldText` 匹配同一份原始文件；
3. 每个 `oldText` 必须唯一；
4. 区间不得重叠；
5. 优先精确匹配；
6. 精确匹配失败时，允许 Pi 风格 NFKC、智能引号、破折号、特殊空格和行尾空白归一化匹配；
7. 模糊匹配时保留未修改行的原始内容；
8. 保留 UTF-8 BOM；
9. 保留原始 CRLF/LF；
10. 无实际变化时拒绝；
11. 同一目标文件的 edit/write 串行化；
12. 最终只执行一次 DSH `writeText`；
13. 写入使用当前版本或 DSH edit intent 的 `replaceIfVersion` 守卫；
14. 任一验证失败时不得部分写入。

Diff 通过 DSH Diff Card 展示，不要求把 Pi Unified Patch 逐字返回模型。

## 8.4 `write`

```text
write(path, content)
```

- 写入完整 UTF-8 内容；
- 文件不存在时创建；
- 文件存在时整体替换；
- DSH 本地文件系统自动创建父目录；
- 与 edit 共用同文件 mutation queue；
- 通过 `fs/write-intent` 和 DSH 原子写 seam；
- 成功后发出 `fs/observed`。

## 8.5 `find`

```text
find(pattern, path?, limit?)
```

- 使用 fd；
- 默认 limit 为 1,000；
- 包含隐藏文件；
- Git 仓库中遵循 fd 的 Git-aware ignore；
- 仓库外使用 `--no-require-git`；
- 包含 `/` 的 pattern 使用 full-path 匹配；
- Windows 下转换路径分隔模式；
- 结果相对搜索根并统一为 `/`；
- 最终输出上限 50 KiB。

## 8.6 `grep`

```text
grep(pattern, path?, glob?, ignoreCase?, literal?, context?, limit?)
```

- 使用 ripgrep JSON 输出；
- 默认 limit 为 100 个匹配；
- 包含隐藏文件并遵循 ignore；
- `ignoreCase`、`literal`、`glob` 生效；
- context 为非负 number；
- 每个匹配行最多 500 字符；
- context 行格式与匹配行可区分；
- context 展开跳过超过 10 MiB 的单文件，避免整文件解码造成 Host 内存尖峰；
- 达到匹配上限时终止 rg；
- 无匹配返回 `No matches found`；
- 最终输出上限 50 KiB。

## 8.7 `ls`

```text
ls(path?, limit?)
```

- 只列一个目录；
- 默认 limit 为 500；
- 包含点文件；
- 忽略大小写排序；
- 目录后添加 `/`；
- 空目录返回 `(empty directory)`；
- 最终输出上限 50 KiB。

---

## 9. fd/rg 管理

### 9.1 解析顺序

1. `PI_COMPAT_FD_PATH` / `PI_COMPAT_RG_PATH`；
2. 系统 PATH；
3. `<DSH_HOME>/pi-compatible/bin`；
4. GitHub 最新兼容 Release。

### 9.2 离线模式

以下任一变量为 `1`、`true` 或 `yes` 时禁止网络下载：

```text
PI_COMPAT_OFFLINE
PI_OFFLINE
```

缺少二进制时必须返回可操作错误。

### 9.3 下载安全

- 使用 HTTPS GitHub API 和 Release URL；
- 下载、解压目录位于 DSH Home 私有缓存；
- 文件和目录仅当前用户可访问；
- GitHub Asset 提供 SHA-256 Digest 时必须校验；
- 使用唯一临时目录防止并发冲突；
- 失败后清理半成品；
- 本 npm 包不分发 fd/rg 二进制。

---

## 10. Plus 扩展需求

### 10.1 Web

- `WebFetch` 只允许 HTTP(S)；
- 可选 `prompt` 必须作为 Focus Instruction 进入返回文本；
- 页面正文上限 50,000 字符；
- `WebSearch` 默认最多 10 个来源。

### 10.2 Task

- 启动 DSH Subagent；
- Prompt 必须自包含；
- 默认 provider 为 `spawn`；
- `model` 仅作为兼容字段；
- run 必须在结束后释放。

### 10.3 Todo

- `TodoWrite` 每次提交完整列表；
- 状态为 `pending`、`in_progress`、`completed`；
- 复用 DSH `todo/write` 事件。

### 10.4 Plan

- `/plan` 进入会话级计划模式；
- 计划模式只允许只读探索；
- `ExitPlanMode` 必须通过 DSH userQuestions 审核；
- 审核拒绝或通道不可用时不得执行。

### 10.5 Think 与 Slash

- `Think` 无外部副作用；
- `SlashCommand` 只执行 DSH 已注册命令；
- 未知命令明确失败。

---

## 11. 安装与升级

### 11.1 Bundle

```bash
dsh plugin --profile web add kingguuu8-svg/dsh-pi-compatible
```

本地安装：

```bash
dsh plugin --profile web add .
```

### 11.2 安装目标

```text
<DSH_HOME>/.agent-presets/pi-compatible/
<DSH_HOME>/.agent-presets/pi-compatible-plus/
```

### 11.3 幂等规则

- 完整目标默认不覆盖；
- 打包文件变化时提示 `force: true`；
- `force: true` 覆盖打包清单中的文件；
- `0.1.x → 0.2.0` 强制迁移会删除已知的旧版包内 Legacy 模块；
- 不删除清单之外的其他用户文件；
- Core 与 Plus 均为自包含 preset；
- Plus 内的核心模块必须与 Core 保持字节一致，catalog 除外。

### 11.4 版本

本次重构版本为 `0.2.0`。不保留旧 PascalCase Legacy preset，也不保留未激活的：

```text
pi-fs.mjs
pi-search.mjs
pi-shell.mjs
pi-core-fs-loader.mjs
```

---

## 12. 环境变量

| 变量 | 需求 |
|---|---|
| `PI_COMPAT_BASH_PATH` | 覆盖真实 Bash 绝对路径 |
| `PI_COMPAT_FD_PATH` | 覆盖 fd 绝对路径 |
| `PI_COMPAT_RG_PATH` | 覆盖 rg 绝对路径 |
| `PI_COMPAT_OFFLINE` | 禁用二进制下载 |
| `PI_OFFLINE` | Pi 兼容离线变量 |
| `DSH_HOME` | Preset 根和二进制缓存归属 |

---

## 13. 安全要求

1. 模型工作区文件操作必须通过 DSH fs seam；
2. Bash 和搜索进程必须通过 DSH subprocess seam；
3. 进程取消必须作用于完整进程树；
4. 编辑必须使用版本守卫和原子发布；
5. 图片必须通过 DSH attachment 验证；
6. WebFetch 拒绝非 HTTP(S)；
7. 下载器不得覆盖任意用户路径；
8. 下载临时目录必须唯一且失败清理；
9. Full Access 假设必须在 README、PRD 和系统提示中同时披露；
10. 第三方源码行为参考必须保留 MIT Notice。

---

## 14. 非功能需求

### 14.1 兼容性

- Node.js：包声明 `>=20`；
- DSH 正式验证：rc.6；
- DSH seam 参考：rc.7；
- Windows：正式支持；
- POSIX：Best Effort。

### 14.2 输出边界

- 文本读取：2,000 行 / 50 KiB；
- Bash：尾部 2,000 行 / 50 KiB；
- Bash 完整 Spill：默认 64 MiB，超限时删除不完整 Spill 并继续只保留有界尾部；
- 文本 Read 整文件安全上限：64 MiB；
- Grep Context 单文件安全上限：10 MiB；
- Grep：默认 100 匹配，单行 500 字符；
- Find：默认 1,000 条；
- LS：默认 500 条；
- WebFetch：50,000 字符；
- Edit：默认 64 个替换、10 MiB 文件。

### 14.3 可审计性

- Core 和 Plus Composition 可直接阅读；
- 无运行时生成的隐藏工具；
- 二进制来源和缓存路径有文档；
- README 中英双语；
- PRD 中文；
- Git 记录所有实现变化。

---

## 15. 验收标准

### 15.1 Core

- [x] 工具目录恰好为七个小写工具；
- [x] 七工具默认全部可见；
- [x] Host 工具被 catalog 限制；Native Presentation 确保 `run_code` 不进入模型目录；
- [x] Native 呈现；
- [x] Agent Instructions；
- [x] DSH Compaction。

### 15.2 文件

- [x] Read offset/limit 与 Head Truncation；
- [x] 首行超限提示；
- [x] Write 原子发布；
- [x] Edit 唯一和重叠检查；
- [x] Edit 模糊标点兼容；
- [x] BOM 保留；
- [x] CRLF/LF 保留；
- [x] 版本守卫；
- [x] 同文件 mutation queue。

### 15.3 Shell

- [x] Windows 真实 Git Bash；
- [x] 非持久；
- [x] 无默认 timeout；
- [x] 可选秒级 timeout；
- [x] stdout/stderr 合并；
- [x] Tail Truncation；
- [x] 私有完整输出 Spill；
- [x] 非零退出、abort、timeout 错误。

### 15.4 搜索

- [x] fd Find；
- [x] rg Grep；
- [x] 系统、缓存、下载解析；
- [x] 离线模式；
- [x] Windows Release Asset；
- [x] Git ignore 行为；
- [x] Grep JSON 和 context；
- [x] LS 排序和 dotfiles。

### 15.5 Plus

- [x] Plus 自包含；
- [x] Web、Task、Todo、Plan、Think、Slash；
- [x] `/plan` 和 `/compact`；
- [x] `WebFetch.prompt` 进入输出；
- [x] Core 与 Plus 核心模块同步检查。

### 15.6 安装与真实 DSH

- [x] 一个 Bundle 安装两个 preset；
- [x] 幂等安装；
- [x] Force 更新；
- [x] DSH rc.6 Local FS/Subprocess Integration；
- [x] 真实 Git Bash 执行；
- [x] 真实 fd/rg 下载或缓存；
- [x] 运行中 DSH Web Host `agentPreset.list` 发现两个 preset；
- [x] `session.create` 成功 mount Core；
- [x] `session.create` 成功 mount Plus。

---

## 16. 测试命令

```bash
npm run check
npm test
npm run test:integration
```

### 单元测试覆盖

- 七工具目录与 Schema；
- Host catalog 限制；
- BOM、CRLF、模糊匹配；
- 重复和重叠编辑失败；
- Read 续读；
- Write seam；
- Bash argv 和无默认 timeout；
- LS 排序；
- 双 preset 安装器；
- Core/Plus 边界；
- Plus 核心文件漂移。

### 集成测试覆盖

- 全局安装 DSH rc.6 的 LocalFileSystem；
- LocalSubprocessRuntime；
- 真实 Git Bash；
- fd Find；
- rg Grep；
- DSH 原子文件写入与编辑。

---

## 17. 已知偏差

| 偏差 | 原因 | 产品处理 |
|---|---|---|
| 默认七工具，而 Pi 默认四工具 | 不复刻动态激活 | 明确记录为有意差异 |
| BMP 无图片块 | DSH attachment 不接受 BMP | 返回转换说明 |
| 大图不缩放到 2,000×2,000 | DSH attachment 无 resize seam | 保存原图并披露 |
| Diff 不作为 Pi Patch 文本返回 | DSH UI 已有 Diff Card | 保持模型结果简洁 |
| 错误文案不逐字一致 | DSH Error 与平台差异 | 保证错误类别和可操作性 |
| Windows 为唯一发布阻断平台 | 用户真实使用环境优先 | POSIX Best Effort |

---

## 18. 发布产物

主要产物：

- `agent.cordis.yml`：Core Composition；
- `preset.yml`：Core Metadata；
- `pi-core-common.mjs`：Pi 截断和共享算法；
- `pi-core-fs.mjs`：read/write/edit；
- `pi-core-shell.mjs`：真实非持久 Bash；
- `pi-core-binaries.mjs`：fd/rg 管理；
- `pi-core-search.mjs`：find/grep/ls；
- `presets/pi-compatible-plus/`：Plus 自包含模板；
- `lib/index.js`：双 preset 安装器；
- `README.md` / `README.zh.md`；
- `THIRD_PARTY_NOTICES.md`；
- `test/`。

---

## 19. 最终产品原则

1. Pi 0.84.2 是冻结事实，不是滚动目标；
2. Core 只承诺七工具；
3. Plus 扩展必须显式；
4. Full Access 是产品前提；
5. DSH 拥有宿主能力，preset 拥有工具语义；
6. Bash 必须是真实 Bash；
7. 编辑必须保真、唯一、原子；
8. 搜索必须使用 fd/rg；
9. 输出必须有界且可恢复；
10. 文档、测试和实际工具目录必须保持一致。
