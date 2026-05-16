# devradar — Visual Studio extension

The real-Microsoft-Visual-Studio counterpart to the VS Code extension and the JetBrains plugin. Shows which teammates have the same git repo open and are coding right now, and lets you chat with them 1-to-1 inside the IDE.

Targets **Visual Studio 2022** (17.0+), all SKUs (Community, Pro, Enterprise), x64.

## What it gives you

- A **"devradar" tool window** under `View → Other Windows → devradar`. Top half lists peers in the same git repo (● online / ○ offline + last seen). Bottom half is a chat panel with whoever you've selected.
- An **options page** under `Tools → Options → devradar → General` for server URL, display-name override, and an optional team key (mirrors the VS Code / Rider settings).
- The **same WebSocket protocol** as the other two clients — VS, VS Code, and JetBrains users all sit in the same room when they have the same git repo open.

Zero configuration: identity comes from `git config user.name` / `user.email`, the room is derived from `remote.origin.url`. Open the tool window, you're in.

## Build (you need Windows)

Visual Studio extensions can only be built on Windows with MSBuild + the Visual Studio SDK. There are two ways:

### Option A — GitHub Actions (recommended, no Windows machine needed)

Just push to `main`. The `.github/workflows/build-vs.yml` workflow runs on a Windows-2022 runner and uploads the `.vsix` as a build artifact:

1. Push your changes (any commit under `clients/vs/**` triggers the build, or run it manually via the **Actions** tab → "Build Visual Studio VSIX" → "Run workflow").
2. After the run, scroll to **Artifacts** at the top of the run page.
3. Download `devradar-vsix.zip`, unzip it. Inside is `Devradar.vsix`.

### Option B — Local build on Windows

Requirements: Visual Studio 2022 (any SKU) with the **Visual Studio extension development** workload installed. Then:

```pwsh
cd clients/vs
nuget restore devradar-vs.sln
msbuild devradar-vs.sln /p:Configuration=Release /p:DeployExtension=false
```

The built VSIX lands at `DevradarVS/bin/Release/Devradar.vsix`.

> If you don't have `nuget.exe` on PATH, opening the solution in Visual Studio once will restore packages automatically; then **Build → Build Solution** in Release configuration works the same way.

## Install (Windows)

1. Make sure Visual Studio 2022 is **closed**.
2. Double-click `Devradar.vsix`. The VSIX installer runs, picks up your VS 2022 installations, and installs into all SKUs you have.
3. Start Visual Studio. Open any solution that has a git repo (the extension does nothing in non-git folders).
4. `View → Other Windows → devradar` — the tool window docks somewhere sensible (typically next to Solution Explorer).
5. First open may take a couple of seconds while it reads git config and connects to the server. After that, peers in the same repo appear in the top half.

If you want to chat: click a peer in the top list → use the bottom panel.

## Publish (Visual Studio Marketplace)

The Visual Studio Marketplace is at https://marketplace.visualstudio.com/manage. It is **separate** from the VS Code Marketplace, even though both sit under `marketplace.visualstudio.com` — you create a publisher there, not in the VS Code Marketplace.

1. Sign in with the Microsoft account you'll publish under → create a publisher (one-time).
2. **Create new extension** → upload `Devradar.vsix`. Fill in the same display name (`devradar — who's online`), categories, tags, screenshots, README.
3. The first submission goes through a **manual review** by Microsoft (similar to JetBrains; 1–2 business days typically). Subsequent versions are auto-validated.

The VSIX already contains the icon, description, license, and supported VS version range — the Marketplace listing pre-fills from these.

## Notes / current limitations

- **Status bar item:** Visual Studio doesn't let extensions add a persistent status bar widget the way VS Code and IntelliJ-based IDEs do, so devradar lives in a tool window instead. The tool window title still surfaces the online count (`devradar — N online · …`).
- **File-in-edit tracking:** other clients send which file each peer is on; the VS extension currently only sends `null` for `file` until the active-document subscription is wired up.
- The wire protocol is unchanged from the other clients — a VS user looks indistinguishable from a VS Code or Rider user to the server, beyond the `"ide"` field which is set to `"vs"`.

## License

GPL-3.0-or-later (same as the rest of devradar).
