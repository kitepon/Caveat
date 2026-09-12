# Changelog

All notable changes are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## [0.19.2] — 2026-09-12

### Fixed
- Codexの`features.hooks`と旧aliasの`features.codex_hooks`が両方`true`の時、
  工場診断が誤ってhookを無効と判定する問題を修正する。明示的な`false`の拒否と設定の読取り専用契約を維持する。

## [0.19.1] — 2026-09-10

### Fixed
- Windowsで長いentryパスの同期・checkoutが失敗する問題を修正する。Caveatが起動するGitに
  `core.longpaths=true`を渡し、ユーザーのGit設定ファイルは変更しない。

## [0.19.0] — 2026-09-10

### Added
- `caveat init`がCodex・Grok・CursorのMCP登録を所有する。既存設定を保持し、バックアップと
  読戻しを行う。工場による登録の代行は不要になった。
- `CODEX_HOME` / `GROK_HOME` / `CURSOR_HOME` / `CLAUDE_CONFIG_DIR`に導入先を合わせる。

### Fixed
- `init --sync --yes`は端末でも質問を挟まず、未指定の公開ミラー設定を保持する。
- `init --dry-run`による設定・scaffold・移行の書込みをなくす。
- 初期化・解除・診断の設定先を共通化し、Windowsの`HOME`未設定にも対応する。
- Claude CLIなしでもMCP登録を解除でき、保持した追加設定が導入診断を失敗させない。
- Codexの設定ディレクトリがあればCLIがPATHになくてもMCPを登録する。
- npmのpackage名付きJSON出力に文書検査を対応させ、配布ファイル一覧を正しく読む。
- Windowsのエラー収集用ACL処理もPowerShell 7へ揃える。所有者以外への権限を拒否する判定を維持し、内部例外には失敗原因を残す。
- ClaudeのMCP登録失敗を`init`の非0終了へ反映し、導入成功として報告しない。
- ClaudeのMCP登録を既存環境変数を保持するマージへ変更し、remove/addによる登録の消失をなくす。
- 0.18.1までの修正を含み、`init --sync --yes`の既存private remote同期とscaffold復旧を配布する。
- Windowsの文書検査・配布検査・pnpm起動をPowerShell 7へ揃え、`npm.cmd`直接起動の`EINVAL`を修正する。
- Claude hookのsymlink検査fixtureをWindowsの正規quote形式へ合わせる。

## [0.18.1] — 2026-08-30

### Added
- `caveat factory-diagnostics --json` now reports product-owned Cursor
  compatibility without changing the v1 default readiness set. Hosts that
  require Cursor can pass `--require-connector cursor`; Caveat then validates
  its exact hook set, command assets, and timeout, folds the result into
  `overall.status`, and exits non-zero unless the aggregate is ready.

### Changed
- Runtime error collection is now owned entirely by Caveat and is enabled with
  `"runtimeErrors": true` in the existing `~/.caveatrc.json`. Existing configs
  without the key remain disabled, and the public runtime error JSON shape is
  unchanged.
- Markdown-only CI now runs Caveat's own current-document index, archive-link,
  unresolved-marker, and fixed-host-path checks. Windows native product CI uses
  PowerShell 7 instead of Git Bash.
- The documentation check now parses CommonMark/GFM through `unified`/`remark`,
  parses raw HTML attributes and character references through `parse5`, and
  checks `srcset` candidates before comparing every effective relative target
  with the CLI's actual npm dry-run pack manifest.

### Fixed
- Runtime error collection now resolves the Windows user config through
  `USERPROFILE` before `HOME`, matching Caveat's existing user-config location
  when the two environment variables differ.
- The canonical Claude hook detector now proves both parsed asset candidates
  are present before calling string-only helpers, restoring CLI typecheck
  without weakening its exact command validation.

## [0.18.0] — 2026-08-24

### Added
- Native Cursor hooks. `caveat cursor-hook install` upserts flat command entries
  into `~/.cursor/hooks.json` (`beforeSubmitPrompt` / `postToolUse` /
  `postToolUseFailure` / `stop`) and leaves factory hooks in place. The runner
  reads the Cursor envelope (`conversation_id`, `prompt`) and returns
  `additional_context` JSON. `caveat init` installs them when `~/.cursor` exists
  (`--skip-cursor-hook` to opt out). Factory diagnostics connectors remain
  Claude/Codex only (exact allowlist).

## [0.17.8] — 2026-08-24

### Fixed
- Factory diagnostics falsely reported Claude hooks as `not_installed` on macOS
  since 0.17.6: the canonical detector compared the whole command against a string
  built from `process.execPath`, while the installer intentionally writes the
  stable bin path (a symlink to the same binary). The detector now validates
  quoting against the command's own token paths and relies on the existing
  realpath-based canonical-asset check for identity, keeping the legacy unsafe
  (unquoted backslash) shape rejected. Regression test added.

## [0.17.7] — 2026-08-24

### Changed
- Behavior-preserving OS-layer consolidation (factory-wide harness/OS separation
  campaign): the env-aware Windows detection that `runtimeErrors.ts` implemented
  privately (`env.OS === 'Windows_NT' || isWindows()`) moved into
  `packages/core/src/platform.ts` as `isWindowsEnv()`, keeping platform.ts the
  single owner of OS branching. No API, schema, or behavior change; 575 tests green.

## [0.17.6] — 2026-08-24

### Fixed
- Claude hooks on Windows now quote backslash paths even when they contain no spaces. Git Bash previously consumed the unquoted backslashes in the global `caveat-cli` script path, so every hook failed with `MODULE_NOT_FOUND`. Reinstall migrates existing commands in place, preserves explicit environment prefixes, and factory diagnostics rejects the legacy unsafe shape.

## [0.17.3] — 2026-08-02

### Fixed
- Codex native hooks now write the supported `timeout` field in seconds instead of the ignored `timeoutSec` field. Reinstall and upgrade canonicalize existing Caveat-owned entries in place, and diagnostics flag the legacy shape until it is repaired.

## [0.17.2] — 2026-07-29

