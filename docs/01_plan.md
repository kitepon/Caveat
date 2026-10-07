# Caveat product contract

この文書はCaveatの現行設計と所有境界を短く示す正本である。実装履歴、完了済み計画、却下案は
[`archive/`](archive/)に置き、通常作業では読まない。コードと本書が食い違う場合はコードを確認し、
同じ変更で本書を直す。

## 製品境界

Caveatは単独でinstall、設定、記録、検索、同期、公開、診断、migration、復旧、releaseできる。
dotagentsは複数製品を束ねる導入・互換・host projectionを所有するが、Caveatの状態や判断を
代行しない。Caveatの動作にdotagentsを必須依存として持ち込まない。

## 真実の源と状態

- 正本はmarkdown-in-git。SQLite FTS5 indexは常に再構築できる派生物。
- 自分の知識は既定で`~/.caveat/own/`、indexは`~/.caveat/index/caveat.db`。
- ユーザー設定の正本は`~/.caveatrc.json`だけ。`knowledgeRepo`で知識repoの場所を変更でき、
  `runtimeErrors: true`でlocal runtime error収集を明示的に有効化できる（既定false）。
  `runtimeErrorReportCredentialFile`へcredentialの絶対パスを書いた時だけ、未受領の記録を
  そのcredentialが指すcollectorへ署名付きで送る（既定null。パッケージに宛先は無い）。
- `CAVEAT_HOME`でCaveatのdata rootを明示変更できる。
- entryの主キーはsourceとidの組。sourceは`own`または`community/<handle>`。
- schemaとmigrationは`packages/core/src/schema.sql`と`packages/core/src/migrations/`が所有する。

## 配布境界

`visibility`は配布範囲の上限である。

- `private`: 自分の端末または同じprivate remoteを使える組織内まで。
- `public`: 世界へ配布してよい。
- `caveat sync`: public/privateを含むown全体をprivate remoteと同期する。匿名可読remoteは拒否する。
- `caveat publish`: public entryだけを検査し、`README.md`とAES-256-GCM封緘bundleへ生成して
  public remoteを一方向更新する。non-showcase本文を平文treeへ置かない。
- publishには`publishTarget`、`sealedKeyserverUrl`、`sealedKeyId`が必要。鍵配布契約とrotationは
  [`../keyserver/README.md`](../keyserver/README.md)を正とする。

封緘はカジュアル閲覧、crawler、host上の平文収集を妨げる摩擦であり、認証境界ではない。
keyserverは無認証なので、動機ある人間による解析を防ぐとは主張しない。

## Agent host契約

- Claude Code: MCPと`UserPromptSubmit` / `PostToolUse` / `PostToolUseFailure` / `Stop` hooks。
- Codex: `caveat codex-hook install`でnative hooksを登録する。
- Cursor: `caveat cursor-hook install`で`~/.cursor/hooks.json`へnative hooksをupsertする。
- `caveat init`がClaude / Codex / Grok / CursorのMCP登録を所有する。CodexはCLIまたは設定ディレクトリ、Grok / Cursorは
  設定ディレクトリを検出した場合に登録する。既存の環境変数・timeout・無効化指定は保持し、
  登録失敗と読戻し失敗は非0終了する。GrokにはMCPを提供し、独自hookは追加しない。
- host固有adapterは同じ検索・pending・同期coreを再利用し、別hostのfieldやstdout契約を改名しない。
- 検索結果は共有しても操作案内はhostごとに分ける。ClaudeはMCP、Codex / Cursorは
  Caveat CLIとown Markdownを使い、別hostにしかない入口を案内しない。
- 機械可読な製品集約診断のschemaは`caveat.native_factory_diagnostics.v1`。既定overallは既存の
  Claude / Codex readinessを維持し、Cursorを必須とするhostは
  `caveat factory-diagnostics --json --require-connector cursor`を使う。Caveatが
  `connectors.cursor.compatibility_status`とoverall、exitを決める。呼出し側はschemaとtop-level
  `overall.status`、exitだけで合否を決め、Cursorのhook名、必要集合、command、timeoutを複製しない。
- Grokを必須とするhostは`caveat factory-diagnostics --json --require-connector grok`を使う。
  `connectors.grok.mcp`は登録の有無、有効状態、実行先の正規性を診断する。ComposerもGrok CLIの
  MCP登録を使うが、モデル認証と回答は実機smokeで別に確認する。

詳細なhost契約は[`03_dual_agent_support.md`](03_dual_agent_support.md)、利用手順は
[`../README.md`](../README.md)と[`../README.ja.md`](../README.ja.md)を正とする。

## 運用入口

