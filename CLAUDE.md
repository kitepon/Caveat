# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクトの状態

**v0.19.0**。Claude Code、Codex、Cursorのnative integrationとGrokを含むMCP登録を持つ。runtime error収集は
既存の`~/.caveatrc.json`で明示的に有効化し、製品文書とrelease gateはCaveat自身が所有する。

**`docs/00_overview.md` が文書の入口、`docs/01_plan.md` が現行の製品契約**。
通常作業ではoverviewの「現行」だけを読む。過去versionの変更履歴は
[`CHANGELOG.md`](CHANGELOG.md)、完了plan・handoff・監査・release ledgerは[`docs/archive/`](docs/archive/)を
正とし、必要な時だけ参照する。Caveatは単独でinstall、設定、診断、復旧、更新、releaseできる
状態を保ち、dotagentsを製品制御の依存先にしない。

## コマンド

pnpm 10.0.0 が `packageManager` で pin。pnpm 10 はビルドスクリプトをデフォルトブロック、ホワイトリストは root `package.json` の `pnpm.onlyBuiltDependencies`。CLI パッケージ名は `caveat-cli`（bin は `caveat`）、他の workspace パッケージは `@caveat/core` / `@caveat/mcp` / `@caveat/web`。

**rootのscript（`check:release-smoke` / `check:npm-pack` / `eval:*`など）はCorepack経由で実行できる**。内部の`scripts/pnpm.mjs`は、明示した`CAVEAT_PNPM_BIN`、Corepack、PATH上の`pnpm`、`npx pnpm@10.0.0`の順で選ぶ。CIも`corepack pnpm <script>`を正規入口とし、`packageManager`でpinした10.0.0を使う。`CAVEAT_PNPM_BIN`にpin外の実行ファイルを指したり、`--pm-on-fail=ignore`で版の不一致を黙らせたりしない。

```sh
corepack pnpm install                              # workspace 依存をインストール
corepack pnpm --filter @caveat/core test           # core tests（181 tests）
corepack pnpm --filter @caveat/core build          # tsup + schema.sql / migrations を dist へコピー
corepack pnpm --filter caveat-cli test             # CLI smoke + installer tests（32 tests）
corepack pnpm --filter caveat-cli build            # CLI ビルド（bundle + workspace deps noExternal + dist/caveat.js 生成）
corepack pnpm --filter @caveat/mcp test            # MCP tool-handler tests（8 tests）
corepack pnpm --filter @caveat/web test            # Web tests（17 tests）
corepack pnpm -r build                             # 全 workspace パッケージをビルド
corepack pnpm check:docs                          # 現行索引・archive link・未解決marker・固定pathを検査
node scripts/pnpm.mjs eval:hook-search             # private golden による hook 検索 characterization
node scripts/pnpm.mjs prepare:proposal-review      # local-only masked review packet を生成
node scripts/pnpm.mjs prepare:proposal-execution   # local-only execution plan を生成（モデル未呼出し）
node scripts/pnpm.mjs run:proposal-execution       # 承認済み plan を実行し terminal receipt を生成
node scripts/pnpm.mjs test:proposal-execution      # fake CLI だけで execution harness をE2E検証
node scripts/pnpm.mjs prepare:proposal-execution-review # completed outcomeだけのmasked review packetを生成
node scripts/pnpm.mjs eval:proposal-execution      # 全plan分母のexecution-aware評価を集計
node scripts/pnpm.mjs eval:proposal-quality        # local-only masked judgment artifact を検証・集計

# ローカルで配布形態をテスト:
cd apps/cli && corepack pnpm pack                  # caveat-cli-0.x.y.tgz を生成
npm install -g ./caveat-cli-0.5.0.tgz              # 別シェル/別ホストでも同様
caveat init                                        # ~/.caveat/ を scaffold + Claude Code 連携
caveat uninstall                                   # Claude 連携を戻す（~/.caveat/ は残す）

# ビルド済みバイナリの直接実行（リポジトリ内デバッグ用）:
node apps/cli/dist/caveat.js <subcommand>          # 警告抑制ラッパ経由
node apps/cli/dist/caveat.js serve --port 4242     # Web ポータル
node apps/cli/dist/caveat.js mcp-server            # MCP stdio（手動テスト時）
```

`caveat init`はCLIまたは設定ディレクトリがあるCodexと設定ディレクトリがあるGrok・CursorのMCP登録も所有する。
登録は`apps/cli/src/mcpInstall.ts`に集約し、NodeとCLIの実行パスを使う。既存の環境変数、
timeout、無効化指定、他の登録を保持し、バックアップと読戻しを行う。登録失敗は非0終了する。
`CODEX_HOME` / `GROK_HOME` / `CURSOR_HOME` / `CLAUDE_CONFIG_DIR`を尊重する。

単一テストファイル: `corepack pnpm --filter @caveat/core exec vitest run tests/env.test.ts`
単一 describe/it: `corepack pnpm --filter @caveat/core exec vitest run tests/env.test.ts -t "envMatch"`

### 評価レーンの分離

