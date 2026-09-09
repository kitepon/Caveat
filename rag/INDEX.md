# RAG Index

- `windows-pwsh-acl/`: PowerShell 7のACL API、所有者限定ACLの適用と第三者権限拒否のWindows実測（取得日 2026-09-10、確度 confirmed）

調査資産の1行台帳。

運用規約: dotagents/PLAN.md 原則10に従い、一次ソースは `rag/<topic>/raw/` に置き、要約・リンク・成果物を還流し、ここへ1行台帳として記録する。

- `proposal-execution-provenance/`: Codex / Claude Code 非対話CLIの出力・model・permission固定能力と、execution receipt設計上の限界（取得日 2026-07-13、確度 confirmed）
- `codex-sidecar-model-policy/`: GPT-5.6 Sol/Terra/Lunaの用途区分、Codex subscription/credit費用、Luna採用実測とbounded hook-signal paired A/B（取得日 2026-07-13、確度 confirmed / synthetic feasibility）
- `codex-hooks-feature/`: 正規`features.hooks`、deprecated alias移行、Codex 0.144.1実測（取得日 2026-07-13、確度: 高）
- `codex-app-server-output-schema/`: Codex App Server 0.144.1の`turn/start.params.outputSchema`生成schemaとsidecar適用判断（取得日 2026-07-13、確度: confirmed）
- `claude-hook-stream/`: Claude Code fresh-sessionのstream-json hook event、認証分離、Haiku実効モデル検証（取得日 2026-07-13、確度: confirmed）
