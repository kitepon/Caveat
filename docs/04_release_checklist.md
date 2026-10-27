# Release Checklist

Use this checklist for every `caveat-cli` npm release. Do not stop at publish:
the release is only complete after the published package passes fresh-install
checks for Claude/Codex/Cursor and the available new-session host smokes.

MCP登録はGrokも含めて確認する。`caveat init`を隔離した設定先で二度実行し、Claude / Codex /
Grokの公開CLIによる読戻し、CursorのJSON、登録したcommandによるMCP接続と検索を確認する。
Grokの必須判定は`caveat factory-diagnostics --json --require-connector grok`で行い、
`grok mcp doctor caveat --json`でハンドシェイクとツール検出を見る。AitermのComposerは
`grok-cli`と`grok-composer-2.5-fast`で実際にCaveatを呼ぶ。モデルの認証・回答結果は
登録診断と分けて記録する。指定モデルが`grok models`に無ければComposerは失敗とし、
別のGrokモデルやCursorのComposerで代用しない。
既存の環境変数・timeout・無効化指定・別サーバーが保持され、不正な既存設定は変更されず失敗すること。

実機導入は端末の所有と具体許可に従い、WindowsはPowerShell 7を使う。
managed-v1で配布するhostは、受入済みの固定entryを保持し、検証したpackageを
`deployment stage` / `deployment activate`で選択する。通常更新でglobal npmや`init`を再適用しない。
未管理hostの初回導入だけ、公式npm導入、`caveat init --sync --yes`、初期化の再実行と製品診断を行う。
実機の共有AI設定は先にバックアップし、他製品のinstallerと同時に変更しない。
既存private remoteのcheckout、更新後の登録先更新、公開ミラーと明示hook拒否の保持も確認する。
新規private remoteを作成する試験には認証済みの`gh`を使う。認証待ち・未実施は成功と区別する。

Node 24以降では、登録されたcommandとenvによる4 AIのMCP接続・検索を次で確認できる。
引数は公開npm版の`caveat-cli`ディレクトリで、検査は設定値や検索本文を出力しない。

```sh
node scripts/mcp-registration-smoke.mjs "$(npm root -g)/caveat-cli"
```

## Pre-Publish

Run workspace checks sequentially. Do not run `build` and `typecheck` in
parallel: `build` may clean package `dist/` output while downstream packages are
resolving generated declarations.

Use the repository-pinned pnpm through Corepack. Root scripts delegate through
`scripts/pnpm.mjs`, whose order is an explicit `CAVEAT_PNPM_BIN`, Corepack,
`pnpm` on `PATH`, then `npx pnpm@10.0.0`. CI intentionally invokes root scripts
through Corepack, so the nested delegation remains on the pinned package
manager. Do not set `CAVEAT_PNPM_BIN` to an unpinned binary or silence a package
manager mismatch with `--pm-on-fail=ignore`.

Windowsのpackage-manager shimは`scripts/process-command.mjs`を通じてPowerShell 7から起動する。
文書検査・pack・隔離npm導入も同じ処理を使い、Windowsで`.cmd`を直接spawnしない。

```bash
corepack pnpm -r build
corepack pnpm -r typecheck
corepack pnpm check:release-smoke
corepack pnpm -r test
git diff --check
```

Update the version and release notes, then verify the packed manifest again
before publishing. `check:npm-pack` packs `apps/cli` with pnpm, fails if
`workspace:` protocols, missing bin files, or non-executable `dist/caveat.js`
leak into the tarball, then installs the tarball with npm and verifies
`caveat --version`. `check:docs` also reads npm's dry-run pack manifest and
requires every relative link and image in packed Markdown to resolve inside
that same tarball. Pack from `apps/cli` with pnpm. Direct `npm publish` of the
workspace source is forbidden because it can leave `workspace:*` strings in the
packed manifest; the release workflow publishes the checked pnpm tarball.
The pack check requires all six x64/arm64 native bridge variants and their MIT
license, then loads the bridge from an isolated staged managed payload and calls
only its own process-ID API. A successful source dependency import does not replace
this archive check. Keep the fixed entry/runtime independent of the native probe.
Derive the release version from that package manifest in the same shell used
for the remaining release commands.