検索精度とモデル行動を同じ指標へ混ぜない。`eval:hook-search` は query から関連 entry を
返せるかを測る offline retrieval characterization、`eval:proposal-quality` は固定 scenario と
固定 reminder の control / caveat 成果物を masked review で検証・集計する
offline self-attested proposal artifact aggregator である。
後者は host / model / policy ごとに分離し、known-bad claim rate と valid solution rate を同時に
測る。live task の warning holdout や raw transcript の常時保存は行わず、online effectiveness は
提示・回答・訂正・結果を結ぶ同意済み観測が実装されるまで名乗らない。
assignment manifest は割付の内部整合性を再計算するが事前登録時刻までは証明しないため、
pre-run digest を外部固定していない値を因果効果とは呼ばない。execution-provenance harness は
request bytes、condition envelope、provider run ID、model provenance、terminal receiptを保存・検証し、
execution-aware compilerは全planを分母へ入れる。ただしprovider署名や外部timestampは持たないため、
結果はbounded offline characterizationとして扱い、実利用全体へ一般化しない。

proposal evaluation artifact は knowledge repo ではなく
`<caveatHome>/local-eval/proposal/{scenarios,policies,assignments,trials,review-packets,judgments}.jsonl` に置く。runner は親 directory `0700`、
file `0600` を fail-closed で要求し、stdout へは digest と集計だけを出す。契約と非目標は
[docs/archive/08_proposal_effectiveness_eval.md](docs/archive/08_proposal_effectiveness_eval.md) を正とする。

Project-local `.claude/settings.json` は端末固有の permission allowlist なので repo には作らない。必要な場合は Claude Code の fewer-permission-prompts 生成手順でローカル作成し、既存の `**/.claude/` ignore のまま管理する。

## アーキテクチャ

**`markdown-in-git` が真実の源**。SQLite は再構築可能な派生 FTS5 インデックスで `<caveatHome>/index/caveat.db`（gitignore）。SQLite DB を権威扱いしない — 必ず markdown から再生成できる状態を保つ。

**単一 repo**: v0.5 から tool 本体と共有ナレッジ DB を本 repo に統合（`entries/` が共有 DB 本体）。ユーザ個人の repo は `<caveatHome>/own/`（`~/.caveat/own/`）、`~/.caveatrc.json` の `knowledgeRepo` で絶対パス上書き可。個人の絶対パスを tool repo に書かない。

**caveatHome の解決**: `findCaveatHome(userHome)` → `process.env.CAVEAT_HOME ?? join(userHome, '.caveat')`。NPM グローバルインストール時、tool の実体は `node_modules/caveat-cli/` に置かれるが、**ユーザーデータ（DB・own repo）は常に `~/.caveat/` 側**。テストは `CAVEAT_HOME` override で一時ディレクトリに隔離する。

**runtime error収集**: opt-inの正本は既存`~/.caveatrc.json`の`runtimeErrors: boolean`（既定false）だけ。状態はPOSIXの`$XDG_STATE_HOME/caveat/runtime-errors.json`またはWindowsの`%LOCALAPPDATA%\caveat\runtime-errors.json`へ置き、外部productのconfigを読まない。公開するsnapshot / diagnostics JSON shapeは`packages/core/src/runtimeErrors.ts`が所有する。

**source 名前空間**: 全行が `source ∈ {'own', 'community/<handle>'}` を持つ。PK は `(source, id)` 複合 — community 取り込みで `own` と衝突しないための必須条件。`packages/core/src/schema.sql` 参照。

**FTS5 はトリガ経由で同期**: `entries_fts` は `entries.rowid` に対する external-content。`schema.sql` の 3 トリガ（ai/ad/au）が FTS を同期する。インデクサコードは `entries_fts` を直接触らない — `entries` への UPDATE/INSERT/DELETE のみ。

**インデクサの意味論**: `scanSource(db, source, entriesRoot)` は 1 source ずつ走査し、タッチした rowid の TEMP table を経由して**その source 内の**未タッチ行のみ削除する。全 source を 1 パスで走査すると他 source を巻き込んで削除するので絶対にしない。

**単一ファイル upsert 経路**: `upsertEntry(db, row)` は `caveat_record` / `caveat_update` の md 書き込み後に同期呼びする。MCP ツールは必ず同一プロセスで同期呼びしないと、直後の `caveat_search` で新規行が拾えない。

## FTS5 クエリのサニタイズ（Phase 9 で追加）

- `repository.ts` の `search()` は内部で `sanitizeFtsQuery` を呼び、user-provided query の**非英数・非 CJK 文字を空白に置換してから各トークンを `"..."` で quote** する
- これで `node:sqlite` / `node.js` / `a+b*c` 等の FTS5 operator に該当する文字を含むクエリでも死なない
- 代償: FTS5 の高度な演算子（`NEAR`, `OR`, `-negative` 等）は使えない。v1 は全部シンプルな phrase AND 扱い
- 必要になったら `search({ query, raw: true })` を追加して生クエリパスを開ける（v1 には入れない）

## スタック固有の罠（Phase 2/3 で検証済、Phase 12 で bundle 側も解決）

