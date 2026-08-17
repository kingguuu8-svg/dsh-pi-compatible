# dsh-pi-compatible

在 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 中复刻 Pi 工具组的 Pi-compatible agent preset。

本项目把 Pi coding-agent 0.84.2 的核心工具调用契约接入 DSH 宿主能力，同时保留 DSH 提供的网页检索、任务、计划、todo、think 和 slash 扩展。

## 提供的核心工具

- `read(path, offset?, limit?)`
- `write(path, content)`
- `edit(path, edits[{oldText, newText}])`
- `bash(command, timeout?)`
- `find(pattern, path?, limit?)`
- `grep(pattern, path?, glob?, ignoreCase?, literal?, context?, limit?)`
- `ls(path?, limit?)`

核心工具使用 DSH 的 `ctx.fs`、`ctx.shell` 和 `ctx.subprocess` seam，不复制或替换 DSH 宿主的沙箱、凭据和审批实现。图片读取通过 DSH attachment seam 返回，前提是当前模型路由声明支持图像输入。

## 安装

在 DSH 的 `web` profile 中安装：

```bash
dsh plugin --profile web add kingguuu8-svg/dsh-pi-compatible
```

也可以在本地仓库目录执行：

```bash
dsh plugin --profile web add .
```

安装后重启 DSH。插件会把自带的 `pi-compatible` preset 幂等复制到：

```text
${DSH_HOME:-~/.dsh}/.agent-presets/pi-compatible/
```

如果目标 preset 已存在，默认不会覆盖；需要升级包内版本时，在 profile patch 的插件行中设置 `force: true`。

然后新建会话并选择 **Pi-compatible 模式**。

## 直接使用 preset 文件

如果不需要安装 bundle，也可以把以下文件放入 `$DSH_HOME/.agent-presets/pi-compatible/`：

- `preset.yml`
- `agent.cordis.yml`
- `pi-*.mjs`

其中核心工具实现是 `pi-core-fs.mjs`、`pi-core-shell.mjs` 和 `pi-core-search.mjs`；`pi-core-fs-loader.mjs` 只负责提供可刷新的本地加载入口。

## 开发与测试

```bash
npm run check
npm test
```

测试不需要 LLM API Key；测试上下文使用最小化的 DSH seam mock。

## 兼容性边界

- 目标 DSH 版本：`0.1.0-rc.6` 及兼容的后续版本。
- 核心工具名称和参数采用 Pi-compatible 小写契约。
- `WebSearch`、`Task`、`ExitPlanMode`、`Think`、`TodoWrite` 和 `SlashCommand` 是 DSH-backed 扩展，不宣称为 Pi core 工具。
- preset 权限等于它引用的 DSH 插件权限，请在安装第三方 bundle 前自行审阅源码。

## License

MIT
