package com.creeperux.sonus.core

import kotlin.random.Random

/** One row of the queue panel: a song queued by hand ("queue"), or what follows in the playing context ("context"). */
data class QueueEntry(val id: String, val trackId: String, val manual: Boolean)

/**
 * What plays and what comes next, exactly as the Windows app's PlayQueue (and, from Sonus Connect v2 on, the server's
 * session queue): the playing context (an album, a playlist … in playback order), the position in it, and the songs
 * queued by hand, which play first. The player asks it for the next song; nothing here plays audio. Not thread-safe:
 * the app uses it on the main thread.
 */
class PlayQueue(private val lookup: (String) -> Track?, private val random: Random = Random.Default) {
    private var context: List<String> = emptyList()
    private var source: List<String> = emptyList() // the context in its own order (an album's, a search's), to come back to from shuffling
    private var pointerAt = -1
    private var manual: List<Pair<String, String>> = emptyList() // (entry id, track id)
    private var nextId = 0

    var playContext: PlayContext? = null
        private set
    var current: String? = null
        private set
    var order: PlaybackOrder = PlaybackOrder.Default
    var stopAfterCurrent: Boolean = false

    /** The order or the songs to come changed. */
    var onChanged: (() -> Unit)? = null

    val contextIds: List<String> get() = context
    val pointer: Int get() = pointerAt

    /** Hand-queued songs first, then the rest of the context. */
    val entries: List<QueueEntry>
        get() = manual.map { (id, t) -> QueueEntry(id, t, true) } +
            context.drop(pointerAt + 1).mapIndexed { i, t -> QueueEntry("c${pointerAt + 1 + i}:$t", t, false) }

    private fun changed() = onChanged?.invoke()

    /** Plays from a context: from [startId], or its first song (a random one when shuffling). Returns the song to play, or
     *  null when the context has none. */
    fun start(context: PlayContext, ids: List<String>, startId: String?, shuffle: Boolean = false): String? {
        if (shuffle && !shuffled(order)) order = PlaybackOrder.ShuffleTracks
        val known = ids.filter { lookup(it) != null }
        if (known.isEmpty()) return null
        val start = if (startId != null && startId in known) startId
        else if (shuffled(order) || order == PlaybackOrder.Random) known[random.nextInt(known.size)]
        else known[0]
        source = known
        this.context = arrange(known, order, start)
        pointerAt = maxOf(0, this.context.indexOf(start))
        playContext = context
        current = this.context[pointerAt]
        changed()
        return current
    }

    /** Takes over a queue saved elsewhere (continue on another device). */
    fun adopt(context: PlayContext, ids: List<String>, current: String): String? {
        val known = ids.filter { lookup(it) != null }
        if (current !in known) return null
        this.context = known
        source = known
        pointerAt = known.indexOf(current)
        manual = emptyList()
        playContext = context
        this.current = current
        changed()
        return current
    }

    /**
     * Sonus Connect version 2: the queue as the server holds it (the server runs this same logic; the app shows its
     * result): the context in playback order, the pointer, the hand-queued songs with the server's keys, the current
     * song and the order. [onChanged] is called only when something differs.
     */
    fun mirror(context: PlayContext?, order: List<String>, pointer: Int, manual: List<Pair<String, String>>, current: String?, playbackOrder: PlaybackOrder, stopAfterCurrent: Boolean) {
        if (playContext == context && pointerAt == pointer && this.current == current && this.order == playbackOrder &&
            this.stopAfterCurrent == stopAfterCurrent && this.context == order && this.manual == manual
        ) {
            return
        }
        this.context = order.toList()
        source = order.toList()
        pointerAt = pointer
        this.manual = manual.toList()
        playContext = context
        this.current = current
        this.order = playbackOrder
        this.stopAfterCurrent = stopAfterCurrent
        changed()
    }

    /**
     * The song that follows when the current one ends — what [next] (ended = true) will return — without moving there
     * (to load it early), or null when that is not a different song known now (stop after current, repeat one, random).
     */
    fun peek(): String? {
        if (stopAfterCurrent || order == PlaybackOrder.RepeatTrack) return null
        if (manual.isNotEmpty()) return manual[0].second
        if (order == PlaybackOrder.Random) return null
        if (pointerAt + 1 < context.size) return context[pointerAt + 1]
        return if ((order == PlaybackOrder.RepeatPlaylist || shuffled(order)) && context.isNotEmpty()) context[0] else null
    }

