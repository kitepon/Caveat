# Caveat product contract

この文書はCaveatの現行設計と所有境界を短く示す正本である。実装履歴、完了済み計画、却下案は
[`archive/`](archive/)に置き、通常作業では読まない。コードと本書が食い違う場合はコードを確認し、
同じ変更で本書を直す。

## 製品境界

Caveatは単独でinstall、設定、記録、検索、同期、公開、診断、migration、復旧、releaseできる。
dotagentsは複数製品を束ねる導入・互換・host projectionを所有するが、Caveatの状態や判断を
代行しない。Caveatの動作にdotagentsを必須依存として持ち込まない。

## 真実の源と状態

SQLite search requires a working FTS5 virtual table with the trigram tokenizer, not only a `node:sqlite` import or Node version string. A bounded in-memory create/insert/MATCH probe runs before opening or migrating the persistent index, before init/index side effects, and in managed preflight/stage/activate. Known missing FTS5/trigram fails with `CAVEAT_RUNTIME_UNSUPPORTED` and its original SQLite cause; unknown failures and probe cleanup failures remain errors. Preflight includes the measured runtime capability. No alternative search engine, empty result, or partial index is used as a fallback. This candidate does not change the numerical minimum Node version; adopting its supported-runtime wording remains a product review decision.

- 正本はmarkdown-in-git。SQLite FTS5 indexは常に再構築できる派生物。
- 自分の知識は既定で`~/.caveat/own/`、indexは`~/.caveat/index/caveat.db`。
- ユーザー設定の正本は`~/.caveatrc.json`だけ。`knowledgeRepo`で知識repoの場所を変更でき、
  `runtimeErrors: true`でlocal runtime error収集を明示的に有効化できる（既定false）。
  `runtimeErrorReportCredentialFile`へcredentialの絶対パスを書いた時だけ、未受領の記録を
  そのcredentialが指すcollectorへ署名付きで送る（既定null。パッケージに宛先は無い）。
- 任意の非secret設定`githubUser`はprivate同期のGitHub accountを名指しする。Gitとfactory診断の子だけにhelperを渡し、共有active/global Gitを変えない。ghは安定入口から`auth token --user --no-refresh`を呼び、環境token4種/他helper/askpassへfallbackしない。user不在・非対応CLI・期限切れはCAVEAT_GITHUB_*型付き拒否。設定無しは従来どおり。
- `CAVEAT_HOME`でCaveatのdata rootを明示変更できる。
- entryの主キーはsourceとidの組。sourceは`own`または`community/<handle>`。
- schemaとmigrationは`packages/core/src/schema.sql`と`packages/core/src/migrations/`が所有する。

## Entryの入出力契約

record/updateのargumentsはJSON表現のUTF-8で1MiB、合成後Markdownは1MiB、raw frontmatterは64KiB、展開したgraphは10,000 node/edgeと深さ128を上限とする。transportの10MiB上限はSDK既定を維持し、製品の上限を無制限化しない。超過はfile/index/updated_at/onEntryWrittenの前に型付き`CAVEAT.ENTRY_INPUT_CONSTRAINT`として拒否し、MCPでは`isError:true`、field/limit/actual/measure/actual_kind/guidanceを返す。byte境界はexact、parserやgraphの打切り・alias展開をdump前に止める十分条件はlower_boundと明示する。この副作用前の型付き拒否だけをMCP_TOOL_FAILEDから除外し、未知/DB例外は従来の重大度で記録する。

YAML以外のnamed frontmatter engineはgray-matterの呼出前に拒否する。YAML load/dumpは単一のCaveat schemaで行い、js-yaml4.3.2 parserに従来4.1.1のint/float scalar解決だけをMIT出典/SHA付きで組む。既存の非引用1_000はnumberとして保持し、同schemaでnumeric/yes/date-shaped stringだけを引用する。forceQuotesは使わない。parser maxDepth128と展開graphのdepth128は異なる尺度で、flow深さ110は受入、parser guardに到達した深さはtyped診断となる。循環や多重aliasはdump/JSON化前に有界検査する。

