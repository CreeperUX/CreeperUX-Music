package com.creeperux.sonus.core

import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Test

class QualityPolicyTest {
    @Test
    fun resolveTierRespectsServerExtensionOriginalAndAutoDowngrade() {
        assertThat(QualityPolicy.resolveTier(AudioQuality.Auto, metered = false, alwaysOriginal = false, autoDowngradeSteps = 0, serverHasRenditions = false)).isNull()
        assertThat(QualityPolicy.resolveTier(AudioQuality.Lossless, metered = true, alwaysOriginal = true, autoDowngradeSteps = 2, serverHasRenditions = false)).isNull()

        assertThat(QualityPolicy.resolveTier(AudioQuality.Normal, metered = true, alwaysOriginal = true, autoDowngradeSteps = 3, serverHasRenditions = true)).isEqualTo("original")

        assertThat(QualityPolicy.resolveTier(AudioQuality.Auto, metered = false, alwaysOriginal = false, autoDowngradeSteps = 0, serverHasRenditions = true)).isEqualTo("lossless")
        assertThat(QualityPolicy.resolveTier(AudioQuality.Auto, metered = false, alwaysOriginal = false, autoDowngradeSteps = 1, serverHasRenditions = true)).isEqualTo("veryHigh")
        assertThat(QualityPolicy.resolveTier(AudioQuality.Auto, metered = false, alwaysOriginal = false, autoDowngradeSteps = 2, serverHasRenditions = true)).isEqualTo("high")
        assertThat(QualityPolicy.resolveTier(AudioQuality.Auto, metered = false, alwaysOriginal = false, autoDowngradeSteps = 3, serverHasRenditions = true)).isEqualTo("normal")

        assertThat(QualityPolicy.resolveTier(AudioQuality.Auto, metered = true, alwaysOriginal = false, autoDowngradeSteps = 0, serverHasRenditions = true)).isEqualTo("high")
        assertThat(QualityPolicy.resolveTier(AudioQuality.Auto, metered = true, alwaysOriginal = false, autoDowngradeSteps = 1, serverHasRenditions = true)).isEqualTo("normal")

        // Manual tiers never auto-downgrade
        assertThat(QualityPolicy.resolveTier(AudioQuality.Lossless, metered = true, alwaysOriginal = false, autoDowngradeSteps = 3, serverHasRenditions = true)).isEqualTo("lossless")
        assertThat(QualityPolicy.resolveTier(AudioQuality.VeryHigh, metered = false, alwaysOriginal = false, autoDowngradeSteps = 3, serverHasRenditions = true)).isEqualTo("veryHigh")
    }

    @Test
    fun computeLoudnessGainHandlesEbuR128PeakCeilingAndReplayGainFallback() {
        val loud = LoudnessInfo(trackLufs = -10.0, trackPeak = 0.95, albumLufs = -12.0, albumPeak = 0.98)
        assertThat(QualityPolicy.computeLoudnessGain(LoudnessLevel.Off, LoudnessMode.Album, loud, -6.0, -5.0)).isEqualTo(1.0)
        assertThat(QualityPolicy.computeLoudnessGain(LoudnessLevel.Normal, LoudnessMode.Album, loud, null, null)).isWithin(0.01).of(0.794)
        assertThat(QualityPolicy.computeLoudnessGain(LoudnessLevel.Normal, LoudnessMode.Track, loud, null, null)).isWithin(0.01).of(0.631)

        // Quiet track boosted toward -11 LUFS is clamped by true peak (0.5 -> max 2.0x)
        val quiet = LoudnessInfo(trackLufs = -24.0, trackPeak = 0.5, albumLufs = -24.0, albumPeak = 0.5)
        assertThat(QualityPolicy.computeLoudnessGain(LoudnessLevel.Loud, LoudnessMode.Track, quiet, null, null, allowBoost = true)).isWithin(0.001).of(2.0)
        assertThat(QualityPolicy.computeLoudnessGain(LoudnessLevel.Loud, LoudnessMode.Track, quiet, null, null, allowBoost = false)).isWithin(0.001).of(1.0)

        // ReplayGain fallback relative to -18 LUFS
        assertThat(QualityPolicy.computeLoudnessGain(LoudnessLevel.Quiet, LoudnessMode.Track, null, -8.0, -6.0)).isWithin(0.01).of(0.501)
        assertThat(QualityPolicy.computeLoudnessGain(LoudnessLevel.Normal, LoudnessMode.Track, null, -8.0, -6.0)).isWithin(0.01).of(0.794)
    }

