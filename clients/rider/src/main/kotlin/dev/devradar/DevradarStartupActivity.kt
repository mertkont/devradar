package dev.devradar

import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity

class DevradarStartupActivity : ProjectActivity {
    override suspend fun execute(project: Project) {
        val service = DevradarService.getInstance(project)
        service.start()
        // Register the notification-only chat listener at project open so we
        // can surface incoming chats as balloon notifications even before the
        // user has opened the chat tool window for the first time.
        service.addChatListener(DevradarChatNotifier(project))
    }
}
