# Private tier 設計 — 対象範囲の拡張

> **状態**: 歴史文書（v0.11 で実装済み）。**visibility の定義と共有モデルは v0.15 で更新された** — 現行の正典は [06_sharing_and_reindex.md](06_sharing_and_reindex.md)。本メモの「private = 1 台ローカルのみ、複数マシン同期は保留」という前提は廃止され、private は private remote（`caveat sync`）で保有境界内に同期する方式に置き換わった。以下は当時の検討記録として保持する。
> **日付**: 2026-04-23

## 背景 — Caveat の狙いの転換

これまでの Caveat は **「自分では直せない、第三者の仕様の罠」** だけを対象にしてきた。
実際 v0.10 時点で DB に入っている 50 件は全て `source: own` / `visibility: public`、
中身も PyInstaller / Stripe Japan / Podman rootless / Claude Code hook 仕様 等、
**第三者が自分の環境で再現しうる外部仕様の罠** に揃っている。

今回の方向は対象を広げる:
**「自分のプロジェクト固有の罠」** も Caveat に記録できるようにする。

### なぜこの拡張に意味があるか

- Claude Code にはプロジェクト単位の継続的な記憶層が実質無い
- CLAUDE.md は常時読み込まれるので、書けば書くほどトークン消費が膨らみ続ける
- Caveat の「プロンプトの語と共起した時だけ全文検索で浮上する」という拾い上げの性質は、
  **特定の場面でだけ必要になるプロジェクト固有の文脈の器** として CLAUDE.md より筋が良い
- つまり Caveat の性格が
  「外部仕様の wiki」から「**コードを読んでも復元できない文脈の、選択的な置き場**」に拡張される

### 対象拡張のリスクと規律

自分のコードは本来「直せる」ので、caveat に書く前に修正するのが第一選択。
private な caveat の正当性は以下に限定する:

- **コード自体を読んでも復元できない、かつ繰り返し刺さる文脈** のみ
- 例: 「見た目は変だが意図的」「X 制約でリファクタ不可」「上流修正まで workaround 必須」
- 反例: 「TODO」「バグってる」「読みづらい」は issue / 修正 / リファクタに行くべき

この規律が崩れると「メモ帳」に退化するので、ツール説明で歯止めをかける。

## 層の整理 — public / private のみ

書き手から見た層は 2 つ:

- **public** = 第三者と共有できる内容（`~/.caveat/own/` に書き、共有リモートに push）
- **private** = 自分だけで使う内容（複数マシンで同期したい場合のみ、別途リモート構成が必要）

`community/<handle>` は「他人の公開リポジトリを購読して読む側」の話で、書き手の層ではない。

### private の保存・検索は既に動いている

コード確認結果:

