package com.creeperux.sonus.data

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.provider.Settings as SystemSettings
import androidx.core.content.edit
import com.creeperux.sonus.core.AudioQuality
import com.creeperux.sonus.core.LoudnessLevel
import com.creeperux.sonus.core.LoudnessMode
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
        get() = enumOr(prefs.getString("replayGain", null), ReplayGainMode.Off)
        set(v) = prefs.edit { putString("replayGain", v.name) }

    var wifiQuality: AudioQuality
        get() = enumOr(prefs.getString("wifiQuality", null), AudioQuality.Auto)
        set(v) = prefs.edit { putString("wifiQuality", v.name) }

    var cellularQuality: AudioQuality
        get() = enumOr(prefs.getString("cellularQuality", null), AudioQuality.Auto)
        set(v) = prefs.edit { putString("cellularQuality", v.name) }

    var loudnessLevel: LoudnessLevel
        get() = enumOr(prefs.getString("loudnessLevel", null), LoudnessLevel.Off)
        set(v) = prefs.edit { putString("loudnessLevel", v.name) }

    var loudnessMode: LoudnessMode
        get() = enumOr(prefs.getString("loudnessMode", null), LoudnessMode.Album)
        set(v) = prefs.edit { putString("loudnessMode", v.name) }

    var alwaysOriginal: Boolean
        get() = prefs.getBoolean("alwaysOriginal", false)
        set(v) = prefs.edit { putBoolean("alwaysOriginal", v) }

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

    /** 设置 › 更新 › 启动时自动检查（每天一次）. */
    var autoCheckUpdates: Boolean
        get() = prefs.getBoolean("autoCheckUpdates", true)
        set(v) = prefs.edit { putBoolean("autoCheckUpdates", v) }

    /** When GitHub was last asked for a newer version (epoch ms; 0: never). */
    var lastUpdateCheck: Long
        get() = prefs.getLong("lastUpdateCheck", 0L)
        set(v) = prefs.edit { putLong("lastUpdateCheck", v) }

    /** The newer version that check found ("android-v0.4.0-test.1"; empty: none). */
    var knownUpdate: String
        get() = prefs.getString("knownUpdate", "").orEmpty()
        set(v) = prefs.edit { putString("knownUpdate", v) }

    /** The newer version the app last said was there, so that it says so once per version. */
    var announcedUpdate: String
        get() = prefs.getString("announcedUpdate", "").orEmpty()
        set(v) = prefs.edit { putString("announcedUpdate", v) }

    /** The version code that ran last: a new one has been installed when it differs (its download can go). */
    var lastVersionCode: Long
        get() = prefs.getLong("lastVersionCode", 0L)
        set(v) = prefs.edit { putLong("lastVersionCode", v) }

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
