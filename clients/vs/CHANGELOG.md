# Change Log — devradar (Visual Studio)

## 0.2.4

- Marketplace listing Overview updated. No code changes — identical
  binary to 0.2.3; the version bump exists only because the VS
  Marketplace publisher UI requires it to update listing metadata.

## 0.2.3

- Marketplace listing improvements:
  - Overview rewritten with a feature walkthrough and embedded
    screenshots (shared with the VS Code listing — the UI is similar).
  - Description matches the JetBrains and VS Code listings for
    consistency across the suite.
- No code changes.

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
