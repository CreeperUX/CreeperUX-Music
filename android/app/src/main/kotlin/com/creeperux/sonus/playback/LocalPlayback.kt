package com.creeperux.sonus.playback

import android.content.Context
import android.util.Log
import androidx.annotation.OptIn
import androidx.core.net.toUri
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import com.creeperux.sonus.core.PlayContext
import com.creeperux.sonus.core.PlayQueue
import com.creeperux.sonus.core.PlaybackOrder
import com.creeperux.sonus.core.QueueEntry
import com.creeperux.sonus.core.RemoteQueue
import com.creeperux.sonus.core.ReplayGainMode
import com.creeperux.sonus.core.Scrobbling
import com.creeperux.sonus.core.ServerUnreachableException
import com.creeperux.sonus.core.SubsonicException
import com.creeperux.sonus.core.Track
import com.creeperux.sonus.data.Settings
import com.creeperux.sonus.session.MusicSession
import com.creeperux.sonus.session.Toast
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.SerializationException
import okhttp3.OkHttpClient
import kotlin.math.min
import kotlin.math.pow

/**
 * This device's own player (the playing half of the Windows app's MusicService): the queue ([PlayQueue]) decides what
 * plays; Media3's ExoPlayer holds just the current song and the one after it, loaded early so one runs into the next
 * without a gap. When ExoPlayer moves on by itself, the queue moves with it. Scrobbles as the Windows app does: "now
 * playing" once a song really starts, the counted play past half the song or four minutes. Saves the queue on the
 * server (savePlayQueue) so another device, or this one next time, can continue. Lives on the main thread.
 */