- [record.ts:58](../../packages/core/src/record.ts#L58) — `caveat_record` は `visibility: private` を frontmatter に書いて `~/.caveat/own/<id>.md` に保存する
- [repository.ts:76](../../packages/core/src/repository.ts#L76) — 検索も `visibility: 'private'` フィルタで引ける
- 全文検索の索引にも入る

**ローカル 1 台運用では今日から動く**。この設計メモで扱うのは主に「対象拡大に伴う判定・誘導の仕組み」の話。

複数マシン間の同期は [pre-commit-visibility-gate.mjs](../../hooks/pre-commit-visibility-gate.mjs) が
`visibility: private` のコミットを弾くので現状不可。複数マシンで private を同期したくなった時点で
private 専用リポジトリを別途用意する等の検討が必要。現時点では保留。

## 判定の仕組み — 発火側は触らない

3 つの hook のうち、分類の誘導に関わるのは **Stop のみ**:

| Hook | 役割 | public/private 判定に関与するか |
|------|------|--------------------------------|
| UserPromptSubmit ([claudeHooks.ts:162](../../packages/core/src/claudeHooks.ts#L162)) | 関連 caveat を浮上させるだけ | 関与しない（変更不要） |
| PostToolUse ([claudeHooks.ts:144](../../packages/core/src/claudeHooks.ts#L144)) | 同上、拾い上げ専用 | 関与しない（変更不要） |
| Stop ([claudeHooks.ts:191](../../packages/core/src/claudeHooks.ts#L191)) | 苦戦シグナルと関連 caveat を出して `caveat_record` / `caveat_update` を誘導 | **関与する** |

**発火ロジックは据え置き**。判定は `caveat_record` を呼ぶ時に Claude がツール説明を読んで決める。
介入点は **ツール説明を中心に、Stop リマインダに 1 行補強**。

### 介入点 1: ツール説明（主役）

`caveat_record` / `caveat_update` のツール説明に以下の二項基準を書く:

> **同じ外部ツール / 仕様に触れた第三者が再現できる罠か？**
> → yes なら `visibility: public`
> → あなたのリポジトリ固有の振る舞い / 意図的な非標準設計 / このプロジェクトでしか起きない文脈 → `visibility: private`
> → 迷ったら `private`（漏洩防止のため）

この基準で既存 50 件は全部 public 判定が通る（過去の実績を壊さない）。

**あわせて「書き方の誘導」も同じ説明に入れる**:

> `visibility: private` で記録する場合、本文には **リポジトリの固有識別子（関数名・クラス名・ファイルパス・独自運用用語）を必ず含めて書く**

理由: private の罠が埋もれないための検索対策。
外部ツールのエラーメッセージには `PyInstaller` 等の公共語彙が直接出るので public の罠は共起しやすい。
一方 private の罠は、本文が「この問題が何について書かれているか」を自分の固有名詞で明示していないと、
将来その領域のコードを触っている最中のプロンプトと共起せず、リマインダに浮上しない。
書き方を誘導することで、本文の語彙による自然な仕分けが機能する前提を満たす。
運用して埋もれが頻発するようなら別の検索機構を検討する段階的方針。

### 介入点 2: Stop リマインダ（補強）

`stopReminderText` に 1 行追記:

> 記録する場合はツール説明の基準で public/private を選べ

これが無いと Claude が毎回ツール説明から基準を再導出する羽目になり、private 側に広げた効果が薄れる。

### 介入点 3: 他のリマインダ — 変更しない

- `toolErrorReminderText` / `userPromptSubmitReminderText` は拾い上げ専用で `caveat_record` を誘導していない
- PostToolUse に記録誘導を足すと Stop と職務重複 + 前景 hook の応答予算（v0.10 の 約 20ms）を食う
- 分業維持: **PostToolUse = 既存の罠を浮上させるだけ / Stop = 記録誘導**

## 検索の仕組み — 結論

### 検索時に public / private の絞り込みは掛けない

検討の末、**検索時に public / private で絞り込みの切替はしない**。理由:

- 2 語共起ルールは `new` / `the` 等の無意味な 1 語ヒットを防ぐために置いた構造ルール。
  private 側だけ閾値を緩めたら、このノイズ防止が private で再発する
- ルールを両層で統一すべき、というのがユーザの指摘
- public と private は本文の語彙が必然的に分かれる
  （public = 外部ツール名 / API / エラーメッセージ、private = 自分のプロジェクト名 / 関数名 / ファイルパス / 独自運用用語）
- 現行の 2 語共起の全文検索を両方に掛ければ、**本文の語彙が自然に仕分ける** —
  プロンプトに個人語彙が出た時だけ private がヒット、外部ツール名が出た時だけ public がヒットする
- 分類の効果は検索には現れず、公開範囲（git push の可否）にだけ現れる
  = **public/private は公開フラグ以上のものではない** と割り切る

### 苦戦検知時点での事前分類は原理的に無理

Stop hook で苦戦シグナルを捉えた瞬間、その session の罠が public 系（外部仕様）か private 系（自分のリポジトリ固有）
かは、構造信号からは確信を持って決められない。

考えたヒント案:

- **WebSearch / WebFetch の有無** — 走ったなら外部仕様を調査中 → public 寄り、無ければ内部デバッグ → private 寄り。
  二値の構造信号、v0.9 の `SessionSignals` で既に取得済なので追加コストゼロ
- **エラーの発生箇所** — `node_modules` / `site-packages` 配下なら public、自分の作業ディレクトリ内なら private。
  ただし「外部所属パスの一覧」を抱えることになり、v0.8 の手書きリスト忌避に反する
- **エラー文字列と自分のコードとの共起** — 作業ディレクトリの別索引が要るので対象範囲が広すぎる

**採用**: Stop リマインダに **WebSearch / WebFetch の有無を public/private のヒントとして 1 行添える** だけ。
最終判定は Claude がツール説明の二項基準で行う。機械側は決めつけない。

### Claude 主導で検索範囲を絞る選択肢を提供する（`caveat_search` の公開度 3 択）

Hook 発火の拾い上げはフラットのまま（そこは触らない）。
**Claude が自発的に `caveat_search` を呼ぶ時の絞り込み項目として公開度を露出する**。

現状:
- core 側 ([repository.ts:76](../../packages/core/src/repository.ts#L76)) は `visibility: 'public' | 'private' | 'all'` の絞り込みを既に実装済
- MCP ツール側 ([apps/mcp/src/tools/search.ts](../../apps/mcp/src/tools/search.ts)) の絞り込み欄には `source` / `tags` / `confidence` しか露出されていない

追加作業（3 ステップ）:

1. **検索ツールの入力欄に「公開度」の絞り込み項目を追加**
   — 入力スキーマに `visibility: z.enum(['public', 'private', 'all']).optional()` を追加するだけ
2. **入力値を検索エンジンにそのまま渡す**
   — ハンドラで `args.filters.visibility` を `search()` に引き渡す。新しいロジックは書かない（core 側が既対応）
3. **ツール説明に 3 択の使い分けを 1 段落追加**
   — 3 択の意味と使い分け指針を書く。
     「迷ったら省略 / `all`」を明示して絞りすぎのノイズを防ぐ

効果の範囲の正しい見積もり:

- hook 発の自動浮上は今まで通りフラット。Claude が目にするリマインダの大半はここ由来 → 変化なし
- この 3 択が実効するのは **Claude が自発的に `caveat_search` を呼んだ時のみ**
  （外向けの文面を書くとき / 特定の過去ノートを狙い撃ちしたいとき）
- 発動頻度は低いが「ここぞの場面で Claude が文脈に合わせて絞れる」表現力は得られる

## 保留事項

- **複数マシン間の同期** — 現状 [pre-commit-visibility-gate.mjs](../../hooks/pre-commit-visibility-gate.mjs) が
  `visibility: private` のコミットを弾くので、複数マシンで private を同期する経路が無い。
  1 台運用の間は保留。複数マシン運用が要る時点で private 専用リポジトリ分離 or 歯止めの調整を検討。

## 観察と運用

### 埋もれた罠を見つける仕組み (#2 対応)

「private の本文には自分の固有名詞（関数名・ファイルパス等）を含めて書け」はツール説明の
推奨であって強制ではない。守られなかった時、書いた private が検索で浮上しないまま
忘れ去られる可能性がある。これを検出するため、**各エントリに「最後に検索で拾われた時刻」
を記録する**。

仕組み:

- エントリのデータ欄に「最後浮上時刻」を 1 つ追加。新規記録時は空、検索で拾われるたびに
  現在時刻で上書きする。
- 検索処理は「読み取りだけ」に保ち、時刻更新は別の関数に切り出す（読み書きを混ぜない）。
  hook やツールが検索を走らせたあと、拾われた id 一覧を渡してこの関数を呼ぶ形。
- CLI に「**最後に浮上してから N 日経っているエントリを一覧表示**」する
  `caveat list --stale` サブコマンドを追加。公開度での絞り込みも可（例: private だけ）。
  初期値は 90 日。

運用: quo が月に 1 回くらい `caveat list --stale --visibility private` を叩く。
3 ヶ月浮上していない private は「書き方が悪くて埋もれている」か「もう刺さらない話になった」
のどちらか。本文を書き直すか削除するかの判断材料にする。

この仕組みは public にも使えるが、主用途は private の検索ヒット率を見張ること。

### private の立ち上げ対策 (#7 対応)

Stop hook の自動誘導だけだと Claude は「外部ツール名を拾って public」に流れやすく、
private が育たないリスクがある。2 方向で対策:

**a. ユーザからの明示依頼パターンをツール説明に例示**

`caveat_record` の説明に以下を追加:

> ユーザが「これは private で記録して」「自分用にメモしておいて」等と明示的に依頼した場合、
> 二項基準（第三者再現性）を飛ばして即 `visibility: private` を選ぶ。明示指示が自動判定に優先する。

これで Claude は「ユーザの明示指示 > 自動判定」と理解する。立ち上げ期には quo が
会話中に一言添えるだけで初期の private が溜まっていく。

**b. 初期シードとして private を数本手書き**

01_plan.md マージと同時の作業として、quo が自分の典型的な「コードを読んでも復元できない文脈」を
3〜5 件、手で `caveat_record` する。例の候補:

- Caveat プロジェクト固有の作業手順 / 設計判断
- 自分の常用環境（Windows + corepack + pnpm）での操作上の罠
- 自分の公開アカウント運用上の判断基準

これで private にもシードが入り、検索の動作確認が回せる。

### CLAUDE.md への波及

01_plan.md にマージするとき、[AGENTS.md](../../AGENTS.md) にも以下を反映:
- 二項基準と「迷ったら private」の方針
- 明示依頼パターンの存在（「private で記録して」と言われたら即従う）
- `caveat list --stale` の月次点検の運用

## 実装の順序（次のステップ）

1. `caveat_record` / `caveat_update` のツール説明に二項基準 + 書き方誘導 + 明示依頼パターンを追加（最優先）
2. Stop hook のリマインダ文言に分類ヒント 1 行 + WebSearch/WebFetch 有無ヒント
3. `caveat_search` ツールの絞り込み欄に公開度（3 択）を追加 + ツール説明更新
4. エントリのデータ欄に「最後浮上時刻」を追加 + 既存 DB の移行 + 時刻更新関数 + hook/ツールとの統合
5. `caveat list --stale` CLI サブコマンド追加
6. 初期シード private を 3〜5 件手書き
7. 01_plan.md / CLAUDE.md に反映してマージ

## 関連

- [01_plan.md](../01_plan.md) — 設計の真実の源（本メモがマージされるべき先）
- [AGENTS.md](../../AGENTS.md) — hook 実装の現行仕様
- [archive/auto-merge-design.md](auto-merge-design.md) — v0.7 転換の背景（自動マージの却下理由）