- **DB は `node:sqlite`（builtin、Node 22.5+）** — `better-sqlite3` ではない。MSVC の無い Windows ではネイティブビルド不能、かつ `better-sqlite3` 12.x は Node 24 prebuild 未提供。`node:sqlite` はプロセスごとに `ExperimentalWarning` を 1 回出す（stderr、1 行）。CLIは[ビルド設定](apps/cli/tsup.config.ts)が生成する`dist/caveat.js`を経由する — 静的 import を持たず、`process.removeAllListeners('warning')` + カスタムハンドラで SQLite 警告だけ抑制してから `import('./index.js')` で本体をロード。ESM import 巻き上げを回避するため **同一モジュール内の banner では抑制できない**。MCP サーバは stdout に JSON-RPC 以外を書けないので spawn 時に `--disable-warning=ExperimentalWarning` も併用する（belt & suspenders）。
- **`packages/core` は `tsup` を `bundle: false` で使う**。bundle すると esbuild が dist 出力時に `node:` プレフィクスを剥がす（例: `from 'node:sqlite'` → `from 'sqlite'`）。bundle せず `entry: ['src/**/*.ts']` でファイル個別出力にすると prefix が保持される。
- **`apps/cli` は `tsup` を `bundle: true` + `noExternal: ['@caveat/*']` + onSuccess で `node:` プレフィクスを復元**（`NODE_BUILTINS` を全走査して `from "fs"` → `from "node:fs"` など regex 置換）。CJS 依存（gray-matter）のため banner で `createRequire` shim を注入。`schema.sql` + `migrations/` も onSuccess で `dist/` にコピー。
- **vitest 4 + vite 7 必須**。vitest 2 + vite 5 は `node:sqlite` の import を解決できない（`node:` プレフィクスを剥がす）。
- **FTS5 trigram は 3 文字以上のクエリが必要**。日本語 2 文字（例: `仕様`）はヒットしない。ドキュメント化済の仕様なので、クエリの事前バリデーションは足さない。
- **gray-matter の YAML エンジン**は `jsyaml.JSON_SCHEMA` に固定。`!!js/function` 等の unsafe タグはパース時に throw する想定（`tests/frontmatter.test.ts` で検証済）。

## OS依存・ホスト依存の分離規約（2026-08-23 リファクタ）

- **`process.platform` / `win32` の分岐を書けるのは [packages/core/src/platform.ts](packages/core/src/platform.ts) だけ**（テストのスキップ条件と、telemetry 用の値変換 `normalizeOs` は除く）。owner-only 所有判定・PowerShell call prefix・node 実行ファイル名・パス case 正規化はここの関数を使う。全関数は `platform` を引数で受けてテスト可能
- **Claude / Codex / Cursor 各インストーラの共通ヘルパは [apps/cli/src/installShared.ts](apps/cli/src/installShared.ts)**（`resolveAgentConfigPaths` / `quoteCommandPath` / `commandTokens` / `isCanonicalAsset` / backup付き書込）。設定先の解決は初期化・解除・診断で共有し、設定形式の差は各installerと`mcpInstall.ts`が所有する。
- **hook のベンダー中立エンジンは [apps/cli/src/hookShared.ts](apps/cli/src/hookShared.ts)**。`HookHost` 設定（agent / stderrTag / errorCode / stop-state dir / dedupe key）で Claude / Codex / Cursor を切り替え、stdin 処理・DB 検索（markHit / query-miss log 込み）・pending drain / compact・stop 重複抑止を 1 実装で共有する。各host commandに残るのは出力形式・payload 解釈・reminder 本文組み立て・worker 方式だけ
- 片方のホスト / OS を直す時は、共有モジュール側を直せば両方に効く。共有モジュールを迂回して cmd ファイルに同種ロジックを再複製しない

## Import 規約

- ESM、tsconfig は `"module": "NodeNext"`。**ソース間の相対 import は `.ts` ファイルでも `.js` 拡張子を書く**（例: `import { parseMarkdown } from './frontmatter.js'`）。vitest/vite と tsup の双方で正しく解決される。
- `@caveat/core` の公開 API は `packages/core/src/index.ts` 経由。
- ランタイムアセット（`schema.sql`, `migrations/`）は `db.ts` から `fileURLToPath(import.meta.url)` で相対解決。`tsup.config.ts` の onSuccess でビルド時に `dist/` へコピー。

## ロギング

MCP stdio サーバは stdout に JSON-RPC 以外を書いてはいけない。`packages/core/src/db.ts` は `stderrLogger` を export しているのでこれを使う。CLI プロセスでは stdout で可（`apps/cli/src/logger.ts` の `stdoutLogger`）。プロセスのエントリで適切なロガーを注入する。

## CLI の構造（Phase 3 / Phase 12 で拡張）

- コマンドは `apps/cli/src/commands/<name>.ts` に 1 ファイル 1 コマンド。`CliContext`（`context.ts`）経由で `caveatHome` / `userHome` / `config` / `paths` / `logger` を注入
- **`buildContext(logger, { caveatHome?, userHome? })`** — テストで `caveatHome` と `userHome` を override して一時ディレクトリに閉じる。本番実行では override なしで `findCaveatHome(userHome)`（`CAVEAT_HOME` env か `~/.caveat`）と `homedir()` を使う
- Phase 12 で追加されたサブコマンド:
  - `caveat mcp-server` — `@caveat/mcp` の `startMcpStdioServer()` を呼ぶ。Claude Code から spawn される
  - `caveat hook <user-prompt-submit|stop>` — `@caveat/core` の `claudeHooks.ts` を使って stdin JSON を読み、該当時のみ `<system-reminder>` を stdout に出す
  - `caveat init [--skip-claude] [--dry-run]` — Claude Code に MCP + hooks を登録（詳細下）
  - `caveat uninstall [--dry-run]` — 登録を解除
- v0.11 で追加されたサブコマンド:
  - `caveat stale [--days N] [--visibility public|private] [--limit N]` — 最後に検索で拾われてから N 日（default 90）経ったエントリを一覧。埋もれた private の月次点検用途
- **`paths.ts` / `config.ts` は `packages/core`**。`import { findCaveatHome, loadConfig, resolvePaths, ... } from '@caveat/core'`（旧 `findToolRoot` / `loadConfigFromPaths` は削除済）
- **default 設定は `packages/core/src/config.ts` 内の `DEFAULT_CONFIG` 定数**。`config/default.json` は Phase 12 で削除。`knowledgeRepo` default は `'own'`（caveatHome 相対）

