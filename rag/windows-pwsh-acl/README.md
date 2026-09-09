# WindowsのACL処理をPowerShell 7で実行する

出典: [一次資料](raw/set-acl.md)、`packages/core/tests/runtimeErrorsAcl.test.ts`の実機実行。
取得日: 2026-09-10
確度: confirmed（一般ユーザー）、CIサービスユーザーでの再検証は進行中。

PowerShell 7.6.5の実機では`System.IO.Directory.GetAccessControl`は存在しない。
`Get-Acl`と`Set-Acl`は使用できるため、CaveatのACL処理は`pwsh.exe`とこれらのcmdletを使う。
パスを`-LiteralPath`で渡し、非停止エラーは`ErrorActionPreference=Stop`で失敗として扱う。

所有者SID、非継承のAllow ACEが1件だけ、FullControlを持つという既存の検証条件は維持する。
実機試験ではディレクトリとファイルの適用・読戻しが成功し、EveryoneのRead ACEを追加すると
検証が終了コード42で拒否した。既存エラー収集試験も成功した。

旧CIは`store_unsafe`だけを返しており、その時のACL失敗の内訳は確定できない。
外向きのエラー語彙と保存schemaを変えず、内部`Error.cause`にseamの詳細を保持して追跡する。
