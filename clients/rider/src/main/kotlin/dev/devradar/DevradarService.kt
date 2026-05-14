package dev.devradar

import com.google.gson.Gson
import com.google.gson.JsonParser
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationInfo
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.thisLogger
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.WindowManager
import com.intellij.util.concurrency.AppExecutorUtil
import java.io.File
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.WebSocket
import java.security.MessageDigest
import java.time.Duration
import java.util.concurrent.CompletionStage
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

const val DEVRADAR_WIDGET_ID = "devradar.statusBar"
const val DEVRADAR_DEFAULT_SERVER = "wss://devradar.mrt-kntt53.workers.dev/ws"

data class DevradarUser(
    val userId: String,
    val userName: String,
    val ide: String,
    val project: String,
    val file: String?,
    val line: Int?,
    val status: String,
    val lastSeen: Long?,
)

@Service(Service.Level.PROJECT)
class DevradarService(private val project: Project) : Disposable {

    private val log = thisLogger()
    private val gson = Gson()
    private val httpClient: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .build()
    private val exec = AppExecutorUtil.getAppScheduledExecutorService()
    private val disposed = AtomicBoolean(false)
    // Java's WebSocket API requires sendText() calls to be serialized — a second
    // sendText before the previous Future completes throws IllegalStateException.
    // We may call send() from several threads (heartbeat tick, file-change handler,
    // onOpen). One lock per service is enough; messages are tiny and infrequent.
    private val sendLock = Any()

    @Volatile private var generation = 0
    @Volatile private var ws: WebSocket? = null
    @Volatile private var heartbeat: ScheduledFuture<*>? = null
    @Volatile private var noRepo = false
    @Volatile private var probed = false
    @Volatile private var projectLabel = "?"
    @Volatile private var selfId = ""
    @Volatile private var userName = "anon"

    @Volatile var users: List<DevradarUser> = emptyList()
        private set

    fun start() {
        project.messageBus.connect(this).subscribe(
            FileEditorManagerListener.FILE_EDITOR_MANAGER,
            object : FileEditorManagerListener {
                override fun selectionChanged(event: FileEditorManagerEvent) = sendUpdate(event.newFile)
            },
        )
        connect()
    }

    fun restart() {
        val old = ws
        ws = null
        heartbeat?.cancel(false); heartbeat = null
        noRepo = false; probed = false; users = emptyList()
        refreshWidget()
        try { old?.sendClose(WebSocket.NORMAL_CLOSURE, "settings changed") } catch (_: Throwable) {}
        connect()
    }

    private fun connect() {
        if (disposed.get()) return
        val gen = ++generation
        ApplicationManager.getApplication().executeOnPooledThread {
            if (gen != generation) return@executeOnPooledThread
            try {
                val settings = DevradarSettings.getInstance()
                val basePath = project.basePath ?: run {
                    noRepo = true; probed = true; refreshWidget(); return@executeOnPooledThread
                }
                val remote = gitConfig(basePath, "--get", "remote.origin.url")
                if (remote.isNullOrBlank()) {
                    noRepo = true; probed = true; refreshWidget(); return@executeOnPooledThread
                }
                val repo = normalizeRemote(remote)
                projectLabel = repo
                val teamKey = settings.teamKey
                val roomKey = "repo:" + sha256Short(if (teamKey.isBlank()) repo else "$repo|$teamKey")
                userName = settings.displayName.ifBlank {
                    gitConfig(basePath, "user.name")?.takeIf { it.isNotBlank() } ?: System.getProperty("user.name") ?: "anon"
                }
                val email = gitConfig(basePath, "user.email")?.lowercase()
                selfId = if (!email.isNullOrBlank()) "e:" + sha256Short(email)
                else "x:" + sha256Short((System.getProperty("user.name") ?: "") + "@" + basePath)
                probed = true
                refreshWidget()

                val uri = URI.create("${settings.serverUrl}?room=${URLEncoder.encode(roomKey, "UTF-8")}")
                // Explicit connect timeout for the WS handshake, plus an overall
                // orTimeout so a stuck future (after macOS sleep/wake the underlying
                // HttpClient state can hang silently) can never block the reconnect
                // chain forever — TimeoutException routes us back to scheduleReconnect.
                httpClient.newWebSocketBuilder()
                    .connectTimeout(Duration.ofSeconds(10))
                    .buildAsync(uri, Listener(gen))
                    .orTimeout(15, TimeUnit.SECONDS)
                    .whenComplete { socket, err ->
                        if (gen != generation) {
                            try { socket?.sendClose(WebSocket.NORMAL_CLOSURE, "superseded") } catch (_: Throwable) {}
                            return@whenComplete
                        }
                        if (err != null) {
                            log.warn("devradar: connect failed: ${err.message}")
                            scheduleReconnect(gen)
                        } else {
                            ws = socket
                        }
                    }
            } catch (t: Throwable) {
                log.warn("devradar: connect error", t)
                scheduleReconnect(gen)
            }
        }
    }

