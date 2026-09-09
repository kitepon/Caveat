# Caveat Multi-Host Support

This document is additive to `CLAUDE.md`. `CLAUDE.md` remains the canonical
description of Caveat's existing Claude Code behavior. Codex and Cursor are
additive host adapters over the same product-owned retrieval and pending state.

## Current Claude Contract

Caveat's Claude integration remains the canonical contract; Codex-specific
support is additive. Claude and Codex now share the same pending-reminder policy:
Stop reminders are queued and surfaced on the next context-capable hook instead
of being emitted directly from Stop.

- CLI install command: `caveat init [--skip-claude] [--dry-run]`
- CLI uninstall command: `caveat uninstall [--dry-run]`
- MCP command registered for Claude: `caveat mcp-server`
- Hook command shape: `caveat hook <name> [arg]`
- Hook names: `user-prompt-submit`, `post-tool-use`, `stop`, `worker`
- Claude settings targets:
  - MCPは製品のinstallerがClaudeのuser設定へマージし、既存の環境変数と他の登録を保持する。
  - Hooks are merged into `~/.claude/settings.json`
  - Caveat registers `PostToolUse` and `PostToolUseFailure` to the same
    `caveat hook post-tool-use` command. Current Claude Code emits
    `PostToolUseFailure` for failed tool runs with an `error` field instead of
    a `tool_response` object.
- Hook stdout contract:
  - Emits at most one `<system-reminder>...</system-reminder>` block per hook invocation
  - Compacts multiple pending reminders into one block with dedupe and an omitted-count line
  - Logs diagnostics to stderr with `[caveat:hook]`
- Stop-hook recursion guard: `payload.stop_hook_active === true` exits silently
- PostToolUse async behavior:
  - Foreground hook drains pending reminders
  - Tool errors from either `PostToolUse` (`tool_response.is_error`) or
    `PostToolUseFailure` (`error`) enqueue detached worker inspection
  - Worker writes reminders under Caveat pending storage for the next hook tick
- Stop behavior:
  - Objective struggle signals enqueue a per-session pending reminder
  - Unchanged Stop signal digests are not re-queued
  - Stop itself emits no stdout, avoiding final-answer clutter
- Markdown entry contract:
  - Frontmatter is parsed with `gray-matter` and `js-yaml` `JSON_SCHEMA`
  - Canonical fields are the `Frontmatter` type in `packages/core/src/types.ts`
  - Body sections are `##` headings parsed by `extractSections`
- File convention:
  - Own entries live under `entries/**/*.md`
  - Community entries live under `community/<handle>/entries/**/*.md`

Codex support must not rename these fields, rewrite hook text, or replace Claude
commands. Codex receives an adapter output derived from the same entry.

## Reminder Action Surfaces

Reminderの検索結果と発火判定はhost間で共有するが、次の操作を示す文面は共有しない。

- Claudeは`mcp__caveat__caveat_get`で詳細を取得し、
  `mcp__caveat__caveat_update` / `mcp__caveat__caveat_record`で更新・記録する。
- Codex / Cursorは`caveat show <id> --source <source>`で詳細とpathを取得する。既存own entryは
  そのpathのMarkdownを更新し、新規entryはCaveatのown knowledge repoへMarkdownで作成して、
  `caveat index`を実行する。community entryは購読物なのでlocalで直接編集しない。

`caveat init`はCodex / Grok / CursorにもMCPを登録する。native hookの既存のCLI・Markdown案内は
維持する。MCPの呼出し名はhostごとに異なるため、Claude固有のprefixを他hostへ複製しない。
登録形式の差は`apps/cli/src/mcpInstall.ts`が所有する。Codex / GrokはTOML、Claude / CursorはJSONへ
NodeとCaveatの実行パスを登録し、既存の環境変数・timeout・無効化指定・他の登録を保持する。
`CODEX_HOME` / `GROK_HOME` / `CURSOR_HOME`で設定先を変更でき、Claudeは`CLAUDE_CONFIG_DIR`を使う。
Grokは設定ディレクトリがある場合のMCP登録だけを追加し、hook契約は増やさない。

