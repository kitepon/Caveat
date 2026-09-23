---
id: onnxruntime-1.20.1-required-in-exe
title: 'PyInstaller bundled exe では onnxruntime を 1.20.1 にピン（1.24.4 は exe で DLL error 1114）'
visibility: public
confidence: confirmed
outcome: resolved
tags: [pyinstaller, onnxruntime, python, version-pin, dll]
environment:
  onnxruntime: "=1.20.1"
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
LiveTR の exe ビルドで onnxruntime を要する Whisper / VAD モデルを読む。dev では動くが exe で 1114 エラー。

## Symptom
exe 起動直後に `import onnxruntime` → `OSError: [WinError 1114] A dynamic link library (DLL) initialization routine failed`。dev 環境では同バージョンで動く。

## Cause
onnxruntime 1.24.4 の Windows prebuild が PyInstaller の bundling 過程で依存 DLL の初期化順序に敏感。CUDA provider 自体の初期化失敗とは別レイヤ（CPU provider の `onnxruntime_providers_shared.dll` が依存する VC++ runtime DLL の load sequence）。

## Resolution
- `requirements.txt` で `onnxruntime==1.20.1` 固定
- GPU 版が要るなら `onnxruntime-gpu==1.20.1`。ただし [RTX 50 系では CUDA provider 自体が別問題で死ぬ](../gpu/rtx-50-series-onnxruntime-1114.md)
- exe build 後の **起動+推論の両方**をテスト。起動成功でも推論で落ちる場合がある

## Evidence
- LiveTR/CLAUDE.md に version 試行履歴
- OLTranslator 側でも同じ 1114 を別経路（RTX 50 系 GPU provider）で踏んでいる。エラーコードが同じでも原因層が違う点に注意