上限は書込requestと最終生成物へ掛け、既存の超過fileを削除しない。indexは超過entryをskipし、既存rowはstaleとして保全する。`caveat entry-diagnostics --json`は最後のsource別scanで除外したsource/path/id、制約、数値、file SHA、観測時刻、stale/skippedを表示する。新規scanが失敗したsourceの過去診断を成功へ置換しない。`index --full`も検査前に全rowを削除せず全fileをrescanする。既存本文をpatchして上限内へ減らせる場合は保存できる。frontmatterが安全に復元できない場合だけ更新をtyped拒否し、raw整理へ案内する。

`caveat_get`はid/sourceの従来応答を維持し、unindexed entryは診断のpathを指定して読める。超過/過深の場合は`raw_entry`、diagnosticsと明示offset/length/total/next_offsetのUTF-8 window（4..65536B）を返す。不正UTF-8はbase64と明示する。CLIは`caveat show [id] --path <relative.md> --source <source> --offset-bytes <n> --limit-bytes <n>`を使える。無言で切り詰めた全文や空frontmatterにしない。封緘communityの通常id取得は既存indexを使い、stale診断を添える。明示pathのraw取得は既存content keyでメモリ内復号し、復号Markdownをdiskへ書かず新しい認証を始めない。

公開前に実4hostのown/community corpusをread-onlyで検査し、旧/新の意味差・超過・読取不可・採取中変更が0件であることをhash/件数/型差だけで確認する。本文やsecretを監査原本へ持ち出さず、非0件は製品判断へ戻す。設計probeやCI fixtureを実corpusへ代用しない。

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
  Caveat CLIとown Markdownを使い、別hostにしかない入口を案内しない。managed導入は例外で、
  全AI hostへ既登録MCPのget/update/record/syncを案内する。MCPが使えなければ停止し、bare CLIへ戻さない。
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

## Managed deployment and stable hook identity

### New v1 placement

The immutable v1 entry for a new deployment is **`<canonical-user-home>/.caveat-deploy/managed-v1/entry/caveat.mjs`**. This is a Caveat-owned private directory directly below the user's home, independent of shared `.local` permissions, XDG variables and `CAVEAT_HOME`. Once registered, the entry derives its root from its own absolute file location; changing data/config environment variables does not move the entry. Release selection changes `active.json`, never the definition's launcher path.

Before publishing an artifact, install that exact candidate into isolated prefixes on all target hosts with their usual npm umask. Run `caveat deployment preflight --json` against each actual home. This read-only command checks the source inventory/ACL, existing ancestors, root selection, create permissions and any existing entry protocol. It creates no root, lock, pointer or AI registration. All target hosts must pass before publication; retain the observations with the final exact hook definitions. Preflight describes current conditions, so stage/activate repeat the same checks under the installer lock and still reject later changes.

`caveat deployment stage --json [--package-root <verified-package>]` copies the caller-verified package into side-by-side `releases/` directories. POSIX source files with ordinary umask 002 are accepted only below a current-user-owned, owner-only ancestor; ownership, links, hardlinks and content bounds are still checked. Only the new copy is sealed to 0700/0600, preserving owner execute, then its complete manifest is checked. Source permissions, shared ancestors and an unsafe existing managed root are never repaired automatically. Windows verifies source ACLs and explicitly seals newly created roots, entry metadata, lock, pointer and payload to the current SID.

Windows existing ancestors may be owned by the current SID, SYSTEM or Administrators, with writes by other ordinary principals rejected. The managed root and selected private metadata/payload retain current-SID ownership and owner-only ACL requirements. Accepting a privileged ancestor does not broaden the selected root ACL. OS permissions cannot distinguish a malicious same-user process or privileged administrator from the installer; that threat is outside this guarantee.

`caveat deployment activate <release-id> --json` fully validates the target, flushes a complete temporary pointer and commits it with one same-directory rename. It returns the previous release ID; use the current installer to select that ID for rollback. Normal activation rejects damaged pointers; `--recover-invalid-pointer` explicitly preserves the invalid bytes before selecting a separately verified payload. `deployment status --json` rechecks full content/native ACLs. Locks record PID/start time; status reports busy/stale/absent, and explicit `deployment unlock --json` requires ESRCH and unchanged lock identity/bytes. Age alone never permits removal.

