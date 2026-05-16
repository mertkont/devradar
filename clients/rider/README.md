# devradar — JetBrains plugin (Rider, IntelliJ, PyCharm, …)

The JetBrains counterpart to the VS Code extension. Shows in the status bar which teammates have the same git repo open and are coding right now, and lets you chat with them 1-to-1 inside the IDE. Zero configuration — identity from git, room from the repo URL.

Built on the IntelliJ Platform, so it runs in Rider, IntelliJ IDEA, PyCharm, GoLand, WebStorm, and friends (the plugin only uses generic platform APIs).

## Development / build

The Gradle wrapper is committed. Building requires **JDK 17–21**.

```bash
cd clients/rider
./gradlew buildPlugin        # produces build/distributions/devradar-rider-<version>.zip
./gradlew runIde             # opens the plugin in a sandbox IDE (for trying it out)
```

> **If you're on JDK 23+:** Gradle 8.10 + Kotlin DSL doesn't recognise JDK 25. Build with a JDK 17–21:
> ```bash
> JAVA_HOME="/path/to/jdk-17-to-21" ./gradlew buildPlugin
> ```
> Any installed JetBrains IDE or Android Studio bundles a JBR 21 (e.g. `/Applications/Android Studio.app/Contents/jbr/Contents/Home`) which works.
> (Alternatively, upgrading the wrapper to Gradle 9.1+ also fixes it.)

`runIde` downloads an IDE on first run (large). To try the plugin in your real Rider:
**Settings → Plugins → ⚙ → Install Plugin from Disk…** → pick the built `.zip`.

## Publishing to the JetBrains Marketplace

1. https://plugins.jetbrains.com → "Sign In" with a JetBrains account → create a **vendor profile** (first time only).
2. **Upload plugin** → drop the built `.zip`. First submission is reviewed by JetBrains (can take a few days).
3. Can also be done via CLI: get a **permanent token** (Marketplace → profile → "My Tokens"), then:
   ```bash
   ./gradlew publishPlugin -Ppublish.token=<TOKEN>
   ```
   (This requires a `publishing { token = ... }` block in `build.gradle.kts` — set up after the first web upload yields a pluginId.)

## Server

Open source, Cloudflare Workers + Durable Objects: https://github.com/mertkont/devradar
