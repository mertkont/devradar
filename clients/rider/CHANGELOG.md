# Change Log — devradar (Rider / JetBrains)

## 0.2.3

- **Marketplace listing improvements** — no code changes:
  - Plugin description rewritten with the full feature set (chat tool
    window, balloon notifications, settings) — the previous text was
    from 0.1.x and only mentioned the status-bar widget.
  - Added `<change-notes>` to `plugin.xml` so the marketplace listing's
    "What's New" section actually shows the version history.
  - Screenshots upload (via plugins.jetbrains.com web UI) recommended.

## 0.2.2

- UI strings are now English (was Turkish). No functional changes.

## 0.2.1

- Chat panel parity with VS Code: amber warning banner explains why the
  input is disabled (peer offline / disconnected); right-hand status
  label shows "last seen 5 min ago" instead of a bare "offline".
- Status-bar popup now opens chat for offline peers too (matches VS Code).

## 0.2.0

- **devradar Chat tool window** (right-anchored): peer combo + transcript
  + Send. Click any peer in the status-bar popup to open the panel
  pre-selected to them. Balloon notifications surface incoming messages
  even before the tool window is opened for the first time. New action:
  `Tools → devradar: Open Chat`.

## 0.1.3

- Marketplace icon: replaced the PNG with a hand-coded SVG so the
  JetBrains Marketplace listing renders it correctly (PNG-only plugin
  icons aren't recognised by the marketplace per their docs).

## 0.1.2

- WebSocket builder now has `connectTimeout(10s)` and the future has an
  overall `orTimeout(15s)` — fixes a real "stuck on connecting" hang
  reported after macOS lid close.
- All chat / heartbeat / file-change sends are serialised through a
  per-service lock to satisfy `java.net.http.WebSocket`'s "one pending
  sendText at a time" contract.
- Cleared the stale peers list on disconnect (was still showing pre-
  disconnect "online" peers in the click-popup).
- New `Tools → devradar: Reconnect` action — manual escape hatch
  without restarting the IDE.

## 0.1.1

- Status-bar popup now shows "last seen 5 min ago" for offline
  teammates.

## 0.1.0

- Initial release: status-bar widget in any IntelliJ-based IDE (Rider,
  IDEA, PyCharm, GoLand, WebStorm, …). Online count, click-popup
  listing peers and their current files. Zero configuration.