The startup entry performs bounded pointer/manifest reads, manifest hash validation and file metadata/identity checks; it never scans the payload or starts an ACL process. Stage/activate/status own complete payload and native ACL validation. MCP and Claude/Codex/Cursor hook registration share the same fixed entry. New npm installation does not implicitly select a managed release or grant hook trust.

### Published 0.21.1 compatibility

Compatibility lives in `managedDeploymentLegacy.ts`, separately from the new placement's safety checks. A safe existing 0.21.1 root at `.local/share/caveat/managed-v1` retains its exact known public entry/runtime bytes and registered path while a current installer stages/selects new payloads. Only the two known 0.21.1 public asset hashes qualify; unknown or modified readers require explicit migration. The legacy branch does not relax ownership/mode/ACL checks. Conflicting active roots are rejected rather than silently switching registrations. The original Node 24.20 extended-main argument limitation remains: the installer emits a canonical non-extended path, and file identity accepts alternative spellings only after Node has loaded the entry.

### Migration and acceptance

The first migration from version-specific commands requires review/trust of the exact new three Codex definitions per host through Codex's normal flow. The installer never writes trusted_hash, grants another product trust or bypasses review. Static installed diagnostics do not establish native trust or conversation acceptance. Keep shared Node, PATH, credentials and native schedules unchanged unless separately authorized.

### Global migration preflight (unreleased source)

The process preflight reports an explicit observation scope, not the absence of
all possible future imports. Every observed argv is checked for old root, npm root,
alias and protected-path literals, including foreign users, ancestors, transient
processes and inline code. A bound old executable/script is a consumer; a bound
npm executable/script is a writer. Both stop the operation. Same-owner missing
exe/argv and changed birth/executable identity remain unknown and stop it. The
stable current migration process alone may carry its required scope arguments.

Typed counts cover self, non-executing (PF_KTHREAD/kernel task or a same-birth
zombie), foreign-user with readable uid/birth/argv, a finite identity-bound ancestor
chain, transient observations and outside-observed-scope processes with readable
exe/argv. No executable name alone excludes a process. Deleted-image suffixes
are recorded and stripped only for runtime/scope classification. Public results
contain counts, classifications and hashes; raw argv and native errors stay private.
Collection failure leaves counts unknown. Outside-scope scripts and helpers such
as ELECTRON_RUN_AS_NODE may dynamically import the old global after observation;
the import can fail after retention in quarantine. The product never overwrites
data to hide that failure. Package rename and owned npm uninstall have fresh
checks before and after; a newly detected consumer stops at the confirmed journal
state and requires a fresh `global-recovery-plan` before known-only recovery.

The four migration/recovery callers exclude the read-only ordinary Node/libnode
paths from the process stop scope, while retaining runtime classification. Sharing
that Node or nvm prefix alone is allowed; old-global/npm/alias/config/protected-A
literals still stop. The runtime proof independently re-reads held executable and
loaded-library identities/content and alias/parent bindings before and after each
mutation. Post-check failure retains a confirmed native move in the journal and
stops further operations; fresh recovery admission must verify all protected state
again. No runtime file is changed or repaired.

`node scripts/check-global-processes.mjs` runs serially after mutation fixtures on
each real CI runner. It records normal-table readiness and a stopped real literal
consumer. A reader fault withholds metadata for that real same-owner child to
prove refusal; this third case is explicit fault injection over a native table,
not a claim that host access permissions were changed. The check owns only its
fixture child and files; observation never signals existing processes.

Linux reads bounded procfs records. macOS uses kernel process APIs and corroborates
the executable with lsof text-file device/inode data; environment-shaped arguments
are conservatively rejected when argument boundaries cannot be proven. Windows
uses one owned CIM child with ordered progress frames and a 20-second deadline.
Only a child created by the probe may be terminated. Exit without pipe closure
does not establish completion. No privilege elevation or existing-process signals
are part of preflight.

