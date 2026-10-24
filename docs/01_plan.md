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
- `caveat autosync run --json`: OS予定用の単発処理。既存cycleの間隔・再試行・privacy判定を
  再利用し、dirty treeを保留する。repo共通lockとindex lockで手動/hook同期と排他する。
  終了値は成功0/保留2/失敗1。`autosync status --json`は最後の実試行・失敗・成功完了を保持する。
  定期起動の登録はこの入口に含めず、通常init・更新から自動で有効化しない。
- `caveat autosync schedule install|status|uninstall --json`: 現在ユーザーのsystemd/launchd/
  Task Scheduler定義を明示管理する。`--dry-run`は生成だけで書込み・native操作なし。
  Windowsでは現tokenのSIDを読み取って登録主体に使う（dry-runでもこの読取processだけは実行する）。
  取得できない時は登録せず固定reasonを返し、環境変数のdomain名からは推測しない。
  Node/CLI/data home/config homeを固定し、毎分起動から既存cycleの間隔・backoffを使う。
  定義hash・所有記録・cycle lockで他job/編集済み定義/実行中処理を保護する。
  Windowsの新定義はUTF-16LE+BOMで保存し、hashは保存bytesに一致させる。
  この候補を入れた検査機で旧候補へ戻す時は、新候補でschedule uninstallを済ませてから戻す。
  登録失敗を保持し、登録状態と受信成功を分ける。ログイン・sleep・再起動後の実行は実機検証する。
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
  MCPの読み取り1操作の失敗はwarn、server起動不能とindex利用不能はhigh。
  MCPの記録・更新失敗は書き込み結果を確認できないためhighを保ち、再試行前にentryを照合する。
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


## Factory private evidence v1 隔離候補

#### 製品所有の契約

所有: kitepon/Caveat、担当ノア。pure隔離候補。状態: draft、未実装・未配布・未有効化。
これはCaveatの利用者限定の公式入口として採用するための契約案。
現行`caveat.native_factory_diagnostics.v1`の公開JSON、診断の意味・終了値は変更しない。
Caveatはdotagentsが無くても同じ入口を使え、製品の診断/復旧/公開判断を自分で所有する。

### 1. 何を返せるか

通常の`caveat factory-diagnostics --json`を**一回**呼ぶ際に、呼出元が明示設定した
private channelへ同じ実行中の補助証拠を返す。追加の製品process、Git照会、同期は起こさない。
対象は、その実行で既に得たrepo identityとHEAD、public出力との対応、process情報だけ。

| 情報 | 生成と意味の所有者 | v1の扱い |
|---|---|---|
| local/remote HEAD・未取得理由 | Caveatのsync診断 | 同runで取得済みの値だけ。未到達はnull+固定reason |
| knowledge repo/remoteの識別digest | Caveatの既存設定/解決結果 | 同runの解決結果から。工場cwdや外部推測を使わない |
| public JSON bytesへの対応 | Caveat CLI action | 実際にstdoutへ渡す1行のUTF-8 bytes SHAと長さ |
| process/entry/packageの自己申告 | 当該Caveat process | collectorの観測と照合。自己申告だけを実行証明と呼ばない |
| 実同期操作receipt | Caveatの別の操作契約 | **v1ではnot_supported。receipt=null** |
| runtime error/ack/内部DB内容 | 製品の既存責務 | この契約には含めず、factoryへ返さない |

工場はCaveatのGit repo、内部DB、sync state、runtime保存fileを直接読んで補完しない。
操作receiptが必要な時はCaveatが別の公式版付き契約を設計する。診断の近くにある履歴を
操作成功のreceiptへ仕立てたり、v1のnullを内部fileから埋めたりしない。

### 2. 能力の宣言元と選択

製品releaseが公式artifactとして配布する候補path:
`<caveat-cli-package>/dist/factory-private-evidence-capabilities.v1.json`。
このfileは公開可能な能力記述で、利用者の内部設定/状態ではない。
製品のpack/release gateがentryとschemaの整合を保証し、将来採用時に製品文書から案内する。

能力fileの厳格なkey集合:

