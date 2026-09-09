# pnpm 10とnpm 12の公開引数

取得日: 2026-09-10。確度: 実装と実測で確認。

pnpm 10.0.0のpublishは元の引数の先頭を除いた配列をnpmへ渡す。
`--dir apps/cli publish`の順では`apps/cli publish`が残り、npm 12.0.2はEUSAGEになる。
`--no-git-checks`もnpmへ渡り、EUNKNOWNCONFIGになる。

MacのNode 26.8.1 / npm 12.0.2 / pnpm 10.0.0で再現した。
`apps/cli`を作業ディレクトリにし、`corepack pnpm publish --dry-run`で成功した。
通常のGit検査とCaveatのprepublishOnlyは両方を維持する。

出典: [pnpm 10.0.0 publish実装](https://github.com/pnpm/pnpm/blob/v10.0.0/releasing/plugin-commands-publishing/src/publish.ts)。
短い原文は[raw](raw/publish.md)に保存。