### Changed
- The npm package page now carries the same Caveat visual, Japanese documentation route, and kitepon.dev ownership line as the public GitHub repository.

### Fixed
- The Windows Server 2025 / Node 22 CI lane now runs workspace test suites sequentially, avoiding runner-contention timeouts while the other five matrix lanes remain parallel.
- Sidecar advisory hook tests use the same explicit Windows timeout contract.

## [0.17.1] — 2026-07-20

### Fixed
- Windows native Codex hook commands now prefix quoted Node executables with the PowerShell call operator `&`. Reinstall migrates the legacy command, diagnostics accept the canonical form, and POSIX commands are unchanged.

## [0.17.0] — 2026-07-17

### Added
- `caveat_record` and `caveat_update` now trigger a background sync directly, so a new entry reaches the private remote without waiting for the session to end.

### Changed
- Automatic sync now runs at most every 15 minutes instead of every 24 hours. The old interval applied independently to the sending and receiving machine, so an entry recorded on one machine could take up to two days to become visible on another.
- Repeated own-sync failures now back off to a 6-hour retry instead of suspending auto-retry until the next manual `caveat sync`, and the degraded state re-announces itself every 24 hours instead of being announced once and then staying silent.

### Fixed
- A malformed `CAVEAT_AUTO_SYNC_DEBOUNCE_MS` parsed as `NaN` and disabled the debounce entirely, spawning a sync worker on every trigger. Invalid values now warn on stderr and fall back to the default.
- The Windows ACL seam timed out after 3 seconds, which a contended CI runner crossed often enough to fail intermittently: the killed PowerShell reported a null exit status, and that read as an unsafe ACL rather than a slow one. The bound is now 15 seconds, sized against the runners themselves (one apply costs 331-459ms there) rather than against a developer machine.
- Windows ACL failures now report whether the seam hit a spawn error, a timeout, or a non-zero exit, instead of collapsing every mode into one opaque `store_unsafe`. Recorded errors still carry no paths or stderr.

## [0.16.3] — 2026-07-13

### Added
- `caveat factory-diagnostics --json` now exposes a strict, read-only factory contract for the owned database schema, own-repository sync state, Claude MCP/hooks, and Codex native hooks.
- `caveat runtime-errors` now provides an explicit-opt-in local structured error store with bounded snapshots, monotonic acknowledgement, resolve/reopen lifecycle, and acknowledged-record retention.

### Changed
- Caveat hook, sync, index, and MCP failure boundaries record only fixed allow-listed error definitions; prompt text, entry/file content, paths, stack traces, stderr, and credentials are never stored.
- Factory diagnostics validate exact database and connector structures and report unavailable remote state as unverified instead of silently accepting stale local tracking data.

### Security
- Runtime collection shipped disabled by default and required explicit opt-in. Runtime state ownership, size, symlink, POSIX mode, and Windows ACL checks fail closed.

## [0.16.2] — 2026-07-13

### Added
- Provenance-aware Claude/Codex hook evaluation keeps topic and failure evidence separate, with a synthetic per-surface quality evaluator and shared core policy.
- Pending reminders now use semantic single-flight claims and atomic publication, including process-concurrency and crash-recovery coverage.
- Release gates now include a deterministic fake Claude fresh-session hook smoke across the CI matrix.

### Changed
- Codex sidecar advisory validation targets the closed structured-output contract released by codex-sidecar 0.3.6 while preserving fail-closed behavior.
- Windows real-Git fixtures use named phase timeouts and non-interactive child-process environments.

### Fixed
- Stop and tool-error hooks no longer combine unrelated query, tool input, and generic failure fragments into false-positive Caveat proposals.
- Concurrent reminder producers no longer duplicate advisory work or inflate the omitted-context count; queue cleanup failures are explicit and retryable.
- Claude fresh-session smoke preserves the authenticated keychain identity while isolating project settings, MCP configuration, working directory, and `CAVEAT_HOME`.

## [0.16.1] — 2026-07-13

### Fixed
- Codex hook installation now enables the canonical `[features].hooks` key, migrates the deprecated `codex_hooks = true` alias without leaving a startup warning, and diagnoses the current `hooks` feature reported by Codex.

## [0.16.0] — 2026-07-13

### Added
- **Sealed public bundles.** `caveat publish` now emits a deterministic AES-256-GCM bundle instead of a plaintext entry tree; community indexing decrypts in memory without materializing plaintext files. A separately deployed keyserver-lite Worker supplies versioned content keys.
- **Stop-triggered automatic sync.** Detached autosync pulls community sources, syncs the private own repository, and reindexes without blocking the agent. Repeated own-sync failures pause automatic retries until a successful manual sync.
- **One-step initialization.** `caveat init` can configure the own repository, sync/publish targets, Claude integration, and Codex hooks while reporting the resulting environment.
- **Outbound publish inspection and retrieval measurement.** Public publishing scans for identifiers before release, and repository tooling can characterize hook-search quality against local-only golden data.
- Repository-local proposal evaluation and execution-provenance tooling, including synthetic evaluation coverage.
- Luna low-effort sidecar advisory policy with advisory smoke coverage.

### Changed
- Public mirrors are rebuilt as a one-commit sealed snapshot; community pull follows orphan force-push replacements safely.
- Git operations use bounded inactivity timeouts and non-interactive credential behavior.
- Bounded hook signal handling and worker temporary-file/context handling were strengthened.

### Fixed
- Community entries cannot be modified through the own-entry update path, and sidecar context no longer claims a plaintext file path for sealed community entries.
- Codex Stop hooks receive the same pending-directory maintenance and autosync triggers as the Claude path.

### Security
- Publish performs a fail-closed content scan before sealed output, and the production public repository was purged and recreated as a sealed one-commit mirror. Previously cloned or archived plaintext cannot be retroactively erased.
- Hook sidecar input excludes raw errors, queries, paths, transcript paths, and session IDs; detached worker jobs use owner-only directories/files and a versioned schema (POSIX modes or inherited per-user Windows temp ACLs).

