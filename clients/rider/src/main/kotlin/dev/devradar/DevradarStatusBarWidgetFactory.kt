package dev.devradar

import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.ui.awt.RelativePoint
import com.intellij.util.Consumer
import java.awt.Component
import java.awt.event.MouseEvent

class DevradarStatusBarWidgetFactory : StatusBarWidgetFactory {
    override fun getId(): String = DEVRADAR_WIDGET_ID
    override fun getDisplayName(): String = "devradar"
    override fun isAvailable(project: Project): Boolean = true
    override fun createWidget(project: Project): StatusBarWidget = DevradarStatusBarWidget(project)
    override fun disposeWidget(widget: StatusBarWidget) = Unit
    override fun canBeEnabledOn(statusBar: StatusBar): Boolean = true
}

class DevradarStatusBarWidget(private val project: Project) :
    StatusBarWidget, StatusBarWidget.TextPresentation, DumbAware {

    override fun ID(): String = DEVRADAR_WIDGET_ID
    override fun getPresentation(): StatusBarWidget.WidgetPresentation = this
    override fun install(statusBar: StatusBar) = Unit
    override fun dispose() = Unit

    override fun getText(): String = DevradarService.getInstance(project).statusText()
    override fun getAlignment(): Float = Component.LEFT_ALIGNMENT
    override fun getTooltipText(): String = DevradarService.getInstance(project).tooltipText()

    override fun getClickConsumer(): Consumer<MouseEvent> = Consumer { e ->
        val svc = DevradarService.getInstance(project)
        // Build parallel lists: a label for display, and the user behind each row
        // (or null when the row is just informational — own entry, "no data").
        val sorted = svc.users
            .sortedWith(compareByDescending<DevradarUser> { it.status == "online" }.thenBy { it.userName })
        val rows = mutableListOf<String>()
        val peers = mutableListOf<DevradarUser?>()
        for (u in sorted) {
            val dot = if (u.status == "online") "● " else "○ "
            val where = if (u.status == "online") {
                u.ide + (u.file?.let { " · $it" } ?: "")
            } else {
                "offline · son görülme: ${formatLastSeen(u.lastSeen)}"
            }
            // VS Code lets you open a chat panel with offline peers too (input
            // stays disabled, banner explains why) — match that behaviour so
            // clicking an offline row from the status-bar popup also works.
            val suffix = if (u.userId == svc.selfUserId) "   (sen)" else "   →  💬 sohbet"
            rows.add("$dot${u.userName}  —  $where$suffix")
            peers.add(u)
        }
        if (rows.isEmpty()) {
            rows.add("(henüz veri yok)")
            peers.add(null)
        }
        JBPopupFactory.getInstance()
            .createPopupChooserBuilder(rows)
            .setTitle("devradar — birine tıkla → sohbet")
            .setItemChosenCallback { chosen ->
                val idx = rows.indexOf(chosen)
                val peer = peers.getOrNull(idx) ?: return@setItemChosenCallback
                if (peer.userId == svc.selfUserId) return@setItemChosenCallback
                // Open chat regardless of online status — for offline peers
                // the panel will show the banner + last-seen and keep input
                // disabled, but the user can at least see history.
                DevradarChatToolWindowFactory.open(project, peer.userId)
            }
            .createPopup()
            .show(RelativePoint(e))
    }
}
