<p align="center">
  <img src="https://raw.githubusercontent.com/kitepon/Caveat/main/.github/og.png" alt="Caveat — long-term memory layer for coding agents" width="100%">
</p>

# Caveat

[![npm](https://img.shields.io/npm/v/caveat-cli?color=cb3837&label=caveat-cli)](https://www.npmjs.com/package/caveat-cli)
[![CI](https://github.com/kitepon/Caveat/actions/workflows/ci.yml/badge.svg)](https://github.com/kitepon/Caveat/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/caveat-cli?color=blue)](https://github.com/kitepon/Caveat/blob/main/LICENSE)

> **Stop rediscovering the same trap.** Caveat is a long-term memory layer for Claude Code, Codex, and Cursor: record a hard-won external-spec quirk or repo-specific oddity once, and the relevant note surfaces before an AI repeats it.

🇯🇵 **日本語版**: [README.ja.md](https://github.com/kitepon/Caveat/blob/main/README.ja.md)

Built and maintained by [Quo](https://x.com/QLyun35332) at [kitepon.dev](https://kitepon.dev/en).

**Source / full docs**: [github.com/kitepon/Caveat](https://github.com/kitepon/Caveat)

## Install

```sh
npm install -g caveat-cli
caveat init                          # state + available Claude/Codex/Cursor integrations
```

On macOS with Homebrew Node, Caveat installs hook commands through the stable
`/opt/homebrew/bin/node` symlink when it points at the current Node binary. This
keeps Claude Code, Codex, and Cursor hooks working after Homebrew moves Node between
`/opt/homebrew/Cellar/node/<version>/...` directories.

`caveat init` (idempotent, `--dry-run` supported) does the product setup:

1. Scaffolds `~/.caveat/own/` (your personal knowledge repo) + `~/.caveat/index/caveat.db`
2. Claudeのuser設定へMCPを登録し、既存の環境変数と他の登録を保持
3. Merges `UserPromptSubmit` / `PostToolUse` / `PostToolUseFailure` / `Stop` hooks into `~/.claude/settings.json` (existing entries preserved, backup written before any change)
4. Installs product-owned Codex and Cursor hooks when those hosts are available

同じ`init`がCodex・Grok・CursorへもMCPを登録します。CodexはCLIの存在、Grok・Cursorは
設定ディレクトリの存在で導入対象を決めます。`CODEX_HOME` / `GROK_HOME` / `CURSOR_HOME` /
`CLAUDE_CONFIG_DIR`を尊重し、既存の環境変数・timeout・無効化指定・他の登録を保持します。
設定変更前のバックアップと読戻しを行い、MCP登録失敗は非0終了します。
`--skip-codex-hook` / `--skip-cursor-hook`はhookだけを省略します。

For one non-interactive setup that also creates, checks out, or synchronizes the
private ownership remote, invoke `caveat init --sync --yes` with stdin closed.
It uses the account already authenticated in `gh`, is idempotent, and exits
non-zero if the explicitly requested sync fails. Callers do not inspect product
state or run separate Caveat hook installers around this entry.

Opt-out: `--skip-claude`. `caveat uninstall` reverses the Claude Code changes without touching `~/.caveat/`. **No central DB is auto-subscribed** — add knowledge sources explicitly with `caveat community add`.

For a targeted Codex repair, run `caveat codex-hook diagnostics` first,
then `caveat codex-hook install`. It registers Caveat-owned
`UserPromptSubmit`, `PostToolUse`, and `Stop` entries in `~/.codex/hooks.json`
and enables Codex's native hook runtime.

For a targeted Cursor repair, run `caveat cursor-hook install`. It upserts Caveat-owned
`beforeSubmitPrompt`, `postToolUse`, `postToolUseFailure`, and `stop` entries
in `~/.cursor/hooks.json` while preserving unrelated hooks. Use
`caveat cursor-hook diagnostics` to inspect the installed contract.

Automation uses the aggregate product contract instead:
`caveat factory-diagnostics --json --require-connector cursor`. Its versioned
schema, top-level `overall.status`, and exit status are the complete gate. The
output also exposes `connectors.cursor.compatibility_status` for diagnosis,
but callers do not duplicate Caveat's Cursor event set, command rules, or
timeout checks. Without `--require-connector cursor`, the v1 aggregate keeps
its existing Claude/Codex readiness semantics.

With either host enabled, Caveat surfaces matching entries at three moments:
before prompts, after failed tools, and after struggle-heavy sessions. Stop
reminders are queued for the next context-capable hook tick so the agent's final
answer is not cluttered by hook output.

## Basic usage

```sh
caveat search "rtx"                 # FTS across your own entries + subscribed repos
caveat list                         # recent entries
caveat community add <github-url>   # subscribe to a teammate / group repo
caveat community pull               # git-pull every subscribed repo
caveat community list               # show subscribed handles
caveat community remove <handle>    # unsubscribe + purge db rows
caveat pull                         # community pull + re-index everything
caveat serve                        # http://localhost:4242 read-only portal
caveat uninstall                    # reverse `caveat init` Claude integration
caveat codex-hook diagnostics       # inspect Codex hook availability/install state
caveat factory-diagnostics --json --require-connector cursor
                                    # machine gate for a host that requires Cursor
```

## Sharing: two boundaries, two commands

- `caveat sync` synchronizes both private and public entries to an authenticated,
  non-anonymously-readable private remote owned by you or your group.
- `caveat publish` writes only public entries to a separate public mirror. It
  publishes a deterministic AES-256-GCM sealed bundle plus README metadata;
  subscribers decrypt in-process with the configured keyserver.

The publish scan fails closed if private content, an invalid destination, or
missing keyserver configuration is detected. Trust in a private source is still
social — subscribers choose which repository owners to trust.

## MCP tools (6)

`caveat init`が登録するMCPを通じて、Claude Code・Codex・Grok・Cursorから利用できます。

`caveat_search`, `caveat_get`, `caveat_record`, `caveat_update`, `caveat_list_recent`, `caveat_pull`.

Claude can autonomously pull subscribed-repo updates (safe, idempotent).
Recording and updating writes locally; use `caveat sync` for the private
ownership boundary and `caveat publish` for the public sealed boundary.

Codex and Cursor use native hooks rather than MCP for automatic surfacing. A
native reminder inspects an entry with
`caveat show <id> --source <source>`, then updates or creates Markdown in the
own knowledge repo and runs `caveat index`. Community entries are subscriptions
and are not edited locally. The optional `codex-sidecar` commands remain
available for bounded second opinions, review, risk-check, and isolated work.

## Pointing at a different knowledge repo

If you want `~/.caveat/own/` to live elsewhere (e.g. a git-tracked directory you sync to a team repo), override in `~/.caveatrc.json`:

```json
{ "knowledgeRepo": "/absolute/path/to/your/caveats-repo" }
```

## Runtime error diagnostics (explicit opt-in)

Local runtime error collection is disabled by default. Enable it in the same
`~/.caveatrc.json` file while preserving any existing keys:

```json
{ "runtimeErrors": true }
```

Use `caveat runtime-errors diagnostics --json` and
`caveat runtime-errors snapshot --json` to inspect it. The lifecycle commands
are `ack <cursor>`, `resolve <fingerprint>`, `reopen <fingerprint>`, and
`compact`; each requires `--json`. A missing key or any value other than the
boolean `true` keeps collection disabled. Runtime state lives under Caveat's
own state directory, independently of the knowledge index and host hook files.

## Requirements

- Node 22.5+ (for built-in `node:sqlite`)
- `git` for `caveat community add` / `caveat community pull`
- Claude Code installed if you want Claude MCP / hooks integration. Without it, `caveat init --skip-claude` still provisions local state.
- Codex installed if you want native Codex hooks via `caveat codex-hook install`.
- Cursor installed if you want native Cursor hooks via `caveat cursor-hook install`.

Release install smoke:

```sh
npm uninstall -g caveat-cli
npm install -g caveat-cli
caveat --version
caveat init
caveat codex-hook install
caveat cursor-hook install
```

## License

MIT
