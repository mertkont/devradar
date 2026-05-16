# devradar — release notes

## 0.2.2 — 2026-05-16

- **Globalised UI**: every user-facing string in the VS Code and Rider
  extensions is now in English (previously Turkish), so the extensions are
  useful to teammates regardless of language. `formatLastSeen` reads
  "just now / 5 min ago / 3 h ago / 2 d ago / 1 w ago".
- No functional changes; wire protocol unchanged.

## 0.2.1 — 2026-05-14

- **Rider chat panel UX parity with VS Code**:
  - Added an amber warning banner between the header and the transcript
    that explains *why* the input is disabled when the peer is offline or
    the WS is down.
  - Right-hand status label now shows "last seen 5 min ago" for offline
    peers instead of just "offline".
  - Status-bar popup callback no longer bails out for offline rows — VS
    Code already opened chat with offline peers (input disabled, banner
    visible), Rider now matches.
- **VS Code chat header** also shows "last seen X" for offline peers,
  matching what its own QuickPick already exposed.

## 0.2.0 — 2026-05-14

- **In-IDE realtime 1-to-1 chat** for VS Code and Rider, layered onto the
  existing WebSocket without breaking 0.1.x clients (additive protocol):
  - Server: `chat` / `chat-ack` / `chat-error` message types, server-
    stamped sender identity (impersonation-resistant), per-socket sliding-
    window rate limit (15 msg / 10 s), room isolation, no persistence —
    relay only, plus a 100-message in-memory buffer per DO for replays.
  - VS Code: webview-based chat tab per peer, CSP'd with a nonce'd script,
    `textContent`-only message rendering (no XSS), optimistic send with
    server ack, banner on disconnect / peer-offline, opened from the
    QuickPick or via the `devradar: Open chat` command.
  - Rider: dedicated "devradar Chat" tool window (right-anchored), peer
    combo + transcript + input, balloon notifications via a project-
    startup listener so messages still surface when the tool window has
    never been opened.
- Added 4 pre-ship bug fixes uncovered during review: `to` field added
  to `chat-ack` / `chat-error` so VS Code can route precisely; double-
  HTML-escape of `selfName` in the webview removed; project-startup chat
  notifier so Rider doesn't drop messages before the tool window is ever
  opened; buffer write + listener forEach made atomic.

## 0.1.3 — 2026-05-14 (Rider only)

- Rider marketplace icon switched from PNG to a hand-coded 40×40 SVG
  (~632 bytes, scales crisply). The JetBrains Marketplace requires SVG
  per docs; the previous PNG-only `pluginIcon.png` was being ignored.

## 0.1.2 — 2026-05-14

- **Reliability fixes after a real "stuck on connecting" report:**
  - Rider: `WebSocket.Builder.connectTimeout(10s)` plus an overall
    `CompletableFuture.orTimeout(15s)` so the post-sleep Java HttpClient
    state can no longer hang the reconnect chain silently.
  - Rider: serialised `sendText` calls through a per-service lock —
    `java.net.http.WebSocket` mandates that the next `sendText` only
    runs after the previous future completes, which we were violating
    by dispatching every send to its own pool thread.
  - Rider + VS Code: clear the cached `users` list on disconnect so the
    click-popup / QuickPick stops showing pre-disconnect "online" peers
    while the status bar already says "not connected".
  - VS Code: explicit `handshakeTimeout: 10000` on `new WebSocket(...)`
    for symmetry with the Rider fix.
  - Rider: new `Tools → devradar: Reconnect` action as a manual escape
    hatch.
- Both packages also picked up the new radar icon at this version.

## 0.1.1 — 2026-05-13

- **Server-side liveness detection (the real fix for the "phantom online"
  problem after macOS lid close):** added `lastSeen` to the per-socket
  attachment, refreshed on every inbound message (hello / update /
  heartbeat). A Durable Object alarm now runs every 30 s while sockets
  are connected and force-closes anything that hasn't sent a message in
  75 s. `broadcast()` also defensively filters stale sockets.
- Server includes `lastSeen` in offline broadcast entries; both clients
  format it with their own `formatLastSeen` helper so the peer list
  shows "last seen 5 min ago" instead of a bare "offline" string.

## 0.1.0 — 2026-05-11

- Initial release.
- **Server**: Cloudflare Workers + a single `PresenceRoom` Durable Object
  (SQLite-backed). Repo-keyed rooms (`sha256(remote.origin.url [+ "|" +
  teamKey]).slice(0,16)`). WebSocket Hibernation API. `DELETE /room`
  admin reset, `/health` endpoint.
- **VS Code extension** (Marketplace publisher `MertKont`): status bar
  widget with online count, hoverable tooltip listing peers and their
  current files, QuickPick command "Who's online?", zero-config —
  identity derived from `git config user.name` / `user.email`, room
  derived from `remote.origin.url`.
- **Rider / JetBrains plugin** (vendor `mert-kont`, plugin id
  `dev.devradar.ide`): same surface in any IntelliJ-based IDE (Rider,
  IDEA, PyCharm, GoLand, WebStorm, …) via a status-bar widget.
- **Identity model**: `userId = "e:" + sha256(email).slice(0,16)` or
  `"x:" + ...` random fallback when there's no git email. Same person
  on a laptop and desktop becomes one user.

— see https://github.com/mertkont/devradar for source, server,
DEPLOY.md for the wire protocol, and `clients/<name>/README.md` for
per-extension build / install / publish instructions.