The package contains Koffi 3.3.4 and native binaries for Linux, macOS and Windows
on x64/arm64. The packaged loader uses adjacent binaries only; it never searches
external node_modules. Loading is lazy and ordinary hooks do not inspect processes
or load the native bridge. Full preservation, guarded uninstall/recovery, wrapper replacement and the
seven-file registration migration are implemented by the separate unreleased
transaction callers described below. The preflight API does not authorize or
perform those mutations.

The unreleased path guard retains directory and leaf handles. POSIX uses
directory-relative exclusive rename; Windows opens children relative to retained
native directory handles and renames the held object without replacement. It
checks names, ancestry, ownership, metadata and bounded file-content hashes before
moving, then verifies the original identity at the destination. Visible xattrs and
Darwin extended ACLs, or Windows owner/group/DACL, have separate bounded digests.
Hidden or privileged metadata is never inferred absent from a readable projection;
the original object is retained rather than reconstructed from these digests.
Darwin extended allow ACL entries remain unclassified and are refused. Unsupported
ACL layouts, reparse objects and permission failures are stopped without repair.

A failed or incomplete move returns unknown with separately observed held/source/
destination states. It never assumes a failed syscall means unchanged state and
never automatically overwrites an unknown object during recovery. The directory
guard does not verify an entire descendant tree or establish process/writer
absence; full package preservation and the mutation journal must supply those
checks before scoped uninstall can be connected.

The native guard can create a new private journal relative to its held directory.
Only references returned by that creation may append or flush. Original object
references, read-only journal references, foreign tokens and closed references
cannot write. POSIX uses exclusive no-follow creation, 0600 files and file/parent
fsync; Windows supplies a protected current-user security descriptor at exclusive
creation and flushes its owned write handle. Each append verifies the expected
file/name/bytes, flushes and reads back before returning. Partial writes, flush
failure or failed readback poison that writer; no retry or truncation occurs.

The bounded LF JSONL format binds a plan digest and a random run ID, consecutive
sequence numbers and the previous record hash. Intent must precede a matching
confirmed/unknown result. An unfinished intent stays pending; unknown and complete
are terminal, and a partial final record stays torn evidence. Existing journals
are read-only recovery inputs and are never replayed or appended automatically.
The journal proves recorded ordering, not completion of the full migration plan;
the preservation/uninstall/recovery engine still has to verify actual state.

The unreleased preservation engine inventories descendants relative to retained
native directories, with entry/depth/byte bounds and no link traversal. It checks
every descendant's owner, link count, identity, contents and observable security,
then repeats the inventory before and after the root-object move. A same-volume
rename retains the original object, including unprojected attributes and Windows
alternate streams; the inventory never substitutes for that original. A changed
or unreadable descendant after a move yields unknown with the observed root
placement and any completed tree observation. POSIX moves also fsync both parents.

The internal engine limits original-object moves to the Caveat package, npm's
management file and the known shell leaves. Fresh package/protected-state/process
checks remain mandatory caller responsibilities before each mutation; the engine
has no CLI entry or permission bypass. It records durable intent/result for each
object, exact partial states and known-only restoration without destination
overwrite. Before the first original move it exclusively creates, flushes and
reads back a private full original-tree manifest. Before each result record it
persists the current full state and binds that file digest into the journal.
The backup directory must already be private; permissions are never repaired. This component does not yet run npm, reopen a persisted recovery plan or install
wrappers. Those integrations, final review and
candidate validation remain unfinished.

The working-copy primitive exclusively creates new private directory/file/link
objects relative to a held private staging directory. Only native references
branded by that creation may receive copied bytes, mode changes or flushes;
original, foreign and closed references cannot. It reads the retained original
through held handles, preserves content/internal link text and owner execute,
checks new file identities and private security, and rechecks the complete
original tree. The staged tree is read back before an exclusive move to the
original name. It does not unlink or overwrite competing names or failed stages.
Original native metadata and alternate streams stay on the retained original;
working copies use new private security and are not original-state backups.

The engine rechecks its original evidence bytes, writes durable copy intent,
persists exact copy outcomes and only quarantines an unchanged known working
tree before original restoration. Partial writes, changed originals or working
copies, failed flush/close and interrupted publication stay stopped/unknown.
An explicit release method accepts only a successfully created working-tree
token, allowing the future owned npm step to operate without dropping original
pins. Fresh process/protected-state integration and scoped npm remain unfinished;
this primitive is not an executable global-migration command.