### Migration Notes
- Existing publishers must deploy the keyserver-lite Worker (or provide an equivalent compatible endpoint), keep the content key in Worker KV, and set `sealedKeyserverUrl` plus the matching `sealedKeyId` in `~/.caveatrc.json`. `caveat publish` fails closed until this is configured; see `keyserver/README.md` and `docs/archive/07_sealed_public_and_autosync.md`.
- v0.15 and older clients can permanently fail `community pull` against sealed public repos after an orphan force-push, often as `unrelated histories`; upgrade to v0.16 before subscribing to sealed community bundles.

## [0.15.0] — 2026-07-11

### Added
- **`caveat sync`** — sync your own knowledge repo to a **private** git remote (the shared boundary for you across machines, or your whole org). Runs a credential-free anonymous-readability probe against the effective push URL(s) and **refuses to push private entries to any anonymously-readable remote**. Without setup, `caveat sync --init` uses `gh` to create `<user>/Caveat-Private` after one confirmation (`--repo <url>` to override).
- **`caveat publish`** — mirror only `visibility: public` entries to a **public** repo (`<user>/Caveat-Public` by default) as a one-way full replacement. Parses and re-verifies every mirrored file; aborts entirely if any entry has invalid visibility; nothing but the generated README and public `entries/**/*.md` may exist in the mirror.
- **`caveat community add <username>`** — bare GitHub usernames now expand to `https://github.com/<name>/Caveat-Public` (validated against a handle pattern first).
- **Automatic reindex** — Stop hooks detect when the entries tree changed (e.g. from `git pull` on another machine) via a content digest and reindex on a detached worker, so entries synced from other machines become searchable without a manual `caveat index`. Disable with `CAVEAT_INDEX_AUTOSYNC=off`.

