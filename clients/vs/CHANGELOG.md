# Change Log — devradar (Visual Studio)

## 0.2.2

- **Initial release.** Tool window under `View → Other Windows → devradar`
  with peers list (top) + chat panel (bottom). Options page at
  `Tools → Options → devradar → General` for server URL, display name,
  and team key. Reconnect button in the tool window header.

  Uses the same WebSocket protocol as the VS Code extension and the
  JetBrains plugin — VS, VS Code, and Rider/IDEA users all sit in the
  same room when they have the same git repo open.

  Version starts at 0.2.2 to align with the rest of the suite; future
  releases will bump in step with VS Code / Rider so users on different
  IDEs always see matching capabilities.