The product migration caller now captures the old package/dependency closure,
Node/npm bytes and aliases, other globals and existing/absent shell leaves. It
validates the active managed payload against its manifest and retains native
objects for its pointer, entry, payload and protected settings. Before each
mutation it rechecks those objects, runtime/npm and other-global baselines, and a
fresh native process assessment. Original and working objects have separate
identities; a missing original name is never treated as a successful fresh
package snapshot. Declared peers outside the retained package also stop.

After read-only admission it creates an exclusive private run directory and
persists the complete plan. It shares the existing installer.lock protocol:
a complete owned lock moves exclusively into place, then returns to the private
run as evidence on close. It never removes someone else's lock or probes/kills
its process. No CLI collector/deadline bypass is provided.

The owned npm child uses the fixed Node and npm script with only caveat-cli,
a bound global prefix, ignore-scripts/offline/no-audit/no-fund flags, private
empty user/global config and a restricted environment without inherited Node
options, npm configuration or credentials. Its started, exit and close events
are distinct. Timeout, failed receipts, nonzero exit or unconfirmed close are
never success; only that spawned child can receive a single termination request.
Captured output is bounded/hashed and never returned raw. Closing owned capture
handles after timeout does not prove close or descendant exit.

Working pins alone are released before npm. After confirmed child termination,
the caller rechecks original/protected state and processes. Only full absence or
a deletion-only subset with the same known file identities/bytes/security can be
accepted for recovery. New or changed objects remain unknown and untouched, with
the observed after-tree preserved. A known partial tree may be quarantined before
original restoration; interrupted or unknown journals are never replayed.
Generated wrappers now publish exclusively from owned private files. Only a file
born as this guard's journal may be sealed executable; sealing invalidates its
write token, closes the write handle once and binds the reopened native identity,
bytes and security before a relative move. Original/foreign/read-only references
cannot be sealed. A complete private manifest directory is similarly closed and
rebound before publication. The v2 shell manifest explicitly uses native guard
identities; legacy v1 capture/status retains its existing format. The new
publication path uses no PATH PowerShell reader. Accepted bin aliases are bound;
redirecting a separate prefix bin outside the canonical layout is refused.

Each wrapper/manifest operation persists intent, exact result and current state.
Before and after publication it reuses the preservation engine's original-tree/
original-evidence verification and sticky stop state, alongside fresh process and
protected-state checks. A changed backup cannot be hidden by a healthy wrapper.
Known partial publication can be quarantined after a fresh successful check,
then originals restored in their required order. Unknown publication retains
separate destination/stage/quarantine observations and is never replayed or
removed to make the result appear successful. Original absence is restored too.

Recovery inspection opens private plan/original/state/journal evidence read-only,
checks canonical JSON, scope, sequence/hash references and current full original,
working/generated/protected trees plus Node/npm/other globals. Its total evidence
is limited to 256 files/64MiB; each file remains bounded to16MiB. Evidence is
rechecked before returning. Pending/torn/unknown stops before replay. A matching
observation grants no execution permission and starts no child or filesystem
write. It does not reopen a writer or execute recovery actions.

Native-v2 status now opens the private bounded manifest through the native guard,
verifies the selected A payload/entry, ordinary Node proof and rendered wrapper
identities, and finishes fresh readback before reporting payload health. It uses
no PATH PowerShell child. Legacy v1 status remains compatible; the async product
status caller selects the manifest version without reinterpreting v1 identities.
An unknown native read never falls back to the legacy reader.

The product `deployment global-plan --global-root <global-node-modules>
--npm-cli <absolute-npm-cli.js> --json` performs read-only admission, using normal
product settings paths and the production native process/writer collector. It
creates no private run or installer lock. Its digest binds the active.json boundary,
input aliases/canonical targets, parent identities/security, existing protected
settings and absent settings with their nearest existing parents. It reads no
knowledge repository or credential store. Unknown processes/writers stop admission.

