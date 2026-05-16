# Change Log — devradar (VS Code)

## 0.2.2

- UI strings are now English (was Turkish). No functional changes.

## 0.2.1

- Chat header shows "last seen 5 min ago" for offline peers instead of
  a bare "offline" string.

## 0.2.0

- **1-to-1 chat** with teammates in the same git repo. Click someone in
  the status-bar popup (or QuickPick), and a chat tab opens beside the
  editor. Webview with CSP, optimistic send, banners on disconnect /
  peer-offline. New command: `devradar: Open chat`.
- Defensive fixes: `handshakeTimeout` on `new WebSocket(...)`, stale
  presence list cleared on disconnect.

## 0.1.1

- Peer list (QuickPick) now shows "last seen 5 min ago" for offline
  teammates.

## 0.1.0

- Initial release: status-bar presence indicator with online count and
  tooltip listing peers + their current files. Zero configuration —
  identity from `git config`, room from `remote.origin.url`.