| key | 型・制約 |
|---|---|
| schema | `caveat.factory_private_evidence_capability.v1`固定 |
| product | `caveat`固定 |
| package_version | 配布packageのsemverと一致 |
| public_diagnostic_schema | `caveat.native_factory_diagnostics.v1`固定 |
| private_protocol | `caveat.factory_private_evidence.v1`固定 |
| transports | 実装・製品検証済みのtransportだけの配列。重複なし |
| max_channel_bytes | v1では16384固定。hello/result/改行の合計 |
| operation_receipt | `not_supported`固定 |

各transportは`id`、`platforms`、`launch_paths`の3key。
候補IDは`posix-fd-v1`（linux/darwin）、`windows-named-pipe-v1`（win32）。
launch_pathsは製品が受け入れた`direct_node_entry` / `native_exe` / `powershell_standard_shim`の明示集合。
Windows能力をPOSIX能力から推定しない。公開版0.20.3は能力file無し→not_supported。
0.21.0候補は空のtransportsを持つ能力fileを含み、private transportの実行は引き続きnot_supported。
この候補の作成を、能力fileの公開配布やruntime接続の完了とは扱わない。

選択順序:

1. collector側opt-inがOFFなら能力fileを読まず、private env/channel/file/workerを作らない。
2. ON時だけ、既存のcommand解決が指す公式packageの能力fileを読む。
   owner/type/上限16KiB/厳格JSON/version整合を確認する。別packageから借りない。
3. file無し/既知非対応は`not_supported`。読取不能/形不正/版不一致は`unverified`。
4. 現platform・実際のexe/shim経路・collectorの安全なtransport実装の共通能力を選ぶ。
   共通能力無しはnot_supported、保証を検査できない場合はunverified。
5. channelが通常診断の起動時点で安全に用意できないなら、private要求を付けず通常診断を一回呼ぶ。
   channel準備のため診断開始/既存timeoutを待ち延ばさない。

能力確認用にhelp/version/診断を追加起動しない。標準shimを迂回せず、内部repo/DBで代用しない。
能力fileは宣言であって実行証拠ではない。実frame/peer/nonce/EOFの検査に失敗すれば採用しない。

### 3. 明示要求

候補request envは次の4つ。対応版のCaveatだけが解釈する。

| env | 値 |
|---|---|
| CAVEAT_FACTORY_PRIVATE_EVIDENCE | `v1` |
| CAVEAT_FACTORY_PRIVATE_COLLECTION_ID | RFC4122形式UUID |
| CAVEAT_FACTORY_PRIVATE_NONCE | CSPRNGの32bytesを表す64桁lowercase hex。毎実行更新 |
| CAVEAT_FACTORY_PRIVATE_CHANNEL | 選択済みtransportのlocal descriptor |

4つが揃い有効な時だけprivate機能を試みる。未指定/OFF/不正はprivate出力なし。
不正要求やprivate保存の成否でpublic診断のstatus/exitを変更しない。
env全体やnonceをlogへ出さない。URL・credential・保存file pathを引数へ足さない。
collectorはCAVEAT_HOMEや認証/製品設定をこの機能のために変更しない。

### 4. framing・identity・EOF

channelはUTF-8 strict JSONのNDJSONを最大2frame、合計16384bytes以内で返す。
unknown key・重複key・不正UTF-8・frame超過・多重hello/resultは拒否する。
同protocolのhello 1件→diagnostic_result 1件→EOFの順序が必要。
長さが上限内でもEOF無しは完全な結果としない。

共通keyは`schema`、`type`、`collection_id`、`nonce`、`execution_id`。
schemaは`caveat.factory_private_evidence.v1`、execution_idはCaveatが当該起動時に生成したUUID。
helloとresultの全共通keyが一致し、要求collection/nonceにexact一致しなければ採用しない。

helloに含める追加key:

- `product`=caveat、`product_version`、`public_diagnostic_schema`、`transport`。
- `process`: pid、parent_pid、process-startの識別値/取得元、主体UID/GID又はSID、
  process.execPathとentry realpath、package version/build ID。取れないものはnullと明示reason。
  これらはprivateで、collectorの実peer観測と一致する範囲だけ信頼する。