```bash
VERSION=$(node -p "require('./apps/cli/package.json').version")
corepack pnpm check:docs
corepack pnpm check:npm-pack
```

## npm Trusted Publishing (one-time setup)

Before the first workflow release, register `kitepon/Caveat` and the exact
workflow filename `publish-npm.yml` for `caveat-cli` on npm. Allow direct
`npm publish`; the default staged-only permission will not publish a release.
This registration needs one interactive npm 2FA approval. Afterward, the
GitHub-hosted release workflow uses OIDC and needs no per-release npm approval
or stored npm publish token. Run once with npm 11.15 or newer:

```bash
npm trust github caveat-cli --file publish-npm.yml --repo kitepon/Caveat --allow-publish
npm trust list caveat-cli
```

The trust relation is bound to this workflow filename. Keep its filename and
repository identity aligned with npm settings. The workflow uses a GitHub-hosted
runner, `id-token: write`, Node 24 and npm 11.19.1. If trust setup is not yet
complete, do not push a new release tag expecting publication to succeed.

## Publish

Commit and push `main`, then wait for that commit's CI. The CLI's
`prepublishOnly` gate still requires a clean release commit already landed on
`origin/main`. Release artifacts are made once by `pack-release.yml` on main,
then retained as the immutable `caveat-release-pack` Actions artifact for 30 days.
Its `release-artifact.json` records the source/tree, version, run/attempt, tool
versions and exact tgz SHA256. Read the run summary and download that artifact
for final acceptance and any authorized host preflight. Local repacks are not
the acceptance artifact: pnpm 10 rewrites workspace dependencies asynchronously,
so JSON key order can change even with the same source and tools.

```bash
gh workflow run pack-release.yml --ref main
gh run list --workflow pack-release.yml --limit 5
# Set RELEASE_RUN to the successful candidate run selected for acceptance.
release_candidate=$(mktemp -d)
gh run download "$RELEASE_RUN" --repo kitepon/Caveat --name caveat-release-pack --dir "$release_candidate"
RELEASE_SOURCE=$(node -p 'require(process.argv[1]).source' "$release_candidate/release-artifact.json")
VERSION=$(node -p 'require(process.argv[1]).version' "$release_candidate/release-artifact.json")
RELEASE_SHA=$(node -p 'require(process.argv[1]).sha256' "$release_candidate/release-artifact.json")
```

After that exact source/archive is accepted and publication is explicitly
authorized, create the annotated tag at the recorded source. Tag pushes do not
publish. Dispatch the existing trusted-publisher filename with the accepted
run ID and complete archive SHA256:

```bash
git tag -a "v$VERSION" "$RELEASE_SOURCE" -m "v$VERSION"
git push origin "v$VERSION"
gh workflow run publish-npm.yml --ref main \
  -f tag="v$VERSION" -f candidate-run-id="$RELEASE_RUN" -f archive-sha256="$RELEASE_SHA"
gh run list --workflow publish-npm.yml --limit 5
```

The publisher checks the annotated tag/version/main ancestry and clean tree,
then checks the candidate run's repository, source, main branch, workflow,
event, successful completion and attempt before downloading it. It rejects
unexpected files, changed artifact metadata and any archive digest mismatch.
It publishes that same tgz with pinned npm 11.19.1 and existing OIDC; it never
installs workspace dependencies, builds or repacks. A failed or expired
candidate is not replaced under the accepted digest: prepare and accept a new
run/archive before publishing. An old tag without this artifact provenance is
not a reason to rebuild silently in the publishing job.

After publication, download the registry tarball, verify its npm integrity and
SHA256 against `RELEASE_SHA`, and fresh-install that archive. Compare every
packed file with the installed package. Publication is not acceptance when the
bytes differ; retain both archives and stop distribution for a concrete decision.
The published 0.21.5 metadata-order exception was an explicit one-time adoption,
not a general semantic-equality fallback.

