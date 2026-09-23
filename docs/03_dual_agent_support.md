# Caveat Multi-Host Support

This document is additive to `AGENTS.md`. `AGENTS.md` remains the canonical
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
  - Foreground hook peeks at pending reminders, then acknowledges them after output
  - Tool errors from either `PostToolUse` (`tool_response.is_error`) or
    `PostToolUseFailure` (`error`) enqueue detached worker inspection
  - Worker writes reminders under Caveat pending storage for the next hook tick
- Stop behavior:
  - Jev無効時は既存の構造化シグナルをpendingへ積む。Jev有効時は3ターン判定に任せる
  - 件数や経過時間だけの変化ではStopシグナルを再通知しない
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

CodexのMCP登録はCLIまたは設定ディレクトリが存在する場合に行う。hook導入の可用性判定と
明示的な拒否は維持する。設定先は`installShared.ts`で解決し、初期化・解除・診断が共用する。
Windowsでは`HOME`未設定でもOSのユーザーホームを使う。`caveat uninstall`はClaude連携だけを
解除し、Claude CLIの有無に依存しない。他hostのhook解除は各hostの専用コマンドを使う。

## Jevによる苦戦判定

Claude / Codexの`UserPromptSubmit`は、明示的に`caveat jev enable --key-stdin`で有効化した時だけ
Throughlineの公開`caveat-context`から直近の完了3ターンを読む。各ターンのユーザー発言、回答、取得可能な
Thinkingだけを送り、toolログは送らない。Codexの暗号化Reasoningは取得できないので空欄のまま扱う。
Throughlineが未導入、投影待ち、または3ターン未満なら判定を行わない。

Jevには1回の問い合わせで「同じ問題への試行が繰り返されたか」「一過性でなく明確に苦戦しているか」と、
ローカル検索に使う語を尋ねる。両スコアが0.85以上の時だけCaveatのFTS5を検索する。知見DB全件は
Jevへ送らず、最大20件の候補概要と3ターンを2回目の問い合わせへ渡して候補の直接関連性を判定する。
関連度0.85以上の知見だけ原文の対処を短く通知する。候補が無い場合は一度だけ検索を促す。
同じ完了ターンは再判定せず、通知済みの知見IDは同一セッションで再通知しない。

この機能は3ターンの文脈と候補の概要をTypeSafe APIへ送る。APIキーはCaveat所有の
`<caveatHome>/credentials/typesafe.key`に保存し、無効化は`caveat jev disable`、状態確認は
`caveat jev status`で行う。失敗はhookのstderr診断へ出し、Jev助言を成功扱いしない。

## Codex Primary Hooks

Codex primaryではnative hook runtimeから`caveat codex-hook ...`を直接呼ぶ。

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

完了したCodex-hook実装計画は
[`archive/CODEX_HOOK_SUPPORT_PLAN.md`](archive/CODEX_HOOK_SUPPORT_PLAN.md)に保管する。

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

Claude / Codex / Cursorの配布後smokeは[`04_release_checklist.md`](04_release_checklist.md)を正とする。
`corepack pnpm check:release-smoke`は梱包とinstallを検証する。Jevの苦戦判定は有効化した実機で、
3ターン投影、FTS候補、通知済みIDの抑止、API失敗診断を確認する。
