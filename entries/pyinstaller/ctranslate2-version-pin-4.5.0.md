---
id: ctranslate2-version-pin-4.5.0
title: 'PyInstaller bundled exe では ctranslate2 を 4.5.0 にピン留め必須（4.7.1 は exe で segfault、4.4.0 は dev で crash）'
visibility: public
confidence: confirmed
outcome: resolved
tags: [pyinstaller, ctranslate2, python, whisper, version-pin]
environment:
  ctranslate2: "=4.5.0"
  python: ">=3.10"
  pyinstaller: "bundled"
  os: windows
  applies_to_os: windows
source_project: null
source_session: "manual/2026-04-19"
created_at: 2026-04-19
updated_at: 2026-04-19
last_verified: 2026-04-19
---

## Context
LiveTR（ライブ翻訳）で faster-whisper → ctranslate2 のパイプラインを PyInstaller で exe 化する運用。dev（plain Python）で動いても exe で segfault というケースが頻出。

## Symptom
- **ctranslate2 4.7.1**: exe で `models.Whisper()` 構築時に segfault。dev では動く
- **ctranslate2 4.4.0**: dev 環境で音声キャプチャ中に crash。exe では回避できない
- **ctranslate2 4.5.0**: 両方で動作

## Cause
ctranslate2 は C++ 実装 + CUDA バインディング。PyInstaller は共有ライブラリの依存解決を限定的にしか追えない。4.7.1 で導入された新しい依存 DLL が exe bundling 時に欠落、4.4.0 の先行バグは dev 側に影響。**ピンポイントに 4.5.0 のみが両方で安定**する。

## Resolution
- `requirements.txt` で `ctranslate2==4.5.0` と厳密ピン
- `setuptools>=82.0.1` が `pkg_resources` を別 distribution に移した影響で ctranslate2 4.4.0 が import 失敗するため、併せて `setuptools<=75.x` もピン（別 caveat: [setuptools-82-breaks-ctranslate2](../python/setuptools-82-breaks-ctranslate2.md)）
- exe build 後は **必ず全パイプライン（音声入力→翻訳出力）をテスト**。起動確認だけでは不足（[pyinstaller-exe-test-full-pipeline](test-full-pipeline-not-startup.md)）

## Evidence
- LiveTR/CLAUDE.md に version pin 決定の履歴
- 再現手順: dev で 4.4.0 入れて音声キャプチャ → crash / exe で 4.7.1 ビルド → Whisper() で segfault
