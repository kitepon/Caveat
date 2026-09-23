# Private tier 実装計画

> **対応する設計**: [private-tier-design.md](private-tier-design.md)
> **日付**: 2026-04-23
> **状態**: 方針決定済、着手可能

## 方針決定（2026-04-23）

v0.6.2 の「visibility は必ずユーザに聞け、自動分類するな」ルールは **廃案**。
以降は **二項基準で Claude が自動分類 + 迷ったら private + ユーザ明示指示が最優先** を正とする。

波及する更新:

- [apps/mcp/src/tools/record.ts:18-20](../../apps/mcp/src/tools/record.ts#L18-L20) の現行説明（「Ask the user... never auto-classify」）は本計画ステップ 1 で書き換え
- メモリ `feedback_visibility_user_decides.md` は新方針に更新済（2026-04-23）
- 01_plan.md / CLAUDE.md への反映はステップ 7 で実施

## 変更対象ファイル一覧

### ステップ 1: ツール説明の更新（最優先）

| ファイル | 変更内容 |
|---|---|
| [apps/mcp/src/tools/record.ts](../../apps/mcp/src/tools/record.ts) | `visibilitySchema.describe(...)` を書き換え。二項基準 + 書き方誘導 + 明示依頼パターン |
| [apps/mcp/src/tools/update.ts](../../apps/mcp/src/tools/update.ts) | 必要なら `visibilitySchema` に同じ説明を追加。変更対象は `patchFrontmatterSchema.visibility` |

**テスト観点**:
- 既存 [apps/mcp/tests/](../../apps/mcp/tests/) の record/update ハンドラテストは動くか確認
- zod 説明文は振る舞いに影響しないので、テスト追加は不要。ただし schema stringification で説明文の存在を verify するテストを 1 つ足してもよい

### ステップ 2: Stop リマインダ文言更新

| ファイル | 変更内容 |
|---|---|
| [packages/core/src/claudeHooks.ts](../../packages/core/src/claudeHooks.ts) | `stopReminderText` に分類ヒント 1 行追加 + WebSearch/WebFetch 有無ヒント 1 行 |
| [packages/core/tests/claudeHooks.test.ts](../../packages/core/tests/claudeHooks.test.ts) | 既存のリマインダ文言検証テストの fixture 更新 |

**懸念**: 既存テストの多くが stopReminderText の出力文字列を assert している可能性が高い。fixture を漏れなく更新する必要あり。

### ステップ 3: `caveat_search` の公開度 3 択追加

| ファイル | 変更内容 |
|---|---|
| [apps/mcp/src/tools/search.ts](../../apps/mcp/src/tools/search.ts) | `searchInputShape.filters` に `visibility: z.enum(['public','private','all']).optional()` を追加 |
| 同上 | `handleSearch` で `args.filters.visibility` を `search()` に引き渡す |
| 同上 | `searchInputShape.filters.describe(...)` または zod `.describe()` に 3 択の使い分け指針を 1 段落 |

**テスト観点**:
- [packages/core/tests/repository.test.ts](../../packages/core/tests/repository.test.ts) には既に visibility フィルタのテストがあるはず、確認
- `apps/mcp/tests/` に search ハンドラの visibility 絞り込みテストを追加

### ステップ 4: 最後浮上時刻の記録（`last_hit_at`）

| ファイル | 変更内容 |
|---|---|
| [packages/core/src/schema.sql](../../packages/core/src/schema.sql) | `entries` テーブルに `last_hit_at TEXT` カラム追加、`PRAGMA user_version = 2` に更新 |
| `packages/core/src/migrations/002_last_hit_at.sql` | 新規ファイル。既存 DB に `ALTER TABLE entries ADD COLUMN last_hit_at TEXT` |
| [packages/core/src/indexer.ts](../../packages/core/src/indexer.ts) | インデックス再構築時に `last_hit_at` を保存/復元する扱いを追加（null OK） |
| [packages/core/src/repository.ts](../../packages/core/src/repository.ts) | `SearchResult` 型に `last_hit_at?: string` を追加（省略可） |
| `packages/core/src/markHit.ts` | 新規ファイル。`markHit(db, ids: string[]): void` を export。`UPDATE entries SET last_hit_at = ? WHERE rowid IN (...)` |
| [packages/core/src/index.ts](../../packages/core/src/index.ts) | `markHit` を export |
| [packages/core/src/claudeHooks.ts](../../packages/core/src/claudeHooks.ts) | `findCaveatsForPrompt` 呼び出し後に `markHit(db, hits.map(h => h.rowid))` を呼ぶ |
| [apps/mcp/src/tools/search.ts](../../apps/mcp/src/tools/search.ts) | `handleSearch` で検索結果取得後に `markHit` を呼ぶ |

**テスト観点**:
- `packages/core/tests/markHit.test.ts` 新規: 複数 id に対する時刻更新を verify
- 既存 `repository.test.ts` の search: `last_hit_at` が返り値に含まれるかを任意で確認
- 既存 DB での migration 動作: CAVEAT_HOME を v1 schema で初期化 → openDb で v2 に移行されることを verify

### ステップ 5: `caveat list --stale` CLI サブコマンド

| ファイル | 変更内容 |
|---|---|
| `packages/core/src/stale.ts` | 新規ファイル。`listStale(db, opts: { days: number, visibility?: Visibility }): Entry[]` を export |
| [packages/core/src/index.ts](../../packages/core/src/index.ts) | `listStale` を export |
| [apps/cli/src/commands/list.ts](../../apps/cli/src/commands/list.ts) | `--stale [days]` / `--visibility public\|private` オプション対応を追加 |
| CLI エントリ（`apps/cli/src/cli.ts` 等） | 新オプションのパーサ追加 |

**代替案**: `list.ts` にフラグを足すのではなく `apps/cli/src/commands/stale.ts` を新規作成する方が責務が分かれる。現行の `list` が「最近追加順」なのに対し `stale` は「最後浮上からの経過日数順」で意味が違うので、分けるほうが筋が良い。

**テスト観点**:
- `packages/core/tests/stale.test.ts` 新規
- `apps/cli/tests/` に smoke test 追加

### ステップ 6: 初期シード private を 3〜5 件手書き（作業項目）

コード変更ではなく quo の手作業:

- `~/.caveat/own/` に `visibility: private` の md を 3〜5 件 `caveat_record` 経由で作成
- 候補は設計メモ記載の例: Caveat プロジェクト固有 / 常用環境 / 運用判断

この時点で `caveat list --stale` が動く前提のはずなので、ステップ 5 完了後に実施。

### ステップ 7: 01_plan.md / CLAUDE.md への反映

| ファイル | 変更内容 |
|---|---|
| [docs/01_plan.md](../01_plan.md) | 本設計メモを取り込み。private tier / 二項基準 / `caveat list --stale` / 明示依頼パターンの記載 |
| [AGENTS.md](../../AGENTS.md) | 二項基準、明示依頼パターン、月次点検運用の要約を追記 |
| メモリ `feedback_visibility_user_decides.md` | 2026-04-23 に更新済（新方針への反転） |

## 実装の依存関係

```
ステップ1 (ツール説明) ──┐
ステップ2 (Stop文言) ────┼─→ 動作確認 ─→ ステップ6 (手書きシード)
ステップ3 (search絞込) ──┘                ↓
                                          ステップ7 (01_plan.md/CLAUDE.md)
ステップ4 (last_hit_at) ──→ ステップ5 (list --stale)
```

- 1/2/3 は独立、並行可
- 4 は 5 の前提
- 6 は 1 以降が動いてから
- 7 は最後

## 想定工数（雑見積もり）

| ステップ | 見積 |
|---|---|
| 1 | 30 分（zod 説明書き換えとテスト確認） |
| 2 | 45 分（文言 + 既存テストの fixture 漏れなく修正） |
| 3 | 30 分（入力欄追加 + テスト） |
| 4 | 2 時間（schema 変更 + migration + markHit + hook/tool 統合 + テスト） |
| 5 | 1 時間（CLI 新サブコマンド + テスト） |
| 6 | 30 分〜1 時間（手書きシード 3〜5 件） |
| 7 | 45 分（01_plan.md / CLAUDE.md 反映） |
| **合計** | **約 6 時間** |

## リスクと注意点

### 既存テスト緑維持（192 件）

- ステップ 2 の Stop 文言変更は、`stopReminderText` を assert している既存テスト fixture を全て更新する必要あり
- ステップ 4 の schema 変更は、既存 DB を開く動作の回帰テストを必ず走らせる
- ステップ 1/3 の zod 説明は振る舞いに影響しないので既存テストは通るはず

### v0.10 の応答予算

- ステップ 4 の `markHit` は hook のホットパスに入る。v0.10 で詰めた「前景 hook 約 20ms」を壊さないよう、`markHit` は PREPARE 済みステートメントで 1 トランザクション / 数 ms で済ませる
- ベンチマーク: `markHit` 単独で 10 ms 以内（目安）

### 段階的ロールバック可能性

- ステップ 1/2/3 は設定（ツール説明と文言）の変更で、ロールバックは revert 1 コミットで済む
- ステップ 4/5 は schema 変更と新機能、ロールバックは migration を戻すか user_version を手で下げる必要がある。**migration 追加前に DB バックアップを取る習慣を CLAUDE.md に追記すべきか要検討**

### 複数マシン同期は保留

- pre-commit visibility gate は触らない
- マシン跨ぎで private を同期したくなった時は別の変更提案が必要（今回の計画範囲外）

## 次のアクション

1. ステップ 1 から順次着手
2. 各ステップ完了時に `corepack pnpm -r test` を走らせて緑維持を確認

## 関連

- [private-tier-design.md](private-tier-design.md) — 設計思想と論拠
- [01_plan.md](../01_plan.md) — 設計の真実の源（本計画完了後にマージ）
- [AGENTS.md](../../AGENTS.md) — 現行仕様（本計画完了後に反映）