    /**
     * The song [next] (ended = false) will move to when the user skips forward, without moving — unlike [peek], repeat
     * one and stop-after-current still move on when skipped manually. Null at the end of a non-repeating list, or in
     * [PlaybackOrder.Random] when the manual queue is empty (the next song is chosen on the skip).
     */
    fun peekNext(): String? {
        if (manual.isNotEmpty()) return manual[0].second
        if (order == PlaybackOrder.Random) return null
        if (context.isEmpty()) return null
        if (pointerAt + 1 < context.size) return context[pointerAt + 1]
        return if (order == PlaybackOrder.RepeatPlaylist || shuffled(order)) context[0] else null
    }

    /**
     * The song [previous] will move to, without moving: while a hand-queued song plays, the context song before it;
     * otherwise the previous song in the context (wrapping for repeat-all and shuffled orders). Null at the start of a
     * non-repeating list, or in [PlaybackOrder.Random] when not returning from a hand-queued song.
     */
    fun peekPrevious(): String? {
        val c = current
        if (c != null && pointerAt >= 0 && pointerAt < context.size && context[pointerAt] != c) {
            return context[pointerAt]
        }
        if (order == PlaybackOrder.Random) return null
        if (context.isEmpty()) return null
        if (pointerAt - 1 >= 0) return context[pointerAt - 1]
        return if (order == PlaybackOrder.RepeatPlaylist || shuffled(order)) context.last() else null
    }

    /** Whether [next] (ended = false) can move to a song (including [PlaybackOrder.Random] while context is non-empty). */
    fun hasNext(): Boolean = peekNext() != null || (order == PlaybackOrder.Random && context.isNotEmpty())

    /** Whether [previous] can move to a song (including [PlaybackOrder.Random] while context is non-empty). */
    fun hasPrevious(): Boolean = peekPrevious() != null || (order == PlaybackOrder.Random && context.isNotEmpty())

    /** Moves to the next song (hand-queued first). Null: the end, playback stops. */
    fun next(ended: Boolean = false): String? {
        if (ended && stopAfterCurrent) {
            stopAfterCurrent = false
            return null
        }
        if (ended && order == PlaybackOrder.RepeatTrack) return current
        if (manual.isNotEmpty()) {
            current = manual[0].second
            manual = manual.drop(1)
            changed()
            return current
        }
        return step(1)
    }

    /** Moves to the previous song in the context (null at the start, unless repeating). While a hand-queued song plays,
     *  that is the context song that played before it. */
    fun previous(): String? {
        val c = current
        if (c != null && pointerAt >= 0 && pointerAt < context.size && context[pointerAt] != c) {
            current = context[pointerAt]
            changed()
            return current
        }
        return step(-1)
    }

    private fun step(dir: Int): String? {
        if (context.isEmpty()) return null
        var at = pointerAt + dir
        if (order == PlaybackOrder.Random) at = random.nextInt(context.size)
        if (at >= context.size || at < 0) {
            if (order == PlaybackOrder.RepeatPlaylist || shuffled(order)) at = if (dir > 0) 0 else context.size - 1
            else return null
        }
        pointerAt = at
        current = context[pointerAt]
        changed()
        return current
    }

    /** Changes the playback order, arranging the context again when shuffling starts or stops (the Windows SetOrder;
     *  assigning [order] alone does not rearrange). */
    fun changeOrder(order: PlaybackOrder) {
        val was = this.order
        this.order = order
        if (context.isNotEmpty() && (shuffled(order) || shuffled(was))) {
            // back from shuffling: the context's own order, without the songs removed from the queue meanwhile
            val basis = if (shuffled(order)) context else source.filter { it in context }.distinct()
            context = arrange(basis, order, current)
            pointerAt = maxOf(0, current?.let { context.indexOf(it) } ?: 0)
        }
        changed()
    }

    /** The context in an order its sender arranged (shuffling by album or folder over Sonus Connect v2, where the server
     *  takes the order it is given), with the current song where it now is. The context's own order is kept, to come
     *  back to when the shuffling stops. */
    fun arrangeAs(order: List<String>) {
        val known = order.filter { it in context || it in source }.distinct()
        if (known.isEmpty()) return
        context = known
        pointerAt = maxOf(0, current?.let { known.indexOf(it) } ?: 0)
        changed()
    }

    fun add(trackIds: List<String>, next: Boolean = false) {
        val added = trackIds.filter { lookup(it) != null }.map { "q${++nextId}" to it }
        manual = if (next) added + manual else manual + added
        changed()
    }

