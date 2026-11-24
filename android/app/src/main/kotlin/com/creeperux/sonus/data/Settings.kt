package com.creeperux.sonus.data

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.provider.Settings as SystemSettings
import androidx.core.content.edit
import com.creeperux.sonus.core.PlaybackOrder
import com.creeperux.sonus.core.ReplayGainMode
import java.security.SecureRandom

enum class ThemeMode { System, Dark, Light }

/** The app's preferences (the Windows app's AppSettings). The sign-in is not here: it is in [LoginStore]. */
class Settings(private val prefs: SharedPreferences) {
    var order: PlaybackOrder
        get() = enumOr(prefs.getString("order", null), PlaybackOrder.Default)
        set(v) = prefs.edit { putString("order", v.name) }

    var replayGain: ReplayGainMode
        get() = enumOr(prefs.getString("replayGain", null), ReplayGainMode.Album)
        set(v) = prefs.edit { putString("replayGain", v.name) }

    var theme: ThemeMode
        get() = enumOr(prefs.getString("theme", null), ThemeMode.System)
        set(v) = prefs.edit { putString("theme", v.name) }

    /** The server and user typed last, offered again on the sign-in page. */
    var lastServer: String
        get() = prefs.getString("lastServer", "").orEmpty()
        set(v) = prefs.edit { putString("lastServer", v) }

    var lastUser: String
        get() = prefs.getString("lastUser", "").orEmpty()
        set(v) = prefs.edit { putString("lastUser", v) }

    var libraryFilter: String
        get() = prefs.getString("libraryFilter", "").orEmpty()
        set(v) = prefs.edit { putString("libraryFilter", v) }

    var librarySort: String
        get() = prefs.getString("librarySort", "recent").orEmpty()
        set(v) = prefs.edit { putString("librarySort", v) }

    /**
     * This installation's own device id for Sonus Connect v2 (docs/protocol/connect.md: a random id made once per
     * installation, [A-Za-z0-9_-]{8,64}).
     */
    val deviceId: String
        get() = prefs.getString("deviceId", null) ?: newId().also { id -> prefs.edit { putString("deviceId", id) } }

    private fun newId(): String {
        val chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
        val r = SecureRandom()
        return (1..22).map { chars[r.nextInt(chars.length)] }.joinToString("")
    }

    private inline fun <reified T : Enum<T>> enumOr(name: String?, fallback: T): T = enumValues<T>().firstOrNull { it.name == name } ?: fallback

    companion object {
        /** The phone's name as its owner set it ("小明的手机"), else its model: what the server lists this app as. */
        fun deviceName(context: Context): String =
            SystemSettings.Global.getString(context.contentResolver, SystemSettings.Global.DEVICE_NAME)?.takeIf { it.isNotBlank() } ?: Build.MODEL
    }
}