| 判断 | 正規入口 |
|---|---|
| install / config / update / uninstall | [`../README.md`](../README.md) |
| state / schema / migration / source構造 | [`../AGENTS.md`](../AGENTS.md)と実装 |
| host diagnostics | 人の個別修復は`caveat codex-hook diagnostics` / `caveat cursor-hook diagnostics`。機械判定は`caveat factory-diagnostics --json [--require-connector cursor]` |
| runtime error設定・確認・復旧 | [`../README.md`](../README.md#runtime-error-diagnostics-explicit-opt-in)と`caveat runtime-errors ... --json` |
| sealed publish / key rotation | [`../keyserver/README.md`](../keyserver/README.md) |
| npm release | [`04_release_checklist.md`](04_release_checklist.md) |

## 通信失敗の報告と重大度

通信環境の事象、アプリの対処不良、原因未確定を分ける。通信コードや件数だけで欠陥や
重大度を決めない。BugHubの通信判断契約は
[NETWORK_REPORTING.md](https://github.com/kitepon/ServerManager/blob/main/bughub/NETWORK_REPORTING.md)。

- 手動syncの正常な取消、設定・privacyの拒否、abortを確認できた競合、リモート操作の失敗は、
  コマンドの表示と非0終了で知らせる。入力を保持し、これだけでは自動のアプリ修理登録をしない。
  リモート操作失敗は原因未確定・相手の結果不明を明示する。再実行は共有先を照合し、Gitの同じ
  commitを同期する。pullの復旧失敗はhighで登録し、再試行前にrebaseの確認を求める。
- 重大度の入力は実害。1操作の失敗はwarn、機能利用不能と復旧失敗はhigh、確認したデータ喪失は
  fatal。検索結果を返せるmarkHit/query log失敗はwarn、検索・contextを作れないhookはhigh。
  MCPの単一tool失敗はwarn、server起動不能とindex利用不能はhigh。
- 原因未確定の登録はアプリ欠陥の確定を意味しない。rootの責任・復帰の可否・影響範囲は
  hook-details、report-status、autosync状態、操作時の診断と担当調査で確認する。
  未解決の重大な影響は後の軽い発生で下げない。旧版の証拠不足のhighは保持し、
  件数・時刻・fingerprintの自動再分類や推定解決をしない。外部の旧API呼出しで実害の指定が
  無い場合も、旧highを保持して確認を要する。
- 通信環境の影響も隠さない。syncが続けて失敗すれば既存autosyncの状態・再試行間隔と
  繰り返し通知が残る。失敗回数は再試行の制御だけに使い、バグの重大度へ変換しない。
  端末間の更新停止など重大な実害が分かった場合は環境担当へ範囲と根拠を報告し、
  アプリの表示・入力保持・復旧の不良を確認した場合は別に修理する。
- collector送信失敗は既存report-statusへ残す。受領未確認の記録を保持し、署名付きackだけで
  受領済みにする。再送の累計で二重発生を作らない。送信失敗そのものをruntime errorへ再登録しない。
- snapshotと送信JSONへ分類や実害の未対応項目は足さない。不足する根拠は既存診断と担当報告で補う。

## 現行: 通知配送とJev苦戦判定

- Throughlineの公開CLIが返す完了3ターン（toolログを除き、取得できるThinkingを含む）を
  Claude / CodexのUserPromptSubmitで利用する。Observerはこの連携に含めない。
- Jevを明示的に有効化した場合、苦戦と検索語を1回で判定する。高い苦戦スコアの時だけ
  JevのChoice確率が「該当語なし」を上回る上位最大3語をAND条件でローカルFTSへ渡す。
  最大20件の候補概要をJevで選別する。知見DB全件は送らない。
- 検索語の選択肢はCaveatが3ターンのログを語分割して作る。長いログでは複数ターンに
  現れる語と新しい発言の語を優先し、Jevには原文に存在する候補だけを渡す。
- Jev有効時はClaude / Codexの旧UserPromptSubmit直接検索、PostToolUseエラー検索、
  Stop構造シグナル通知を止める。切替前のセッション保留通知も破棄し、
  Jev経路だけが知見を自動通知する。全体向け同期通知とMCPの明示検索は維持する。
- 罠の再通知は同一セッションの`(source,id)`で抑止する。Stopシグナルは種類と共起罠が
  変わった時だけ伝え、件数や経過時間の増加では再送しない。pendingは実際の出力後に受領する。
- 通知本文は罠IDと要点を短く示す。詳細取得、記録、visibility判定はMCP tool説明で扱う。
- 記録端末の`environment.os`は適用条件ではない。明示的な`applies_to_os`だけを対象作業の
  OSと照合する。対象作業のOSが書かれていない場合は現在のhostを使う。
- codex-sidecarのCaveat連携とCLIは廃止する。製品自体も退役させるが、repoの移動・削除は行わない。
- 配送量は観測済み通知の同一条件replayと配布後の実測で検証し、新しい知見や新しい
  シグナルの到達を確認する。
- Jevの判定が完了した3ターンごとに、元セッション参照、判定点数、検索語と候補、
  通知本文と配送状態をCaveatの端末内状態へ保存する。正誤は人のレビューで記録し、
  Web UIに通知の正答率と取りこぼし率を評価済み分母付きで表示する。解決成否は測らない。
  元の会話・Thinking全文は複製しない。

## 文書寿命

- 現行文書は[`00_overview.md`](00_overview.md)に列挙したものだけ。
- 完了したplan、handoff、release ledger、監査、告知案は`archive/`へ移す。
- 同じ目的の現行説明はREADME、本書、host契約、release checklistのいずれかへ統合し、並立させない。
- ADRと`rag/`は履歴・根拠として専用棚に残すが、通常作業の必読にはしない。