    /** A drag in the queue panel: [order] is every entry id in the new order, [keys] the moved ones, which now belong to
     *  [toManual]'s section. */
    fun move(order: List<String>, keys: List<String>, toManual: Boolean) {
        val byId = entries.associateBy { it.id }
        val placed = order.mapNotNull { byId[it] }.map { if (it.id in keys) it.copy(manual = toManual) else it }
        manual = placed.filter { it.manual }.map { if (it.id.startsWith('q')) it.id to it.trackId else "q${++nextId}" to it.trackId }
        context = context.take(pointerAt + 1) + placed.filter { !it.manual }.map { it.trackId }
        changed()
    }

    fun remove(entryIds: Collection<String>) {
        val ids = entryIds.toHashSet()
        // a context entry is "c<index>:<song>": only removed when that index still holds that song and is still to come
        // (an id from a menu left open across a song change must not remove another song)
        val contextIndexes = ids.filter { it.startsWith('c') }.map(::contextIndex).filter { it >= 0 }.toHashSet()
        manual = manual.filter { it.first !in ids }
        context = context.filterIndexed { i, _ -> i !in contextIndexes }
        changed()
    }

    fun clear(manualSection: Boolean) {
        if (manualSection) manual = emptyList() else context = context.take(pointerAt + 1)
        changed()
    }

    private fun contextIndex(entryId: String): Int {
        val colon = entryId.indexOf(':')
        if (colon < 2) return -1
        val digits = entryId.substring(1, colon)
        if (!digits.all(Char::isDigit)) return -1
        val i = digits.toIntOrNull() ?: return -1
        return if (i > pointerAt && i < context.size && context[i] == entryId.substring(colon + 1)) i else -1
    }

    /** Jumps to a queue entry; returns its song. */
    fun jump(entryId: String): String? {
        val e = entries.firstOrNull { it.id == entryId } ?: return null
        if (e.manual) manual = manual.filter { it.first != entryId } else pointerAt = entryId.substring(1, entryId.indexOf(':')).toInt()
        current = e.trackId
        changed()
        return current
    }

    /** The queue as saved on the server: what played, the current song, what comes (hand-queued first), at most 500
     *  songs around the current one. */
    fun forServer(): List<String> = snapshot().first

    /** [forServer]'s list and the current song's place in it (a song may be there twice): what another device takes over
     *  (Sonus Connect). */
    fun snapshot(): Pair<List<String>, Int> {
        val c = current ?: return emptyList<String>() to -1
        val before = context.take(pointerAt + 1).toMutableList()
        if (before.isEmpty() || before.last() != c) before += c
        val all = before + manual.map { it.second } + context.drop(pointerAt + 1)
        val from = maxOf(0, before.size - 100)
        return all.drop(from).take(500) to before.size - 1 - from
    }

    private fun arrange(ids: List<String>, order: PlaybackOrder, start: String?): List<String> {
        if (order == PlaybackOrder.ShuffleTracks) {
            val rest = shuffle(ids.filter { it != start })
            return if (start != null && start in ids) listOf(start) + rest else rest
        }
        if (order == PlaybackOrder.ShuffleAlbums || order == PlaybackOrder.ShuffleFolders) {
            fun key(id: String) = if (order == PlaybackOrder.ShuffleAlbums) lookup(id)?.albumId.orEmpty() else folderOf(lookup(id)?.path.orEmpty())
            val groups = shuffle(ids.map(::key).distinct()).toMutableList()
            if (start != null && groups.remove(key(start))) groups.add(0, key(start))
            return groups.flatMap { g -> ids.filter { key(it) == g } }
        }
        return ids.toList()
    }

    private fun <T> shuffle(items: List<T>): List<T> {
        val list = items.toMutableList()
        for (i in list.lastIndex downTo 1) {
            val j = random.nextInt(i + 1)
            val x = list[i]
            list[i] = list[j]
            list[j] = x
        }
        return list
    }

    companion object {
        fun shuffled(o: PlaybackOrder) = o == PlaybackOrder.ShuffleTracks || o == PlaybackOrder.ShuffleAlbums || o == PlaybackOrder.ShuffleFolders

        /** The folder of a path, either separator ("A/B/1.flac" → "A/B"). */
        fun folderOf(path: String): String {
            val i = maxOf(path.lastIndexOf('/'), path.lastIndexOf('\\'))
            return if (i < 0) "" else path.substring(0, i)
        }
    }
}
