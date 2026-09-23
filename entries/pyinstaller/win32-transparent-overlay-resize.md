---
id: win32-transparent-overlay-resize
title: 'PySide6 の WS_EX_TRANSPARENT overlay を resize すると UpdateLayeredWindow が壊れる'
visibility: public
confidence: confirmed
outcome: resolved
tags: [win32, pyside6, transparent-window, overlay]
environment:
  pyside6: ">=6.5"
  os: windows
  applies_to_os: windows
source_project: null
source_session: "manual/2026-04-19"
created_at: 2026-04-19
updated_at: 2026-04-19
last_verified: 2026-04-19
---

## Context
ライブ字幕 overlay のように、透過背景 + クリックスルー (click-through) な最前面ウィンドウを PySide6 で作る。Win32 `SetWindowLongPtrW` で `WS_EX_TRANSPARENT` を立てる。

## Symptom
- overlay 起動直後は描画 OK
- user が window を resize（drag 端 or プログラム resize）した直後から rendering が崩れる
- 透過部分が黒くなる、字幕テキストが消える、`UpdateLayeredWindow` API call が silently fail
- `WS_EX_TRANSPARENT` を外せば resize 後も描画される（ただし click-through は失われる）

## Cause
Win32 の `WS_EX_TRANSPARENT` + `WS_EX_LAYERED` を組み合わせた layered window で、resize event が **layered window buffer の再初期化を必要とする**が、Qt の resize flow はこれを前提にしていない。結果 `UpdateLayeredWindow` が過去の buffer size を前提に呼ばれて ERROR 状態に落ちる。

## Resolution
**resize イベントで `WS_EX_TRANSPARENT` を一瞬外して再付与する**:

```python
def resizeEvent(self, event):
    super().resizeEvent(event)
    hwnd = int(self.winId())
    style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE)
    # 一瞬外す
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style & ~WS_EX_TRANSPARENT)
    self.update()  # redraw
    # 付け直す
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | WS_EX_TRANSPARENT)
    self.update()
```

副作用: resize 中の数フレームは click-through が効かない。user experience としては許容範囲（resize 中に click できない overlay なんて意図的に使わない）。

代替: layered window を諦めて `Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint` + CSS alpha で半透明化。こちらは click-through が効かないので用途次第。

## Evidence
- LiveTR/CLAUDE.md で subtitle_overlay.py の実装を記録
- Win32 docs: https://learn.microsoft.com/en-us/windows/win32/winmsg/extended-window-styles
