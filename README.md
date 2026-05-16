# devradar

> See which teammates have **the same git repo open and are coding right now** — across VS Code, Visual Studio, and any JetBrains IDE (Rider, IntelliJ IDEA, PyCharm, GoLand, WebStorm, …). Plus 1-to-1 chat in-IDE so you can ping someone the moment you see them online. Zero configuration: identity comes from `git config`, the "room" is the repo itself.

A small open-source presence + chat system, hosted on Cloudflare Workers + Durable Objects on the free tier.

## Why

When you're working on the same project as a teammate but across different IDEs and different OSes, it's annoying to flip to Slack just to ask "are you in this file right now?" or "got 2 min for a quick look?". devradar surfaces that information natively in the IDE you're already in, keyed off the git repo so it's automatic and team-scoped.

## Architecture

- **Server** (`src/index.ts`): a single Cloudflare Workers project. One Durable Object (`PresenceRoom`) per repo. WebSocket Hibernation, SQLite-backed, server-side stale-socket detection via alarms, in-memory chat buffer per room. See [`DEPLOY.md`](./DEPLOY.md) for the wire protocol.
- **Clients**:
  - [`clients/vscode/`](./clients/vscode) — VS Code extension. Published as `MertKont.devradar-vscode`.
  - [`clients/rider/`](./clients/rider) — JetBrains plugin. Works in any IntelliJ-based IDE (Rider, IDEA, PyCharm, GoLand, WebStorm, …). Vendor `mert-kont`, plugin id `dev.devradar.ide`.
  - [`clients/vs/`](./clients/vs) — Visual Studio 2022 extension (the real Microsoft IDE, not VS Code). Tool window-based, built from Windows / CI.

All three clients speak the same protocol — a teammate on VS Code sees a teammate on Rider and a teammate on Visual Studio in the same room without any extra setup, as long as they all have the same git repo cloned.

## Identity & rooms

- `userId = "e:" + sha256(git user.email).slice(0, 16)` — same person looks like **one** user across all their IDEs/devices because they share a git email. (Fallback `"x:" + random` if no git email.)
- `roomKey = "repo:" + sha256(normalizedRemote + optional teamKey).slice(0, 16)` — derived from `git config remote.origin.url`. The optional team key, if everyone enters the same value, keeps out outsiders who happen to know your repo URL.

## Status

| Component | Version | Marketplace |
|---|---|---|
| Server (Cloudflare) | live | – |
| VS Code extension | 0.2.2 | `MertKont.devradar-vscode` |
| JetBrains plugin | 0.2.2 | `dev.devradar.ide` |
| Visual Studio extension | 0.2.2 | (TBD — first publish) |

See [`CHANGELOG.md`](./CHANGELOG.md) for the full release history.

## Build & install

Each client has its own README with build / install / publish instructions:

- VS Code → [`clients/vscode/README.md`](./clients/vscode/README.md)
- JetBrains → [`clients/rider/README.md`](./clients/rider/README.md)
- Visual Studio → [`clients/vs/README.md`](./clients/vs/README.md) (build on Windows or via the included GitHub Actions workflow)

## License

GPL-3.0-or-later
