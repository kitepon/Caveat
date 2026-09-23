---
id: qt6-voicevox-vb-cable-env
title: 'Qt6 アプリ + VOICEVOX + VB-Cable は環境変数と external service の先行起動が必要'
visibility: public
confidence: confirmed
outcome: resolved
tags: [python, qt6, voicevox, vb-cable, audio, environment]
environment:
  os: windows
  applies_to_os: windows
  pyside6: ">=6.5"
  voicevox: "external server"
  vb-cable: "driver"
source_project: null
source_session: "manual/2026-04-19"
created_at: 2026-04-19
updated_at: 2026-04-19
last_verified: 2026-04-19
---

## Context
Windows で Qt6 / PySide6 ベースの音声アプリを VOICEVOX（ローカル TTS サーバ）+ VB-Cable（仮想オーディオドライバ）と組み合わせる。

## Symptom
- VOICEVOX 合成呼び出しが silent fail / "service not running" エラー
- VB-Cable 経由の音声出力が聞こえない / ルーティングされない
- アプリ起動時にエラーは出ない（遅延発覚）

## Cause
- **VOICEVOX**: 外部プロセス（`run.exe` or nemo cli）を事前起動する必要がある。default port `http://127.0.0.1:50021`。環境変数 `VOICEVOX_URL` が未設定だと default を当てるが、起動していなければ connection refused
- **VB-Cable**: driver を system に install しないと仮想デバイスが存在しない。インストール後 reboot 必要
- これらは**依存 service / driver**であって、Python パッケージで自動で入るわけではない

## Resolution
起動 checklist（README に書く）:
1. VOICEVOX を先に起動（`VOICEVOX.exe` or `run.bat`、起動に 20-30 秒）
2. `curl http://127.0.0.1:50021/version` で応答確認
3. VB-Cable driver が system にインストールされていることを `Get-PnpDevice | grep VB-Cable` 等で確認
4. Python アプリ起動、`.env` or PowerShell で `VOICEVOX_URL=http://127.0.0.1:50021` を明示

**fail-fast** を組む:
```python
# アプリ起動時に preflight
import requests
try:
    r = requests.get(f"{VOICEVOX_URL}/version", timeout=2)
    r.raise_for_status()
except Exception as e:
    print(f"VOICEVOX not reachable at {VOICEVOX_URL}: {e}")
    sys.exit(1)
```

VB-Cable は Python からは check しづらい（system audio device 列挙）。起動 script で `ffmpeg -list_devices true -f dshow -i dummy` の出力を grep する等。

## Evidence
- ai-group README に VOICEVOX 起動手順明記
- 「fail-fast な preflight」が無いと UI 立ち上がってから合成ボタン押すまで気付かない
