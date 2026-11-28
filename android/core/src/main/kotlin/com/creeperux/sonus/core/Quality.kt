package com.creeperux.sonus.core

import kotlin.math.pow

/** Streaming quality preference for Wi-Fi or cellular/metered networks. */
enum class AudioQuality {
    /** Automatic: lossless on Wi-Fi, high (Opus 160) on cellular/metered; may temporarily step down on slow buffering. */
    Auto,
    /** Opus 96 kbps. */
    Normal,
    /** Opus 160 kbps. */
    High,
    /** Opus 256 kbps. */
    VeryHigh,
    /** Lossless FLAC at original sample rate and bit depth. */
    Lossless,
}

/** EBU R128 loudness normalization target level. */
enum class LoudnessLevel {
    /** Disabled (default): play at unmodified level. */
    Off,
    /** -18 LUFS target. */
    Quiet,
    /** -14 LUFS target (default when enabled). */
    Normal,
    /** -11 LUFS target. */
    Loud,
}

/** Whether loudness normalization preserves relative track dynamics across an album or levels each track independently. */
enum class LoudnessMode { Album, Track }

/** Server-measured EBU R128 integrated loudness (LUFS) and true peak (linear, 1.0 = 0 dBFS). */
data class LoudnessInfo(
    val trackLufs: Double?,
    val trackPeak: Double?,
    val albumLufs: Double?,
    val albumPeak: Double?,
)

/** One pre-generated playback rendition available on the server. */
data class RenditionInfo(
    val tier: String,
    val format: String,
    val sampleRate: Int,
    val bitDepth: Int,
    val channels: Int,
    val totalSamples: Long,
    val bitRate: Int,
    val fileSize: Long,
)

/** Rendition catalog and EBU R128 loudness metadata returned by `getSonusRenditions`. */
data class SongRenditions(
    val id: String,
    val sourceFormat: String,
    val sourceLossless: Boolean,
    val sourceSampleRate: Int,
    val sourceBitDepth: Int,
    val sourceBitRate: Int,
    val loudness: LoudnessInfo?,
    val renditions: List<RenditionInfo>,
)

/** X-Sonus-* HTTP response headers captured from a stream response. */
data class StreamHeaderInfo(
    val quality: String? = null,
    val format: String? = null,
    val sampleRate: Int? = null,
    val bitDepth: Int? = null,
    val bitRate: Int? = null,
)

/** Display info for the playback-bar quality badge. */
data class QualityBadgeInfo(val text: String, val isLossless: Boolean, val isHiRes: Boolean) {
    companion object {
        val Empty = QualityBadgeInfo("", isLossless = false, isHiRes = false)
    }
}

/**
 * Pure streaming-quality, auto-downgrade, EBU R128 loudness-gain, and playback-bar badge policy matching
 * the Windows and Web clients.
 */
object QualityPolicy {
    private val tierLadder = listOf("lossless", "veryHigh", "high", "normal")
    private val losslessFormats = setOf("flac", "wav", "alac", "aiff", "ape", "wv", "dsf", "dff")
    private val legacyTranscoded = setOf("dsf", "dff", "ape", "wv", "tta", "tak", "mpc", "wma")

    fun targetLufs(level: LoudnessLevel): Double? = when (level) {
        LoudnessLevel.Off -> null
        LoudnessLevel.Quiet -> -18.0
        LoudnessLevel.Normal -> -14.0
        LoudnessLevel.Loud -> -11.0
    }

    /**
     * Resolves the `sonusQuality` query parameter for `stream`, or null when the server does not advertise
     * `sonusRenditions`. Auto-downgrade only applies when the active network's preference is [AudioQuality.Auto].
     */
    fun resolveTier(
        setting: AudioQuality,
        metered: Boolean,
        alwaysOriginal: Boolean,
        autoDowngradeSteps: Int,
        serverHasRenditions: Boolean,
    ): String? {
        if (!serverHasRenditions) return null
        if (alwaysOriginal) return "original"
        return when (setting) {
            AudioQuality.Lossless -> "lossless"
            AudioQuality.VeryHigh -> "veryHigh"
            AudioQuality.High -> "high"
            AudioQuality.Normal -> "normal"
            AudioQuality.Auto -> {
                val base = if (metered) 2 else 0
                val idx = (base + autoDowngradeSteps.coerceAtLeast(0)).coerceIn(0, tierLadder.lastIndex)
                tierLadder[idx]
            }
        }
    }

