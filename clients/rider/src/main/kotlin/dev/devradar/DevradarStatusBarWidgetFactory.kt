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
        val rows = svc.users
            .sortedWith(compareByDescending<DevradarUser> { it.status == "online" }.thenBy { it.userName })
            .map { u ->
                val dot = if (u.status == "online") "● " else "○ "
                val where = if (u.status == "online") u.ide + (u.file?.let { " · $it" } ?: "") else "offline"
                "$dot${u.userName}  —  $where"
            }
        val items = rows.ifEmpty { listOf("(henüz veri yok)") }
        JBPopupFactory.getInstance()
            .createPopupChooserBuilder(items)
            .setTitle("devradar — kim, nerede")
            .createPopup()
            .show(RelativePoint(e))
    }
}
