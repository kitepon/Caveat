---
id: rtx-50-series-onnxruntime-1114
title: 'RTX 50 系 GPU で ONNX Runtime CUDA Provider が LoadLibrary error 1114 で初期化失敗する'
visibility: public
confidence: confirmed
outcome: impossible
tags: [gpu, nvidia, rtx-50xx, onnxruntime, blackwell]
environment:
  gpu: RTX 5080
  onnxruntime: "1.24.3"
  cuda: "12.x"
  os: windows
  applies_to_os: windows
source_project: null
source_session: "manual/2026-04-19"
created_at: 2026-04-19
updated_at: 2026-04-19
last_verified: 2026-04-19
---

## Context
OLTranslator（OCR + Argos 翻訳）で GPU OCR を有効にしようとした。RTX 5080 + CUDA 12.x + ONNX Runtime 1.24.3 の組み合わせ。

## Symptom
`onnxruntime.InferenceSession` で CUDA provider を指定すると `LoadLibrary failed with error 1114` が返る。cublasLt64_12.dll / cublas64_12.dll / cudart64_12.dll / cufft64_11.dll / cudnn64_9.dll は全部配置済み、nvidia-smi は正常、他の CUDA アプリ（PyTorch 等）は動く。ONNX Runtime の provider だけ落ちる。

## Cause
Blackwell 世代（RTX 50 系 / sm_120）が現行 ONNX Runtime の CUDA provider 初期化経路（Windows）で未サポート。ONNX Runtime 側の issue で CUDA 12.8 / sm_120 対応は進行中だが distribution の公式ビルドには入っていない。自前で CUDA 12.8 + sm_120 向けにカスタムビルドしてハッシュ検証まで通しても、provider の初期化段階で同じ 1114 を返す（下位の cuDNN/cuBLAS バイナリ側の ABI 整合が必要）。

## Resolution
- **現状（2026-04 時点）**: 不可能と判定して **CPU-only 運用にフォールバック**（`OCR/GpuMode=CpuOnly` または `Auto` で RTX 50 系スキップ）
- CUDA Toolkit 更新だけでは解けない（[rtx-5090-cuda](../gpu/rtx-5090-cuda.md) の CUDA<12.5 問題とは別層の罠、こちらは ONNX Runtime 側）
- `DirectML` provider は動くかもしれないが OCR 精度・速度で検証未了
- 進展は ONNX Runtime GitHub の sm_120 対応 PR を watch

## Evidence
- OLTranslator/HANDOVER_GPU_ORT.md: カスタム CUDA 12.8/sm_120 ビルドでも 1114 再現、ハッシュ一致を確認済
- LiveTR/CLAUDE.md でも同じ 1114 が onnxruntime 1.24.4 + PyInstaller exe で再現
- Blackwell 対応状況: https://developer.nvidia.com/blog/nvidia-geforce-rtx-50-series/