`deployment global-migrate` takes the same inputs plus mandatory
`--expected-plan-sha256 <digest> --json`. The coordinator checks that reviewed
plan digest before preparation, repeats fresh admission, then connects original
preservation, working copies, fixed ordinary Node/npm uninstall, exclusive shell
publication and independent status readback. Ordered bounded phase receipts omit
raw paths, argv and exception text. The full preservation engine verification
remains mandatory around wrapper operations. A complete journal is a mutation
checkpoint, not proof of subsequent close or independent status. Final readback
reopens all saved original/state/journal/protected/working/generated evidence
read-only against the checkpoint journal byte digest (a replacement empty
completion is not a full state match), then must also match the reviewed pointer
bytes, executable Node proof and rendered
wrapper paths/hashes; a separately healthy selection cannot substitute for that
reviewed plan after the original guard closes. Partial/unknown
results are preserved; there is no automatic replay, unlink or overwrite.

`deployment global-inspect-recovery <run-id> --plan-sha256 <digest> --json`
inspects bounded saved migration evidence read-only and returns its full evidence
digest. It grants no execution permission and does not open a writer.

`deployment global-recover <migration-or-recovery-run-id> --plan-sha256 <digest>
--evidence-sha256 <digest> --json` separately restores independently proved original
objects. It requires matching plan and full evidence digests, holds old evidence
read-only, and rebinds current original/working/generated objects, protected
state, aliases/parents/absences, Node/npm/other globals and the production native
process/writer collector. A legitimately absent package is not a new package
snapshot failure. Unknown or pending/torn/unknown source intent stops before a
new run. Another installer lock is retained unchanged.

The new exclusive private recovery directory is bound to the source evidence
digest and cannot be reused. Only its new journal receives intent/result writes.
Fresh verification occurs before intent and again after intent flush, immediately
before each rename. Known generated objects and remaining working copies move
into owned quarantine, then exact original objects move back in package/npm
management/old-leaf order. Original contents and permissions are never rewritten;
unknown names are never removed or overwritten. New state records distinguish
confirmed observations from uncertain ones and say whether rename was issued.
A lost receipt leaves pending/unknown history and never grants replay.

Before reporting restored, recovery verifies the full state, captures its complete
journal digest, closes the original guard and independently reopens all current
objects, protected state, source evidence and new result files. A checkpoint
alone is not proof of that later readback. A separately changed object is retained
as unknown rather than silently repaired.

`global-inspect-recovery` also accepts a recovery-attempt id. This only verifies
its bounded journal/result evidence: `currentObjects: not-assessed` and
`executionPermission: false` are explicit even for a complete journal. Resuming
from a known partial recovery-attempt requires the separately reviewed fresh
binding described below; journal inspection does not supply it. The final
candidate requires validation of the exact versioned source and packaged artifact.
These source commands do not grant approval for distribution or machine changes.

Ordinary Node selection uses an explicit absolute executable path, independently
of the interpreter running Caveat. A bounded owned child uses a restricted
environment, tests in-memory SQLite FTS5/trigram, and reports the actual loaded
libnode dependencies from Node's diagnostic report. Spawn, exit and pipe close
must all succeed. The product binds alias identity, canonical file identity,
contents, native security and every parent for the executable and reported
libnode files, then repeats the capability under those held bindings. A shared
build with missing or inconsistent dependency evidence is explicitly refused.
No runtime/library permissions are repaired. This proof covers the executable
and libnode; it does not attest every system library or the whole host.

The stable runtime proof enters the reviewed plan, native shell manifest,
coordinator readback digest and recovery admission; transient child PIDs do not
change the plan hash. Every mutation gate freshly checks binary/library bindings
and includes their alias/canonical paths in the native process/writer scope.
Native status independently reads those objects without claiming process/writer
absence (`processAssessment: not-performed`). Legacy saved history remains
readable; a missing runtime proof cannot grant new execution or a native-ready
result. The immutable entry/runtime sources and accepted bytes remain unchanged.

