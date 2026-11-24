package com.creeperux.sonus.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The sign-in kept between runs: the server, the user, and either the token (md5(password + salt)) with its salt, or an
 * API key (the browser sign-in, [DeviceLogin]: OpenSubsonic apiKeyAuthentication, a key of this app's own that the user
 * can revoke). The password itself is never kept. Token and key work like the password for this API, so they are
 * secrets: the app keeps this encrypted with a key in the Android Keystore.
 */
data class Login(val server: String, val user: String, val salt: String, val token: String, val apiKey: String? = null) {
    /** Signed in through the browser: requests carry the API key alone. */
    val isApiKey: Boolean get() = !apiKey.isNullOrEmpty()

    fun toJson(): String = JsonObject(
        if (isApiKey) mapOf("server" to JsonPrimitive(server), "user" to JsonPrimitive(user), "apiKey" to JsonPrimitive(apiKey))
        else mapOf("server" to JsonPrimitive(server), "user" to JsonPrimitive(user), "salt" to JsonPrimitive(salt), "token" to JsonPrimitive(token)),
    ).toString()

    // a data class prints its properties: never the secrets, should one end up in a log
    override fun toString() = "Login { server = $server, user = $user${if (isApiKey) ", by API key" else ""} }"

    companion object {
        fun withApiKey(server: String, user: String, apiKey: String) = Login(server, user, "", "", apiKey)

        fun fromJson(json: String?): Login? {
            if (json.isNullOrBlank()) return null
            val o = try {
                Json.parseToJsonElement(json) as? JsonObject
            } catch (_: Exception) {
                null
            } ?: return null
            val server = J.str(o, "server").orEmpty()
            val key = J.str(o, "apiKey").orEmpty()
            if (server.isNotEmpty() && key.isNotEmpty()) return withApiKey(server, J.str(o, "user").orEmpty(), key)
            val user = J.str(o, "user").orEmpty()
            val salt = J.str(o, "salt").orEmpty()
            val token = J.str(o, "token").orEmpty()
            return if (server.isNotEmpty() && user.isNotEmpty() && salt.isNotEmpty() && token.isNotEmpty()) Login(server, user, salt, token) else null
        }
    }
}

/** The server answered with a Subsonic error (wrong password, not found, not allowed …). */
class SubsonicException(val code: Int, message: String, val httpStatus: Int = 0) : Exception(message) {
    /** The sign-in itself was refused: wrong password (40), token not allowed (41), an API key revoked (44). */
    val isAuthentication: Boolean get() = code == 40 || code == 41 || code == 44
}

/** The server could not be reached at all. */
class ServerUnreachableException(message: String, cause: Throwable? = null) : Exception(message, cause)
