---
id: venv-windows-system-python-conflict
title: 'Windows で system Python に globally install されたパッケージが venv を乗っ取ることがある'
visibility: public
confidence: confirmed
outcome: resolved
tags: [python, venv, windows, pip, site-packages]
environment:
  os: windows
  applies_to_os: windows
  python: "3.13"
source_project: null
source_session: "manual/2026-04-19"
created_at: 2026-04-19
updated_at: 2026-04-19
last_verified: 2026-04-19
---

## Context
Windows で Python プロジェクトをいくつも持っていると、system Python（`C:\Program Files\Python313` 等）の site-packages に過去の global install が溜まる。venv を作って pip install しても conflict が起きる。

## Symptom
- venv を `python -m venv .venv` で作って activate
- `pip install -r requirements.txt` が成功する
- しかし import 時に `ModuleNotFoundError` / 別バージョンが読まれる挙動
- `python -c "import pkg; print(pkg.__file__)"` で system Python の site-packages を指している

## Cause
- Windows で venv を activate しても、`PYTHONPATH` の解決順や拡張 search path で system site-packages が入ることがある
- 特に `pip install --user` で過去に入れたパッケージが `%APPDATA%\Python\Python313\site-packages` に残って venv より優先
- user site-packages を明示的に無効化しないと venv だけでは隔離しきれない

## Resolution
**venv 化を厳格に**:
```bash
python -m venv .venv
.\.venv\Scripts\activate        # PowerShell: .\.venv\Scripts\Activate.ps1

# .venv の python を直接使う（PATH 依存を排除）
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe main.py
```

**user site-packages を無効化**:
- 環境変数 `PYTHONNOUSERSITE=1` を venv の activate script に追加
- または venv の `pyvenv.cfg` に `include-system-site-packages = false`（これはデフォルト false だが確認）

**診断**:
```python
import sys, site
print("prefix:", sys.prefix)
print("executable:", sys.executable)
print("paths:", sys.path)
print("user site:", site.getusersitepackages())
```
これで load 順序が分かる。

## Evidence
- ai-group で system Python の古い PySide6 が venv を乗っ取って起動失敗
- `PYTHONNOUSERSITE=1` + `.\.venv\Scripts\python.exe` 直呼び出しで解決
