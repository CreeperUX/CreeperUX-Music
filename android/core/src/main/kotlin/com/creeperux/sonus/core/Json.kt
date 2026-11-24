package com.creeperux.sonus.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import java.time.Instant
import java.time.OffsetDateTime
import java.time.format.DateTimeParseException

/**
 * Reading the server's JSON the forgiving way the Windows client does (SubsonicClient.Str/Int/Num/…): a missing or
 * differently typed field is null or 0, never an exception. Numbers given as strings are read as numbers too.
 */
internal object J {
    fun obj(e: JsonElement?, name: String): JsonObject? = (e as? JsonObject)?.get(name) as? JsonObject

    fun array(e: JsonElement?, name: String): List<JsonElement> = ((e as? JsonObject)?.get(name) as? JsonArray) ?: emptyList()

    fun str(e: JsonElement?, name: String): String? {
        val v = (e as? JsonObject)?.get(name) as? JsonPrimitive ?: return null
        if (v is JsonNull) return null
        return if (v.isString) v.content else if (v.booleanOrNull == null) v.content else null
    }

    fun numOrNull(e: JsonElement?, name: String): Double? {
        val v = (e as? JsonObject)?.get(name) as? JsonPrimitive ?: return null
        if (v is JsonNull || v.isString) return null
        return v.doubleOrNull
    }

    fun num(e: JsonElement?, name: String): Double = numOrNull(e, name) ?: 0.0

    fun int(e: JsonElement?, name: String): Int = numOrNull(e, name)?.toInt() ?: 0

    fun bool(e: JsonElement?, name: String): Boolean {
        val v = (e as? JsonObject)?.get(name) as? JsonPrimitive ?: return false
        return !v.isString && v.booleanOrNull == true
    }

    /** An ISO 8601 date ("2025-03-01T10:00:00Z", with or without an offset) as epoch milliseconds. */
    fun date(e: JsonElement?, name: String): Long? {
        val s = str(e, name) ?: return null
        return try {
            OffsetDateTime.parse(s).toInstant().toEpochMilli()
        } catch (_: DateTimeParseException) {
            try {
                Instant.parse(s).toEpochMilli()
            } catch (_: DateTimeParseException) {
                try {
                    java.time.LocalDateTime.parse(s).toInstant(java.time.ZoneOffset.UTC).toEpochMilli()
                } catch (_: DateTimeParseException) {
                    null
                }
            }
        }
    }
}