Confirmed partial recovery journals may be planned with `deployment global-recovery-plan
<run-id> --plan-sha256 <original-digest> --json`. This is read-only: no run, lock or
execution permission. A successful result supplies a full evidence digest for a
separate `global-recover` invocation. The source chain is limited to eight runs,
256 referenced files and 64 MiB in total; every run must have its exact canonical
private directory. Pending, torn or unknown intents anywhere in the chain stop
before a new journal is created. Source plan/seed and confirmed transitions derive
all allowed names and current object locations. A saved path is never authority.
New migration plans also bind the full native original trees before mutation;
original seed rows must match that reviewed identity/content/security exactly.
Legacy evidence remains readable, but a recovery chain without this native plan
anchor is explicitly refused rather than upgrading its trust from journal hashes.
The digest binds every source reference, derived state and fresh parent bindings;
current objects, absences, aliases, protected state and native process/writer gates
are rechecked independently at execution. Each attempt uses a new private journal.
Old evidence stays read-only, and independent post-close readback covers every
source directory as well as the new attempt and restored/quarantined objects.
Journal-only inspection of a recovery run remains `currentObjects: not-assessed`
and `executionPermission: false`, including completed journals.

### Saved seven-file registration Node migration (unreleased source)

`deployment registration-plan --observation <saved-json> --proposal <saved-json>
--node-version <exact-version> --json` admits the saved Main projection schemas
`caveat.main15_readonly_confirmation.v1` and
`caveat.main15_node_migration_proposal.v1`. Saved paths are assertions against
seven normal configuration paths derived from the current home, never authority
for arbitrary files. The plan requires exactly four MCP definitions and eleven
Claude/Codex/Cursor hook roles. All fifteen exact pointers, original metadata and
command/argument hashes must agree. The saved Node candidate is independently
resolved and proven with the ordinary Node/libnode capability described above;
neither its saved name nor an earlier observation establishes current acceptance.
The selected binary and its loaded libnode dependencies must also be outside the
recorded retired dedicated Node root.

`deployment registration-migrate` takes the same inputs plus
`--expected-plan-sha256 <reviewed-digest> --clients-closed`. Planning creates no run or installer
lock and returns no execution permission. Execution repeats fresh process/writer,
native object, parent, alias, protected A pointer/entry/payload and runtime proof
checks before and after each same-file pair. Retain/publish and recovery
quarantine/restore run synchronously, with native identity/evidence checks and
durable intent/result writes between the two no-replace renames. No asynchronous
process collection or promise scheduling occurs while that name is vacant. It never reads the retired Node executable,
changes its permissions, modifies hook trust or changes any existing process.
The reviewed plan lists Claude Code (`~/.claude.json` and settings), Codex
(config and hooks), Grok (config), and Cursor (MCP and hooks) with all seven paths.
The operator must close those clients plus other editors/automation writing these
files and explicitly attest `--clients-closed` for migration and recovery. This
attestation never grants execution permission or proves process absence; the
product does not close clients. B uninstall does not require this flag.
The new configuration files are private; each complete original object, including
its native identity, contents and security, is moved without replacement to the
new private run before its new file is installed. Unknown names are retained and
stop the operation. The pair is not an atomic exchange: synchronous validation
and durable flush still take time. A concurrent writer, crash or unknown rename
can leave the original in private backup and require manual recovery. Known
non-move errors are not yet distinguished from unknown outcomes; pending/torn/unknown
recovery remains refused. These residual risks accompany plan/execution results
and the separate Owner request. No whole-document serialization or in-place overwrite occurs.

The codec uses strict JSON with duplicate-key rejection and the existing TOML
parser. JSON AST locations select exact pointer targets, including distinct hooks
with identical command values; only the encoded leading Node token is replaced.
TOML accepts a uniquely located single-line command string and refuses ambiguous
or multiline command targets. Both formats are parsed again and compared against
the complete expected semantic value. All other source bytes, MCP arguments,
hook suffixes, entry paths and unrelated values remain unchanged. The saved MCP
argument hash uses the original comma-space JSON array encoding, not a compact
reserialization. Missing full original configuration bytes are not reconstructed
from the saved projection; execution must bind the exact original files.

