---
id: argos-program-files-stanza-resources
title: 'Argos Translate を Program Files 配下で動かすと Stanza の resource 書き込みで timeout'
visibility: public
confidence: confirmed
outcome: resolved
tags: [python, argos, stanza, windows, program-files]
environment:
  os: windows
  applies_to_os: windows
  argos: "argos-translate + stanza"
  install-location: "C:\\Program Files\\..."
source_project: null
source_session: "manual/2026-04-19"
created_at: 2026-04-19
updated_at: 2026-04-19
last_verified: 2026-04-19
---

## Context
Argos Translate（offline 翻訳）を Windows アプリに組み込んで Inno Setup 等で Program Files 配下にインストール。

## Symptom
- アプリから Argos backend を起動 → `/health` は `ready: true` を返す
- しかし実際の `/translate` リクエストで `python-worker-timeout` → 翻訳が returned せず
- `Release/` ビルド（非インストール）では動く、インストール版だけ fail
- Program Files 外（LocalAppData 等）にインストールすれば動く

## Cause
Argos は内部で Stanza（Stanford NLP）を使って sentence segmentation を行う。Stanza は resource（モデル、config）を**package ディレクトリ内に書こうとする**。Program Files 配下は **read-only**（管理者権限無しでは書けない）ため、resource 展開が無言で fail し、sentence segmentation が hang、最終的に worker timeout。

`STANZA_RESOURCES_DIR` という環境変数で書き込み先を override できる設計だが、Argos backend はこれを使わず package 内 path を hard-code している箇所がある。

## Resolution
**bundled Python worker で `StanzaSentencizer.lazy_pipeline()` を override**:
```python
# Monkey-patch で stanza resources を writable path に向ける
import stanza
from argostranslate.stanza_sentencizer import StanzaSentencizer

_original_lazy = StanzaSentencizer.lazy_pipeline
def lazy_pipeline_writable(self, *args, **kwargs):
    # LocalAppData 配下の書き込み可能 path
    writable_root = os.path.join(os.environ['LOCALAPPDATA'], 'YourApp', 'StanzaResources')
    os.makedirs(writable_root, exist_ok=True)
    os.environ['STANZA_RESOURCES_DIR'] = writable_root
    return _original_lazy(self, *args, **kwargs)

StanzaSentencizer.lazy_pipeline = lazy_pipeline_writable
```

**+ インストーラで resources を staged copy**: `stanza/resources.json` と language directory を全言語分 `LocalAppData/YourApp/StanzaResources` に copy（初回起動時 or installer 実行時）。

**log で `effectiveStanzaDir` を出す**：実際に使われた path が書き込み可能か確認できるように。

## Evidence
- OLTranslator/DEVELOPER_HISTORY.md の「Program Files 運用記録」節
- Stanza docs: https://stanfordnlp.github.io/stanza/download_models.html 「resource dir」
- 環境変数 override の制限は argostranslate の実装読むと判る