## Codex Adapter

`@caveat/core` exposes `caveatEntryToSidecarContextBlock(entry)`, which converts
a `GetResult` into a plain JSON context block:

```json
{
  "kind": "caveat_entry",
  "source": "caveat",
  "trust": "local",
  "summary": "Short warning derived from title and Symptom.",
  "references": [{ "path": "entries/example.md", "label": "source caveat" }],
  "data": {
    "id": "example",
    "source": "own",
    "title": "Example caveat",
    "tags": ["mcp"],
    "confidence": "confirmed",
    "visibility": "public",
    "environment": {}
  }
}
```

The adapter is intentionally separate from Claude hooks and MCP tools. Claude
continues to consume Caveat through reminders and the Caveat MCP server; Codex
can consume `caveat_entry` blocks through `codex-sidecar`.

`codex-sidecar` accepts these blocks from both integration surfaces:

- CLI: `--context-file <json>`
- MCP: `context: [...]` tool input

## Codex Primary Hooks

Codex primary hook support is a separate adapter surface from `codex-sidecar`.
When Caveat is running inside a primary Codex session, Caveat should use Codex's
own hook runtime to call `caveat codex-hook ...` directly. It should not call
`codex-sidecar` just to reach another Codex process.

The Codex hook adapter uses these commands:

```bash
caveat codex-hook install
caveat codex-hook uninstall
caveat codex-hook diagnostics
caveat codex-hook user-prompt-submit
caveat codex-hook post-tool-use
caveat codex-hook stop
```

`install` writes Caveat-owned entries to user-level `~/.codex/hooks.json` and
ensures `[features].hooks = true` in `~/.codex/config.toml` and migrates the
deprecated `codex_hooks = true` alias. Commands in
the hook config use absolute `nodePath` + `cliScriptPath` so Codex App Server
does not need `caveat` or `node` to be discoverable through `PATH`.