    private inner class Listener(private val gen: Int) : WebSocket.Listener {
        private val buf = StringBuilder()

        override fun onOpen(webSocket: WebSocket) {
            if (gen != generation) {
                try { webSocket.sendClose(WebSocket.NORMAL_CLOSURE, "superseded") } catch (_: Throwable) {}
                return
            }
            webSocket.request(1)
            send(webSocket, mapOf(
                "type" to "hello",
                "userId" to selfId,
                "userName" to userName,
                "ide" to ideName(),
                "project" to projectLabel,
            ))
            sendUpdate(selectedFile())
            heartbeat = exec.scheduleWithFixedDelay(
                { ws?.let { send(it, mapOf("type" to "heartbeat")) } },
                30, 30, TimeUnit.SECONDS,
            )
            refreshWidget()
        }

        override fun onText(webSocket: WebSocket, data: CharSequence, last: Boolean): CompletionStage<*>? {
            buf.append(data)
            if (last) {
                val text = buf.toString()
                buf.setLength(0)
                if (gen == generation) handleMessage(text)
            }
            webSocket.request(1)
            return null
        }

        override fun onClose(webSocket: WebSocket, statusCode: Int, reason: String?): CompletionStage<*>? {
            if (gen == generation) onDisconnect(gen)
            return null
        }

        override fun onError(webSocket: WebSocket, error: Throwable?) {
            if (gen == generation) onDisconnect(gen)
        }
    }

    private fun onDisconnect(gen: Int) {
        if (gen != generation) return
        ws = null
        heartbeat?.cancel(false); heartbeat = null
        // Stale presence data would otherwise stay visible in the click-popup while
        // the widget itself says "bağlanıyor…". Drop it so users see a truthful
        // empty list until the next presence broadcast arrives.
        users = emptyList()
        refreshWidget()
        scheduleReconnect(gen)
    }

    private fun scheduleReconnect(gen: Int) {
        if (disposed.get() || gen != generation) return
        exec.schedule({ if (gen == generation) connect() }, 5, TimeUnit.SECONDS)
    }

    private fun handleMessage(text: String) {
        try {
            val obj = JsonParser.parseString(text).asJsonObject
            if (obj.get("type")?.asString != "presence") return
            val arr = obj.getAsJsonArray("users") ?: return
            users = arr.map { e ->
                val u = e.asJsonObject
                fun strOrNull(k: String) = u.get(k)?.takeIf { !it.isJsonNull }?.asString
                DevradarUser(
                    userId = strOrNull("userId") ?: "",
                    userName = strOrNull("userName") ?: "?",
                    ide = strOrNull("ide") ?: "?",
                    project = strOrNull("project") ?: "?",
                    file = strOrNull("file"),
                    line = u.get("line")?.takeIf { !it.isJsonNull }?.asInt,
                    status = strOrNull("status") ?: "offline",
                    lastSeen = u.get("lastSeen")?.takeIf { !it.isJsonNull }?.asLong,
                )
            }
            refreshWidget()
        } catch (t: Throwable) {
            log.debug("devradar: bad message: $text", t)
        }
    }

    private fun sendUpdate(file: VirtualFile?) {
        val socket = ws ?: return
        val basePath = project.basePath
        val rel = when {
            file == null -> null
            basePath != null && file.path.startsWith(basePath) -> file.path.removePrefix(basePath).trimStart('/')
            else -> file.name
        }
        send(socket, mapOf("type" to "update", "file" to rel, "line" to null, "project" to projectLabel))
    }