## community 取り込み（Phase 8）

- [packages/core/src/community.ts](packages/core/src/community.ts) に全ロジック集約。CLI と Web UI から共用
- **URL validation**: `^https://github\.com/<org>/<repo>(\.git)?\/?$` 固定、gitlab・ssh・http は拒否。v1 は GitHub 限定
- **handle 抽出**: URL の repo 名部分。`.git` サフィクスと末尾スラッシュを除去。衝突時は `-2, -3, ...` で一意化（`caveat_record` の id slug と同じパターン）
- `caveat community add <url>` → `simpleGit().clone(url, target, ['--depth', '1'])` で shallow clone
- `caveat community pull` → `community/<handle>/` 各ディレクトリで `simpleGit(path).pull()`。失敗は `{ status: 'failed', message }` で収集（途中で落とさない）
- `caveat community list` → DB の `source = 'community/<handle>'` カウントと合わせて表示
- **community 取り込みと index は別コマンド**: add/pull した後は明示的に `caveat index` を呼んで FTS 同期する（01_plan.md の一方向フロー原則）

## Web の構造（Phase 5）

- [apps/web/src/routes/](apps/web/src/routes/) に 1 ルート 1 ファイル（`index.ts` = list + search / `detail.ts` = `/g/:id` / `community.ts` = community repo 一覧）
- [apps/web/src/app.ts](apps/web/src/app.ts) が Hono アプリを組み立て、[apps/web/src/server.ts](apps/web/src/server.ts) が `@hono/node-server` で listen する `startServer(opts)` を export
- [apps/web/src/wikilinks.ts](apps/web/src/wikilinks.ts) は markdown-it の **inline ルール拡張**（`md.inline.ruler.before('emphasis', 'wikilink', ...)`）。`[[slug]]` と `[[slug|label]]` を `<a href="/g/<encoded-slug>" class="wikilink">label</a>` に展開。外部 npm パッケージ非採用
- [apps/web/src/layout.ts](apps/web/src/layout.ts) に全 HTML と CSS。ビルドレス（no JSX、template literal）
- **read-only 原則**: `/new` や `/g/:id/edit` の書き込みエンドポイントは**持たない**。編集は Obsidian または md 直接編集 → `caveat index` で DB 同期
- CLI の `caveat serve --port 4242` が `@caveat/web` の `startServer` を直接呼ぶ（spawn ではなく同プロセス）

## MCP の構造（Phase 4）

- 6 tools が [apps/mcp/src/tools/](apps/mcp/src/tools/) に 1 ファイル 1 ツール（`search` / `get` / `record` / `update` / `listRecent` / `pull`）。v0.7 で `push` を削除、v0.6 で NLM 2 tools (`nlm_brief_for` / `ingest_research`) を `caveat_record` の薄いラッパとして削除済
- 各 tool ファイルは zod の `inputShape`（`ZodRawShape`）と `handleXxx(ctx, args)` を export
- [apps/mcp/src/registerTools.ts](apps/mcp/src/registerTools.ts) が `McpServer#registerTool` に全 tool を接続。戻り値は `JSON.stringify(data, null, 2)` を `content[0].text` で返す統一形
- [apps/mcp/src/server.ts](apps/mcp/src/server.ts) が stdio エントリ。`buildMcpContext()` で `stderrLogger` 注入（stdout は JSON-RPC 専用）。SIGINT/SIGTERM で `db.close()`
- **MCP の書き込み系ツール（`caveat_record` / `caveat_update`）は `@caveat/core` の `recordEntry` / `updateEntry` を呼ぶ**。core が md 書き出し + 同プロセス upsert を一体で行うので、直後の `caveat_search` で新規行が拾える
- **visibility の自動分類（v0.11）**: `caveat_record` / `caveat_update` の `visibility` は zod description の二項基準（第三者再現性）で Claude が自動判定する。v0.6.2 の「必ずユーザに聞け」は廃案。ユーザ明示依頼（「これは private で記録して」等）は自動判定に優先
- **visibility 3 択絞り込み（v0.11）**: `caveat_search` の `filters.visibility` に `'public' | 'private' | 'all'` を expose。省略時は全部。Hook 発の自動 surface はフラットのまま（絞らない）で、Claude が自発的に狙い撃ちしたい時のみ narrow する用途

## last_hit_at と caveat stale（v0.11、schema v2）

- `entries.last_hit_at TEXT`（nullable）を v2 で追加。検索で拾われるたびに ISO timestamp で UPDATE される
- **検索は pure、markHit で副作用分離**: [packages/core/src/markHit.ts](packages/core/src/markHit.ts) の `markHit(db, keys: Array<{id, source}>)` が時刻更新のみ担当。`search()` / `findCaveatsForPrompt()` 本体は副作用なし
- 呼び出し元: [apps/cli/src/commands/hookCmd.ts](apps/cli/src/commands/hookCmd.ts) の `searchCaveatsFromTextSafely` と [apps/mcp/src/tools/search.ts](apps/mcp/src/tools/search.ts) の `handleSearch` が検索結果が 0 件超の時のみ markHit を呼ぶ
- **migration 002**: 既存 v1 DB は `packages/core/src/migrations/002_last_hit_at.sql` の `ALTER TABLE entries ADD COLUMN last_hit_at TEXT` で自動 v2 化
- **`caveat stale` CLI**: [apps/cli/src/commands/stale.ts](apps/cli/src/commands/stale.ts) が `listStale(db, { days, visibility, limit })` を呼び出す。デフォルト 90 日、`--visibility private` で private だけに絞れる。月次点検で埋もれた private を発見する用途

