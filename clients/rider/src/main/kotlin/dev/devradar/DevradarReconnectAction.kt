package dev.devradar

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

// "Tools → devradar: Reconnect" — manual escape hatch when the WebSocket
// is stuck in a half-open state (e.g. after macOS sleep/wake) and the user
// doesn't want to restart the whole IDE.
class DevradarReconnectAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        DevradarService.getInstance(project).restart()
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT
}