    private fun selectedFile(): VirtualFile? =
        FileEditorManager.getInstance(project).selectedFiles.firstOrNull()

    private fun send(socket: WebSocket, payload: Map<String, Any?>) {
        val json = gson.toJson(payload)
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                synchronized(sendLock) {
                    socket.sendText(json, true).get(3, TimeUnit.SECONDS)
                }
            } catch (t: Throwable) {
                log.debug("devradar: send failed", t)
            }
        }
    }

    private fun refreshWidget() {
        ApplicationManager.getApplication().invokeLater {
            if (!project.isDisposed) WindowManager.getInstance().getStatusBar(project)?.updateWidget(DEVRADAR_WIDGET_ID)
        }
    }

    fun statusText(): String = when {
        noRepo -> "devradar: repo yok"
        !probed -> "devradar: …"
        ws == null -> "devradar: bağlanıyor…"
        else -> "devradar: ${users.count { it.status == "online" }} online"
    }

    fun tooltipText(): String {
        if (noRepo) return "Bu projenin git remote'u yok — devradar repo bazlı çalışır."
        val others = users.filter { it.status == "online" && it.userId != selfId }
        return buildString {
            append("Repo: ").append(projectLabel)
            if (others.isEmpty()) append("\nŞu an bu repoda tek başınasın.")
            else others.forEach { u ->
                append("\n• ").append(u.userName).append(" — ").append(u.ide)
                if (u.file != null) append(" · ").append(u.file)
            }
        }
    }

    override fun dispose() {
        disposed.set(true)
        heartbeat?.cancel(false)
        try { ws?.sendClose(WebSocket.NORMAL_CLOSURE, "ide closing") } catch (_: Throwable) {}
        ws = null
    }

    companion object {
        fun getInstance(project: Project): DevradarService = project.getService(DevradarService::class.java)
    }
}

private fun ideName(): String {
    val n = ApplicationInfo.getInstance().versionName.lowercase()
    return when {
        "rider" in n -> "rider"
        "intellij" in n || "idea" in n -> "intellij"
        "pycharm" in n -> "pycharm"
        "webstorm" in n -> "webstorm"
        "goland" in n -> "goland"
        "clion" in n -> "clion"
        "phpstorm" in n -> "phpstorm"
        "rubymine" in n -> "rubymine"
        else -> "jetbrains"
    }
}

private fun gitConfig(cwd: String, vararg args: String): String? = try {
    val p = ProcessBuilder(listOf("git", "config") + args).directory(File(cwd)).start()
    val out = p.inputStream.bufferedReader().readText().trim()
    if (!p.waitFor(3, TimeUnit.SECONDS)) { p.destroyForcibly(); null } else out.ifBlank { null }
} catch (t: Throwable) {
    null
}

private fun normalizeRemote(url: String): String {
    var s = url.trim()
    if (s.endsWith(".git", ignoreCase = true)) s = s.dropLast(4)
    Regex("""^[^@\s]+@([^:\s]+):(.+)$""").find(s)?.let { return "${it.groupValues[1]}/${it.groupValues[2]}".lowercase() }
    Regex("""^[a-zA-Z][a-zA-Z0-9+.\-]*://(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?/(.+)$""").find(s)
        ?.let { return "${it.groupValues[1]}/${it.groupValues[2]}".lowercase() }
    return s.lowercase()
}

private fun sha256Short(s: String): String =
    MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }.take(16)

fun formatLastSeen(ts: Long?): String {
    if (ts == null || ts <= 0) return "uzun süre önce"
    val age = (System.currentTimeMillis() - ts).coerceAtLeast(0L)
    val sec = age / 1000
    if (sec < 60) return "az önce"
    val min = sec / 60
    if (min < 60) return "$min dk önce"
    val hr = min / 60
    if (hr < 24) return "$hr sa önce"
    val day = hr / 24
    if (day < 7) return "$day gün önce"
    if (day < 30) return "${day / 7} hafta önce"
    return "uzun süre önce"
}