`deployment registration-recovery-plan <run-id> --plan-sha256 <original-digest>
--json` derives current placements only from that approved plan, its native seed
and a finite chain of confirmed moves. It verifies every source privately and
read-only, current originals/replacements, missing target names, all parents,
protected state and fresh runtime/process proof. Its full evidence digest binds
all source references, derived state and current directory bindings.
`registration-recover` requires that digest through `--evidence-sha256` plus
`--clients-closed`; each
attempt creates a separate private journal, quarantines only known installed
replacements and restores only the held original objects. It never replays a
saved intent or modifies an ancestor journal. Chains stop at eight runs, 256
references and 64 MiB; cycles, reused journal identities, redirected directories,
pending/torn/unknown ancestors and reuse of an existing attempt are refused.
Independent post-close readback covers every source/new directory, journal,
protected object and current original/replacement before completion is reported.
`registration-inspect` reads only bounded saved plan/journal evidence and always
returns `currentObjects: not-assessed` and `executionPermission: false`.

### Windows hookの保護保存transport（未公開source）

Hookの集計/詳細保存は同じ同期API・排他・atomic renameと全ACL checkpointを保つ。Windowsでは1hook限りのlazy Worker/PowerShell sessionで各要求を順に実行し、ACL結果はcacheしない。disabled/POSIXはhelperを起動しない。既30秒guardを保持し、拒否/不正応答/起動失敗/timeoutはcauseを失わずunavailable、拒否後も次storeを独立に試す。helperは両保存後に明示終了し、終了異常は原hook診断と共に表面化する。共有Node/実席設定や固定entry/runtime bytesを変更する機構ではない。

## MCP runtimeの読込み境界（次版source）

通常hook/検索等はMCP SDKのmodule評価を必要としない。MCP server実装はpack必須asset `dist/mcp-server.js` に分離し、`mcp-server` command境界で読み込む。読込みとserver起動の失敗は従来の `CAVEAT.MCP_SERVER_FAILED` を記録して元例外を返す。MCPの検証/transport/ツール契約を省略せず、通常stdio経路で受け入れる。固定managed entry/runtimeのbytesを変更しない。

## managed導入のAI操作案内（0.21.7）

managed rootが確実に不在の場合だけ、通常npm導入の既存案内を維持する。存在・破損・読取不明ならPATHのcaveatを案内しない。詳細はcaveat_getにid+source、更新/新規はcaveat_update/caveat_recordを使い、raw編集後のindex手順は出さない。

caveat_syncはstrict空入力で、自分のMCP contextのown repoとconfig.githubUserだけを既syncOwnへ渡す。community pull、remote作成、任意URL/user/command、認証変更は行わない。私有知識を既remoteへpushするためopenWorldHint:trueとし、readOnlyHintを付けずclientの承認方針を保つ。

Git/reindex lockは既存と共用し重複はSYNC_BUSY。clientのtimeout/cancelは進行中syncを中断しない。完了/失敗の固定summaryはcaveatHome/sync/mcp-sync.jsonへ残し、deployment statusのownSyncで読める。runningは成功を意味せず、server強制終了などの未完了も成功へ補完しない。結果とエラーに資格・remote URL・Git標準出力を返さない。

## Git子の安全境界（0.21.8）

simple-git4.0.2/argv-parser2.0.1へ固定し、検出したunsafe categoryの自動許可をしない。EDITOR/VISUAL/GIT_EDITOR/GIT_SEQUENCE_EDITOR/PAGER/GIT_PAGERと不要なtraceは非対話子から外し、親envは変えない。未検証GIT_CONFIG_*、SSH命令、askpass、その他のunsafe category/未知Git環境は値を出さないSyncError CAVEAT_GIT_ENV_UNSAFEで拒否する。署名したnamed helperとHTTPS protocolだけを製品が作る一つのGit instanceでopt-inする。

4系のallowEnvironmentは、製品が検証・構成した子envを渡す仕組みでありunsafe flagを許す機能ではない。author/committer metadataと既TLS入力、製品固定の非対話/HTTP低速上限だけを既定入力として扱う。named時のGIT_ALLOW_PROTOCOL=httpsは製品生成値のみ。利用者のcore.askPassがある場合は値を読まず名前でCAVEAT_GITHUB_CONFIG_UNSUPPORTEDとし、空resetのためにallowUnsafeAskPassを追加しない。inline include/includeIf/trailer/略記とその他upstream guardは無効にしない。