resultに含める追加key:

| key | 型・制約 |
|---|---|
| public_output | `bytes`非負整数、`sha256`64hex。stdoutへ実際に渡すJSON+改行のbytes |
| public_result | `schema`、`overall_status`、`planned_exit_code`。stdoutとの整合だけを示す |
| sync_observation | 下記の同run観測。公開診断のsync.status/reasonと整合 |
| operation_receipt | `{status:"not_supported", receipt:null}`固定 |

planned_exit_codeはCLIが決めた予定値であり、OSが観測した実終了codeとは別。
collectorのcode/signal/timeout/spawn情報を置換しない。
public JSONが途中で失われた時はpublic_output hashを使って内容を復元しない。

`sync_observation`のkey:

- `status`/`reason_code`: 当該公開sync結果そのもの。
- `repo_identity`: `status`=available/not_observed/unverified、`algorithm`、`digest`又はnull、固定reason。
- `local_head`/`remote_head`: 各`status`=observed/not_observed/unverified、`value`=40hex又はnull、固定reason。
- `comparison`: `equal`/`different`/`not_evaluated`。両値取得済みの時だけ比較。
- `relation_counts`: `{status:"not_supported", behind:null, ahead:null}`固定。

各値は既存sync関数がそのrunで得た変数だけをsinkへ渡す。
remote_mismatchでreturnする前に取得済み値を渡すが、後からrev-list/ls-remote/fetchを足さない。
dirty/origin不在/通信不能等で未到達ならnull+固定reason。過去/current値は使わない。
v1はSHA-1の40hexだけを対象にし、異なるrepo hash形式はunverifiedとして補完しない。