Observed Codex hook config keys are PascalCase (`UserPromptSubmit`,
`PostToolUse`, `Stop`). Observed runtime payloads include `session_id`,
`turn_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, and
`permission_mode`. `UserPromptSubmit` context is returned with
`hookSpecificOutput.additionalContext`. Codex hook stdout must be a single JSON
object for each hook invocation; if multiple pending reminders need to surface,
join them into one `additionalContext` string instead of writing JSONL or
multiple JSON objects. The Codex formatter dedupes repeated `Stop` reminders,
keeps the newest session-level `Stop` summary, and caps surfaced context blocks
to avoid dumping a stale backlog into the prompt. Codex also records a per-session
Stop signal digest, so an unchanged transcript signal is not re-queued on every
turn after the first reminder. Codex `Stop` reminders are queued into the same
per-session pending-reminder store and drained on the next
`UserPromptSubmit`, rather than returned as `{"decision":"block","reason":"..."}`
from `Stop`, because blocking `Stop` causes Codex's final assistant message to
be visually grouped with collapsed work in the app UI.

`PostToolUse` uses the same Caveat pending-reminder model as Claude, but drains
through Codex's `UserPromptSubmit` formatter instead of Claude
`<system-reminder>` text. In current Codex operational smoke, Bash
`PostToolUse` stdin did not include `exit_code`, and the transcript
`function_call_output` was not visible until after the hook returned. Detached
children launched by the hook also did not reliably leave pending reminders in
real Codex runs. For that reason, Codex `PostToolUse` performs a bounded
foreground lookup from `tool_input` + `tool_response` and writes the pending
file before returning; the next `UserPromptSubmit` drains it.

`codex-sidecar` remains appropriate for Claude-hosted second opinions and for
Codex-hosted work that has a real boundary, such as an isolated worktree,
structured result, explicit second pass, or review/risk role separation. The
completed Codex-hook implementation plan is retained only as history in
[`archive/CODEX_HOOK_SUPPORT_PLAN.md`](archive/CODEX_HOOK_SUPPORT_PLAN.md).

## Cursor Primary Hooks

Cursor is a first-class native hook host. The product-owned entrypoints are:

```bash
caveat cursor-hook install
caveat cursor-hook uninstall
caveat cursor-hook diagnostics
```

Install upserts Caveat-owned `beforeSubmitPrompt`, `postToolUse`,
`postToolUseFailure`, and `stop` entries in `~/.cursor/hooks.json`, preserving
unrelated factory and user hooks. Commands use the installed CLI path and the
shared host engine in `apps/cli/src/hookShared.ts`; Cursor-specific parsing and
output remain in the Cursor adapter. `caveat init` installs this adapter when
`~/.cursor` exists unless `--skip-cursor-hook` is supplied.

Cursor reuses the same retrieval, pending-reminder, stop-signal, and dedupe
contracts as Claude/Codex. It must not rename canonical frontmatter fields,
write another product's state, or require dotagents to run. Diagnostics and
uninstall are owned by Caveat and operate only on Caveat-managed hook entries.

`caveat cursor-hook diagnostics` is the human-facing targeted repair view.
Factory automation uses
`caveat factory-diagnostics --json --require-connector cursor` and validates
the `caveat.native_factory_diagnostics.v1` schema, top-level `overall.status`,
and process exit only. Caveat owns the exact Cursor event set, canonical
command assets, and timeout validation behind
`connectors.cursor.compatibility_status`; an integrator must not reproduce
those rules. Omitting `--require-connector cursor` preserves the v1 aggregate's
existing Claude/Codex readiness meaning for hosts where Cursor is not required.

## Execution Policy

`decideCodexSidecarExecution` prevents accidental recursive delegation.

| Host agent | Policy |
|---|---|
| Claude | Prefer operational Codex sidecar for independent review, exploration, opinion, and risk-check tasks. |
| Codex | Use Codex sidecar only when there is a clear boundary: isolated worktree, structured result, explicit second pass, or risk/review role separation. |
| Automation / unknown | Require explicit `sidecar_agent: codex` before delegation. |

Availability levels:

| Level | Meaning |
|---|---|
| `disabled` | Sidecar is intentionally off. |
| `unavailable` | Sidecar is absent, cannot run, or diagnostics failed. |
| `configured` | Diagnostics can be shaped and attempted, but read-only smoke has not succeeded. |
| `operational` | Read-only smoke succeeded. |
| `work-capable` | `codex_work` smoke succeeded and allowed paths are configured. |

`codex_work` requires `work-capable`. Read-only review/explore/opinion/risk-check
requires `operational` or `work-capable`.

## Proposal Artifact Evaluation Boundary

Claude と Codex の検索器は共通でも、reminder の配送契約とタイミングは同一ではない。
したがって誤提案の artifact 集計は host ごとに別 stratum とし、
Claude / Codex の pooled effect を出さない。model/version と tool/permission policy も固定する。

`eval:proposal-quality` は live hook telemetry ではなく offline self-attested proposal artifact aggregator である。
同一 scenario の control / caveat を独立 run として宣言し、condition を含まない packet を受ける judge が
`knownBadClaimEmitted` と `validSolutionSupplied` を別々に判定する。raw trial は
`<caveatHome>/local-eval/proposal/` に local-only で置き、knowledge repo の sync/publish 対象へ
入れない。内部 reasoning は評価対象外で、外部化された回答だけを扱う。
assignment manifest は割付を再計算可能にするが、pre-run digest を外部固定しない限り事前登録時刻は
証明しない。execution-provenance harness は request bytes、condition envelope、provider run ID、
model provenance、terminal receiptを保存・検証し、execution-aware compilerは全planを分母へ入れる。
provider署名や外部timestampは持たないため、結果はbounded offline characterizationとして扱う。

検索評価、offline proposal artifact aggregation、将来の実行 provenance 付き characterization、
consent 済み online observability の境界は
[`archive/08_proposal_effectiveness_eval.md`](archive/08_proposal_effectiveness_eval.md) を正とする。

## Smoke Commands

Release-grade Claude/Codex/Cursor hook installation smoke is tracked in
[`04_release_checklist.md`](04_release_checklist.md). That checklist is the required
post-publish path for proving the published npm package can install all host
hooks and start fresh Claude/Codex sessions. The commands below are sidecar-specific
diagnostics and do not replace release smoke.

Release state is derived from `apps/cli/package.json`, `CHANGELOG.md`, and the
release checklist rather than a mutable handoff note. Historical implementation
and adversarial-audit ledgers are kept under [`archive/`](archive/).

CI runs `corepack pnpm check:release-smoke` to keep release-smoke scripts
syntactically valid, verify the packed npm manifest has no `workspace:`
protocol leaks, prove the packed tarball installs with npm, and confirm the
documented pnpm entrypoint accepts `--` argument forwarding. It intentionally
does not run authenticated Codex App Server smoke, which remains a release gate
in the checklist.

Preferred installed-path diagnostics:

```bash
caveat codex-sidecar diagnostics --project /path/to/repo --preset advisory
```

Development-path diagnostics:

```bash
export CODEX_SIDECAR_NODE_CLI=/absolute/path/to/codex-sidecar/packages/cli/dist/index.js
caveat codex-sidecar diagnostics \
  --project /path/to/repo \
  --preset advisory \
  --node-cli "${CODEX_SIDECAR_NODE_CLI:?set CODEX_SIDECAR_NODE_CLI}"
