package dev.devradar

import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindowManager

/**
 * Project-scoped chat listener whose only job is to surface incoming chat
 * messages as IDE balloon notifications when the chat tool window is not
 * currently visible. It runs from the moment the project opens (registered in
 * DevradarStartupActivity), so messages still get noticed even before the user
 * has ever opened the chat tool window — without forcing the UI to be visible.
 */
class DevradarChatNotifier(private val project: Project) : DevradarChatListener {

    override fun onChat(msg: ChatMessage) {
        if (msg.self) return // never balloon-notify on our own outgoing echoes
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            val tw = ToolWindowManager.getInstance(project).getToolWindow(DEVRADAR_CHAT_TOOL_WINDOW_ID)
            // If the chat panel is currently on screen, the in-tool-window UI
            // already shows the message — no point doubling up with a balloon.
            if (tw?.isVisible == true) return@invokeLater

            val preview = if (msg.text.length > 120) msg.text.substring(0, 117) + "…" else msg.text
            val notification = NotificationGroupManager.getInstance()
                .getNotificationGroup("devradar.chat")
                .createNotification(
                    /* title  = */ msg.fromName,
                    /* content = */ preview,
                    NotificationType.INFORMATION,
                )
            notification.addAction(NotificationAction.createSimple("Aç") {
                DevradarChatToolWindowFactory.open(project, msg.from)
                notification.expire()
            })
            notification.notify(project)
        }
    }

    override fun onChatAck(id: String, ts: Long) {}
    override fun onChatError(id: String, reason: String) {}
    override fun onConnectionChanged(connected: Boolean) {}
    override fun onPresenceChanged() {}
}