    /**
     * Computes the linear amplitude multiplier for loudness normalization using server EBU R128 loudness (with
     * true-peak clipping protection), falling back to ReplayGain tags referenced to -18 LUFS.
     */
    fun computeLoudnessGain(
        level: LoudnessLevel,
        mode: LoudnessMode,
        loudness: LoudnessInfo?,
        rgAlbum: Double?,
        rgTrack: Double?,
        allowBoost: Boolean = true,
    ): Double {
        val target = targetLufs(level) ?: return 1.0

        if (loudness != null) {
            val measured = if (mode == LoudnessMode.Album) loudness.albumLufs ?: loudness.trackLufs else loudness.trackLufs ?: loudness.albumLufs
            val peak = if (mode == LoudnessMode.Album) loudness.albumPeak ?: loudness.trackPeak else loudness.trackPeak ?: loudness.albumPeak
            if (measured != null && measured.isFinite()) {
                var linear = 10.0.pow((target - measured) / 20.0)
                if (peak != null && peak.isFinite() && peak > 0.0001 && linear * peak > 1.0) {
                    linear = 1.0 / peak
                }
                return linear.coerceIn(0.05, if (allowBoost) 4.0 else 1.0)
            }
        }

        val rg = if (mode == LoudnessMode.Album) rgAlbum ?: rgTrack else rgTrack ?: rgAlbum
        if (rg != null && rg.isFinite()) {
            val db = rg + (target - (-18.0))
            val linear = 10.0.pow(db / 20.0)
            return linear.coerceIn(0.05, if (allowBoost) 4.0 else 1.0)
        }

        return 1.0
    }

    fun formatSampleRate(hz: Int): String {
        if (hz <= 0) return ""
        return if (hz % 1000 == 0) {
            "${hz / 1000} kHz"
        } else {
            val khz = hz / 1000.0
            val text = "%.1f".format(java.util.Locale.US, khz).removeSuffix(".0")
            "$text kHz"
        }
    }

    fun formatBadge(
        stream: StreamHeaderInfo?,
        renditions: SongRenditions?,
        track: Track?,
        requestedTier: String?,
    ): QualityBadgeInfo {
        if (stream != null && (!stream.quality.isNullOrEmpty() || !stream.format.isNullOrEmpty())) {
            val fmt = stream.format.orEmpty().trim().lowercase()
            val q = stream.quality.orEmpty().trim()
            var sr = stream.sampleRate ?: 0
            var bd = stream.bitDepth ?: 0
            var br = stream.bitRate ?: 0
            if (q == "original" && track != null) {
                if (sr <= 0) sr = track.sampleRate
                if (bd <= 0) bd = track.bitDepth
                if (br <= 0) br = track.bitrate
            }
            return buildBadge(fmt, q, sr, bd, br)
        }

        if (!requestedTier.isNullOrEmpty() && requestedTier != "original" && renditions != null) {
            val r = renditions.renditions.firstOrNull { it.tier.equals(requestedTier, ignoreCase = true) }
            if (r != null) return buildBadge(r.format.lowercase(), r.tier, r.sampleRate, r.bitDepth, r.bitRate)
            if (!renditions.sourceLossless && renditions.sourceFormat.isNotEmpty()) {
                return buildBadge(renditions.sourceFormat.lowercase(), "original", renditions.sourceSampleRate, renditions.sourceBitDepth, renditions.sourceBitRate)
            }
        }

        if (track == null) return QualityBadgeInfo.Empty
        if (requestedTier == null && track.suffix in legacyTranscoded) {
            return QualityBadgeInfo("MP3 320", isLossless = false, isHiRes = false)
        }
        val fallbackFmt = track.suffix.ifEmpty { track.codec }.lowercase()
        return buildBadge(fallbackFmt, if (track.isLossless) "lossless" else "original", track.sampleRate, track.bitDepth, track.bitrate, track.codec)
    }

    private fun buildBadge(fmt: String, quality: String, sampleRate: Int, bitDepth: Int, bitRate: Int, codecHint: String? = null): QualityBadgeInfo {
        val lossless = quality == "lossless" || bitDepth > 0 || fmt in losslessFormats
        if (lossless) {
            val hiRes = bitDepth > 16 || sampleRate > 48_000
            val rate = formatSampleRate(sampleRate)
            val detail = when {
                rate.isNotEmpty() && bitDepth > 0 -> "$rate/$bitDepth 位"
                rate.isNotEmpty() -> rate
                bitDepth > 0 -> "$bitDepth 位"
                else -> ""
            }
            return QualityBadgeInfo(if (detail.isNotEmpty()) "无损 · $detail" else "无损", isLossless = true, isHiRes = hiRes)
        }

        if (fmt == "opus") {
            val kbps = if (bitRate > 0) bitRate else when (quality) {
                "veryHigh" -> 256
                "high" -> 160
                "normal" -> 96
                else -> 0
            }
            return QualityBadgeInfo(if (kbps > 0) "Opus $kbps" else "Opus", isLossless = false, isHiRes = false)
        }

        val codec = when (fmt) {
            "mp3" -> "MP3"
            "aac", "m4a" -> "AAC"
            "ogg", "oga", "vorbis" -> "Vorbis"
            else -> if (!codecHint.isNullOrBlank() && codecHint != "?") codecHint else fmt.uppercase()
        }
        if (codec.isEmpty()) return QualityBadgeInfo.Empty
        return QualityBadgeInfo(if (bitRate > 0) "$codec $bitRate" else codec, isLossless = false, isHiRes = false)
    }
}
