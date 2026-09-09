# Caveat documentation overview

このファイルが文書の入口である。通常作業で読むのは「現行」だけとし、履歴は理由や過去判断を
調べる場合に限って開く。

## 現行

| 文書 | 所有する判断 |
|---|---|
| [`../README.md`](../README.md) / [`../README.ja.md`](../README.ja.md) | install、設定、利用、同期、封緘公開、診断、復旧の利用者入口 |
| [`../CLAUDE.md`](../CLAUDE.md) | 実装構造、検証コマンド、host・OS境界 |
| [`../AGENTS.md`](../AGENTS.md) | Claude以外のagent向け入口と文書寿命 |
| [`01_plan.md`](01_plan.md) | 製品契約、状態、配布、単独運用、文書所有境界 |
| [`03_dual_agent_support.md`](03_dual_agent_support.md) | Claude / Codex / Cursor host adapterとsidecar境界 |
| [`04_release_checklist.md`](04_release_checklist.md) | npm publishからfresh install・host smokeまでのrelease gate |
| [`../keyserver/README.md`](../keyserver/README.md) | sealed bundleの鍵配布とrotation |

## 履歴

- [`archive/`](archive/) — 完了済みplan、handoff、監査、release ledger、告知案、却下設計。
- [`adr/`](adr/) — 採用済みarchitecture decision。

履歴文書は現行仕様を上書きしない。過去のversionや当時の未完項目を現在の作業指示として扱わない。

## 証拠

- [`../rag/INDEX.md`](../rag/INDEX.md) — 外部仕様・調査の索引。
- `entries/` — public dogfood entryとformat例。公開knowledgeの生成物は`caveat publish`が所有する。

## 文書寿命

- 現行文書はこの「現行」表へ載せる。
- 完了したplan、handoff、release closeout、監査、告知案は`archive/`へ物理移動する。
- 同じ目的の説明は一つの現行文書へ統合する。別文書を増やして同期対象を増やさない。
- 製品内部のinstall、config、state、schema、migration、diagnostics、recovery、update、releaseは
  Caveat repositoryが所有する。dotagentsには複製しない。
- `corepack pnpm check:docs`は現行索引、archive移動後を含むlocal link、未解決marker、
  個人host固定pathに加え、CommonMark/GFM ASTとHTML parserで得た実効link・image targetを
  検査する。公開packageは実際の`npm pack --dry-run --ignore-scripts --json`に入る
  Markdownの相対targetが同じtarball内に存在しなければ失敗する。
  Markdown-only CIもこの製品所有commandを実行する。