### Changed
- `visibility` now means **distribution ceiling**: `private` = shareable within your ownership boundary (your machines / your org's private remote), `public` = shareable with the world. The design canon is [docs/archive/06_sharing_and_reindex.md](docs/archive/06_sharing_and_reindex.md).
- The default when `visibility` is omitted (core fallback) is now **`private`**, not `public` (leak-safety). The MCP `caveat_record` tool still requires it explicitly.

### Fixed
- Entries synced in from other machines were invisible to search and hooks because nothing reindexed them; the digest-based auto-reindex closes this.

## [0.14.10] — 2026-05-10

### Changed
- Documented the macOS/Homebrew install smoke path in the published CLI README so npm users can verify `npm install -g caveat-cli`, `caveat init`, and `caveat codex-hook install` from a clean global install.

### Verification
- Published npm install path re-verified on macOS: `npm uninstall -g caveat-cli`, `npm install -g caveat-cli`, `caveat --version`, `caveat init`, and `caveat codex-hook install` all exit 0.

## [0.14.9] — 2026-05-10

### Fixed
- **macOS Homebrew Node hook path stability.** Claude Code and Codex hook installers now prefer the stable `node` found on `PATH` when it resolves to the same executable as the current process. On Homebrew macOS this writes `/opt/homebrew/bin/node` instead of versioned Cellar paths such as `/opt/homebrew/Cellar/node/26.0.0/bin/node`, so hooks survive Node upgrades.
- Existing Caveat-owned Claude Code and Codex hook entries are rewritten in place when their command still points at an older Caveat install or a Homebrew Cellar Node path. Non-Caveat hooks are preserved.
- Root npm scripts no longer require a globally available `corepack pnpm`; they use a local wrapper that tries `pnpm`, `corepack pnpm`, then `npx pnpm@10.0.0`.

### Verification
- `node scripts/pnpm.mjs -r build`, targeted CLI hook tests, `node scripts/pnpm.mjs --filter caveat-cli typecheck`, and full `npm test` passed.
- Published package smoke passed on macOS: `npm uninstall -g caveat-cli`, `npm install -g caveat-cli`, `caveat --version`, `caveat init`, and `caveat codex-hook install`.

## [0.14.8] — 2026-05-08

### Added
- **Self-cleaning `pending/` directory.** Per-session reminder folders left behind by drained or abandoned sessions are now collected automatically. `cleanupStalePendingDirs(caveatHome, { staleDays })` removes any `<caveatHome>/pending/<sessionId>/` whose newest entry (directory + leftover `.txt`) is older than the threshold (default 7 days). Active sessions are protected because their `mtime` keeps refreshing as the queue is appended/drained.
- **Hook-driven debounced sweep.** `caveat hook stop` now invokes `maybeSweepPendingDirs(caveatHome)` at the top of the Stop branch. A `<caveatHome>/pending/.last-sweep` marker enforces a 1-day debounce so the housekeeping runs at most once per day even though Stop fires many times per session. Failures are swallowed so the sweep never affects the hook contract. Set `CAVEAT_PENDING_SWEEP=off` to disable entirely.
- **`caveat init` belt-and-suspenders sweep.** `caveat init` runs the same cleanup so a fresh global install on a long-lived `~/.caveat/` does not need to wait for the next Stop hook to clear the backlog. New `--pending-stale-days <n>` flag overrides the threshold (rejects negative values); `--dry-run` prints the planned action without touching the filesystem.

### Verification
- Workspace tests grew from 247 to 259, all passing on Linux. New coverage in `packages/core/tests/pendingReminders.test.ts` exercises stale subtree removal, active-session protection, debounce, env override, and bad input rejection.
- End-to-end with a packed CLI binary against an isolated `CAVEAT_HOME` confirmed: real run removes stale subtrees, dry-run does not, `--pending-stale-days -1` is rejected, hot-path `caveat hook stop` honors the marker debounce, and `CAVEAT_PENDING_SWEEP=off` leaves both directories and marker untouched.

## [0.14.7] — 2026-05-06

### Added
- **Codex sidecar advisory now uses explicit model policy.** Caveat's repository-local `.codex-sidecar.yml` defines an `advisory` preset with `gpt-5.4-mini` and low reasoning effort, and Claude hook advisory calls route through `--preset advisory`.
- **Release smoke automation.** Added reusable release smoke scripts for Codex sidecar advisory and packed npm artifact verification. CI now checks the release-smoke entrypoint, verifies the packed `caveat-cli` tarball has no `workspace:` protocol leak, installs the tarball with npm, and confirms `caveat --version`.

### Fixed
- **Windows release-pack check execution.** The npm pack smoke now runs `.cmd` shims through the Windows shell so `corepack.cmd` and `npm.cmd` work in GitHub Actions Windows jobs.

### Verification
- Published `codex-sidecar` 0.3.0 and verified Caveat advisory smoke against the published `codex-sidecar-cli@0.3.0`.
- GitHub Actions is green across Ubuntu 24.04, Windows 2022, and Windows 2025 with VS 2026 for Node 22 and Node 24.

## [0.14.6] — 2026-05-06

### Changed
- **Complete the dev-tool major refresh.** Updated workspace TypeScript to 6.0.3 and Vite to 8.0.10. The shared tsconfig now explicitly includes Node types and opts into `ignoreDeprecations: "6.0"` for the TypeScript 6 `baseUrl` deprecation path used by the current tsup dts build.
- **Keep Node runtime typing aligned with support policy.** Dependabot now ignores semver-major `@types/node` bumps so Caveat's Node 22.5+ support is not masked by Node 25-only type definitions.

### Verification
- Full workspace `build`, `typecheck`, and `test` pass locally with TypeScript 6 and Vite 8.

## [0.14.5] — 2026-05-06

### Changed
- **Refresh dependency baseline.** Updated published CLI runtime dependency `commander` to 14.0.3, web runtime dependencies `hono` to 4.12.17 and `@hono/node-server` to 2.0.1, MCP/core `zod` to 4.4.3, and workspace `vitest` to 4.1.5. `@types/node` remains on the Node 22 line to match Caveat's Node 22.5+ runtime support.
- **Modernize CI runners and actions.** GitHub Actions now uses `actions/checkout@v6` and `actions/setup-node@v6`, pins Ubuntu to `ubuntu-24.04`, and explicitly tests Windows on both `windows-2022` and `windows-2025-vs2026`.

### Verification
- Full workspace `typecheck`, `test`, and `build` pass locally.
- GitHub Actions is green across Ubuntu 24.04, Windows 2022, and Windows 2025 with VS 2026 for Node 22 and Node 24.

## [0.14.4] — 2026-05-06

### Changed
- **Refresh npm package presentation for Claude + Codex support.** The published `caveat-cli` README, package description, and npm keywords now describe Caveat as a long-term memory CLI for both Claude Code and Codex, including native Codex hook setup and the pending Stop reminder UX.
- **GitHub public metadata was aligned with the current dual-agent positioning.** Repository description and topics now include Codex / OpenAI / coding-agent discoverability terms.

### Verification
- Packed `caveat-cli` with `pnpm pack` and inspected the tarball manifest and README before publish.
- `caveat-cli` hook regression subset remains green.

## [0.14.3] — 2026-05-06

### Fixed
- **Claude Stop reminders now use the same pending UX as Codex.** `caveat hook stop` no longer writes a `<system-reminder>` directly after the final answer. It queues the Stop reminder in per-session pending storage, dedupes unchanged Stop signal digests, and surfaces compacted pending context on the next `UserPromptSubmit` or `PostToolUse` hook as at most one `<system-reminder>` block.
- **CLI bootstrap remains executable after local builds.** The `tsup` post-build wrapper now chmods `dist/caveat.js` to `0755`, keeping direct `.../bin/caveat` hook commands usable after rebuilding the linked development install.
- **Release docs now require `pnpm publish`.** `pnpm pack/publish` rewrites workspace protocol dev dependencies in the public manifest; direct `npm publish` leaves `workspace:*` strings in the tarball.

### Verification
- Added Claude hook regression coverage for compacting multiple pending reminders, deferring Stop stdout, avoiding repeated unchanged Stop reminders, and keeping sidecar-unavailable diagnostics compact.
- Total test count: 242 across workspace packages.

## [0.14.2] — 2026-05-06

### Fixed
- **Prompt surfacing rare-anchor now uses `topical_text`, not `symptom_text`.** `findCaveatsForPrompt` now treats `symptom_text` and `topical_text` as independent evidence: a prompt must overlap the entry's Symptom section to prove the user is describing a failure state, and it must also contain a corpus-rarest topical anchor in `topical_text` (title + tags + environment values) to prove the caveat's curated topic matches. This blocks symptom-prose conversational false positives such as generic "hook worked normally?" or "which hook mistriggered?" prompts surfacing unrelated entries.

### Verification
- Added regression coverage for the two observed symptom-only false-positive classes and a positive control where symptom evidence and rare topical anchor are independent.
- Total test count: 238 across workspace packages.

## [0.14.1] — 2026-05-06

### Fixed
- **Claude failed tools now route through Caveat's mid-turn reminder path.** Current Claude Code can emit failed tool events as `PostToolUseFailure` with a top-level `error` field, not as plain `PostToolUse` with `tool_response.is_error`. `caveat init` now registers `caveat hook post-tool-use` under both `PostToolUse` and `PostToolUseFailure`, preserving any env-prefixed command policy such as `CAVEAT_HOOK_CODEX_SIDECAR=auto`.
- `caveat hook post-tool-use` treats `hook_event_name === "PostToolUseFailure"` or a non-empty top-level `error` field as tool-error input and passes that text to the existing detached worker / pending-reminder pipeline.

### Verification
- Real Claude CLI stream-json smoke confirmed: failing Bash tool -> `PostToolUseFailure` -> Caveat worker -> next hook tick surfaces `[caveat] 直前のエラー...` -> pending queue drains to zero.

## [0.14.0] — 2026-05-05

### Added
- **Codex primary hook adapter.** `caveat codex-hook install|uninstall|diagnostics` and runtime commands for `user-prompt-submit`, `post-tool-use`, `stop`, and `worker` wire Caveat directly into Codex native hooks. The adapter writes Caveat-owned `UserPromptSubmit` / `PostToolUse` / `Stop` entries to `~/.codex/hooks.json`, enables `[features].codex_hooks = true`, uses Codex-specific stdout formats, and keeps `codex-sidecar` separate as a bounded second-opinion / isolated-work route.
- **Codex transcript signal reader.** `readCodexSessionSignals` maps Codex rollout JSONL into Caveat's existing stop-signal model: tool failures from `function_call_output`, repeated `exec_command` calls, repeated patch targets, web searches, web fetches, and duration.

### Verification
- Total test count: 233 across workspace packages.
- Codex hook diagnostics verified `availability=available` and `installation=installed` after global npm install + `caveat codex-hook install`.

## [0.13.0] — 2026-05-05

### Added
- **Codex sidecar advisory for Claude hooks.** `PostToolUse` worker reminders and `Stop` hook reminders keep the existing Caveat text first, then optionally append a `[caveat:codex-sidecar] Codex advisory:` second opinion when `codex-sidecar` is operational for the current project. This improves Claude's next-step advice without changing Caveat's core philosophy: Caveat still decides when to surface memory; Codex only comments on the surfaced context.
- **`caveat codex-sidecar` CLI namespace.** Adds diagnostics, read-only smoke, context-routed `run <review|explore|opinion|risk-check>`, and isolated `work-smoke` commands so consuming projects can verify `codex-sidecar` availability explicitly.
- **Caveat-to-sidecar context adapter.** `@caveat/core` now exports `caveatEntryToSidecarContextBlock` / `caveatEntriesToSidecarContextBlocks`, producing plain JSON `caveat_entry` context blocks for `codex-sidecar` CLI/MCP inputs.
- **Repository-local sidecar policy.** `.codex-sidecar.yml` defines Caveat's allowed paths, deny paths, and presets for read-only and isolated worktree workflows.
- **Codex-facing agent notes.** `AGENTS.md` points Codex users back to `CLAUDE.md` as the source of truth and keeps Codex-specific guidance additive.

### Changed
- **Claude hook install idempotency recognizes env-prefixed Caveat hooks.** This lets users pass `CAVEAT_HOOK_CODEX_SIDECAR`, `CAVEAT_CODEX_SIDECAR_NODE_CLI`, `CODEX_BINARY`, or `CODEX_HOME` through `~/.claude/settings.json` without `caveat init` later duplicating the same hook.
- **CLI serve import is lazy.** Non-serve commands no longer import the web server chunk as a side effect, and the CLI build patch now restores stripped `node:` specifiers across all emitted chunks.

### Configuration
- `CAVEAT_HOOK_CODEX_SIDECAR=off|auto|require` controls hook advisory. Default `auto` only calls Codex when the current project has `.codex-sidecar.yml`; `off` preserves pre-Codex hook behavior; `require` attempts Codex and reports explicit unavailability if it cannot run.
- `CAVEAT_CODEX_SIDECAR_NODE_CLI` and `CAVEAT_CODEX_SIDECAR_COMMAND` select the sidecar command path. `CAVEAT_HOOK_CODEX_SIDECAR_TIMEOUT_MS` controls the synchronous advisory timeout.

### Verification
- Total test count: 217 across workspace packages.
- Real hook smoke verified `post-tool-use-worker codex=yes` and `stop-hook codex=yes`.

## [0.12.0] — 2026-05-04

### Added (BREAKING for hook surfacing behavior)
- **Section-aware role classification (schema v3).** Each entry gets two derived columns: `topical_text` (title + tags + environment values, joined) and `symptom_text` (the entry's `## Symptom` section body). Migration `003_section_roles.sql` auto-applies on next `openDb`; existing rows are backfilled in JS by re-deriving from stored body + frontmatter_json (`db.ts::backfillRoleTexts`).
- **Situational gate.** `findCaveatsForPrompt` now requires that at least one matched prompt token land in the entry's `symptom_text`. Tokens that only land in title / tags / environment ("topical") are insufficient — they mean the prompt named the topic without describing the failure state. Rationale: a prompt like `RTX 5090 CUDA で何かやってる` is just naming the topic, not describing a failure; the user explicitly rejected such proper-noun-only matches.
- **Rare-anchor (min-DF) gate.** Of the matched-in-symptom tokens, at least one must have the minimum document frequency among prompt tokens that exist in the corpus. Common tool-name tokens like `cuda` (high DF across CUDA-related entries) cannot satisfy on their own — only corpus-rare tokens (`cudaGetDeviceCount`, `SQLITE_READONLY`, ...) discriminate. Threshold-free; "rare" is structurally defined as "DF == min over valid prompt tokens".
- **Filesystem path stripping.** `stripFsPaths` removes UNC / Windows drive / POSIX-absolute substrings before tokenization so the user's working directory does not bleed into the token stream and co-occur with caveat bodies that mention the same path components in their Evidence sections. URLs are preserved (the `/` after `:` is not whitespace-prefixed so the POSIX regex does not match into them).
- **Self-identity token filter (env-derived).** `defaultSelfIdentityTokens()` returns the running user's OS username and the path components of `os.homedir()`. The CLI hook caller (`hookCmd.ts::searchCaveatsFromTextSafely`) passes this set to `findCaveatsForPrompt` to drop those tokens before counting. Structural (env-derived, not a hand list). The tool's own brand name (`caveat`) is intentionally NOT special-cased here — the rare-anchor gate handles brand-name noise structurally because brand tokens have high corpus DF.
- **Pure-hiragana trigram filter.** CJK trigrams that are entirely hiragana (e.g., `してる`, `のまま`, `になっ`) are conjugational/particle glue that co-occurs with any Japanese body regardless of topic. Dropped at tokenization. Unicode-range based, no word list.
- **CJK group deduplication.** Trigrams from the same whitespace-separated CJK run share a "group" id. The 2-of-N co-occurrence threshold counts distinct groups, not distinct trigrams. Prevents a 4-char Japanese phrase like `発生する` from auto-satisfying 2-of-N just by expanding into `発生す` + `生する`.
- **Symptom-match word-boundary check.** ASCII / Latin tokens use a Unicode-aware word-boundary regex (`(?:^|[^\p{L}\p{N}])tok(?:[^\p{L}\p{N}]|$)`) when checking the situational gate so a prompt token like `CUDA` does NOT match `cudaGetDeviceCount` as a substring. CJK trigrams continue to use substring (the trigram itself is the lexical unit).

### Changed
- `findCaveatsForPrompt` signature gains `opts.selfIdentity?: Set<string>`. Library default is no filter; the CLI hook caller passes `defaultSelfIdentityTokens()`. Tests can override with `new Set()` for deterministic behavior across machines.
- `extractPromptCandidates` now strips filesystem paths and pure-hiragana trigrams before returning. Existing tests updated.
- `MIN_DISTINCT_TOKEN_MATCHES_CEILING` semantics changed from "distinct token matches" to "distinct group matches" (CJK trigrams from one source phrase = 1 group).
- Total test count: 192 → 202 (+9 in `claudeHooks.test.ts` for path strip / situational / rare-anchor / CJK group dedup / hiragana filter / self-identity cases, +1 in `db.test.ts` for migration 003 + backfill verification).

### Empirical effect (real corpus, ~250 own entries)
| Prompt | Before v0.12 | After v0.12 |
|---|---|---|
| `\\wsl.localhost\Ubuntu-26.04\home\kite\projects\Chime で開発してるんだが、caveat 5 件無関係…` (meta-conversation) | 5 unrelated hits | **0** |
| `RTX 5090 CUDA で何かやってる` (bare proper-noun) | 2 unrelated hits | **0** |
| `RTX 5090 で cudaGetDeviceCount が 0 を返す` (specific symptom) | 1 hit (`rtx-5090-cuda`, correct) | **1** (same, correct) |
| `docker bind mount で SQLITE_READONLY のクラッシュループ` | 5 hits (1 correct + 4 noise) | **1** (correct only) |
| `多少単語が一致したからと言って…` (pure abstract conversation) | 5 unrelated hits | **0** |

### Design philosophy
"List で除外する" のではなく "構造で要求する" — the entire surfacing pipeline relies on Unicode ranges, regex shape, FTS5 spec, runtime env values, entry section structure, and corpus-derived DF. The only numeric constant is `2` (the minimum definition of co-occurrence). No hardcoded word lists, no magic thresholds. New gotcha categories self-extend by simply adding `entries/*.md`.

## [0.11.2] — 2026-05-02

### Changed
- **No-op release.** Verifies the publish pipeline (build → commit → push → `npm publish` → `npm i -g`) from the WSL2 host after migrating off Windows. No behavioral, schema, or API changes — installing 0.11.2 is equivalent to 0.11.1.

## [0.11.1] — 2026-04-23

### Fixed
- **`package.json` `bin.caveat` path.** Removed the leading `./` from `"./dist/caveat.js"` so `npm publish` no longer emits `bin[caveat] script name ... was invalid and removed`. No behavioral change — npm was already normalizing the path at publish time, so installed 0.11.0 works correctly. This is a source-cleanup patch.

## [0.11.0] — 2026-04-23

### Changed (BREAKING)
- **`caveat_record` visibility is now auto-classified by Claude, not asked every time.** The v0.6.2 rule "AI must ASK the user public/private before every call — never auto-classify" is retired. The tool description in `caveat_record` / `caveat_update` now carries a binary criterion: `public` if a third party running the same external tool/spec could reproduce the gotcha, `private` if the trap is specific to your repo / workflow / intentional non-standard design / cross-project personal context. When unclear, prefer `private` (leak-safety). Explicit user instruction ("record this as private", "これは自分用にメモして") always overrides the automatic classification. Rationale: quo's 50 recorded entries at v0.10 classified cleanly under this criterion without human-in-the-loop overhead, and the mandatory-asking pattern was blocking the `private` tier from ever accumulating (cold-start problem). See [docs/archive/private-tier-design.md](docs/archive/private-tier-design.md) for the full argument.

### Added
- **Private tier as a first-class target.** Caveat's scope widens from "external spec gotchas only" to "also repo-specific non-obvious context that code reading cannot reconstruct" (behavior that looks wrong but is intentional, workarounds that survive until upstream is fixed, cross-project conventions). Private entries live alongside public ones in `~/.caveat/own/` but the pre-commit visibility gate keeps them out of any shared git repo. Retrieval is deliberately flat — no source-tier filter switch at search time — because body vocabulary naturally segregates the two (public entries contain external tool names; private entries contain repo-specific identifiers). The 2-token co-occurrence FTS rule stays uniform across tiers.
- **`caveat_search` filter: `visibility: 'public' | 'private' | 'all'`.** Optional, defaults to both. Hook-triggered retrieval (`UserPromptSubmit` / `PostToolUse` / `Stop`) stays flat; this filter is for cases where Claude explicitly narrows, e.g. when drafting externally-visible output and wants to exclude private notes from the signal pool.
- **`entries.last_hit_at` column (schema v2).** Every time an entry surfaces via retrieval (hook reminder or `caveat_search`), its `last_hit_at` is written with the current timestamp. Exposed via `markHit(db, keys)` in `@caveat/core` so the search path stays pure. Existing v1 databases auto-migrate on next `openDb` via `migrations/002_last_hit_at.sql`.
- **`caveat stale` CLI subcommand.** `caveat stale [--days N] [--visibility public|private] [--limit N]` lists entries that haven't been surfaced by retrieval for N days (default 90). Primary use: monthly review of private entries — if a 3-month-old private entry never surfaces, its body likely lacks the repo-specific identifiers it needs to co-occur with relevant prompts, so rewrite or delete.
- **Stop-hook reminder: classification hint.** When the Stop hook fires, the reminder now includes a one-line hint based on objective signals: "外部仕様調査あり → public 寄り" when the session used `WebSearch` or `WebFetch`, otherwise "外部調査なし → private 寄り". Plus a reminder to pick visibility per the `caveat_record` binary criterion. The machine never decides — the hint is input for Claude's judgment.
- **`caveat_record` description: write-style guidance for private entries.** The tool description now instructs: when recording with `visibility: private`, always include repo-specific identifiers (function names, file paths, class names, custom terminology) in the body so the entry can be retrieved by co-occurrence FTS when you touch that area again. Without this, private entries get buried under the 2-token co-occurrence rule.

### Changed
- **Total test count: 192 → 203** (+5 `markHit`, +2 schema v2 / migration, +5 `stale`, +1 integration). All tests green across 5 workspace packages.

### Deferred
- **Cross-machine private sync.** The pre-commit visibility gate still blocks `visibility: private` from being committed to `~/.caveat/own/`'s git remote, which means private entries currently live only on one machine. A separate private repo (with its own remote) is the expected path for multi-machine use but is not implemented in v0.11 — this is fine for single-machine operation, revisit when a concrete multi-machine need arises.

## [0.10.0] — 2026-04-22

### Added
- **PostToolUse hook (実行中発火) with async detached-worker pipeline.** Fires after every `tool_response: { is_error: true }`. The foreground hook does only two things — drain any pending reminders from prior workers and spawn a detached worker — and returns in ~20ms so Claude Code's turn latency is unaffected. The worker runs the co-occurrence FTS asynchronously and writes a reminder to a per-session pending file; the next hook invocation (which could be another PostToolUse or the next UserPromptSubmit) drains and emits it. Reference: `packages/core/src/pendingReminders.ts`, `apps/cli/src/commands/hookCmd.ts::runWorker`.
- **Symmetric 3-firing-point architecture.** Pre-fire (UserPromptSubmit) / mid-fire (PostToolUse async) / post-fire (Stop transcript-signal + FTS) all reuse `findCaveatsForPrompt`'s co-occurrence logic with different text inputs (prompt / tool error / aggregated session signals).
- `claudeInstall.ts` auto-registers `PostToolUse` alongside existing `UserPromptSubmit` and `Stop` entries on `caveat init`.

## [0.9.0] — 2026-04-22

### Changed
- **Stop hook (事後発火) rewritten from "always fire + generic reminder" to signal-gated + co-occurrence FTS.** The hook now parses the session transcript JSONL (`readSessionSignals`) and fires only when at least one objective struggle signal is present: `toolFailureCount > 0`, repeated same-file edits, `webSearchCount > 0`, `webFetchCount > 0`, or `bashRetryCount > 0`. No threshold tuning (0-or-1 gate). When firing, the reminder embeds the concrete signal numbers plus any existing caveats whose content co-occurs with the session's error snippets / search queries, nudging either `caveat_update` (if a match) or `caveat_record` (if new). Catches struggle the AI didn't self-report.

## [0.8.0] — 2026-04-22

### Changed
- **UserPromptSubmit hook (事前発火) rewritten from keyword-allowlist to co-occurrence FTS.** Tokenizes the prompt, runs a per-token FTS5 query, and counts how many distinct tokens co-occur in each entry. Only entries matching ≥ 2 distinct tokens are surfaced. No hardcoded keyword/stopword lists — a new gotcha category just needs a new `entries/*.md` file and the trigger self-extends. Rule design: a single common word like `make` / `new` can't fire a match on its own, but two+ technical tokens co-occurring in the same entry will. See the historical [Phase 15 design](docs/archive/01_plan_history.md#phase-15) and `feedback_no_hardcoded_lists` memory.

## [0.7.0] — 2026-04-19

### Removed (BREAKING)
- **Central shared community DB model abolished.** The "everyone subscribes to one upstream repo and contributes via fork+PR" architecture is retired. Trust is now defined socially via per-group git repos that subscribers add explicitly. See [README.md](README.md) and [docs/archive/auto-merge-design.md](docs/archive/auto-merge-design.md) for the rationale.
- **`caveat push` CLI command** — removed. Group/team sharing now uses plain `git push` to a repo the contributor has write access to.
- **`caveat_push` MCP tool** — removed. Claude no longer has a path to publicly publish caveats. Recording / updating writes to the user's local `~/.caveat/own/` only.
- **`pushEntry` core function and `pullShared` core function** — both removed. `caveat pull` now uses `communityPull` + per-source re-index inline.
- **`caveat init --skip-shared` flag** — removed (the bootstrap subscription it opted out of no longer exists).
- **Auto-subscription to `kitepon/Caveat`** in `caveat init` — removed. New installs get an empty knowledge base; subscribe explicitly with `caveat community add <github-url>`.
- **`sharedRepo` config field, `SHARED_REPO_URL` constant** — removed from `~/.caveatrc.json` and core defaults.
- **`docs/auto-merge-design.md`** — moved to `docs/archive/` (the design was abandoned before implementation; archived for historical context).
- **`.github/ISSUE_TEMPLATE/caveat_contribution.md`** — removed (manual PR contribution to a central DB is no longer the workflow).

### Changed
- **MCP tool count is now 6** (was 7): `caveat_search`, `caveat_get`, `caveat_record`, `caveat_update`, `caveat_list_recent`, `caveat_pull`.
- **`caveat init`** scaffolds local state and registers Claude Code integration; no network operations during init unless `--skip-claude` is also off.
- **Stop hook reminder** no longer nudges `caveat_push` (the tool no longer exists).
- **README / CONTRIBUTING / SECURITY / CLAUDE.md / docs/01_plan.md** rewritten to reflect the new "personal / group" model.

## [0.6.2] — 2026-04-19

### Changed
- **MCP tool descriptions rewritten for AI-correctness**. Every tool now defines what a "caveat" is in its own description (time-wasting traps in external specs — GPU/driver/CUDA versions, native-module builds, IDE/shell quirks, platform-specific behavior) so the tool is usable without shared context. Fixed the silent-not-found gotcha on `caveat_get` (IMPORTANT: pass `source` from search result). Clarified: `caveat_search` query has no FTS5 operators (plain tokens only); `caveat_update` array fields REPLACE rather than append; `caveat_pull` should not be called reflexively at session start; `caveat_record` must search first for duplicates and qualify entries before creating; `caveat_push` is a PUBLIC irreversible action requiring user confirmation.

### Added
- **`caveat_record` visibility is now REQUIRED in the MCP schema** — the AI must ask the user whether the entry is `public` (shareable to community DB) or `private` (local-only) before calling. No auto-classification: the user owns the knowledge and decides its reach.
- **`pushEntry` rejects `visibility: private` entries** with `status=visibility-private` before touching GitHub. Previously private entries could be silently pushed to the public community DB — the pre-commit hook only guarded the tool repo itself. Regression test added.

## [0.6.1] — 2026-04-19

### Fixed
- **community path placement**: `community/` now lives at `<caveatHome>/community/` instead of nested inside `<knowledgeRepo>/community/`. External knowledge caches are no longer buried in the user's own repo. `caveat init` auto-migrates existing clones from the legacy location on first run.
- **`caveat push` DeprecationWarning**: replaced `spawnSync(cmd, args, { shell: true })` with a single-string shell invocation to avoid Node 24's "shell + args array" deprecation. `gh.cmd` / `git.cmd` resolution on Windows still works via the platform shell.
- **Dead imports** cleaned up in `push.ts`.

### Changed
- CLI version is now read from `package.json` at runtime (`apps/cli/src/version.ts`) instead of hardcoded. Single source of truth.
- `~/.caveat/own/.gitignore` template no longer lists `community/` (it lives outside the repo in v0.6.1+).

### Added
- Push dry-run unit tests (`packages/core/tests/push.test.ts`): validates not-found, invalid URL rejection, and the dry-run plan output shape. Gracefully skips when `gh` CLI is unavailable.
- `CHANGELOG.md` (this file).

## [0.6.0] — 2026-04-19

### Removed
- **NLM integration tools** (`nlm_brief_for`, `ingest_research`) and the `Frontmatter.brief_id` field. Both were thin wrappers over `caveat_record` — Claude can generate NotebookLM prompts in-context and record results with `confidence: tentative` directly. MCP tool surface is now 7 (was 9).

## [0.5.0] — 2026-04-19

### Changed
- **Merged the shared knowledge DB into the tool repo**. The former separate `kitepon-rgb/caveats-quo` repo was archived and deleted; all 35 entries moved to this repo's `entries/` directory. The live repository is now `https://github.com/kitepon/Caveat`. One repo to remember.
- `.gitignore` extended with `.obsidian/` and `community/` (the tool repo now also serves as an Obsidian vault).

### Migration
- Existing v0.3-0.4 users: `npm update -g caveat-cli && rm -rf ~/.caveat/community/caveats-quo && caveat init`.

## [0.4.0] — 2026-04-19

### Added
- **`caveat_pull` and `caveat_push` as MCP tools**. Claude Code can now autonomously fetch community updates and submit contributions, gated by Claude Code's tool permission prompt for the public-write direction.
- `packages/core/src/push.ts` (`pushEntry`) and `packages/core/src/pullShared.ts` (`pullShared`) extracted so both CLI and MCP share the same implementation.
- Stop-hook reminder nudges `caveat_push` for genuinely reusable caveats.

## [0.3.0] — 2026-04-19

### Added
- **Shared community knowledge DB model**. `caveat init` auto-subscribes to a default shared repo (`SHARED_REPO_URL` constant, overridable via `~/.caveatrc.json`'s `sharedRepo` field). Skippable with `--skip-shared`.
- **`caveat pull`**: refresh every subscribed community repo and re-index.
- **`caveat push <id>`**: contribute a user-owned caveat via fork + PR using the `gh` CLI. Supports `--dry-run`.

## [0.2.1] — 2026-04-19

### Added
- `caveat init` now writes a default `.gitignore` to the scaffolded knowledge repo (`*.private.md`, `.obsidian/`). Prevents accidental commit of per-user Obsidian state and flagged-private entries.

## [0.2.0] — 2026-04-19

### Removed
- **`source_project` auto-infer**. `caveat_record` no longer consults `projectRoots` to guess the source project from cwd; the field is always written as `null`. This prevents per-user project names from leaking into publicly-shared knowledge. The `CaveatConfig.projectRoots` field and the `inferSourceProject` function were also removed. Users wanting `source_project` for personal traceability can set it manually in the md file.

## [0.1.0] — 2026-04-19

### Added
- **Initial NPM release**. The CLI is distributable as a single public package (`caveat-cli`) with `caveat` as the bin. Workspace deps (`@caveat/core`, `@caveat/mcp`, `@caveat/web`) are bundled into the CLI via tsup `noExternal`.
- **`caveat init` as one-shot installer**: scaffolds `~/.caveat/`, registers the MCP server with Claude Code via `claude mcp add --scope user`, and merges `UserPromptSubmit` / `Stop` hooks into `~/.claude/settings.json`. Idempotent, `--dry-run` supported.
- **`caveat uninstall`**: reverses the Claude Code integration without touching local data.
- **CLI subcommands**: `caveat mcp-server` (stdio MCP entry), `caveat hook <user-prompt-submit|stop>` (hook handler). Eliminates the Phase 10 pattern of registering raw `.mjs` script paths — Claude Code config now only references the `caveat` CLI.
- **caveatHome path model**: `process.env.CAVEAT_HOME ?? ~/.caveat/`. DB at `<caveatHome>/index/caveat.db`, default knowledge repo at `<caveatHome>/own/`.
- **Build pipeline**: `dist/caveat.js` thin bootstrap wrapper suppresses the `node:sqlite` ExperimentalWarning before the ESM bundle's static imports fire. Post-build pass restores `node:` prefix stripped by esbuild. CJS deps handled via `createRequire` banner.

---

## v0 implementation phases (pre-NPM)

For the design history of the v0 feature set (Phase 0 through 11), see `docs/archive/01_plan_history.md`. Those phases predate the NPM release and are captured in commit history on the `main` branch of `kitepon/Caveat`.