## tsup / esbuild の罠

- **`packages/core` と `apps/mcp` は `bundle: false` + `entry: ['src/**/*.ts']`**。bundle すると esbuild が `node:` プレフィクスを dist 出力で剥がす（例: `from 'node:sqlite'` → `from 'sqlite'`）。`node:sqlite` は bare 名前では解決不能なので、consumer 側（vitest 4 / workspace 別パッケージ）で `Cannot find package 'sqlite'` として破綻する。bundle せずファイル個別出力にすれば保持される
- **`apps/cli` は Phase 12 で `bundle: true` + `noExternal` で workspace deps を吸収**。esbuild の prefix 剥がしは onSuccess の post-process で `NODE_BUILTINS` を regex 置換して復元。CJS 依存（gray-matter）は banner で `createRequire(import.meta.url)` を inject
- **`apps/cli` は workspace deps を「src ではなく各パッケージの `dist`」から bundle する**。`@caveat/core` と `@caveat/mcp` を直したら **core → mcp → cli の順で全部ビルドし直す**。`apps/mcp` の build を飛ばすと CLI は古い MCP を bundle し、typecheck も test も通るのに実行時だけ挙動が古いまま——という無症状の失敗になる（`corepack pnpm -r build` なら依存順で解決）。疑ったら `grep -c <新シンボル> apps/cli/dist/index.js` で bundle の実物を見る

## Claude Code 統合（Phase 10 で初期実装、Phase 12 でインストーラ化）

- **MCP サーバ**: `~/.claude.json`（`CLAUDE_CONFIG_DIR`指定時はその直下の`.claude.json`）。製品のinstallerがuser設定をマージする。`settings.json`には書けない（schema validationで`mcpServers`がrejectされる）。
- **Hooks**: `~/.claude/settings.json` の `hooks.UserPromptSubmit` / `hooks.PostToolUse` / `hooks.PostToolUseFailure` / `hooks.Stop` に throughline 等と並ぶ形で**既存エントリを保持したまま追記**
- **`caveat init`** ([apps/cli/src/claudeInstall.ts](apps/cli/src/claudeInstall.ts)) が自動で両方を設定:
  - MCP: `mcpInstall.ts`が`command: <nodePath>`と`args: ["--disable-warning=ExperimentalWarning", <cliScriptPath>, "mcp-server"]`をuser設定へマージする。既存の環境変数を保持し、同一内容なら書き換えない。
  - Hooks: `settings.json` を read → `hooks.UserPromptSubmit` / `hooks.PostToolUse` / `hooks.PostToolUseFailure` / `hooks.Stop` に `node <cliScriptPath> hook <name>` を upsert → write（**書き込み前に `settings.json.caveat-backup-<ts>` を作成**）
  - `cliScriptPath` は `process.argv[1]`（NPM global install 時は `%AppData%/npm/node_modules/caveat-cli/dist/caveat.js`）
- **冪等性**: 既に同 command の hook エントリがあれば skip。重複追加しない
- **テスト**: `apps/cli/tests/claudeInstall.test.ts`の`skipMcpRegistration: true`はMCP設定変更を省略する。MCPのマージ・保持・解除は隔離した設定先で検証する。
- **uninstall**: `caveat uninstall`はClaudeのMCP登録とhookだけを削除する。Claude CLIなしでも設定を直接更新し、他の登録を保持して読戻す。解除失敗は非0終了。`--dry-run`では書き込まない。

## Hook 規約

- **必ず `exit 0`**。stdin の JSON パースエラーでも exit 0 + stderr にログだけ。
- **stdout**: `<system-reminder>[caveat] ...</system-reminder>` を**発火時のみ**最大 1 ブロック出す。複数 pending reminder は 1 block 内で compact / dedupe して結合する。非発火時は**完全無音**（token 節約）。それ以外の文字は書かない。
- **stderr**: 診断情報のみ。
- 既存の `throughline` hook（UserPromptSubmit / Stop）と並走する前提。

### Claude Code Hook の実装（Phase 6 / Phase 12 / v0.8 / v0.12 / v0.13）

- **現行ロジック**: [packages/core/src/claudeHooks.ts](packages/core/src/claudeHooks.ts) に `extractPromptCandidates` / `findCaveatsForPrompt` / `findCaveatsForHook` / `defaultSelfIdentityTokens` / `userPromptSubmitReminderText(hits)` / `stopReminderText` を集約。`findCaveatsForPrompt` はUserPrompt互換、`findCaveatsForHook`は`topicText` / `failureText` / `surface`の出所を保持するhook専用入口。CLI サブコマンド `caveat hook <name>` ([apps/cli/src/commands/hookCmd.ts](apps/cli/src/commands/hookCmd.ts)) が stdin + caveatHome を組み合わせて DB を開き、結果を埋め込んだリマインダを stdout に出す。stdout は host contract に合わせ、Claude では最大 1 `<system-reminder>` block、Codex では単一 JSON object
- **事前発火（UserPromptSubmit）の判定**: プロンプトを token 列に分解 → 各 token を個別に FTS5 phrase 検索 → **3 段の構造的ゲートを全て通過した entry のみ** を hit とみなす:
  1. **共起ゲート**: 1 entry あたり ≥ 2 個の distinct prompt **グループ** (= 空白区切り source token、CJK 連続 run も 1 グループ) が一致
  2. **症状特異語ゲート (v0.12)**: マッチした prompt token のうち最低 1 つが entry の `symptom_text` に出現
  3. **rare topical-anchor ゲート (v0.14.2)**: `topical_text` に出現した prompt token のうち最低 1 つが「prompt 内で corpus DF が最小タイ」のもの
  
  hit ≥ 1 のときのみ発火、DB ヒットをそのままリマインダ本文に埋めるので、Claude が改めて `caveat_search` を呼ばずともコンテキストに関連罠が入る
