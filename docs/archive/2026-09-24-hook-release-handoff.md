# Hook通知削減とJev導入の公開待ち

## 現在地

- Caveat v0.19.3はnpm公開済みで、Mac・main-server・Windowsへ導入済み。差分通知、同一sessionの罠ID抑止、OS適用条件、Jevの3ターン苦戦判定、codex-sidecar連携撤去を含む。
- v0.19.4のcommitとtagはmainへpush済みだが、npm公開は認証ページの404で未完了。Jevに記録環境と適用条件を分けて渡す修正を含む。
- v0.19.5のcommit `5700452` とtagはmainへpush済み。Codexの終了コード0が明示されたツール結果を罠検索へ送らない修正を追加した。Mac・Linux・WindowsのCI、ローカルのビルド・型検査・配布物検査・関連テストは成功。**npm、GitHub Release、実機導入は未完了**。
- v0.19.5のCaveat内統合試験では、隔離した完了3ターンを実際のJev APIとローカルFTSへ渡し、関連知見1件の選別と同一ターンの再通知抑止を確認した。実セッションのThroughline鮮度検査を含む通し試験は未実施。
- `tools-manager`の週次グローバルnpm更新リストからcodex-sidecar 3パッケージを除き、commit `19b94e6` をpush済み。Kikoeruのコンテナ側依存はKikoeruプロジェクトで移行中であり、sidecar製品の完全停止・npm廃止表示は待つ。
- Observerの撤去は別セッションの担当。fox-wslはSSHに到達できず未更新。

## 再開時の順序

1. オーナーがnpm認証ページをすぐ操作できる時に、`apps/cli`で`corepack pnpm publish`を実行する。先に発行した認証URLは失効済みなので使わない。公開する版はv0.19.5のみ。
2. registryで`caveat-cli@0.19.5`を確認し、公開版を一時prefixへ新規導入してCLIとhookを検査する。
3. Mac・main-server・Windowsに公開版を公式npm経由で導入し、`caveat init --sync --yes`を二度実行して製品診断とMCP接続を確認する。設定ファイルのtarバックアップは3端末とも作成済み。
4. 公開版の新規セッションsmokeを行い、v0.19.5のGitHub Releaseを作成する。v0.19.4はnpm未公開であることをrelease noteへ明記する。
5. 配布後の実ログで注入量と新しい罠・シグナルの到達を測る。旧ログの同条件replayではClaudeが21,247→3,324字、Codexが125,907→32,980字だったが、これは配布後7日分の実測ではない。

## 公開前の注意

- main上のv0.19.5 release commitを使う。v0.19.4 tagは残るがnpmへ公開しない。
- 現在の実機はv0.19.3のため、今回の二修正はまだ利用者へ届いていない。
- 既存のpendingには旧版が作った通知が残る。新版の成功判定は今後の生成分に効く。