Artifact upload and download behavior follows the official
[upload-artifact action](https://github.com/actions/upload-artifact) and
[gh run download](https://cli.github.com/manual/gh_run_download) contracts.

## Published Package Smoke

Install from npm into a temporary prefix, not from the local workspace.

```bash
root=$(mktemp -d)
prefix="$root/npm"
mkdir -p "$prefix"
npm install -g "caveat-cli@$VERSION" --prefix "$prefix"
"$prefix/bin/caveat" --version
node -e 'const p=process.argv[1],m=require("node:fs").statSync(p).mode&0o777; console.log(m.toString(8),p)' \
  "$prefix/lib/node_modules/caveat-cli/dist/caveat.js"
node -e 'const p=require(process.argv[1]); console.log(JSON.stringify({version:p.version,bin:p.bin,commander:p.dependencies.commander}, null, 2))' \
  "$prefix/lib/node_modules/caveat-cli/package.json"
```

Expected:

- `caveat --version` prints `$VERSION`.
- `dist/caveat.js` is executable (`755` on Linux).
- The manifest has `bin.caveat = "dist/caveat.js"`.

## Fresh Install Hook Smoke

隔離したOSユーザーのプロファイルで行い、既存ユーザーの`HOME`を変更しない。
そのプロファイルのCaveat設定が既定値であることを確認し、AI設定とデータは次の一時領域へ分ける。

```bash
original_home=$(node -p 'require("node:os").homedir()')
root=$(mktemp -d)
prefix="$root/npm"
smoke_home="$root/profile"
mkdir -p "$prefix" "$smoke_home"
export PATH="$prefix/bin:$PATH"
export CAVEAT_HOME="$smoke_home/.caveat"
export CLAUDE_CONFIG_DIR="$smoke_home/.claude"
export CODEX_HOME="$smoke_home/.codex"
export GROK_HOME="$smoke_home/.grok"
export CURSOR_HOME="$smoke_home/.cursor"
mkdir -p "$CLAUDE_CONFIG_DIR" "$CODEX_HOME" "$GROK_HOME" "$CURSOR_HOME"

npm install -g "caveat-cli@$VERSION" --prefix "$prefix"
caveat init --yes
caveat init --yes
caveat codex-hook diagnostics
caveat cursor-hook diagnostics
```

生成設定を確認する。以下の`~/.claude`等は上記の設定先へ読み替え、Claude MCPは
`$CLAUDE_CONFIG_DIR/.claude.json`を確認する。

- `~/.claude/settings.json` contains Caveat `UserPromptSubmit`,
  `PostToolUse`, `PostToolUseFailure`, and `Stop` commands.
- `~/.claude.json` contains the `caveat` MCP registration.
- `~/.codex/hooks.json` contains Caveat `UserPromptSubmit`, `PostToolUse`, and
  `Stop` commands with `timeout: 5` (seconds) and `async: false`. The obsolete,
  ignored `timeoutSec` key must not appear.
- `~/.codex/config.toml` contains `[features] hooks = true` and no deprecated
  `codex_hooks` alias.
- `~/.cursor/hooks.json` contains Caveat `beforeSubmitPrompt`, `postToolUse`,
  `postToolUseFailure`, and `stop` commands, while unrelated existing hooks are
  preserved.

二度目の初期化で設定ファイルに差分がないことを確認する。解除試験は新規セッション試験の後に行う。
`caveat uninstall`はClaude連携だけ、Codex / Cursorは各`*-hook uninstall`で解除し、
対象のCaveat hookが残っていないことを確認する。Cursor has no
repository-owned live-session smoke harness; its release gate is the focused
installer/adapter tests plus this packed-package install/diagnostics smoke.
実機のCursor会話は下記の手動試験で確かめる。

## New Codex Session Smoke

Use a temporary `CODEX_HOME` created by the fresh-install smoke. Do not copy
auth material into the repository. If auth is needed, symlink the existing
user-level Codex auth files into the temporary Codex home and remove the whole
temporary directory after the smoke.

```bash
REAL_CODEX_HOME=${REAL_CODEX_HOME:-$original_home/.codex}
ln -sfn "$REAL_CODEX_HOME/auth.json" "$CODEX_HOME/auth.json"
ln -sfn "$REAL_CODEX_HOME/installation_id" "$CODEX_HOME/installation_id"

out="$root/codex-exec.jsonl"
last="$root/codex-last.txt"
codex exec \
  --json \
  -C /tmp \
  --skip-git-repo-check \
  -s read-only \
  -m gpt-5.6-luna \
  -o "$last" \
  "Reply exactly: caveat-new-session-ok" >"$out"

if rg -i "hook returned invalid|hook.*failed|invalid user prompt" "$out"; then
  exit 1
fi
```

Expected:

- `codex exec` exits 0.
- `$last` contains `caveat-new-session-ok`.
- No hook invalid/failure lines are present.

## Jev Hook Smoke

公開版を実機へ導入した後、`caveat jev status`で明示的な有効化を確認する。
既知の同一問題を3ターン続けて試行する隔離セッションで、Throughlineの
`caveat-context`が完了3ターンを返し、Jevの判定とローカル候補選別を経て
該当知見が1回だけ通知されることを確認する。新しい問題に切り替えた場合は
新しい判定が届くことも確かめる。API失敗はstderrへ診断される。

## New Claude Session Smoke

Use Haiku for cost control. Keep the fresh-install package, settings, MCP config,
and `CAVEAT_HOME` under the temporary release root, but retain the invoking
Claude user's `HOME`/`USER`/`LOGNAME` and unset `CLAUDE_CONFIG_DIR` for the smoke:
an isolated config directory cannot reuse the user's authentication. The explicit
`--settings` and `--mcp-config` arguments keep the tested configuration isolated.
This is a release-only human smoke; CI runs
the separate fake CLI contract test and never invokes real Claude.

```bash
repo=$(git rev-parse --show-toplevel)
mkdir -p "$root/caveat-home"
env -u CLAUDE_CONFIG_DIR node "$repo/scripts/claude-fresh-session-smoke.mjs" \
  --settings "$CLAUDE_CONFIG_DIR/settings.json" \
  --mcp-config "$CLAUDE_CONFIG_DIR/.claude.json" \
  --caveat-home "$root/caveat-home"
```

Expected:

- Claude uses a Haiku model.
- `UserPromptSubmit` and `Stop` hook events both have `exit_code: 0` and
  `outcome: "success"`.
- The result is `caveat-claude-session-ok`.
- No Caveat hook invalid/failure lines are present.
- If `claude auth status` is unavailable or unauthenticated, the script exits
  unavailable rather than treating the smoke as a pass; authenticate and rerun.

## New Cursor Session Smoke

公開版を導入した実機で、通常のCursor設定のまま新しい会話を1回行う。`~/.cursor`は変更しない。
一時workspaceの`.cursor/hooks.json`にだけ、`caveat cursor-hook user-prompt-submit` /
`post-tool-use` / `stop`を包んで終了コード、stdoutのJSON妥当性、stderrの有無を記録するwrapperを置く。

- 対話セッションで行う。Cursor CLI 2026.09.26の`-p`では`postToolUse`だけが発火し、
  `beforeSubmitPrompt`と`stop`は呼ばれない。
- macOSでは、素のSSHセッションからだとログインキーチェーンがロック扱いになり、`cursor-agent`が起動しない。
  GUIログイン側で動いている端末（Aitermのtmux serverなど）から実行する。
- Cursorの月間利用上限に達したモデルは使えない。その場合は`--model auto`で試す。

```bash
cursor-agent --model auto --approve-mcps --trust
# prompt: Call the caveat MCP server's search tool exactly once with query "git".
#         Do not use any other tool. Then reply exactly: caveat-cursor-session-ok
```

Expected:

- `caveat_search`のMCP呼出しが成功し、回答が`caveat-cursor-session-ok`になる。
- `beforeSubmitPrompt`、`postToolUse`、`stop`の3 hookがすべて終了0で、stderrが空。
- 試験後に一時workspaceとwrapperを削除する。

After the published-package and available host smokes pass, publish the GitHub
Release for the already-pushed annotated tag:

```bash
gh release create "v$VERSION" --verify-tag --title "Caveat $VERSION" --generate-notes
```

## Closeout

Before reporting the release complete:

```bash
gh run list --limit 5
gh pr list --state open --json number,title,author
gh release view "v$VERSION" --json tagName,isDraft,isPrerelease,url
npm view caveat-cli version
git status --short --branch
```

Expected:

- Latest `main` CI is green.
- No superseded Dependabot PR remains open.
- GitHub Release `v$VERSION` exists and is neither draft nor prerelease.
- npm latest equals `$VERSION`.
- Worktree is clean and synced with `origin/main`.


## Private evidence candidate gate

This isolated candidate does not enable a transport or hook into factory diagnostics.
After a clean workspace build, pack locally with pinned pnpm and run
`node scripts/check-private-evidence-pack.mjs <absolute-local-tarball>`.
The gate reads archive bytes only: package version/bin, all three source-identical schemas,
compiled pure entry files, and the schema-valid capability with `transports: []`.
No transport may be added until its platform/launch path, ownership, nonblocking behavior,
peer identity/nonce/EOF, cancellation and secret non-transfer have separate acceptance evidence.
Pure fixture success and local pack success do not establish Windows/macOS or host acceptance.
OFF must not prepare or send private data; optional failures must preserve public bytes and exit.
The fixed synthetic fixture is `apps/cli/tests/fixtures/private-evidence/contract.v1.json`.
No private raw values are put in npm artifacts, logs or public diagnostic JSON.


## Declared minimum Node launcher gate

Run `node --test scripts/cli-bootstrap.test.mjs` on the declared lower bound and the normal build runtime.
Use the shipped bin with `--version` and `--help` without adding an experimental SQLite flag to the test command.
Match the packed bootstrap bytes to `apps/cli/src/bootstrap.mjs`, and verify argv/stdio/exit/signal and explicit-disable refusal.
The product launcher owns the startup requirement; preserve the baseline failure and fixed output separately.
Record the OS and Node version actually exercised. A Linux lower-bound pass does not establish macOS/Windows cancellation
or all product features, private diagnostics, or the full private pure suite on that runtime.

Before accepting the re-exec launcher for all callers, record these separate results:

| Remaining condition | Isolated acceptance and required evidence |
|---|---|
| macOS/Windows minimum Node | Exact declared Node 22.5.0, fresh pack/npm bin version/help without test-only SQLite flags, argv/env/stdio/exit fixtures; record OS/runtime/archive hashes |
| Windows lifetime and cancellation | Fake long-running entry with parent/child IDs; cancel the normal npm/PowerShell path and prove both terminate within the caller deadline; own-tree cleanup on failure |
| POSIX forced parent exit / startup signals | Bounded fake process group, SIGKILL and signals before/after entry readiness; prove no remaining child, preserve signal result, clean up only the owned group |
| Preloads | Local --require/--import marker fixture records one execution without re-exec and two with it; this observed difference needs a caller policy or repair before claiming side-effect equivalence |
| Debugger | Fake entry and loopback inspector in an explicitly authorized isolated test; verify port ownership/conflict and parent/child termination before accepting this Node option |
| Future additional fd/private channel | Keep transports empty and diagnostics disconnected; before any capability claim, prove descriptor ownership/peer/EOF/nonblocking/cancellation across the re-exec and actual shim |

POSIX ready-entry SIGINT/SIGTERM tests are selected only on POSIX; Windows skips are explicit missing acceptance.
The canonical three-OS CI uses each runner's installed Node and does not establish the exact minimum on all OSes.
Minimum-Node private147 and the 3OS x 4harness actual-use matrix remain separate, unverified acceptance.
Local fake-entry regressions, build/pack and CI do not authorize real diagnostics/sync, host configuration,
publication, enabling private evidence, or real private transport.

## Managed-entry acceptance

Build the standalone managed runtime and ship both `dist/stable-entry.mjs` and `dist/managed-deployment.js`. Verify that runtime can load before the minimum-Node SQLite bootstrap. The isolated launcher test stages two fixture versions, invokes the normal bootstrap/argv entry, selects and rolls back, and checks unchanged four-client and native-hook definitions. Windows uses real owner-only root/tree ACLs in that acceptance; pure store fixtures use an injected ACL seam and are not native ACL evidence.

For native hook identity, run `node scripts/managed-native-hash-proof.mjs apps/cli/dist <codex-executable-or-codex.js>` in each accepted OS environment. It uses an owned isolated profile and only initialize/hooks/list, never a thread/model, hook execution or trust write. The three untrusted fixture definitions must retain the same key/currentHash through selection and rollback. Preserve OS/runtime and source/archive identity with the result. Do not treat a Linux proof as Windows/macOS acceptance. The proof waits for the owned child's `close` event, including its stdio, before removing its fixture. A wrapper's `exit` alone does not establish that inherited pipes have closed. The success JSON is emitted only after cleanup; an unclosed pipe retains the fixture and fails the proof.

Before migration, fix the real stable definitions and obtain their normal one-time trust decision. Preserve old registrations/payload until the stable entry is accepted. After migration, compare native hooks/list hashes and all other products' trust across a normal version selection and rollback. A managed deployment is not complete merely because static hook diagnostics say installed.

For managed deployment, compare the same ordinary Codex hooks on each OS through the published 0.20.3 command, the candidate command and the managed launcher in isolated profiles with `runtimeErrors: true`. Record first-in-fixture and subsequent invocations separately; do not claim an OS cold cache. `check:npm-pack` performs this comparison with the packed candidate and an isolated published baseline installation. Keep native ACL/full payload checks in stage/activate/status and verify the fixed runtime has no child-process call or package scan. Test `deployment status` lock diagnosis and explicit dead-owner `deployment unlock`, plus Windows invocation from the registered command string and alternate path spellings.

Before the next managed release is published, retain an acceptance result from each target host's actual canonical home: candidate installed into an isolated prefix with normal npm umask, then read-only `deployment preflight --json` checking the selected v1 root, actual ownership/modes/native ACLs and source. All hosts must report stage/activate allowed before publication. Also exercise actual stage/activate and metadata ownership in isolated profiles using the same host account. Include the preflight results with the exact migration definitions; test-prepared homes alone do not establish the real placement's acceptance.

### CI toolchain

The full Windows native suite has a 45-minute job budget; Linux/macOS retain
30 minutes. The seven-file migration fixtures brought the measured Windows
CLI completion to the old job deadline, which canceled the final native hook
proof after all 345 CLI tests passed. Keep every individual owned-child probe
deadline and all required gates unchanged; job cancellation is not success.

Hosted の文書・candidate pack・公開 job は、`.github/ci-toolchain.json` の Node 24.22.1 と pnpm 10.0.0 を使う。pnpm は root の `packageManager` とも一致させ、実行時に実版を照合する。workflow の完全版指定と共有 contract の一致は文書・release smoke の両 gate で検査する。

3 OS の full CI は host の Node を使い、完全版の固定や host の更新は行わない。core と CLI の移行試験は同じ既存 runner で実行 binary（共有 libnode 版は隣接 library も）を私有 fixture へコピーして起動し、製品の runtime 親保護条件を保つ。共有 runtime の権限は変更しない。実 Node・execPath・SQLite を proof に記録し、package の engines、製品の実 FTS5・trigram probe、共有 contract の既知影響版拒否を通す。将来の host 更新も、これらを満たせば許容する。

影響版の出典は contract に記録する。Realm lifetime の範囲は [Lattice PR32](https://github.com/kitepon/Lattice/pull/32) と同じ [Node upstream repair](https://github.com/nodejs/node/pull/65778) を使い、24.x の修理は [24.22.0](https://nodejs.org/en/blog/release/v24.22.0) に収載されている。選定した 24.22.1 は、さらに [2026-10-21 security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases) の修正版である。これは記録した既知範囲の検査であり、将来の未知の欠陥や host 全体の trust を保証するものではない。

### Managed shell entry

`deployment shell-plan --node … --bin-dir … --json` は固定の絶対 Node 入口と managed entry に結び付く wrapper の内容・完全 SHA を返す。POSIX は `exec`、Windows は拡張子なし・cmd・ps1 の3ファイル。Windows ps1 は Windows PowerShell 5.1 と PowerShell 7 で同じ argv を渡し、native stdio を継承する。シェル自体が入力時に展開する記法は、そのシェルの規則に従う。Node を PATH から探索したり、entry への symlink を作ったりしない。cmd は固定 Node の小さい bootstrap から同じ実体の Node 子へ entry の絶対 argv を渡し、batch の文字コードによる Unicode path の破損を避ける。この三形式の生成は ASCII の Node path に限定し、それ以外は明示拒否する（entry と通常引数は Unicode を保持する）。

旧 v1 の手動配置・host による製品受入の委任は撤回する。通常の移行・完全保全・限定 uninstall・既知だけの復帰・wrapper/manifest 配置・読戻しは Caveat 製品の責務である。host 担当の範囲は OS/共有 runtime 自体の通常保守と作業窓の合意とし、専用 collector/launcher/補完コードへ依存しない。v1 の plan/capture/status API は read-only 互換として保持する。新しい製品移行の契約は [現行 plan](01_plan.md) に従う。

配置後の `deployment shell-manifest --node … --bin-dir … --json` は read-only で内容・owner・mode・identity、Windows の owner SID と ACL digest を照合し、所有 manifest を返す。この v1 API の手動保存手順を host の工程へ再委任しない。新しい移行は製品が native-v2 manifest を私有作成・照合・配置する。`deployment status --json` の `shell` は payload と独立した診断で、未導入、欠落、別 wrapper、所有/ACL/identity の変更、redirect、不明を示す。Homebrew/npm が後から leaf を置き換えた場合も診断し、勝手な修理や global fallback は行わない。


### Product-owned global migration and recovery candidate gate

Before a completed candidate, retain native three-OS fixtures for read-only plans
without a run/lock, unknown process/writer refusal, original-tree preservation,
scoped npm removal and wrapper/readback binding to the reviewed pointer, Node
proof and exact checkpoint journal. Persisted recovery must keep old evidence
read-only, use only a new private journal and prove original inode/content/security
restoration, known partial states, parent/alias/absence changes, unknown writers,
interrupted/new/duplicate attempts and post-close readback changes. An observed
journal is not current-object acceptance or permission to execute. Require fresh binding of known partial recovery-attempt states from the original
validated plan/seed and a bounded confirmed source chain. Bind native original
identity/content/security in the reviewed plan; a self-consistent seed/result hash
rewrite must not substitute a different original. Reject pending/torn/unknown
intents, cycles, changed parents/aliases and arbitrary saved-path authority before
creating a new journal. Keep journal inspection separate from current-object admission.
Retain actual selected-Node SQLite capability and owned-child close receipts,
executable/alias/parent/native-security bindings, reported actual libnode
identity/hash/parent bindings or explicit shared-build rejection, and changed
library/alias/writer refusal fixtures. The same stable proof must enter plan,
manifest, status, coordinator and recovery without altering fixed entry/runtime
bytes or repairing shared runtime permissions. Status alone does not assess
process/writer absence. These proofs,
registration-token migration/readback/known rollback,
versioning and final review remain required before the completed candidate.
For the saved Main scope, retain exact seven-file/fifteen-pointer fixtures with
repeated equal command values, strict JSON/TOML semantic equality and token-only
byte edits; preserve the original native inode/content/security through new private
files and journals. Exercise confirmed partial migration and recovery chains,
pending/torn/unknown refusal, forged paths/roles/original seeds, stale digests,
cyclic or reused journal identities and foreign objects at vacated names.
Post-close readback must independently reopen every source/new directory and all
current/protected objects. The saved projection contains no full original config
bytes and does not establish current Node acceptance or grant live-write approval.
Bind the exact version/source/tree and immutable fixed entry/runtime hashes in the
review packet. A local review tarball is not the main-only release acceptance
artifact; generate and accept the latter through the existing workflow after
normal source review and landing, before any separately authorized publication.
Release or machine-operation approval is separate from these source fixtures.