- **Tokenize 規則** (`extractPromptCandidates` / `buildPromptCandidates` 内、v0.12 拡張):
  - **パス様部分文字列を最初に剥がす**: UNC (`\\\\host\\path`) / Windows drive (`C:\\path`) / POSIX abs (`/x/y/z`) を空白化。URL は preserve (`://` の `/` は whitespace 始まりじゃないので非マッチ)
  - 非英数・非 CJK 文字を空白に置換 → 空白 split
  - ASCII 単語は ≥ 3 文字のみ（`the` / `on` 等は自動脱落するが `make` / `new` / `what` は残す — 共起ルールで無害化）
  - CJK run は 3-char sliding window に展開（`初期化失敗` → `初期化`, `期化失`, `化失敗`）+ **純ひらがな trigram は drop** (`してる`, `のまま` 等は conjugational glue)
  - 同一 source token から派生した複数 trigram は **同じ group id を共有** (CJK 句単位 dedup)
  - Case-insensitive dedup → 先頭 50 token 上限
- **症状特異語 / rare topical-anchor の構造的根拠 (v0.12 / v0.14.2)**: 共起だけでは「固有名詞の偶然一致」を捕まえる (`RTX 5090` がたまたま 2 entry の title に出る → 2-of-N 成立)。これは「話題に触れただけ」であって「困っているか」「何が起きているか」までは何も言っていない。`## Symptom` セクションは entry 構造で「何がどう壊れるか」と定義されているので、**prompt と Symptom の重なりは「ユーザーがその失敗状態を述べている」ことの構造的根拠**。ただし長い症状文には「正常に動く」「誤発火」など会話断片も混ざるため、それだけで主題判定まで兼ねてはいけない。`topical_text` (title + tags + environment 値) は著者が能動的にキュレートした主題語なので、**rare anchor は topical_text 側で要求する**。これにより「何が壊れたか」と「何についての罠か」を両側独立に満たした時だけ発火する
- **共起ルールが `allowlist` / `stopword list` を代替する理由**: 旧設計は (a) keyword allowlist（Phase 6、罠ドメインを regex で列挙）→ recall 低い／メンテ永遠、(b) v0.8 初案の stopword list（`make` / `new` を hand-curate） → リスト化自体が構造欠陥、と辿った。2-of-N co-occurrence + 症状特異語 + rare topical-anchor は **全てリスト不要、閾値チューニング不要** (唯一の数値定数は 2-of-N の `2`)、Unicode 範囲・FTS5 仕様・`os.userInfo()`/`homedir()` runtime 値・corpus DF だけで判定。**「list で除外する」のではなく「構造で要求する」** が設計の肝
- **`defaultSelfIdentityTokens()` (v0.12)**: `os.userInfo().username` と `os.homedir()` の path 成分 (≥ 3 文字) を Set で返す runtime-derived 関数。CLI hook 呼び出し側が `findCaveatsForHook(..., { selfIdentity: defaultSelfIdentityTokens() })` へ渡す。**ツールブランド `caveat` は意図的に含めない** — ハードコードリスト化を避け、rare-anchor gate が「caveat は corpus 全域で高 DF」として構造的に弾くのに任せる
- **hookCmd の DB 接続**: `buildContext(silentLogger)` で caveatHome 解決 → `existsSync(ctx.paths.dbPath)` で DB 未作成時は即 silent（false-block 回避）→ `openDb` → `findCaveatsForHook` → 必ず `db.close()`
- **事後発火（Stop hook）の判定** (v0.9): `payload.transcript_path` の JSONL を `readSessionSignals` ([packages/core/src/transcriptSignals.ts](packages/core/src/transcriptSignals.ts)) で解析し、以下のシグナルを抽出:
  - `toolFailureCount`: `is_error: true` を返した tool_result の件数
  - `fileEditCounts`: Edit/Write/NotebookEdit の file_path 集計（count > 1 のみ）
  - `webSearchCount` / `webFetchCount`: 外部仕様調査の跡
  - `bashRetryCount`: 同一 Bash コマンドを複数回実行した種類数（失敗 → 修正 → 再実行 パターン）
  - `durationMinutes`: first / last timestamp から算出（発火ゲートには使わない、表示のみ）
  - `errorSnippets` / `searchQueries`: リマインダ本文 & FTS 用の raw text
