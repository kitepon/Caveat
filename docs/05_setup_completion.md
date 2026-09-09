# 単独導入の完成計画

起点は `origin/codex/product-owned-setup` の `6a9fb39`。修正対象はCaveat repoとCaveatが所有する導入先だけとする。

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

## 現在地

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
- 残作業はCIの待機ジョブ、npm公開、公開npm版の実機導入とhost smoke。Macのnpm再認証、WindowsのGitHub再認証、MacのSSHリモートログイン有効化を依頼中。公開版はまだ更新しておらず、工場の肩代わり削除は公開後の受入まで保留する。
- 文書のみのCIで、setup-nodeの自動キャッシュがpnpm導入前にpnpmを呼ぶ失敗を確認した。自動キャッシュを無効にし、Corepackによる既存の依存導入順序を維持した。workflow契約のfocused試験は成功。文書だけの後続commitで実CIを再確認する。

参照: [採用中のsetup-nodeの入力定義](https://github.com/actions/setup-node/blob/a0853c24544627f65ddf259abe73b1d18a591444/action.yml)。
