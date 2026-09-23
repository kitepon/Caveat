---
id: pyinstaller-exe-test-full-pipeline
title: 'PyInstaller exe は起動確認だけでは不足、全パイプラインを実行テストする'
visibility: public
confidence: confirmed
outcome: resolved
tags: [pyinstaller, testing, exe, verification]
environment:
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
PyInstaller で ML 系パイプライン（音声→翻訳、画像→テキスト等）を exe 化。dev で動いたから exe も大丈夫だろうと起動確認だけで配布候補にしがち。

## Symptom
exe が起動し GUI が出るが、実際に推論（音声入力→翻訳出力、画像→OCR 結果等）を走らせると segfault / 無言クラッシュ / 結果が空。dev 環境では全く同じコードで問題ない。

## Cause
PyInstaller の bundling で欠落する DLL / データファイルは、**その依存が初めて参照されるタイミング**で露呈する。モデルロードは起動時だが、**推論パスで呼ばれる cuBLAS/cuDNN/libomp** 等は最初の実推論まで load されない。よって起動成功 = 動作成功ではない。

## Resolution
exe build 後のスモークテスト手順を必須化：
1. 起動してクラッシュしないこと
2. **実データで end-to-end パイプラインを走らせる**（音声ファイル→翻訳出力、画像→OCR 結果、等）
3. 結果が dev と同じであること（サンプル 1 件の比較でいい）
4. GPU モード / CPU モード両方で（環境依存の DLL load は別）

CI にこのスモークテストを組む場合、GitHub Actions の Windows runner は GPU 無し CPU 限定なので、CPU 経路で推論まで回す。GPU 経路は手動。

## Evidence
- LiveTR/CLAUDE.md: `ctranslate2 4.4.0` が起動は通るが音声キャプチャで crash した事例
- 同: `onnxruntime 1.24.4` が dev では動くが exe で DLL 1114
- 「exe build 後はフル翻訳テスト必須」が明記
