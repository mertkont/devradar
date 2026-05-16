# devradar — Cloudflare Workers + Durable Objects

Multi-IDE developer "presence" server. Who's in which IDE, on which file, online or offline — all over a single WebSocket connection. Now also relays 1-to-1 chat messages between teammates in the same room.

**Matching model:** the room key is the git repo you're working in. Everyone who has that repo open lands in the same room automatically. No tokens, no login. (Optionally a "team key" is mixed into the room key — to keep out outsiders who happen to know the repo URL.)

- Hosting: **Cloudflare Workers** (free plan, no credit card)
- State: **Durable Object** (`PresenceRoom`), backed by SQLite — works on the free plan
- Language: TypeScript

## Run locally

```bash
npm install
npm run dev          # wrangler dev — http://localhost:8787
```

### Test

While `npm run dev` is running, in another terminal:

```bash
node test-clients.mjs                          # room=test-room
DEVRADAR_ROOM=other-room node test-clients.mjs # different room
```

Two fake clients connect, change files, one disconnects — you'll see the presence stream.

To clear a room (wipe the member list):

```bash
curl -X DELETE "http://localhost:8787/room?room=test-room"
```

## Deploy to Cloudflare

The repo is wired to Cloudflare Workers Builds, so every `git push` deploys. Manual deploys also work:

```bash
npx wrangler login     # first time — opens a browser
npm run deploy
```

> **Note:** the old `SHARED_TOKEN` secret is no longer used — you can delete it from the Cloudflare dashboard.

URL: `https://devradar.<subdomain>.workers.dev`
Health: `.../health` → `devradar ok`

## Logs

```bash
npx wrangler tail
```

## Protocol

WebSocket URL: `wss://devradar.<subdomain>.workers.dev/ws?room=<room-key>`
— `room` is required; otherwise the server returns 400.

Client → Server (JSON):

```jsonc
// 1) First message — registration
{ "type": "hello", "userId": "e:ab12…", "userName": "Mert Kont", "ide": "vscode", "project": "github.com/mertkont/devradar" }

// 2) Active file changed
{ "type": "update", "file": "src/index.ts", "line": 42, "project": "github.com/mertkont/devradar" }

// 3) Heartbeat — every 30s, used by the server for stale-socket detection
{ "type": "heartbeat" }

// 4) Send a chat message to another user in the same room
{ "type": "chat", "to": "e:cd34…", "text": "hey, free for a quick look?", "id": "c_abc123" }
```

Server → Client (JSON):

```jsonc
{ "type": "welcome", "userId": "e:ab12…" }

{ "type": "presence", "users": [
  { "userId": "e:ab12…", "userName": "Mert Kont", "ide": "vscode",
    "project": "github.com/mertkont/devradar", "file": "src/index.ts", "line": 42, "status": "online" },
  { "userId": "e:cd34…", "userName": "Alex G.", "ide": "rider",
    "project": "github.com/mertkont/devradar", "file": null, "line": null, "status": "offline",
    "lastSeen": 1736977200000 }
] }

// Chat relay — server stamps the sender's userId/userName from its socket
// attachment, not from the client payload, so impersonation is blocked.
{ "type": "chat", "from": "e:ab12…", "fromName": "Mert Kont", "to": "e:cd34…",
  "text": "hey, free for a quick look?", "id": "c_abc123", "ts": 1736977205000 }

// Sender-side confirmation that the message was relayed
{ "type": "chat-ack", "id": "c_abc123", "to": "e:cd34…", "ts": 1736977205000 }

// Failure: recipient not online in the room, or rate-limited
{ "type": "chat-error", "id": "c_abc123", "to": "e:cd34…", "reason": "offline" }

{ "type": "error", "message": "missing userId or userName" }
```

Admin:

```
DELETE /room?room=<room-key>   →  resets the member list and disconnects everyone in that room
```

Notes:
- `userId` is a hash of the git email (`e:` prefix). Because the same person uses the same git email on their laptop and desktop, they appear as **one** user; if one connection drops while the other is open, they remain **online**. If there is no git email, a random id (`x:` prefix) is used instead.
- `userName` is git's `user.name`. The extension's `devradar.displayName` setting overrides it.
- When the IDE quits or the computer sleeps, the WebSocket drops and the user goes **offline** — but they remain visible in the room's member list (everyone who ever connected is remembered, pruned after 30 days).
- The room key is derived in the extension as `sha256(normalize(remote.origin.url) [+ "|" + teamKey])`.
- Chat messages are relayed in-memory only — nothing is persisted on the server. The "from" field is server-stamped from the socket's attachment, so a client cannot pretend to be someone else in the same room. The sender is also rate-limited to 15 messages per 10 seconds per socket.
