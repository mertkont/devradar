package dev.devradar

import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity

class DevradarStartupActivity : ProjectActivity {
    override suspend fun execute(project: Project) {
        DevradarService.getInstance(project).start()
    }
}
