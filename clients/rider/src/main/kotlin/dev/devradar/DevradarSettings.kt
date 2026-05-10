package dev.devradar

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

@Service(Service.Level.APP)
@State(name = "DevradarSettings", storages = [Storage("devradar.xml")])
class DevradarSettings : PersistentStateComponent<DevradarSettings.State> {

    data class State(
        var serverUrl: String = "",
        var displayName: String = "",
        var teamKey: String = "",
    )

    private var state = State()

    override fun getState(): State = state
    override fun loadState(s: State) {
        state = s
    }

    var serverUrl: String
        get() = state.serverUrl.ifBlank { DEVRADAR_DEFAULT_SERVER }
        set(v) { state.serverUrl = v.trim() }

    var displayName: String
        get() = state.displayName.trim()
        set(v) { state.displayName = v.trim() }

    var teamKey: String
        get() = state.teamKey.trim()
        set(v) { state.teamKey = v.trim() }

    companion object {
        fun getInstance(): DevradarSettings =
            ApplicationManager.getApplication().getService(DevradarSettings::class.java)
    }
}
