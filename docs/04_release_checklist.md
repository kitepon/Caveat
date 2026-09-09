# Release Checklist

Use this checklist for every `caveat-cli` npm release. Do not stop at publish:
the release is only complete after the published package passes fresh-install
checks for Claude/Codex/Cursor and the available new-session host smokes.

MCP登録はGrokも含めて確認する。`caveat init`を隔離した設定先で二度実行し、Claude / Codex /
Grokの公開CLIによる読戻し、CursorのJSON、登録したcommandによるMCP接続と検索を確認する。
既存の環境変数・timeout・無効化指定・別サーバーが保持され、不正な既存設定は変更されず失敗すること。

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
that same tarball. Publish from `apps/cli` with pnpm; direct `npm publish` is
forbidden because it can leave `workspace:*` strings in the packed manifest.
Derive the release version from that package manifest in the same shell used
for the remaining release commands.

```bash
VERSION=$(node -p "require('./apps/cli/package.json').version")
corepack pnpm check:docs
corepack pnpm check:npm-pack
```

Commit and push `main`, then wait for that commit's CI. The CLI's
`prepublishOnly` gate requires a clean release commit that is already an
ancestor of `origin/main`, so both the publish dry-run and the real publish
must run only after this landing step. Once CI is green, verify the publish
payload, create and push the annotated tag, then publish:

```bash
git status --short --branch
git push
gh run list --commit "$(git rev-parse HEAD)" --limit 5
corepack pnpm --dir apps/cli publish --dry-run --no-git-checks
git tag -a "v$VERSION" -m "v$VERSION"
git push origin "v$VERSION"
corepack pnpm --dir apps/cli publish --no-git-checks
```

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

Use a temporary `HOME` so the user's real Claude/Codex/Cursor config is not modified.

```bash
original_home=${HOME:?}
original_user=${USER:?}
original_logname=${LOGNAME:?}
root=$(mktemp -d)
prefix="$root/npm"
home="$root/home"
mkdir -p "$prefix" "$home"
export HOME="$home"
export PATH="$prefix/bin:$PATH"
export CODEX_HOME="$home/.codex"
export CURSOR_DIR="$home/.cursor"
mkdir -p "$CURSOR_DIR"

npm install -g "caveat-cli@$VERSION" --prefix "$prefix"
caveat init
caveat codex-hook install --codex-home "$CODEX_HOME"
caveat codex-hook diagnostics --codex-home "$CODEX_HOME"
caveat cursor-hook install --cursor-dir "$CURSOR_DIR"
caveat cursor-hook diagnostics --cursor-dir "$CURSOR_DIR"
```

Verify generated config:

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

Run each install twice and require `unchanged` on the second run. Run each
uninstall and require zero remaining Caveat hook entries. Cursor has no
repository-owned live-session smoke harness; its release gate is the focused
installer/adapter tests plus this packed-package install/diagnostics smoke.

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

## Codex Sidecar Advisory Smoke

Run this after the new Codex session smoke, using the same temporary `HOME` and
`PATH`, but set `CODEX_HOME` to the canonical real Codex home. The temporary
`auth.json` symlink above is accepted by the raw Codex CLI smoke, while
`codex-sidecar` intentionally opens its canonical auth source with
`O_NOFOLLOW` before taking a durable snapshot. Passing the symlinked temporary
home must fail closed with `ELOOP`; do not work around that check by copying
auth material. This proves the Caveat hook advisory path reaches
`codex-sidecar`, starts Codex App Server with the `advisory` preset, and binds
the exact bounded hook-signal block to the matched `turn/start` request and
completed turn in the raw App Server log.

`codex-sidecar` must be installed on `PATH`, or `CAVEAT_CODEX_SIDECAR_COMMAND`
must point at the command to use.

```bash
repo=$(git rev-parse --show-toplevel)
CODEX_HOME="$REAL_CODEX_HOME" node "$repo/scripts/codex-sidecar-advisory-smoke.mjs" \
  --repo "$repo" \
  --surface stop \
  --caveat-command caveat \
  --codex-sidecar-command "${CAVEAT_CODEX_SIDECAR_COMMAND:-codex-sidecar}"

CODEX_HOME="$REAL_CODEX_HOME" node "$repo/scripts/codex-sidecar-advisory-smoke.mjs" \
  --repo "$repo" \
  --surface tool-error \
  --caveat-command caveat \
  --codex-sidecar-command "${CAVEAT_CODEX_SIDECAR_COMMAND:-codex-sidecar}"
```

Development path equivalent:

```bash
repo=$(git rev-parse --show-toplevel)
: "${CAVEAT_CODEX_SIDECAR_NODE_CLI:?set this to the development codex-sidecar dist/index.js}"
corepack pnpm smoke:codex-sidecar-advisory -- \
  --repo "$repo" \
  --surface stop \
  --caveat-node-cli "$repo/apps/cli/dist/index.js" \
  --codex-sidecar-node-cli "$CAVEAT_CODEX_SIDECAR_NODE_CLI"

corepack pnpm smoke:codex-sidecar-advisory -- \
  --repo "$repo" \
  --surface tool-error \
  --caveat-node-cli "$repo/apps/cli/dist/index.js" \
  --codex-sidecar-node-cli "$CAVEAT_CODEX_SIDECAR_NODE_CLI"
```

The script writes a JSON summary with the verified `rawEventLogRef`. Temporary
diagnostics and pending reminder files are removed after success unless
`--keep-temp` is passed; they are always kept on failure.

Expected:

- Diagnostics report `modelPolicy.source: "explicit"`.
- `normalizedRequest.model` is `gpt-5.6-luna`.
- `normalizedRequest.modelReasoningEffort` is `low`.
- The hook pending reminder contains `[caveat:codex-sidecar] Codex advisory:`.
- Both `stop` and `tool-error` surfaces complete independently.
- The hook pending reminder does not contain `advisory unavailable`.
- The raw App Server log contains startup args for `model="gpt-5.6-luna"` and
  `model_reasoning_effort="low"`.
- The raw App Server `thread/start` response reports `model: "gpt-5.6-luna"`
  and `reasoningEffort: "low"`.
- The matched outbound `turn/start` text contains exactly one canonical
  `caveat-hook-signal` block for the selected surface.
- The matched `turn/start` text contains none of the raw error/transcript
  sentinels or the synthetic session ID.
- The `turn/start` response and retained `turn/completed` event bind to the
  same thread and turn IDs.

## New Claude Session Smoke

Use Haiku for cost control. Keep the fresh-install package, settings, MCP config,
and `CAVEAT_HOME` under the temporary release root, but retain the invoking
Claude user's `HOME`/`USER`/`LOGNAME`: an isolated `HOME` cannot reuse the
user's keychain authentication. This is a release-only human smoke; CI runs
the separate fake CLI contract test and never invokes real Claude.

```bash
repo=$(git rev-parse --show-toplevel)
mkdir -p "$root/caveat-home"
HOME="$original_home" USER="$original_user" LOGNAME="$original_logname" node "$repo/scripts/claude-fresh-session-smoke.mjs" \
  --settings "$home/.claude/settings.json" \
  --mcp-config "$home/.claude.json" \
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
