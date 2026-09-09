# Windowsの長いGitパス

取得日: 2026-09-10。確度: 公式仕様とWindows native実測で確認。

一次資料: [Git for Windowsのcore設定](https://github.com/git-for-windows/git/blob/main/Documentation/config/core.adoc)。取得時の本文は`raw/core.adoc`。

`core.longpaths`はGit for Windowsのbuiltin commandで260文字を超えるパスを扱う設定で、既定では無効。
CaveatのNodeによるentry作成は成功しても、Gitの追加で失敗し得る。
Windows実データの`init --sync --yes`と隔離した最小試験で確認した。

`createGit`がWindowsで起動するGitにだけ`-c core.longpaths=true`を渡す。
同じ長いファイルの追加・commit・clone・読戻しを実機試験した。
ユーザーのGit設定ファイルには書かない。Explorerや外部shellの長いパス対応を保証する変更ではない。

反証: 設定をfalseにした同じGitの追加は`Filename too long`で失敗する。
修理前の`createGit`も失敗し、修理後は成功した。関連するGit実行・同期を含め18試験成功。