    @Test
    fun formatBadgeFormatsHeadersRenditionsAndFallbacks() {
        val hiRes = QualityPolicy.formatBadge(StreamHeaderInfo("lossless", "flac", 96000, 24, 2800), null, null, "lossless")
        assertThat(hiRes.text).isEqualTo("无损 · 96 kHz/24 位")
        assertThat(hiRes.isLossless).isTrue()
        assertThat(hiRes.isHiRes).isTrue()

        val cd = QualityPolicy.formatBadge(StreamHeaderInfo("lossless", "flac", 44100, 16, 900), null, null, "lossless")
        assertThat(cd.text).isEqualTo("无损 · 44.1 kHz/16 位")
        assertThat(cd.isLossless).isTrue()
        assertThat(cd.isHiRes).isFalse()

        val opus = QualityPolicy.formatBadge(StreamHeaderInfo("high", "opus", 48000, null, 160), null, null, "high")
        assertThat(opus.text).isEqualTo("Opus 160")
        assertThat(opus.isLossless).isFalse()

        val rend = SongRenditions(
            id = "s1", sourceFormat = "flac", sourceLossless = true,
            sourceSampleRate = 96000, sourceBitDepth = 24, sourceBitRate = 2900,
            loudness = null,
            renditions = listOf(RenditionInfo("veryHigh", "opus", 48000, 0, 2, 8640000L, 256, 5_700_000L)),
        )
        assertThat(QualityPolicy.formatBadge(null, rend, null, "veryHigh").text).isEqualTo("Opus 256")
    }

    @Test
    fun subsonicClientStreamUrlAndGetSonusRenditions() = runBlocking {
        val body = """
        {
          "subsonic-response": {
            "status": "ok",
            "version": "1.16.1",
            "sonusRenditions": {
              "enabled": true,
              "songs": [
                {
                  "id": "s1",
                  "sourceFormat": "flac",
                  "sourceLossless": true,
                  "sourceSampleRate": 96000,
                  "sourceBitDepth": 24,
                  "sourceBitRate": 2910,
                  "loudness": { "trackLufs": -10.6, "trackPeak": 0.912, "albumLufs": -11.2, "albumPeak": 0.985 },
                  "renditions": [
                    { "tier": "lossless", "format": "flac", "sampleRate": 96000, "bitDepth": 24, "channels": 2, "totalSamples": 17280000, "bitRate": 2900, "fileSize": 65000000 },
                    { "tier": "high", "format": "opus", "sampleRate": 48000, "bitDepth": 0, "channels": 2, "totalSamples": 8640000, "bitRate": 160, "fileSize": 3600000 }
                  ]
                }
              ]
            }
          }
        }
        """.trimIndent()

        var seenUrl = ""
        val http = OkHttpClient.Builder()
            .addInterceptor { chain ->
                seenUrl = chain.request().url.toString()
                Response.Builder()
                    .request(chain.request())
                    .protocol(Protocol.HTTP_1_1)
                    .code(200)
                    .message("OK")
                    .body(body.toResponseBody("application/json".toMediaType()))
                    .build()
            }
            .build()

        val client = SubsonicClient(Login("http://127.0.0.1:4533", "u", "s", "t"), "Sonus-Test", http)
        assertThat(client.supportsRenditions).isFalse()
        client.extensions = setOf("sonusRenditions")
        assertThat(client.supportsRenditions).isTrue()

        val streamUrl = client.streamUrl("s1", sonusQuality = "high")
        assertThat(streamUrl).contains("sonusQuality=high")
        assertThat(streamUrl).doesNotContain("maxBitRate")

        val map = client.getSonusRenditions(listOf("s1"))
        assertThat(seenUrl).contains("getSonusRenditions.view")
        assertThat(seenUrl).contains("id=s1")
        val s1 = map["s1"]!!
        assertThat(s1.sourceSampleRate).isEqualTo(96000)
        assertThat(s1.loudness!!.trackLufs).isWithin(0.01).of(-10.6)
        assertThat(s1.renditions).hasSize(2)
        assertThat(s1.renditions[1].format).isEqualTo("opus")
    }
}
