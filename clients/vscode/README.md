# devradar

See which teammates have **the same git repo open and are coding right now** — IDE- and OS-agnostic.

- **Who's online, who's offline** — live count in the status bar
- **Who's editing what file** — hover over the status bar for details
- **1-to-1 chat** in a panel next to your editor, with peers in the same repo
- **Zero configuration**: no tokens, no login, no name to type. The extension reads your name/email from git and derives your "room" from the repo URL.
- **Automatic matching**: everyone who has the same git repo open lands in the same room. Different repos stay isolated.

## How it works

The extension reads the `remote.origin.url` of your workspace's git repo, hashes it into a room key, and connects to the devradar server. Anyone else with that same repo cloned and the extension installed lands in the same room. Your identity comes from git's `user.name` (display name) and `user.email` (a stable hash — tied to you, not your laptop).

Folders without a git remote silently disable the extension.

## Settings

| Setting | Default | Description |
|---|---|---|
| `devradar.serverUrl` | `wss://devradar.mrt-kntt53.workers.dev/ws` | Presence server URL. Change this if you run your own. |
| `devradar.displayName` | _(empty)_ | Override the displayed name. Falls back to git `user.name`. |
| `devradar.teamKey` | _(empty)_ | Optional shared phrase. If everyone in the same repo enters the same value, outsiders who know the repo URL cannot join the room. |

## Commands

- **devradar: Who's online?** — list everyone in this repo and where they are
- **devradar: Open chat** — open a chat with someone in the same repo
- **devradar: Reconnect** — force a fresh WebSocket connection

## Run your own server

The presence server is open source (Cloudflare Workers + Durable Objects): https://github.com/mertkont/devradar

## License

GPL-3.0-or-later
