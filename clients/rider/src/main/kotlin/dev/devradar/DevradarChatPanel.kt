package dev.devradar

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.ComboBox
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPanel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import javax.swing.Box
import javax.swing.JButton
import javax.swing.JPanel

/**
 * The chat tool window. A single panel with:
 *  - a peer selector at the top (built from the live presence list)
 *  - the conversation transcript in the middle
 *  - a text field + send button at the bottom
 *
 * Conversations are kept entirely in memory for the lifetime of the IDE
 * session — closing the IDE clears history, as the design intends.
 */
class DevradarChatPanel(project: Project) : JBPanel<DevradarChatPanel>(BorderLayout()) {

    private val service = DevradarService.getInstance(project)

    private val peerCombo = ComboBox<PeerEntry>()
    private val statusLabel = JBLabel(" ")
    private val transcript = JBTextArea().apply {
        isEditable = false
        lineWrap = true
        wrapStyleWord = true
        margin = JBUI.insets(4, 6)
    }
    private val inputField = JBTextField()
    private val sendButton = JButton("Gönder")

    private val conversations = LinkedHashMap<String, MutableList<UiMessage>>()
    private val timeFmt = DateTimeFormatter.ofPattern("HH:mm")
    private val listener = ChatListener()

    init {
        border = JBUI.Borders.empty(6)
        add(buildHeader(), BorderLayout.NORTH)
        add(JBScrollPane(transcript), BorderLayout.CENTER)
        add(buildFooter(), BorderLayout.SOUTH)

        peerCombo.addActionListener { renderConversation() }
        sendButton.addActionListener { doSend() }
        inputField.addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                if (e.keyCode == KeyEvent.VK_ENTER && !e.isShiftDown) {
                    e.consume()
                    doSend()
                }
            }
        })

        service.addChatListener(listener)
        rebuildPeerCombo()
        renderConversation()
    }

    /** Caller (e.g. status-bar click) can pre-select a peer when opening. */
    fun selectPeer(userId: String) {
        rebuildPeerCombo(preferUserId = userId)
        renderConversation()
        ApplicationManager.getApplication().invokeLater { inputField.requestFocusInWindow() }
    }

    fun disposeListener() {
        service.removeChatListener(listener)
    }

    // ---------- UI building ----------

    private fun buildHeader(): JPanel = JPanel(BorderLayout()).apply {
        border = JBUI.Borders.emptyBottom(6)
        add(JBLabel("Kiminle: "), BorderLayout.WEST)
        add(peerCombo, BorderLayout.CENTER)
        val right = JPanel().apply {
            add(Box.createHorizontalStrut(8))
            add(statusLabel)
        }
        add(right, BorderLayout.EAST)
    }

    private fun buildFooter(): JPanel = JPanel(BorderLayout(6, 0)).apply {
        border = JBUI.Borders.emptyTop(6)
        add(inputField, BorderLayout.CENTER)
        add(sendButton, BorderLayout.EAST)
    }

    // ---------- State management ----------

    private fun rebuildPeerCombo(preferUserId: String? = null) {
        val ourId = service.selfUserId
        val entries = service.users
            .filter { it.userId != ourId && it.userId.isNotBlank() }
            .sortedWith(compareByDescending<DevradarUser> { it.status == "online" }.thenBy { it.userName })
            .map { PeerEntry(it.userId, it.userName, it.status == "online") }

        val previousSelection = preferUserId ?: (peerCombo.selectedItem as? PeerEntry)?.userId
        peerCombo.removeAllItems()

        if (entries.isEmpty()) {
            peerCombo.addItem(PeerEntry("", "(kimse yok)", false))
            peerCombo.isEnabled = false
        } else {
            peerCombo.isEnabled = true
            for (e in entries) peerCombo.addItem(e)
            if (previousSelection != null) {
                val match = entries.indexOfFirst { it.userId == previousSelection }
                if (match >= 0) peerCombo.selectedIndex = match
            }
        }
        updateSendEnabled()
    }

    private fun currentPeer(): PeerEntry? = peerCombo.selectedItem as? PeerEntry

    private fun renderConversation() {
        val peer = currentPeer()
        if (peer == null || peer.userId.isBlank()) {
            transcript.text = ""
            statusLabel.text = " "
            updateSendEnabled()
            return
        }

        val msgs = conversations[peer.userId] ?: emptyList()
        val sb = StringBuilder()
        for (m in msgs) {
            val name = if (m.self) "Sen" else m.fromName
            val time = LocalTime.ofInstant(Instant.ofEpochMilli(m.ts), ZoneId.systemDefault()).format(timeFmt)
            sb.append('[').append(time).append("]  ").append(name).append(": ").append(m.text)
            when {
                m.failed != null -> sb.append("   ⚠ ").append(m.failed)
                m.sending -> sb.append("   …")
            }
            sb.append('\n')
        }
        transcript.text = sb.toString()
        transcript.caretPosition = transcript.document.length

        statusLabel.text = if (peer.online) "● online" else "○ offline"
        statusLabel.foreground = if (peer.online) JBColor(0x2E8B57, 0x6BB76B) else JBColor.GRAY
        updateSendEnabled()
    }

    private fun updateSendEnabled() {
        val peer = currentPeer()
        val ready = peer != null && peer.userId.isNotBlank() && peer.online && service.isConnected
        sendButton.isEnabled = ready
        inputField.isEnabled = ready
        inputField.toolTipText = when {
            !service.isConnected -> "Sunucuya bağlı değilsin"
            peer == null || peer.userId.isBlank() -> "Önce birini seç"
            !peer.online -> "${peer.name} şu an offline"
            else -> null
        }
    }

    private fun doSend() {
        val peer = currentPeer() ?: return
        if (peer.userId.isBlank()) return
        val text = inputField.text.trim()
        if (text.isEmpty()) return
        if (!sendButton.isEnabled) return

        val id = service.sendChat(peer.userId, text) ?: return
        val now = System.currentTimeMillis()
        val msgs = conversations.getOrPut(peer.userId) { mutableListOf() }
        msgs.add(
            UiMessage(
                id = id,
                text = text,
                ts = now,
                self = true,
                fromName = service.selfUserName,
                sending = true,
                failed = null,
            ),
        )
        inputField.text = ""
        renderConversation()
    }

    // ---------- Service callbacks (called from non-EDT threads) ----------

    private inner class ChatListener : DevradarChatListener {
        override fun onChat(msg: ChatMessage) {
            ApplicationManager.getApplication().invokeLater {
                val peerId = if (msg.self) msg.to else msg.from
                if (peerId == service.selfUserId || peerId.isBlank()) return@invokeLater
                val msgs = conversations.getOrPut(peerId) { mutableListOf() }
                val existing = msgs.find { it.id == msg.id }
                if (existing != null) {
                    existing.sending = false
                    existing.failed = null
                } else {
                    msgs.add(
                        UiMessage(
                            id = msg.id,
                            text = msg.text,
                            ts = msg.ts,
                            self = msg.self,
                            fromName = msg.fromName,
                            sending = false,
                            failed = null,
                        ),
                    )
                    if (!msg.self && currentPeer()?.userId != peerId) {
                        // Auto-switch to the peer who just messaged so the user sees it.
                        // (Optional UX: comment out if intrusive.)
                        rebuildPeerCombo(preferUserId = peerId)
                    }
                }
                if (currentPeer()?.userId == peerId) renderConversation()
            }
        }

        override fun onChatAck(id: String, ts: Long) {
            ApplicationManager.getApplication().invokeLater {
                if (updateMessageById(id) { it.sending = false; it.failed = null }) renderConversation()
            }
        }

        override fun onChatError(id: String, reason: String) {
            ApplicationManager.getApplication().invokeLater {
                val human = when (reason) {
                    "offline" -> "alıcı offline"
                    "rate-limited" -> "çok hızlı"
                    "disconnected" -> "bağlı değil"
                    else -> "gönderilemedi"
                }
                if (updateMessageById(id) { it.sending = false; it.failed = human }) renderConversation()
            }
        }

        override fun onConnectionChanged(connected: Boolean) {
            ApplicationManager.getApplication().invokeLater {
                if (!connected) {
                    // Mark every still-pending optimistic message as failed.
                    for ((_, msgs) in conversations) {
                        for (m in msgs) if (m.sending) { m.sending = false; m.failed = "bağlı değil" }
                    }
                }
                renderConversation()
            }
        }

        override fun onPresenceChanged() {
            ApplicationManager.getApplication().invokeLater {
                rebuildPeerCombo()
                renderConversation()
            }
        }

        private inline fun updateMessageById(id: String, update: (UiMessage) -> Unit): Boolean {
            for ((_, msgs) in conversations) {
                val m = msgs.find { it.id == id } ?: continue
                update(m)
                return true
            }
            return false
        }
    }

    // ---------- value types ----------

    data class PeerEntry(val userId: String, val name: String, val online: Boolean) {
        override fun toString(): String = (if (online) "● " else "○ ") + name
    }

    private data class UiMessage(
        val id: String,
        val text: String,
        val ts: Long,
        val self: Boolean,
        val fromName: String,
        var sending: Boolean,
        var failed: String?,
    )
}