@OptIn(UnstableApi::class)
class LocalPlayback(
    private val context: Context,
    private val settings: Settings,
    private val http: OkHttpClient,
    private val scope: CoroutineScope,
) : Playback {
    private var session: MusicSession? = null
    private var queue = newQueue()
    private val stateFlow = MutableStateFlow(PlayerState(order = settings.order))
    private val positionFlow = MutableStateFlow(0.0)
    private var counted = false
    private var nowPlayingSent = false
    private var startedAt = 0L
    private var savedAt = 0L
    private var ticker: Job? = null
    private var saveJob: Job? = null

    override val state: StateFlow<PlayerState> = stateFlow.asStateFlow()
    override val position: StateFlow<Double> = positionFlow.asStateFlow()
    override val queueEntries: List<QueueEntry> get() = queue.entries

    var replayGain: ReplayGainMode = settings.replayGain
        set(v) {
            field = v
            settings.replayGain = v
            applyVolume(current)
        }

    val current: Track? get() = session?.lib?.track(queue.current)

    private fun newQueue() = PlayQueue({ session?.lib?.track(it) }).also { q ->
        q.order = settings.order
        q.onChanged = {
            stateFlow.update { it.copy(queueVersion = it.queueVersion + 1, order = q.order, context = q.playContext, stopAfterCurrent = q.stopAfterCurrent) }
            refreshPreload()
            scheduleSave()
        }
    }

    /** The player: made on first use, on the main thread, and kept for the life of the app. */
    val exo: ExoPlayer by lazy {
        ExoPlayer.Builder(context)
            .setMediaSourceFactory(DefaultMediaSourceFactory(OkHttpDataSource.Factory(http)))
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()
            .also { it.addListener(listener) }
    }

    /** What the system's media controls (notification, lock screen, headphones, car) talk to: the player, with next and
     *  previous going through the queue. */
    val sessionPlayer: Player by lazy { QueuePlayer(exo, this) }

    /** Signed in (a session) or out (null): what plays stops. */
    fun attach(s: MusicSession?) {
        if (session === s) return
        if (session != null) {
            saveNow()
            stop()
            exo.clearMediaItems()
        }
        session = s
        queue = newQueue()
        stateFlow.value = PlayerState(order = queue.order)
    }

    // ---------------------------------------------------------------- playing

    override fun play(context: PlayContext, ids: List<String>, startId: String?, shuffle: Boolean) {
        val start = queue.start(context, ids, startId, shuffle) ?: return
        settings.order = queue.order
        load(start, autoplay = true)
    }

    override fun togglePlay() {
        val s = session ?: return
        if (current == null) {
            val (ctx, ids) = s.contextOf("playlist", if ((s.playlist("liked")?.entries?.size ?: 0) > 0) "liked" else "library")
            play(ctx, ids)
            return
        }
        if (state.value.isActive) pause() else resume()
    }

    override fun resume() {
        val id = queue.current ?: return
        val status = state.value.status
        if (status == PlayerStatus.Error || status == PlayerStatus.Stopped || currentPlayerId() != id) {
            load(id, autoplay = true, at = if (status == PlayerStatus.Stopped) 0.0 else position.value)
            return
        }
        if (exo.playbackState == Player.STATE_IDLE) exo.prepare()
        exo.play()
        setStatus(PlayerStatus.Loading)
    }

    override fun pause() {
        exo.pause()
        if (queue.current != null) setStatus(PlayerStatus.Paused)
        scheduleSave(soon = true)
    }

    override fun next() {
        val id = queue.next()
        if (id != null) load(id, autoplay = true) else stop()
    }

    override fun previous() {
        if (position.value > 3) {
            seek(0.0)
            return
        }
        val id = queue.previous()
        if (id != null) load(id, autoplay = true) else seek(0.0)
    }

    fun stop() {
        exo.stop()
        positionFlow.value = 0.0
        setStatus(PlayerStatus.Stopped)
        ticker?.cancel()
    }

    override fun seek(seconds: Double) {
        val d = state.value.duration
        val at = seconds.coerceIn(0.0, if (d > 0) d else seconds.coerceAtLeast(0.0))
        positionFlow.value = at
        if (currentPlayerId() == queue.current) exo.seekTo((at * 1000).toLong())
        scheduleSave()
    }

    override fun setOrder(order: PlaybackOrder) {
        queue.changeOrder(order) // the queue keeps the context's own order (search results, a radio) to come back to
        settings.order = order
    }

    override fun setStopAfterCurrent(on: Boolean) {
        queue.stopAfterCurrent = on
        stateFlow.update { it.copy(stopAfterCurrent = on) }
        refreshPreload()
    }

    override fun queueAdd(ids: List<String>, next: Boolean) = queue.add(ids, next)
    override fun queueRemove(entryIds: List<String>) = queue.remove(entryIds)
    override fun queueClear(manual: Boolean) = queue.clear(manual)
    override fun queueJump(entryId: String) {
        queue.jump(entryId)?.let { load(it, autoplay = true) }
    }

    /** Takes over a saved queue: its song at its position, paused. */
    fun continueQueue(q: RemoteQueue, label: String) {
        queue.adopt(PlayContext("queue", "continue", label), q.trackIds, q.current)?.let { load(it, autoplay = false, at = q.position) }
    }

    // ---------------------------------------------------------------- the player

    private fun currentPlayerId(): String? = if (exo.mediaItemCount > 0) exo.currentMediaItem?.mediaId else null

    private fun itemFor(t: Track): MediaItem {
        val s = session!!
        // ExoPlayer plays FLAC, ALAC, AAC, MP3, WAV, Opus and Vorbis; the rest is asked for as MP3, which every server
        // can transcode to (the same list as the Windows app)
        val transcode = if (t.suffix in TRANSCODED) "mp3" else null
        val cover = s.trackCoverUrl(t, 512)
        return MediaItem.Builder()
            .setMediaId(t.id)
            .setUri(s.client.streamUrl(t.id, transcode))
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(t.title).setArtist(t.artist).setAlbumTitle(t.album).setAlbumArtist(t.albumArtist)
                    .setArtworkUri(cover?.toUri()).setDurationMs((t.duration * 1000).toLong())
                    .setIsPlayable(true).setIsBrowsable(false).setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
                    .build(),
            )
            .build()
    }

    private fun nextItem(currentId: String?): MediaItem? = queue.peek()?.takeIf { it != currentId }?.let { session?.lib?.track(it) }?.let(::itemFor)

    private fun load(trackId: String, autoplay: Boolean, at: Double = 0.0) {
        val t = session?.lib?.track(trackId)
        if (t == null) {
            setStatus(PlayerStatus.Error, "这首歌已不在媒体库中。")
            return
        }
        counted = false
        nowPlayingSent = false
        startedAt = System.currentTimeMillis()
        positionFlow.value = at
        val items = listOfNotNull(itemFor(t), nextItem(trackId))
        applyVolume(t)
        exo.setMediaItems(items, 0, (at * 1000).toLong())
        exo.prepare()
        exo.playWhenReady = autoplay
        stateFlow.update { it.copy(trackId = trackId, duration = t.duration, error = null, status = if (autoplay) PlayerStatus.Loading else PlayerStatus.Paused) }
        if (autoplay) startTicker()
    }

    /** The song after the current one changed (queued by hand, the order …): load that one early instead. */
    private fun refreshPreload() {
        if (exo.mediaItemCount == 0) return
        val i = exo.currentMediaItemIndex
        if (exo.getMediaItemAt(i).mediaId != queue.current) return
        val wanted = nextItem(queue.current)
        val have = if (i + 1 < exo.mediaItemCount) exo.getMediaItemAt(i + 1) else null
        if (have?.mediaId == wanted?.mediaId) return
        if (i + 1 < exo.mediaItemCount) exo.removeMediaItems(i + 1, exo.mediaItemCount)
        wanted?.let(exo::addMediaItem)
    }

    private val listener = object : Player.Listener {
        override fun onMediaItemTransition(item: MediaItem?, reason: Int) {
            if (item == null || reason != Player.MEDIA_ITEM_TRANSITION_REASON_AUTO) return
            val id = item.mediaId
            // the player moved on by itself (gapless): move the queue there too, then load what comes after
            if (queue.peek() == id) {
                queue.next(ended = true)
            } else if (queue.current != id) {
                load(queue.next(ended = true) ?: id, autoplay = true)
                return
            }
            val i = exo.currentMediaItemIndex
            if (i > 0) exo.removeMediaItems(0, i)
            refreshPreload()
            counted = false
            nowPlayingSent = false
            startedAt = System.currentTimeMillis()
            val t = current
            applyVolume(t)
            stateFlow.update { it.copy(trackId = id, duration = t?.duration ?: 0.0, error = null) }
            positionFlow.value = 0.0
            if (exo.isPlaying) nowPlaying()
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            if (isPlaying) {
                setStatus(PlayerStatus.Playing)
                if (!nowPlayingSent) nowPlaying()
                startTicker()
            } else {
                positionFlow.value = exo.currentPosition / 1000.0
                if (exo.playbackState == Player.STATE_BUFFERING && exo.playWhenReady) setStatus(PlayerStatus.Loading)
                else if (!exo.playWhenReady && queue.current != null && state.value.status != PlayerStatus.Stopped && state.value.status != PlayerStatus.Error) {
                    setStatus(PlayerStatus.Paused) // paused here, by a headset, a call or another app taking the sound
                    scheduleSave(soon = true)
                }
            }
        }

        override fun onPlaybackStateChanged(playbackState: Int) {
            when (playbackState) {
                Player.STATE_ENDED -> {
                    // the last loaded song ended: what follows was not known in advance (repeat one, random, the end)
                    val id = queue.next(ended = true)
                    if (id != null) load(id, autoplay = true) else stop()
                }
                Player.STATE_READY -> {
                    val d = exo.duration
                    if (d != C.TIME_UNSET && d > 0) stateFlow.update { it.copy(duration = d / 1000.0) }
                }
                else -> Unit
            }
        }

        override fun onPlayerError(error: PlaybackException) {
            val t = current
            val reason = when (error.errorCode) {
                PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED, PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT -> "连不上服务器"
                PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS, PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND -> "服务器上找不到这个文件"
                PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED, PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED -> "这台设备不支持这个格式"
                else -> error.errorCodeName
            }
            val message = "无法播放“${t?.title.orEmpty()}”：$reason"
            Log.w(TAG, message, error)
            setStatus(PlayerStatus.Error, message)
            session?.say(Toast(message, isError = true))
            // a song that cannot be played here is skipped, as the Windows app does; a lost connection is not (every song
            // would fail the same way)
            val network = error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED ||
                error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT
            if (!network && queue.peek() != null) next()
        }
    }

    private fun setStatus(s: PlayerStatus, error: String? = null) {
        stateFlow.update { it.copy(status = s, error = if (s == PlayerStatus.Error) error else null) }
    }

    /** Four times a second while playing: the position, the counted play, the queue saved every 30 s. */
    private fun startTicker() {
        if (ticker?.isActive == true) return
        ticker = scope.launch {
            while (isActive) {
                delay(250)
                if (!exo.isPlaying) {
                    if (state.value.status != PlayerStatus.Loading) break
                    continue
                }
                val p = exo.currentPosition / 1000.0
                positionFlow.value = p
                val t = current
                if (!counted && t != null && Scrobbling.counts(p, state.value.duration)) {
                    counted = true // a play counts past half the song or four minutes
                    countPlay(t, startedAt)
                }
                if (System.currentTimeMillis() - savedAt > 30_000) scheduleSave(soon = true) // the position, for another device
            }
        }
    }

    private fun nowPlaying() {
        nowPlayingSent = true
        val t = current ?: return
        quietly { session?.client?.scrobble(t.id, submission = false) }
        scheduleSave(soon = true)
    }

    private fun countPlay(t: Track, started: Long) {
        val s = session ?: return
        quietly {
            s.client.scrobble(t.id, submission = true, startedAt = started)
            t.playCount++
            t.lastPlayed = System.currentTimeMillis()
            s.bump()
        }
    }

    /** The volume after replay gain: gains only lower it (ExoPlayer cannot go above full volume). */
    private fun applyVolume(t: Track?) {
        val gain = if (t == null || replayGain == ReplayGainMode.Off) null
        else if (replayGain == ReplayGainMode.Album) t.albumGain ?: t.trackGain else t.trackGain ?: t.albumGain
        exo.volume = (gain?.let { min(1.0, 10.0.pow(it / 20)) } ?: 1.0).toFloat()
    }

    // ---------------------------------------------------------------- continue on another device

    private fun scheduleSave(soon: Boolean = false) {
        if (queue.current == null || session == null) return
        saveJob?.cancel()
        saveJob = scope.launch {
            delay(if (soon) 1 else 1500)
            saveNow()
        }
    }

    private fun saveNow() {
        val s = session ?: return
        val c = queue.current ?: return
        savedAt = System.currentTimeMillis()
        val ids = queue.forServer()
        val at = if (currentPlayerId() == c) exo.currentPosition / 1000.0 else position.value
        quietly { s.client.savePlayQueue(ids, c, at) }
    }

    /** Runs a request whose failure only needs logging (now playing, saving the queue). */
    private fun quietly(request: suspend () -> Unit) {
        scope.launch {
            try {
                request()
            } catch (e: ServerUnreachableException) {
                Log.i(TAG, "background request: ${e.message}")
            } catch (e: SubsonicException) {
                Log.i(TAG, "background request: ${e.message}")
            } catch (e: SerializationException) {
                Log.i(TAG, "background request: ${e.message}")
            }
        }
    }

    private companion object {
        const val TAG = "Sonus"
        val TRANSCODED = setOf("dsf", "dff", "ape", "wv", "tta", "tak", "mpc", "wma")
    }
}
