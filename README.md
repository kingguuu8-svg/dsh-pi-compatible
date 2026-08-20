# dsh-pi-compatible

English | [中文](README.zh.md)

Two **Full Access-only** DeepSeek Harness agent presets whose core tool contract is frozen to `@earendil-works/pi-coding-agent 0.84.2`.

- **Pi-compatible Core** exposes exactly seven lower-case tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`.
- **Pi-compatible Plus** exposes the same core plus explicit DSH-backed Web, Task, Todo, Plan, Think, Slash, and compaction capabilities.

The presets use DSH's filesystem, subprocess, attachment, session, cancellation, model-routing, and presentation seams. They are designed and tested only with the `danger-full-access` permission preset; they do not implement escalation workflows for narrower policies.

## Product contract

### Core tools

| Tool | Pi-compatible behavior |
|---|---|
| `read(path, offset?, limit?)` | Head truncation at 2,000 lines or 50 KiB, offset continuation, a 64 MiB whole-file safety cap, and PNG/JPEG/GIF/WebP/BMP handling subject to DSH attachment capabilities |
| `bash(command, timeout?)` | Fresh real Bash process per call, no persistent state, no default timeout, tail truncation with a private full-output spill file |
| `edit(path, edits[])` | Original-file matching, unique non-overlapping edits, Pi-style fuzzy punctuation fallback, BOM and CRLF/LF preservation, one guarded atomic write |
| `write(path, content)` | Complete UTF-8 write through DSH; missing parent directories are created by the DSH local filesystem backend |
| `grep(...)` | ripgrep JSON search, default 100 matches, 500-character line clipping, optional context/glob/literal/case control |
| `find(pattern, path?, limit?)` | fd glob search, default 1,000 results, `.gitignore`-aware relative paths |
| `ls(path?, limit?)` | One directory, dotfiles included, case-insensitive sort, `/` after directories, default 500 entries |

All seven tools are visible by default. This intentionally differs from Pi 0.84.2's default four-tool activation (`read`, `bash`, `edit`, `write`): DSH does not reproduce Pi's dynamic tool-activation mechanism.

### Plus extensions

`pi-compatible-plus` additionally registers:

- `WebFetch`
- `WebSearch`
- `Task`
- `TodoWrite`
- `ExitPlanMode`
- `Think`
- `SlashCommand`
- `/plan`
- `/compact`
- DSH basic compaction and tool-result pruning

These are DSH-backed extensions, not Pi 0.84.2 core tools.

## Install

Install the bundle into the DSH Web profile:

```bash
dsh plugin --profile web add kingguuu8-svg/dsh-pi-compatible
```

Or install a local checkout:

```bash
dsh plugin --profile web add .
```

The bundle installs both presets into:

```text
${DSH_HOME:-~/.dsh}/.agent-presets/pi-compatible/
${DSH_HOME:-~/.dsh}/.agent-presets/pi-compatible-plus/
```

Installation is idempotent and does not overwrite a complete existing preset. Set `force: true` on the bundle row in the profile patch to replace packaged files during an upgrade. A forced `0.1.x → 0.2.0` migration also removes the known package-owned legacy modules from the Core directory; unrelated user files are preserved.

After installation, create a new session and choose **Pi-compatible Core** or **Pi-compatible Plus**.

## Runtime configuration

| Variable | Meaning |
|---|---|
| `PI_COMPAT_BASH_PATH` | Absolute path to the real Bash executable |
| `PI_COMPAT_FD_PATH` | Absolute path to `fd` |
| `PI_COMPAT_RG_PATH` | Absolute path to `rg` |
| `PI_COMPAT_OFFLINE=1` | Disable fd/rg network download |
| `PI_OFFLINE=1` | Pi-compatible alias that also disables fd/rg download |
| `DSH_HOME` | DSH home and the private `pi-compatible/bin` cache root |

Bash resolution follows Pi's platform intent: on Windows, Git Bash under Program Files is preferred before PATH Bash. PowerShell is never silently presented as `bash`.

`fd` and `rg` resolution is:

1. explicit environment override;
2. system executable on PATH;
3. cached executable under `<DSH_HOME>/pi-compatible/bin`;
4. latest compatible GitHub release download, unless offline mode is enabled.

When GitHub publishes a SHA-256 asset digest, the downloader verifies it. Downloaded files and extraction directories are private to the current user.

## Persona customization

The default persona is intentionally short and direct. To customize it, copy the preset to a new id and edit that copy's `agent.cordis.yml`. Tool compatibility is the stable product contract; persona text is not.

## Compatibility boundaries

- Pi baseline is permanently frozen to `0.84.2` for this product line.
- Compatibility means schema and key behavior, not byte-identical error messages or Pi's TUI rendering.
- DSH owns path authorization, filesystem publication, subprocess-tree cancellation, attachments, sessions, and UI cards.
- BMP is recognized, but DSH rc.6/rc.7 attachments do not accept BMP; `read` returns a conversion instruction instead of an image block.
- Pi resizes large images to 2,000×2,000. DSH's attachment seam has no resize operation, so supported images are stored at their original dimensions and the deviation is disclosed in the tool result.
- Text `read` rejects files above 64 MiB before whole-file decoding. Grep context expansion skips files above 10 MiB. These safety bounds prevent one tool call from exhausting the long-lived DSH host.
- Windows is the release-blocking platform. POSIX paths remain supported on a best-effort basis.
- The preset shadows only the model-facing `sandbox:policy` and `approval:policy` runtime-context prose because it duplicates the Full Access contract and mentions tool parameters that do not exist in Pi. DSH enforcement remains active, and all other runtime contexts remain available.
- The preset does not reject a narrower DSH permission mode at mount time. Such modes are unsupported; host denial is reported directly and the model is instructed not to request escalation.

## Development

```bash
npm run check
npm test
npm run test:integration
```

- Unit tests use DSH seam mocks and require no LLM API key.
- `test:integration` uses the globally installed DSH rc.6 local filesystem and subprocess packages, executes real Git Bash, and exercises downloaded/cached fd and ripgrep.
- The running DSH Web host is separately validated by creating blank Core and Plus sessions through `session.create`; no model request is required for mount validation.

## Trust

A user preset is a Cordis composition and has the authority of the plugins it loads. This bundle is intentionally Full Access-only and can execute arbitrary Bash commands and modify arbitrary files allowed by the host process. Review the source before installation.

## License

MIT. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the Pi 0.84.2 behavior reference.
