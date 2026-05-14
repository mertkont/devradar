package dev.devradar

import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.content.ContentFactory

const val DEVRADAR_CHAT_TOOL_WINDOW_ID = "devradar Chat"

class DevradarChatToolWindowFactory : ToolWindowFactory, DumbAware {

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = DevradarChatPanel(project)
        val content = ContentFactory.getInstance().createContent(panel, "", false)
        content.setDisposer { panel.disposeListener() }
        toolWindow.contentManager.addContent(content)
    }

    companion object {
        /**
         * Open the chat tool window and, if [peerUserId] is supplied, pre-select
         * that peer. Safe to call from any thread; switches to EDT internally via
         * the ToolWindowManager.
         */
        fun open(project: Project, peerUserId: String? = null) {
            val mgr = ToolWindowManager.getInstance(project)
            val tw = mgr.getToolWindow(DEVRADAR_CHAT_TOOL_WINDOW_ID) ?: return
            tw.activate({
                if (peerUserId != null) {
                    val panel = tw.contentManager.getContent(0)?.component as? DevradarChatPanel
                    panel?.selectPeer(peerUserId)
                }
            }, true)
        }
    }
}