```

The `advisory` preset is the hook path and should resolve to
`gpt-5.6-luna` with low reasoning effort. Manual presets use stronger policy:
`explore` uses `gpt-5.4-mini` medium; `review` and `opinion` use `gpt-5.5`
medium; `risk` and `work` use `gpt-5.5` high.

Preset選定とbounded signal評価の根拠値は、完了記録
[`archive/09_sidecar_hook_signal_contract.md`](archive/09_sidecar_hook_signal_contract.md)を正とする。

Read-only operational smoke:

```bash
caveat codex-sidecar smoke \
  --project /path/to/repo \
  --node-cli "${CODEX_SIDECAR_NODE_CLI:?set CODEX_SIDECAR_NODE_CLI}"
```

These commands do not silently substitute another sidecar path. The selected
command is printed before execution.

Work-capable smoke:

```bash
caveat codex-sidecar work-smoke \
  --project /path/to/repo \
  --node-cli "${CODEX_SIDECAR_NODE_CLI:?set CODEX_SIDECAR_NODE_CLI}"
```

This runs `codex_work` in an isolated git worktree and passes
`--remove-worktree`; the real repository should not receive the smoke edit. A
successful result reports `worktreePreserved: false` and a `changedFiles` list
containing only allowed paths.

## Caveat Context Routing

The read-only routing path is:

```text
Caveat DB search
  -> full Caveat entries
  -> caveat_entry context blocks
  -> temporary context JSON file
  -> codex-sidecar --context-file
  -> structured SidecarResult
```

CLI form:

```bash
caveat codex-sidecar run explore \
  "Use the provided Caveat context to answer this question." \
  --query "Claude Code hooks settings reload" \
  --limit 5 \
  --host-agent claude \
  --node-cli "${CODEX_SIDECAR_NODE_CLI:?set CODEX_SIDECAR_NODE_CLI}"
```

Supported read-only workflows are `review`, `explore`, `opinion`, and
`risk-check` (`risk` is accepted as an alias for `risk-check`). The command
marks surfaced Caveat entries as retrieval hits, writes only a temporary context
file, and removes that file after the sidecar process exits.

When policy says not to call Codex sidecar, the command prints an explicit
`skipped` decision instead of silently falling back:

```json
{
  "status": "skipped",
  "decision": {
    "route": "claude-compatibility",
    "reason": "codex-sidecar is not available for this repository."
  }
}
```

For Codex-hosted sessions, `caveat codex-sidecar run ... --host-agent codex`
will skip unless the call declares a real boundary, such as
`--structured-result-required`, `--explicit-second-pass`, or
`--requires-isolation`.

## Result Handling

`codex-sidecar` returns a structured `SidecarResult` JSON object. Caveat does
not need prose scraping to consume or persist the result.

Any Caveat sidecar command can write the structured result to disk:

```bash
caveat codex-sidecar run risk-check \
  "Check the MCP and hook changes." \
  --query "mcp hooks secrets" \
  --host-agent claude \
  --save-result .codex-sidecar/results/risk-check.json