repo_identityの規約は同梱[origin記述の規約](#repo_identityの規約)をnormativeとする。
algorithmは`origin-descriptor-sha256-v1`。remote originのhost/path記述を形式・scheme・明示portとともに識別する。
local clone・認証主体・実操作主体/成否・接続先実体の同一性は証明しない。
URL/scp・明示port有無を区別し、pathの末尾.git/slashを保持。相対scpなど曖昧/非対応はunverified。
第2稿のhost/pathだけの正規化/digest規約を置換し、旧algorithmのdigestと比較しない。
同run既存origin取得の完全な成功出力だけを使い、追加Git照会・内部repo/DB補完は禁止する。


### 5. transportの契約

#### POSIX: posix-fd-v1

descriptorは`fd:3`固定。collectorが作った継承済み専用pipe/socketだけを使い、stdout/stderrを拒否する。
creator/owner/endpoint種別を確認し、nonblockingを**実装で保証できるadapterだけ**が能力を宣言する。
Nodeの任意fdへ同期writeすれば安全という仮定は置かない。
collectorは常にreadを排出し、保存先が失敗/上限超過でもreadを止めない。
productは上限付きnonblocking writeを一度試み、backpressure/切断/権限失敗で追加待機や再送をしない。
書けなかったframeは欠測。privateの送信完了を待ってCaveatの自然終了を遅らせない。

#### Windows: windows-named-pipe-v1

descriptorはlocal `\\.\pipe\caveat-evidence-<random-id>`だけ。
remote pipe名を拒否し、collectorはfirst-instance/remote-client拒否、現SID限定DACL、overlapped I/Oを使う。
既存pipe名の衝突は拒否し、他者endpointへ接続しない。
Windowsのrequest env CHANNELは、transport/path/server_pid/server_start_identity/owner_sidの
5keyを持つ厳格JSON descriptorとする。pathは上記local pipeだけ、serverのPID/start/SIDは
creatorの実値。productはOSから得たserver値と照合し、照合不能ならprivate値を書かない。
POSIX descriptorは`fd:3`のままとし、Windows descriptorをPOSIXへ解釈しない。

| 実launch path | 選択条件 |
|---|---|
| direct `.exe` | capabilityにnative_exeあり、secure named-pipe adapter/peer検査が利用可能 |
| PowerShell→標準npm/script shim→Node | capabilityにpowershell_standard_shimあり、env継承とpeer/実子identityを検査できる |
| 未知shim/custom wrapper | not_supported。迂回しない |
| 能力はあるがSID/peer/start identity等の確認不能 | unverified、private採用なし |

collectorはlookup PowerShell、実wrapper、Caveat Node/exeを別のroleで記録する。
GetNamedPipeClientProcessId相当とprocess creation identityでpeerを取得し、SIDと起動したchainに照合。
pid番号だけやparent_pid自己申告だけで結び付けない。productもserver PID/start identity/SIDを確認する。
hello/resultのnonce、execution_id、process identity、public出力SHA、EOFが整合した場合だけ採用。
named-pipe安全APIがNode標準機能だけで利用できるとは主張せず、必要なnative adapterの
実装・配布・製品検証まで能力は宣言しない。現Windowsは未実装/未確認。

接続/書込みはnonblockingで、保留I/Oを元診断のdeadline/終了より延長しない。
安全にcancel/close/排出を保証できない場合は要求を送らず欠測とする。
channel EOF、wrapper close、診断子closeは別event。wrapperのexitを子のexitに代入しない。
Windowsの既存command lookup等を含めて「全process一個」と呼ばず、**Caveat診断の追加起動0回**を契約にする。

### 6. 未対応・不完全・失敗の採用規則

能力file無し/共通transport無しはnot_supported。宣言矛盾/nonce不一致/peer不明はunverified。
helloだけ、result途中、EOF無し、公開stdout hash不一致はpartial/unverifiedとし、欠測を返す。
実行中のtimeout/kill/signalとprivate channel失敗を別々に保存する。
失敗をpublic stdout/stderrへ生出力せず、public check/終了値/runtime件数も変えない。
collector側の固定local保存statusだけで欠測を通知する。
何も保存できなくても製品正常/同期未実行とは推測しない。

### 7. 受入条件（今回は未実行）

Caveat release gateがschema/能力artifact/entry整合、OFF時の副作用無し、既存public bytes/exit維持、
同run値だけの取得、private pipeの上限/非閉塞、Windows exe/shimとidentity/nonce/EOF拒否、
秘密の非転送を検証する必要がある。dotagentsの検証で製品契約を置換しない。
公開・適用・host受入は別工程。全3OS×4harnessは未適用・未確認。

### 8. schemaとcross-field条件

`../apps/cli/src/contracts/factory-private-evidence/capability.v1.schema.json`、`../apps/cli/src/contracts/factory-private-evidence/private-frame.v1.schema.json`、
`../apps/cli/src/contracts/factory-private-evidence/windows-channel.v1.schema.json`を本草案に付ける。
JSON schemaの構文/型だけで表せない次の条件もnormativeなvalidator条件とする。

- 能力fileのproduct/version/public schemaとhello、hello/resultの共通keyはexact一致。
- descriptorのtransport/platform/launch path、OS peer identity、nonceが同じ呼出しに対応する。
- processのnullにはmissing_reasonsの対応理由が必要。自己申告値をOS実観測へ昇格させない。
- head status=observedだけが値を持ち、両値がobservedの時だけequal/differentを返す。
  comparisonと両HEAD実値の一致/不一致が矛盾したframeはunverified。
- repo status=availableだけが規定algorithm/digestを持つ。それ以外はnull。
- public_outputはcollectorが受信した完全なpublic stdout bytesに一致する。
  public_result/sync_observationは実際の公開JSONと整合し、readyのplanned exitは0、それ以外は1。
- private frameのplanned exitとcollectorの実exit/signalは別情報として残す。
- schemaを通ってもchannel全体の16KiB/順序/EOF検査が未達なら採用しない。

schemaとcapabilityの将来製品配置はCaveat pack manifestへ収容する別工程。
本ディレクトリのschemaを現Caveatが対応済みとするものではない。

##### repo_identityの規約

所有Caveat / ノア。2026-10-18。未実装・未配布のv1草案。第2稿のdigest規約だけを置換する。

#### 意味と証明範囲

`repo_identity`は、**同runで既に取得したremote origin文字列のhost/pathを、形式・scheme・明示portとともに識別するprivate digest**。
`available`は下記の限定文法でその記述を識別できたという意味だけを持つ。
local cloneの同一性・実在、認証アカウント、OS実行主体、実同期操作の主体/契機/成否を証明しない。
同じdescriptor/digestでも、接続先の実体・同じrepository・同じ権限とは断定しない。
URLのuser名は識別入力から除外されるので、同じdigestを認証主体一致として扱うことも禁止する。
DNS、SSH alias/config、proxy、redirect、server側のroutingは確認しない。aliasと実hostの同一性を推定しない。
同じHEADの観測も同期receipt又は成功証明ではない。v1のoperation_receiptはnot_supported/receipt=null、relation_countsも非対応/nullのまま。

#### 入力の境界

Caveatが既存診断runで行うorigin取得の**同じ呼出し**の成功stdoutだけが入力。
将来限定captureを追加する場合も、既存Git呼出し・timeout・公開結果を変えないことが条件。
追加get-url/config/Git、collector cwd、内部repo/DB、以前又は現在の別runの値を使わない。
成功入力の完全性を保証できない、複数行、stdout上限超過、切断、不正UTF-8、NUL/制御文字ならunverified。
既存コマンドの行終端LFを一個、又はCRLFを一個だけ除ける。その他の空白をtrimしない。
既存分岐でorigin取得へ未到達ならnot_observed。試みたが確定できないものはunverified。
追加照会で曖昧さを解消しない。生origin、userinfo、正規化tupleをframe/log/reportへ保存しない。

#### 保守的な対応文法

以下はこの草案が対応する部分集合。Gitが受け入れる全形式の対応を主張しない。
入力は行終端除去後4096 ASCII bytes以下。空白、非ASCII、percent escape、backslash、query又はfragmentは拒否。
疑問符/fragmentを捨てて識別する第2稿の規約は廃止する。

| 部分 | 採用条件/扱い |
|---|---|
| URL | `scheme://[user@]host[:port]/path`のみ。schemeはhttp/https/ssh/gitをASCII小文字化して区別。既知schemeでも残りが未対応ならunverified |
| scp | `[user@]host:/path`の絶対pathだけ。URLと区別し、scheme/portはnull。`host:path`の相対pathはremote home依存が未確定なのでv1ではunverified |
| user | 任意一個、非空の`[A-Za-z0-9._-]+`のみ。digestから除外。password/複数@/曖昧userinfoはunverified、認証情報へ解釈しない |
| host | ASCII DNS labelを`.`で連結。各labelは1〜63文字、英数字で始終し途中のhyphen可、全長253以下。小文字化。末尾dot、IP literal、IPv6 bracket、空hostは本v1では未対応/unverified |
| 明示port | URLだけ、1〜65535の十進表記、先頭zero無し。文字列のまま保持。未指定はnullで、明示default portとも区別。scpのcolonをportへ推測しない |
| path | `/`から始まる一個以上のsegment。segmentは非空の`[A-Za-z0-9._-]+`、`.`/`..`は拒否。途中の空segment、`~`等はunverified。末尾slash一個は許可して保持 |
| 正規化 | schemeとhostのASCII小文字化だけ。pathの大小、末尾`.git`、末尾slashを保持。slash統合、dot解決、URL decode、home展開をしない |
| その他 | file/local path、custom helper、未知scheme、相対path、IPv4/IPv6/IDN等の非対応形はunverified。推測fallback無し |

hostのIP literal除外では、全labelが数字だけのhostも拒否する。DNS/SSH設定を読んで判別しない。
明示port無しは設定/既定portの実値を知ったという意味ではない。
URL/scpを同一SSH接続へ正規化する規則は持たない。上記以外は「同じはず」と補完せずunverifiedにする。

#### digestの版とbytes

algorithmは **`origin-descriptor-sha256-v1`**。
UTF-8で次の固定7要素配列をJSON直列化（余白/改行無し）し、そのSHA256をlowercase 64hexで返す。
要素はASCII string又はJSON nullのみなので、この規約のbytesは実装言語に依存しない。

```text
["caveat.origin-descriptor.v1", form, scheme, host, port, "absolute", path]
```

formは`url`又は`scp`。URLのschemeは上表の小文字、scpのscheme/portはnull。
pathは先頭/末尾slashを含む採用文字列そのもの。digest入力にuser名/credentialを含めない。
available時だけalgorithm/digestを持ち、reasonは`origin_descriptor_observed`。
not_observed/unverifiedではalgorithm=digest=null。固定reason候補は
`origin_not_reached` / `origin_capture_unverified` / `origin_syntax_unsupported` / `origin_semantics_ambiguous`。
生入力/error本文をreasonへ連結しない。製品validatorが採用時にこの固定集合との対応を検査する。

digestはprivate限定。元URLを返さなくても辞書推測を防げるとは保証しない。
第2稿`origin-host-path-sha256-v1`とはalgorithmが異なる。旧digestを変換・比較・同一扱いしない。
未配布草案の訂正で、公開診断schemaやHEADの意味を変更しない。

#### 規約例（実行試験ではない）

以下は例示文字列の比較規則であり、実在repo又は当時のoriginの測定結果ではない。

| 左/右の差 | 規約上の扱い |
|---|---|
| `https://EXAMPLE.invalid/org/repo.git` とhostだけ小文字 | 同じtuple |
| httpsとhttp | 異なるtuple |
| `https://example.invalid/org/repo` と明示`:443` | 異なるtuple |
| `ssh://git@example.invalid/org/repo` と`git@example.invalid:/org/repo` | url/scpが異なるtuple |
| `git@example.invalid:org/repo` | 相対scpなのでunverified |
| `/org/repo` と`/org/repo.git`又は`/org/repo/` | 異なるtuple |
| userだけ変更、他は同じ対応文法 | 同じtupleになり得る。認証主体/接続先実体の一致は示さない |
| query/fragment/escape、dotsegment、alias解決が必要な比較 | 非対応/曖昧ならunverified。別照会で補わない |

同じalgorithmとdigestはこの規約での記述一致のみ。異なるdigestも、異なる実repoの証明ではない。
この限定範囲で役立たない場合は欠測を維持し、文法の拡張は新algorithm版と通常reviewを必要とする。


本文のrepo_identityの固定理由fieldはprivate schemaと同じ`reason`。公開sync及びsync_observationの`reason_code`とは別fieldである。今回の純粋実装は診断入口から未接続。能力artifactのtransportsは空で、実送信/保存/公開/常用有効化は未実装。


## 最低Nodeと通常launcher

製品の公開下限はNode22.5以降。SQLiteがstartup flagを必要とするruntimeでは、
`dist/caveat.js`がbuiltinの可用性を確認し、必要な場合だけ同じNode/argv/cwd/env/stdioで一度起動し直す。
入口は`apps/cli/src/bootstrap.mjs`をclean build後にそのままcopyして所有する。
追加flagは製品launcherが所有し、試験又は利用者設定だけを変更して下限対応済みとしない。
明示的なSQLite enable/disableはNodeが同等とするhyphen/underscoreの混在表記も上書きせず、
判定時だけ正規化して元のargv/NODE_OPTIONSを保持する。flag付きでもmoduleが利用不能なら通常の失敗で止まり再帰しない。
子のcode/signalを親へ返し、POSIXのSIGINT/SIGTERMを転送する。Windowsのprocess-tree終了と
各OS最低Nodeの実受入は別の検証条件であり、このlocal候補の成功だけで全OS対応とはしない。
POSIX親の強制終了と起動直後signal、preload（--require/--import）の再実行、debugger port、
将来の追加fd/private channelの継承も未受入。全Node optionの副作用不変は保証しない。

根拠は[Node22.5のSQLite flag](https://nodejs.org/download/release/v22.5.0/docs/api/cli.html#--experimental-sqlite)と
[Node22.13のunflag変更](https://nodejs.org/en/blog/release/v22.13.0)。runtimeのversion文字列だけで
新しいprivate能力やnative安全性を推測しない。このlauncher修理はprivate evidence候補と独立して扱う。