- **発火ゲート**: `hasAnyStruggleSignal(s)` = 上記 count のいずれか > 0 or fileEditCounts.length > 0。**閾値チューニング無し**の構造的 or 判定（「0 か 1 以上か」のみ）。tool failure 無・編集 1 回だけ・web 検索無しなら完全無音 → 単純編集セッションでリマインダ洪水を起こさない
- **stop リマインダ本文**: シグナル具体数値を列挙（Y）。既存罠の候補化は各`errorSnippet`を独立した`surface: stop`入力として`findCaveatsForHookSegments`へ渡し、session内の別時点の`searchQueries`や別errorとの語の足し算では発火させない。`searchQueries`はreminder/advisoryの構造化文脈にだけ残す。既存罠に類似があれば`caveat_update`を、なければ`caveat_record`を促す（Z）。Stop hook 自体は stdout に出さず、session pending queue に積んで次の `UserPromptSubmit` / `PostToolUse` で表示する。同一 session / 同一 signal digest は再 enqueue しない
- **Codex sidecar advisory (v0.13)**: `Stop` hook が発火した場合、`CAVEAT_HOOK_CODEX_SIDECAR` が `auto` / `require` なら `caveat codex-sidecar run explore` を同期的に呼び、既存 `stopReminderText` の後ろへ Codex の助言を追記して pending に積む。`auto` は project root に `.codex-sidecar.yml` がある時だけ試す。`off` は pre-v0.13 と同じ本文のみ。失敗時は hidden fallback せず unavailable 行を出す
- **Codex CLI の解決順 (codex-sidecar 側設計)**: codex-sidecar は実行時に `process.env.CODEX_BINARY ?? "codex"` で Codex CLI を解決する。`CODEX_BINARY` が立っていればそのパスを、無ければ PATH 上の `codex` を `spawn` する。**Caveat 側は `caveat init` でこの env を一切書き込まない** — 一般ユーザは `npm install -g @openai/codex` で `codex` を PATH に乗せていれば追加設定不要。VS Code 拡張内のバイナリしか手元に無い等で PATH に乗らない環境のみ、ユーザが自力で `~/.claude/settings.json` のフック行に env プレフィックスを足す必要がある。VS Code 拡張のディレクトリ名はバージョン番号入りで更新ごとに変わるため、絶対パスを書くと拡張更新で advisory が ENOENT で死ぬ。基本は PATH 解決に倒す
- **再帰防止**: `payload.stop_hook_active === true` の場合は stdout 空で即 exit（不変）
- **実行中発火（PostToolUse / PostToolUseFailure hook、v0.10 / v0.14）— 非同期パイプライン**:
  - Claude Code は tool 呼び出し後に PostToolUse 系 hook を同期的に呼び出し、その stdout を次ターンのコンテキストに挿入する。現行 Claude Code の失敗 tool は `PostToolUseFailure` として発火し、payload の `error` field に失敗内容を入れる。成功/通常系互換のため `PostToolUse` も維持する。同期的に FTS を走らせると tool ごとに 150-300ms のレイテンシが乗るので、**前景 hook は drain + worker spawn で ~20ms 返す**。
  - 前景フロー: (1) `drainPendingReminders(caveatHome, sessionId)` で過去 worker / Stop が書いた reminder ファイルを読み、dedupe + 上限で compact して最大 1 `<system-reminder>` として stdout に emit → unlink / (2) `tool_response.is_error === true` または `hook_event_name === 'PostToolUseFailure'` / `error` field があるときのみ、allowlistしたtool名・command/queryを`topicText`、失敗本文を`failureText`としてv2 work fileへ分離保存し、`spawn(node, [cli, 'hook', 'worker', workFile], {detached:true,stdio:'ignore'}).unref()` で detached worker を起動し即 exit
  - 非同期 worker (`caveat hook worker <workFile>`): work file を読んで unlink → `findCaveatsForHook(db, { topicText, failureText, surface: 'tool_error' })` を走らせる。主題anchorは両field、症状根拠は`failureText`だけから採る。hit > 0 なら`toolErrorReminderText(hits)`をpendingへ積み、v0.13以降はsidecarが使える時だけCodex advisoryを末尾へ追記する
  - drain は **UserPromptSubmit / PostToolUse の最初で実行**。Stop hook は final answer 直後の stdout 表示を避けるため drain せず、Stop reminder を pending に積むだけにする
  - pending ファイルはセッション id でディレクトリ分離 ([packages/core/src/pendingReminders.ts](packages/core/src/pendingReminders.ts))。`session_id` は `[^A-Za-z0-9_-]` を strip してサニタイズ、traversal 攻撃を防ぐ
  - 結果として reminder は **エラー発生の次の hook tick で Claude のコンテキストに載る**（最短で次の tool 呼び出し、最悪でも user prompt 直前）。Claude は新しいエラーを見る前後のタイミングで「このエラーは既知罠 XYZ」を認識できる
  - セッション跨ぎの pending 蓄積掃除: [packages/core/src/pendingReminders.ts](packages/core/src/pendingReminders.ts) に 2 段の API を持つ。`cleanupStalePendingDirs(caveatHome, { staleDays })` は `<caveatHome>/pending/<sessionId>/` のうち**そのサブツリー内 (ディレクトリ自身 + 残存 .txt) の最新 mtime が `staleDays` 日以上前**のものを丸ごと削除する純粋関数 (default 7 日、`staleDays=0` は「現在より過去のもの全部」)。drain で空になった殻も、放棄されてファイルが残った墓も同条件で扱う。アクティブセッションは append/drain で mtime が更新され続けるので回収されない。`maybeSweepPendingDirs(caveatHome, { staleDays, debounceDays })` はホットパスから呼ぶデバウンス付きラッパで、`<caveatHome>/pending/.last-sweep` マーカーの mtime を見て `debounceDays` (default 1) 以内なら即 return、初回または期限切れなら `cleanupStalePendingDirs` を呼んでマーカーを更新する。`CAVEAT_PENDING_SWEEP=off` で完全無効化可 (マーカーも触らない)。発火点は 2 つ: (a) `caveat hook stop` 冒頭で `maybeSweepPendingDirs(ctx.caveatHome)` を try/catch で呼ぶ — グローバル install 後ほぼ走らない `caveat init` に依存せず、Stop hook が定期掃除を担う。(b) `caveat init` が belt-and-suspenders で `cleanupStalePendingDirs` を呼ぶ (CLI フラグ `--pending-stale-days <n>` で `staleDays` 上書き可、dry-run 時は予告ログのみ)
