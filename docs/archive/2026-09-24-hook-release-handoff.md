# Hook通知削減とJev導入の公開結果

## 現在地

- Caveat v0.19.3はnpm公開済みで、Mac・main-server・Windowsへ導入済み。差分通知、同一sessionの罠ID抑止、OS適用条件、Jevの3ターン苦戦判定、codex-sidecar連携撤去を含む。
- v0.19.4のcommitとtagはmainへpush済みだが、npmには公開していない。Jevに記録環境と適用条件を分けて渡す修正はv0.19.5へ含めた。
- v0.19.5のcommit `5700452` とtagはmainへpush済み。Codexの終了コード0が明示されたツール結果を罠検索へ送らない修正を追加した。Mac・Linux・WindowsのCI、ローカルのビルド・型検査・配布物検査・関連テストは成功。
- v0.19.5はnpmへ公開済み。新規npm導入・初期化2回の冪等性・Claude/Codex/Cursor診断・4クライアントのMCP接続と検索を隔離環境で確認した。Mac・main-server・Windowsへ公式npm版を導入し、各端末で初期化2回、製品診断`ready`、Jevの有効化、4クライアントのMCP接続と検索を確認した。Macの新規Codex/Claudeセッションsmokeも成功した。[GitHub Release v0.19.5](https://github.com/kitepon/Caveat/releases/tag/v0.19.5)は公開済み。
- v0.19.5のCaveat内統合試験では、隔離した完了3ターンを実際のJev APIとローカルFTSへ渡し、関連知見1件の選別と同一ターンの再通知抑止を確認した。実セッションのThroughline鮮度検査を含む通し試験は未実施。
- `tools-manager`の週次グローバルnpm更新リストからcodex-sidecar 3パッケージを除き、commit `19b94e6` をpush済み。Kikoeruのコンテナ側依存はKikoeruプロジェクトで移行中であり、sidecar製品の完全停止・npm廃止表示は待つ。
- Observerの撤去は別セッションの担当。fox-wslはSSHに到達できず未更新。

## 残る実利用観測

1. 実セッションでThroughlineの完了3ターン投影からJevの判定・ローカル検索・一度だけの通知まで確認する。現時点の隔離試験は実Jev APIとFTSを通したが、実セッションのThroughline鮮度検査を含まない。
2. 配布後の実ログで注入量と新しい罠・シグナルの到達を測る。旧ログの同条件replayではClaudeが21,247→3,324字、Codexが125,907→32,980字だったが、これは配布後7日分の実測ではない。
3. Kikoeruのsidecar依存撤去が完了した後に、codex-sidecar製品の完全停止・npm廃止表示を別作業で閉じる。Observer撤去も別セッションの担当。fox-wslはSSHに到達できず未更新。

## 配布時の注意

- v0.19.4 tagは残るがnpmへ公開していない。
- 既存のpendingには旧版が作った通知が残る。新版の成功判定は今後の生成分に効く。
