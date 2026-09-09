# 0002: 製品が所有する初期化・同期・AI登録の受入

日付: 2026-09-10。状態: 採択。

## 判断

公開commit `8866a7c4f554`、npm版`0.19.1`の導入改修を受け入れる。
Caveatが内部scaffold・同期・4 AIのMCP登録を所有し、工場がこれらを代行する必要はなくなった。
現在の利用契約は[製品契約](../01_plan.md)と[README](../../README.ja.md)を参照する。

## 根拠

[完成記録](../archive/20260910_setup_completion.md)の実機受入表を根拠とする。
3 OSの公開npm版で初期化・同期・再実行・設定保持・MCP検索が成功し、利用可能な新規セッションと
補助連携を確認した。Windowsの長いパスは修理前後の実測を伴う。公開前検査と3 OSのCIも成功した。

別ベンダーによる読取専用反証で、設定先・既存値保持・診断・ACL・Gitの責務を確認した。
確定指摘を修理し、Windows固有処理は既存のOS共通入口を使うようにした。

## 受入の限界

Windowsの既存Codex hook拒否は保持したため、総合診断の`not_ready`を成功へ読み替えない。
未認証のLinux Claude、CLI未導入のWindows Codexは新規セッション未実施として残す。
新規GitHub private repo作成は実施せず、初回は隔離bare remote、実GitHubは既存private remoteで確認した。
dotagentsの削除作業と別製品repoの変更は、この受入に含めない。