- **Phase 6 の legacy `.mjs` ファイル**（`hooks/user-prompt-submit.mjs` と `hooks/stop.mjs`）は v0.11.2 で削除済。NPM 配布した `caveat` コマンド経由では `caveat hook <name>` の新経路だけが使われるため、旧キーワード allowlist 実装の dev-mode 参照は不要になった。`hooks/pre-commit-visibility-gate.mjs` は `.husky/pre-commit` から exec される現役のため残置

### Git pre-commit visibility gate（Phase 7）

- [.husky/pre-commit](.husky/pre-commit) — Husky 9 が `core.hooksPath=.husky` を設定すれば git commit 時に自動発火。内容は `hooks/pre-commit-visibility-gate.mjs` を exec するだけの 1 行
- [hooks/pre-commit-visibility-gate.mjs](hooks/pre-commit-visibility-gate.mjs) — staged `entries/**/*.md` を `git diff --cached --diff-filter=ACMR` で列挙、`git show :<path>` で index 版（working tree でなく）を取得、`@caveat/core` の `findBlockedFiles`（内部で `parseMarkdown`）で frontmatter を解析、`visibility: private` があれば blocked 一覧 + 修正案を stderr に出して exit 1
- **非 git ディレクトリや staged 対象なしは exit 0**。false-block を回避（`feedback_no_unnecessary_fallbacks` の範囲内、必要最小のガード）
- 緊急バイパスは `git commit --no-verify`（git 標準）。カスタム escape hatch は作らない
- `findBlockedFiles(stagedContents)` は v0.11.2 で `@caveat/core/visibilityGate` に移動済。`hooks/pre-commit-visibility-gate.mjs` は core から import して re-export する薄いラッパ。test (`hooks/tests/pre-commit-gate.test.ts`) も `@caveat/core` から import するので、`.mjs` を vitest が直接 transform する経路を取らない（Windows + vitest で日本語含む `.mjs` の transform が `SyntaxError: Invalid or unexpected token` で落ちる CI 問題の構造的回避）

## 自動同期（AutoSync）

**多端末伝播の唯一の経路**。ロジックは [packages/core/src/autoSync.ts](packages/core/src/autoSync.ts) に集約。

- **1 cycle の中身**: `communityPull`（全 community repo を git pull）→ `syncOwn`（commit → `pull --rebase` → push）→ 全 source 再索引。**push と pull は分離できない** — `syncOwn` が必ず往復する 1 セット。前段に匿名可読 probe（remote への HTTP GET）が入る。実測 ~3.5s（community 0 件、own 218 entries、detached background なのでユーザー体感 0）
- **発火点は 2 つ**。どちらも `triggerAutoSync` で detached worker (`caveat hook autosync`) を spawn して即 return する:
  1. **Stop hook** ([hookCmd.ts](apps/cli/src/commands/hookCmd.ts) / [codexHookCmd.ts](apps/cli/src/commands/codexHookCmd.ts)) — `AUTO_SYNC_DEBOUNCE_MS` = **15 分**。定期的に他端末の entry を拾う担当
  2. **MCP の書き込み** (`caveat_record` / `caveat_update`) — `AUTO_SYNC_RECORD_DEBOUNCE_MS` = **60 秒**。登録した罠を即座に private remote へ出す担当。`McpContext.onEntryWritten` 経由（**必須フィールド**。テストが暗黙に実 spawn するのを型で防ぐため optional にしない）
- **デバウンス値の根拠**: 旧 24 時間は送信側・受信側の両方に掛かり、伝播が最悪 48h だった。「別端末で登録した罠が当日中に届かない」は Caveat の価値そのものを殺すので、実測コストが許す範囲まで詰めた。record 起点の 60 秒は rate limit ではなく **burst 吸収の floor**
- **失敗時は backoff であって永久停止ではない**: 同一 code の失敗が `AUTO_SYNC_SUSPEND_THRESHOLD`(3) 回連続すると `AUTO_SYNC_DEGRADED_RETRY_MS`(6h) 間隔へ後退する。**手動 `caveat sync` を待たずに自力で回復する**。degraded 中は `AUTO_SYNC_NOTICE_REPEAT_MS`(24h) ごとに reminder を再送する（旧実装は escalation を 1 回告知した後は完全に無言で永久停止し、伝播が死んだことに誰も気づけなかった）
- **notification signature は「本文」から採る**。`sha256(JSON.stringify(lines))` のみ。内部 field (`disposition` / `suspended`) を混ぜると、同じ意味の状態（6h ごとの再試行失敗 と その間の skip）が別物と判定されて backoff 窓ごとに 2 通飛ぶ
- **env**: `CAVEAT_AUTO_SYNC=off` で全停止。`CAVEAT_AUTO_SYNC_DEBOUNCE_MS` でデバウンス上書き（**不正値は stderr に警告して default へ落とす** — `Number('abc')` = NaN、`elapsed < NaN` は常に false なので、素通しにすると「毎回 spawn」になる）
- **配布の注意**: 伝播は両端末が新版を持って初めて速くなる。片側だけ更新しても、相手が push しなければ pull するものが無い