```

The saved file is parsed and re-serialized JSON from sidecar stdout. The
`rawEventLogRef` field, when present, points at the durable App Server event log
under `.codex-sidecar/logs/app-server`.

## Background Task Audit

The current Caveat codebase does not contain a runtime path that calls a Claude
subagent API for background review or audit work. The existing background
behavior is the `PostToolUse` detached worker:

```text
Claude PostToolUse / PostToolUseFailure hook
  -> detached Caveat worker
  -> Caveat DB search
  -> pending reminder for the next hook tick
```

That worker is tied to Claude hook timing and Claude tool-response / failure
payloads, so it remains Claude-primary. When `codex-sidecar` is operational,
the worker can append a Codex advisory to the same pending reminder. The original Caveat
reminder remains first and unchanged; the Codex text is a second opinion for
Claude, not a new Caveat decision engine.

`Stop` hook reminders follow the same rule. The existing signal-gated
`stopReminderText` still decides whether Caveat should speak. If it speaks and
`codex-sidecar` is enabled, Caveat appends Codex advice about whether Claude
should update an existing caveat or record a new one.

Hook advisory does not pass raw tool input/output, error text, search queries,
file paths, transcript paths, or session IDs as the added signal. It passes one
strictly validated `manual_note` block containing only a closed tool/failure
kind or bounded Stop counts. Retrieval still uses raw text locally. Existing
`caveat_entry` blocks—including private entries—remain a separate, pre-existing
provider boundary and are not newly sanitized by this signal contract. The
completed contract is archived at `docs/archive/09_sidecar_hook_signal_contract.md`.

The detached tool-error job uses an owner-only reserved temporary root and a
versioned job schema. POSIX uses `0700` directories and `0600` files; Windows
uses the current user's temporary directory and inherited Windows ACLs because
Node's POSIX mode/uid fields do not represent Windows DACLs. Every Claude hook
invocation sweeps structurally valid jobs older than 24 hours. If the machine
never runs Caveat again after a worker crash, the private orphan remains until
the next invocation; there is no independent daemon.

Independent review, exploration, opinion, risk-check, and scoped work also have
Codex sidecar routes through the commands above.

## Hook Codex Advisory

Hook advisory is controlled by environment variables and is explicit about
availability:

| Variable | Values | Default | Meaning |
|---|---|---|---|
| `CAVEAT_HOOK_CODEX_SIDECAR` | `off`, `auto`, `require` | `auto` | Controls whether hooks ask Codex for a second opinion. |
| `CAVEAT_CODEX_SIDECAR_NODE_CLI` | path | unset | Development path to a built `codex-sidecar` CLI. |
| `CAVEAT_CODEX_SIDECAR_COMMAND` | command | unset | Installed command to run instead of the default `codex-sidecar`. |
| `CAVEAT_HOOK_CODEX_SIDECAR_TIMEOUT_MS` | milliseconds | `120000` | Maximum time for the hook-side advisory call; integer range 1–240000 so it remains below the five-minute single-flight claim TTL. |

`auto` only attempts the advisory when the current project has
`.codex-sidecar.yml`. `off` preserves the pre-Codex hook behavior. `require`
attempts the advisory even without a project config and appends an explicit
`[caveat:codex-sidecar] advisory unavailable: ...` line if it cannot run.

The hook path uses:

```text
caveat hook post-tool-use / stop
  -> existing Caveat DB search and reminder construction
  -> bounded caveat-hook-signal manual_note (raw hook text excluded)
  -> caveat codex-sidecar run explore --preset advisory --host-agent claude --availability operational
  -> optional [caveat:codex-sidecar] Codex advisory appended to the reminder
```

This is not a hidden fallback. If the advisory path was requested and fails,
the reminder says so. If `auto` sees no sidecar config, Caveat emits only the
existing reminder text.
