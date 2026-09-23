---
id: cmake-realpath-windows-reparse-point
title: 'Windows venv の site-packages に含まれる reparse point を CMake で bundle するには REALPATH 解決が必要'
visibility: public
confidence: confirmed
outcome: resolved
tags: [cmake, windows, venv, reparse-point, bundling]
environment:
  os: windows
  applies_to_os: windows
  cmake: ">=3.20"
  build: pyinstaller / installer bundling
source_project: null
source_session: "manual/2026-04-19"
created_at: 2026-04-19
updated_at: 2026-04-19
last_verified: 2026-04-19
---

## Context
Windows で `python -m venv` → `pip install onnxruntime` 等で native-dependent パッケージを入れると、**`.venv/Lib/site-packages/<package>` が reparse point（NTFS の symlink 的な仕組み）で置かれる**ことがある。これを CMake や installer（Inno Setup 等）で bundle すると中身が壊れる。

## Symptom
- CMake の `file(COPY ...)` / `install(DIRECTORY ...)` で `.venv` を target ディレクトリにコピーしても、Program Files install 版に `onnxruntime` が存在しない / 空
- 起動時に `python-worker-start-failed` / `ModuleNotFoundError: No module named 'onnxruntime'`
- Release ビルドディレクトリでは正常に動く

## Cause
reparse point は NTFS レベルで「別の場所を指す」。CMake や Inno Setup は default で reparse point を dereference せず、リンク自体をコピーする。インストール先に展開した時、リンク先（元の venv path）は installer 実行機には存在しないので空。

pip の behavior: 一部 wheel は space-saving で site-packages の一部を reparse point で別ディレクトリに飛ばす（特に巨大な native binary）。

## Resolution
**CMake 側で REALPATH 解決する**:
```cmake
# bad: reparse point がそのままコピーされる
file(COPY .venv/Lib/site-packages/onnxruntime DESTINATION ${CMAKE_INSTALL_PREFIX}/runtime/)

# good: symlink / reparse point を resolve
get_filename_component(ONNX_REAL_PATH .venv/Lib/site-packages/onnxruntime REALPATH)
file(COPY ${ONNX_REAL_PATH} DESTINATION ${CMAKE_INSTALL_PREFIX}/runtime/)
```

**Inno Setup の場合**: `Source` entry で `onnxruntime-*.dist-info` も**明示列挙**（wildcard だけでは reparse point で拾い漏れる）:
```
[Files]
Source: ".venv\Lib\site-packages\onnxruntime\*"; DestDir: "{app}\runtime\onnxruntime"; Flags: recursesubdirs ignoreversion
Source: ".venv\Lib\site-packages\onnxruntime-*.dist-info\*"; DestDir: "{app}\runtime\..."; Flags: recursesubdirs
```

**検証手順**:
```powershell
Get-Item .venv\Lib\site-packages\onnxruntime | Select Attributes
# "ReparsePoint" が含まれていたら注意
```

## Evidence
- OLTranslator/DEVELOPER_HISTORY.md で「build/Release には onnxruntime あるのに Program Files インストール版では無い」を記録
- `cmake/SyncBundledArgosRuntime.cmake` で REALPATH 解決を入れて解決
- pip GitHub issue: https://github.com/pypa/pip/issues?q=reparse+point
