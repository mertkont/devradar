package dev.devradar

import com.intellij.openapi.options.Configurable
import com.intellij.openapi.project.ProjectManager
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import javax.swing.JComponent
import javax.swing.JPanel

class DevradarConfigurable : Configurable {

    private val serverUrlField = JBTextField()
    private val displayNameField = JBTextField()
    private val teamKeyField = JBTextField()
    private var root: JPanel? = null

    override fun getDisplayName(): String = "devradar"

    override fun createComponent(): JComponent {
        reset()
        val panel = FormBuilder.createFormBuilder()
            .addLabeledComponent("Sunucu adresi (wss://…/ws):", serverUrlField)
            .addLabeledComponent("Görünen isim:", displayNameField)
            .addComponent(JBLabel("Boş bırakılırsa git'teki adın (user.name) kullanılır."))
            .addLabeledComponent("Takım anahtarı (opsiyonel):", teamKeyField)
            .addComponent(JBLabel("Aynı repodaki herkes aynı değeri girerse, repo adresini bilen yabancılar odaya giremez."))
            .addComponentFillVertically(JPanel(), 0)
            .panel
        root = panel
        return panel
    }

    override fun isModified(): Boolean {
        val s = DevradarSettings.getInstance()
        return serverUrlField.text.trim() != s.serverUrl ||
            displayNameField.text.trim() != s.displayName ||
            teamKeyField.text.trim() != s.teamKey
    }

    override fun apply() {
        val s = DevradarSettings.getInstance()
        s.serverUrl = serverUrlField.text
        s.displayName = displayNameField.text
        s.teamKey = teamKeyField.text
        for (project in ProjectManager.getInstance().openProjects) {
            if (!project.isDisposed) DevradarService.getInstance(project).restart()
        }
    }

    override fun reset() {
        val s = DevradarSettings.getInstance()
        serverUrlField.text = s.serverUrl
        displayNameField.text = s.displayName
        teamKeyField.text = s.teamKey
    }

    override fun disposeUIResources() {
        root = null
    }
}
