package com.creeperux.sonus.core

import java.time.Instant
import java.time.ZoneId
import java.util.Locale
import kotlin.math.floor
import kotlin.math.roundToInt

/** Numbers as the interface shows them (Chinese), as the Windows app's Formats. */
object Formats {
    /** 3:05, 1:02:03. */
    fun duration(seconds: Double): String {
        val s = if (seconds.isFinite() && seconds >= 0) floor(seconds).toLong() else 0L
        val h = s / 3600
        val m = (s % 3600) / 60
        val sec = s % 60
        return if (h >= 1) "%d:%02d:%02d".format(Locale.ROOT, h, m, sec) else "%d:%02d".format(Locale.ROOT, m, sec)
    }

    /** "约 1 小时 20 分钟", "约 35 分钟". */
    fun longDuration(seconds: Double): String {
        val minutes = (seconds / 60).roundToInt()
        return if (minutes >= 60) "约 ${minutes / 60} 小时 ${minutes % 60} 分钟" else "约 ${maxOf(1, minutes)} 分钟"
    }

    fun songs(n: Int) = "$n 首歌曲"

    fun plays(n: Int) = "播放 ${"%,d".format(Locale.ROOT, n)} 次"

    /** "刚刚", "5 分钟前", "3 天前", "2025年3月1日". Times in epoch milliseconds. */
    fun relative(whenMs: Long?, nowMs: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): String {
        val w = whenMs ?: return "从未"
        val minutes = (nowMs - w) / 60_000.0
        return when {
            minutes < 1 -> "刚刚"
            minutes < 60 -> "${minutes.toInt()} 分钟前"
            minutes < 60 * 24 -> "${(minutes / 60).toInt()} 小时前"
            minutes < 60 * 24 * 30 -> "${(minutes / 60 / 24).toInt()} 天前"
            else -> Instant.ofEpochMilli(w).atZone(zone).let { "${it.year}年${it.monthValue}月${it.dayOfMonth}日" }
        }
    }

    fun size(bytes: Long): String =
        if (bytes >= 1L shl 30) "%.1f GB".format(Locale.ROOT, bytes / (1L shl 30).toDouble()) else "%.1f MB".format(Locale.ROOT, bytes / (1L shl 20).toDouble())

    /** "FLAC · 24 bit / 96 kHz", "MP3 · 320 kbps", "DSD64". */
    fun quality(t: Track): String {
        if (t.codec.startsWith("DSD")) return t.codec
        if (t.bitDepth > 1) return "${t.codec} · ${t.bitDepth} bit / ${khz(t.sampleRate)} kHz"
        return if (t.bitrate > 0) "${t.codec} · ${t.bitrate} kbps" else t.codec
    }

    /** 44100 → "44.1", 96000 → "96". */
    fun khz(sampleRate: Int): String {
        val k = sampleRate / 1000.0
        return if (k == floor(k)) k.toLong().toString() else "%.1f".format(Locale.ROOT, k).trimEnd('0').trimEnd('.')
    }

    /** By the hour (0–23). */
    fun greeting(hour: Int) = when {
        hour < 5 -> "夜深了"
        hour < 12 -> "早上好"
        hour < 18 -> "下午好"
        else -> "晚上好"
    }

    fun albumType(type: AlbumType?) = when (type) {
        AlbumType.Ep -> "EP"
        AlbumType.Single -> "单曲"
        AlbumType.Compilation -> "合辑"
        else -> "专辑"
    }

    fun order(o: PlaybackOrder) = when (o) {
        PlaybackOrder.RepeatPlaylist -> "列表循环"
        PlaybackOrder.RepeatTrack -> "单曲循环"
        PlaybackOrder.Random -> "随机"
        PlaybackOrder.ShuffleTracks -> "乱序（曲目）"
        PlaybackOrder.ShuffleAlbums -> "乱序（专辑）"
        PlaybackOrder.ShuffleFolders -> "乱序（文件夹）"
        PlaybackOrder.Default -> "默认"
    }
}
