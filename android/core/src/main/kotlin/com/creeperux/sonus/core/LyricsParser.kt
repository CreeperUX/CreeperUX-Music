package com.creeperux.sonus.core

import kotlinx.serialization.json.JsonElement

/** Lyrics text: "[01:02.50]line" (any number of stamps per line, LRC) becomes timed lines, plain text untimed lines. */
object LyricsParser {
    private val stamp = Regex("\\[(\\d{1,3}):(\\d{1,2})(?:[.:](\\d{1,3}))?]")
    private val header = Regex("^\\[[a-z]+:.*]$", RegexOption.IGNORE_CASE)

    fun parse(text: String?): List<LyricLine>? {
        if (text.isNullOrBlank()) return null
        val timed = mutableListOf<LyricLine>()
        val plain = mutableListOf<LyricLine>()
        for (raw in text.replace("\r", "").split('\n')) {
            val stamps = stamp.findAll(raw).toList()
            val line = header.replace(stamp.replace(raw, "").trim(), "").trim() // drops [ar:…] [ti:…] headers
            if (stamps.isNotEmpty()) {
                for (m in stamps) {
                    val (min, sec, frac) = m.destructured
                    val time = min.toInt() * 60 + sec.toInt() + (if (frac.isNotEmpty()) "0.$frac".toDouble() else 0.0)
                    timed += LyricLine(time, line)
                }
            } else if (line.isNotEmpty() || plain.isNotEmpty()) {
                plain += LyricLine(null, line)
            }
        }
        if (timed.isNotEmpty()) return timed.sortedBy { it.time }
        while (plain.isNotEmpty() && plain.last().text.isEmpty()) plain.removeAt(plain.lastIndex)
        return plain.ifEmpty { null }
    }

    /**
     * OpenSubsonic structured lyrics (getLyricsBySongId) → lines. "offset" (ms) is subtracted from each line's start:
     * a positive offset shows the lyrics sooner, as the OpenSubsonic specification says.
     */
    fun fromStructured(pick: JsonElement): List<LyricLine> {
        val synced = J.bool(pick, "synced")
        val offset = J.num(pick, "offset") / 1000
        return J.array(pick, "line").map { l ->
            LyricLine(if (synced) maxOf(0.0, J.num(l, "start") / 1000 - offset) else null, J.str(l, "value").orEmpty())
        }
    }

    /** The line playing at a position (seconds): the last one that has started (−1 before the first, or for untimed lyrics). */
    fun currentLine(lines: List<LyricLine>, position: Double): Int {
        var at = -1
        for ((i, l) in lines.withIndex()) {
            val t = l.time ?: return -1
            if (t <= position + 0.05) at = i else break
        }
        return at
    }
}
