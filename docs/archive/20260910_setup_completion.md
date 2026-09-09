# 単独導入の完成記録

起点は `origin/codex/product-owned-setup` の `6a9fb39`。修正対象はCaveat repoとCaveatが所有する導入先だけとする。

## 完了記録（2026-09-10）

公開版は[`v0.19.1`](https://github.com/kitepon/Caveat/releases/tag/v0.19.1)、公開commitは
`8866a7c4f554`。既定ブランチへの着地、3環境の[CI](https://github.com/kitepon/Caveat/actions/runs/34414621733)、
pnpmによるnpm公開、公式npmでの実機更新、公開後smokeまで完了した。
0.19.0の導入改修に、Windows実データで発見した長いGitパスの修理を加えて届けた。

| 実測 | macOS | Linux | Windows native / PowerShell 7 |
|---|---|---|---|
| 公開npm版の公式導入・version | 0.19.1 | 0.19.1 | 0.19.1 |
| 実データの初期化・private同期・再実行 | 成功 | 成功 | 長いentryを含め成功 |
| 既存設定の保持・再実行時の完全一致 | 8ファイルで成功 | 8ファイルで成功 | 8ファイルで成功 |
| Claude / Codex / Grok / Cursor MCP検索 | すべて成功 | すべて成功 | すべて成功 |
| 空remote初回・既存remote checkout・更新後の再設定 | 隔離した公開版で成功 | 隔離した公開版で成功 | 隔離した公開版で成功 |
| 新規Claudeセッション | 成功 | 未実施：未認証 | 成功 |
| 新規Codexセッション | 成功 | 成功 | 未実施：CLI未導入 |
| Claude・Codex・Cursor hook解除 | 隔離設定で成功 | 隔離設定で成功 | 隔離設定で成功 |
| 製品診断（Cursor必須） | ready | ready | Codex以外ready。既存hook拒否を保持したため全体はnot_ready |

Codex補助連携はLinuxでStopとツール失敗の両方が成功し、App Serverのmodel・effort・入力・完了turnを確認した。
Macでは既存の認証leaseが使用中で実行できず、他製品の状態は変更していない。
GrokはMCP連携を確認し、独自hookは追加していない。Cursorには製品所有の新規セッション試験がなく、
installer・adapter試験と公開版の診断・MCP検索で確認した。

初回の空remote試験は実Gitの隔離bare repositoryを使った。実GitHubでは既存private remoteとの同期を確認し、
新規GitHub private repositoryの作成は行っていない。
Linuxの同期再実行は別端末の同時pushに一度拒否された。エラーは非0終了として表れ、
他端末の更新後に同じ正規コマンドを再実行して成功した。

全build・typecheck・公開前smoke、ローカルworkspaceの607試験（OS条件による2件skip）が成功した。
Windowsの長いパスは修理前の失敗と修理後の追加・commit・cloneを実機で確認し、関連18試験が成功した。
別ベンダーの反証は設定先・設定保持・診断・ACL・Git境界について回収し、確認できた指摘を修理した。
文書は全体を検査し、現行案内と配布物のリンク検査も通過した。

## 工場への引継ぎ

dotagentsが削除できる肩代わりは、Caveat内部scaffoldの手動復旧、初期化・同期の内部順序の組立て、
Claude / Codex / Grok / CursorへのMCP登録の代行と、更新後の登録パス手補正である。
製品の導入・更新・診断には次の公開入口を使う。

```sh
npm install -g caveat-cli@latest
caveat init --sync --yes
caveat factory-diagnostics --json --require-connector cursor
```

最初の2行は初回と更新で共通。認証・AI CLIの導入・明示したhook拒否の判断は利用環境が所有する。
工場は端末配置と製品診断の集約を続け、内部設定を再実装しない。
dotagentsと別製品repoは変更していない。工場の削除作業は次の担当へ引き継ぐ。

## 受入条件

公開npm版の `caveat init --sync --yes` が初回、既存private remote、再実行、更新後の再設定を完結する。scaffold復旧・同期・4 AIのMCP登録を製品が所有し、既存env・timeout・無効化指定・他登録・公開ミラー設定・host別reminder契約を保持する。

## 工程

1. 引継ぎ差分とmain包含を確認し、未確認のuninstall変更をfocused試験とCLI再buildで検証する。
2. 初期化・同期・AI設定の実コードと再現を確認し、原因のある不備を修理する。全Markdownを点検し、現行案内を更新する。
3. 別ベンダーによる境界反証を回収し、指摘を実測で裁定する。
4. release checklistのgate、main統合、commit・push・tag・CI・pnpm公開を行う。
5. MacとSSH先のLinux・Windows nativeで公開npm版を公式導入し、初期化・更新・診断・MCP検索・利用可能なhost smokeを確認する。共有AI設定への導入は端末ごとに直列で行う。
6. 実測・未実施・正規コマンド・工場が削除できる肩代わりを報告する。

## 境界と既知の罠

Grok独自hook、dotagents修理、別製品repo変更は対象外。WindowsはPowerShell 7を使う。模擬試験とCIは実端末導入の代わりにしない。buildとtypecheckは直列に行う。認証に人の操作が必要な場合は必要操作を明示する。

## 配置と裁定

受入が公開・実機へ連鎖し、境界裁定の証跡が必要なため統括レーンを適用する。契約・修正・公開・受入は親が担当する。別ベンダーの読取専用反証を並行実行し、同一repoのwriterは親1名とする。Lattice工程管理は使用しない。

## 作業経過（各時点の記録）

- 公開0.19.0の隔離npm導入試験はMac・Linux・Windowsで成功。Mac・Linuxの実設定でも初期化・同期・再実行・4 AI MCP検索が成功した。
- Windows実データで長いentryパスのGit追加が失敗した。最小再現は修理前に失敗し、`createGit`でWindowsだけ`core.longpaths=true`を渡した後は追加・commit・cloneに成功した。関連18試験も成功。修理を0.19.1として公開し、実機導入の受入を続ける。
- 長いパスの別ベンダー反証でGit所有責務・設定非永続化の妥当性を確認した。OS判定を正典の`isWindows()`へ合わせる指摘を採択した。公開前のbuild・typecheck・smoke・workspace全試験は成功した。
- 作業ツリー・stashはclean。指定commitをfetchし、そのブランチへ切替済み。origin/mainは祖先である。
- 導入関連3ファイル29試験とCLI再buildが成功。
- 別ベンダーの反証で設定先不一致、Codex CLIなし時のMCP欠落、Claude追加設定の診断偽陰性を確認した。
- 設定先resolver共有、Claude CLIに依存しない解除、Codex設定dir検出、TTYでのyes、dry-run無変更、追加設定の診断を修理した。いずれも修理前にfocusedで再現した。
- 修理後は導入・解除・MCP関連30試験、初期化9試験、配布CLI診断6試験、同期11試験、初期化・索引4試験が成功。CLI再build済み。
- SSHでLinuxとWindows nativeに接続済み。WindowsはPowerShell 7で実行し、GitHub認証失効とprivate remoteのログイン要求を確認した。利用者に再認証を依頼中。公開・実機への新版導入は未実施。
- 全build、typecheck、公開前smoke、workspace全試験が成功。npmの配布JSON形式変更を実測し、配列とpackage名付き形式を文書検査で扱う修理を加えた。文書focused 9件、全71文書のリンク検査が成功。
- Grokの最終境界反証を回収し、前回4件すべての解消、新規確定欠陥なしを確認した。親も再現試験と実diffから採択した。dotagents runtime依存とGrok独自hookは追加していない。
- npm公開用のMac認証も401となり、再ログインを依頼した。統合・公開・公開後実機smokeは引き続き工程の受入に含む。
- `82e5e13`をmainへ統合・pushした。Windows nativeでは全build/typecheck、導入focused、文書・pack・npm隔離導入、初回空remote・既存remote・再実行・実行パス更新・4 AI MCP検索・設定保持を確認した。これは公開版の実機導入とは別の事前検証である。
- Windows CIの既存エラー収集試験5件が`store_unsafe`で失敗した。旧PowerShell呼出しをPowerShell 7へ揃え、同環境で存在しない静的ACL APIを`Get-Acl` / `Set-Acl`へ変更した。所有者限定判定は維持し、内部causeに診断を残した。一般ユーザーの実機focusedは17件成功・1件既存skip。第三者Read追加は拒否した。サービスユーザーでのCI再検証は未実施。
- ACL変更も別ベンダーの境界反証で新規確定欠陥なし。親は実機focusedと突合して採択した。変更後の全build・typecheck・公開前smoke・workspace全試験は成功。
- `6eabd0a`をmainへpush済み。Mac nativeとWindows nativeのCIが成功し、Windowsのサービスユーザーでも全試験を通過した。SSH先の一般ユーザーでもworkspace全試験と最終pack・npm隔離導入が成功した。旧ACL失敗の内訳は確定していないが、PowerShell 7での処理と拒否契約は実測できた。
- Macのnpm認証とWindowsのGitHub再認証が完了し、Windowsのprivate remote到達も確認した。オーナー裁定によりMacはローカル、Linux・WindowsはSSHで検証する。Macのリモートログインは不要。公開版の受入までは工場の肩代わり削除を保留する。
- CIの待機原因は、退役したWSLと旧Linux labelの要求だった。現行の3環境へ修正し、Linuxはfull CI用の`linux-workstation`へ割り当てる。工場のrunnerや他製品repoは変更しない。
- 文書のみのCIで、setup-nodeの自動キャッシュがpnpm導入前にpnpmを呼ぶ失敗を確認した。自動キャッシュを無効にし、Corepackによる既存の依存導入順序を維持した。workflow契約のfocused試験は成功。文書だけの後続commitで実CIを再確認する。

参照: [採用中のsetup-nodeの入力定義](https://github.com/actions/setup-node/blob/a0853c24544627f65ddf259abe73b1d18a591444/action.yml)。

文書CIでNode準備・依存導入の通過後、生成済みCLIへのリンクがfresh checkoutで切れることも確認した。
CLAUDE.mdの参照をビルド設定へ変更し、未ビルドのcheckoutでも文書を検査できるようにした。

- `96f1df3`のCIは現役3環境すべてで成功した。pnpm 10とnpm 12の公開引数転送をdry-runで切り分け、`apps/cli`内でGit検査を有効にして公開する手順へ修正した。配布物のdry-runは成功した。
