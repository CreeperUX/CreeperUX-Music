package com.creeperux.sonus.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerInputChange
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil3.memory.MemoryCache
import com.creeperux.sonus.core.Track
import com.creeperux.sonus.playback.PlayerStatus
import com.creeperux.sonus.ui.components.Cover
import com.creeperux.sonus.ui.components.px
import com.creeperux.sonus.ui.icons.KitIcon
import com.creeperux.sonus.ui.screens.WhereLine
import com.creeperux.sonus.ui.screens.showsWhereLine
import com.creeperux.sonus.ui.theme.Shapes
import com.creeperux.sonus.ui.theme.Sonus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.sign

/** Vertical drag callbacks for [directionalDrag], using root/screen Y so moving the dragged sheet never distorts pace. */
interface VerticalDragHandler {
    fun onStart(screenY: Float)
    fun onDrag(screenY: Float)
    fun onEnd(velocityY: Float)
    fun onCancel()
}

/** Horizontal drag callbacks for [directionalDrag], using root/screen X. */
interface HorizontalDragHandler {
    fun onStart()
    fun onDrag(deltaXFromStart: Float)
    fun onEnd(velocityX: Float)
    fun onCancel()
}

private enum class DragAxis { Horizontal, Vertical }

/**
 * One pointerInput that locks to horizontal (swiping between songs) or vertical (opening/closing the player sheet)
 * once the finger moves past touch slop — never two stacked pointerInputs fighting over the same gesture.
 *
 * When [vertical] is null (such as the tablet's scrollable right panel), a vertical move past touch slop is left
 * unconsumed so the parent scroll container takes over cleanly. Taps that never cross touch slop are untouched.
 */
@Composable
fun Modifier.directionalDrag(
    key: Any? = Unit,
    vertical: VerticalDragHandler? = null,
    horizontal: HorizontalDragHandler? = null,
): Modifier {
    val currentVertical by rememberUpdatedState(vertical)
    val currentHorizontal by rememberUpdatedState(horizontal)
    var coords by remember { mutableStateOf<LayoutCoordinates?>(null) }
    return this
        .onGloballyPositioned { coords = it }
        .pointerInput(key) {
            fun rootPos(change: PointerInputChange): Offset =
                coords?.takeIf { it.isAttached }?.localToRoot(change.position) ?: change.position

            awaitEachGesture {
                val down = awaitFirstDown(requireUnconsumed = false)
                val pointerId = down.id
                val downRoot = rootPos(down)
                val downTime = down.uptimeMillis
                val slop = viewConfiguration.touchSlop
                var totalX = 0f
                var totalY = 0f
                var axis: DragAxis? = null
                var startRootX = downRoot.x
                var finished = false
                val tracker = VelocityTracker()
                try {
                    while (true) {
                        val event = awaitPointerEvent()
                        val change = event.changes.firstOrNull { it.id == pointerId } ?: break
                        if (!change.pressed) {
                            // Compose turns ACTION_CANCEL (e.g. system back pilfering pointers) into a pre-consumed up
                            if (change.isConsumed) break
                            when (axis) {
                                DragAxis.Horizontal -> {
                                    finished = true
                                    currentHorizontal?.onEnd(tracker.calculateVelocity().x)
                                }
                                DragAxis.Vertical -> {
                                    finished = true
                                    currentVertical?.onEnd(tracker.calculateVelocity().y)
                                }
                                null -> Unit
                            }
                            break
                        }
                        if (change.isConsumed) break
                        val delta = change.positionChange()
                        if (axis == null) {
                            totalX += delta.x
                            totalY += delta.y
                            if (abs(totalX) > slop || abs(totalY) > slop) {
                                val root = rootPos(change)
                                if (abs(totalX) > abs(totalY)) {
                                    val h = currentHorizontal ?: break
                                    axis = DragAxis.Horizontal
                                    // anchor right past touch slop so the cover starts moving smoothly without a jump
                                    startRootX = downRoot.x + sign(totalX) * slop
                                    tracker.resetTracking()
                                    tracker.addPosition(downTime, Offset(downRoot.x, 0f))
                                    tracker.addPosition(change.uptimeMillis, Offset(root.x, 0f))
                                    h.onStart()
                                    h.onDrag(root.x - startRootX)
                                    change.consume()
                                } else {
                                    val v = currentVertical ?: break // yield vertical drags to parent scroll
                                    axis = DragAxis.Vertical
                                    tracker.resetTracking()
                                    tracker.addPosition(downTime, Offset(0f, downRoot.y))
                                    tracker.addPosition(change.uptimeMillis, Offset(0f, root.y))
                                    v.onStart(downRoot.y)
                                    v.onDrag(root.y)
                                    change.consume()
                                }
                            }
                        } else if (axis == DragAxis.Horizontal) {
                            val root = rootPos(change)
                            tracker.addPosition(change.uptimeMillis, Offset(root.x, 0f))
                            currentHorizontal?.onDrag(root.x - startRootX)
                            change.consume()
                        } else {
                            val root = rootPos(change)
                            tracker.addPosition(change.uptimeMillis, Offset(0f, root.y))
                            currentVertical?.onDrag(root.y)
                            change.consume()
                        }
                    }
                } finally {
                    if (!finished) {
                        when (axis) {
                            DragAxis.Horizontal -> currentHorizontal?.onCancel()
                            DragAxis.Vertical -> currentVertical?.onCancel()
                            null -> Unit
                        }
                    }
                }
            }
        }
}

/**
 * State and physics for a Spotify-style horizontal track swipe: follows the finger 1:1 where another song exists,
 * rubber-bands gently at a list boundary, finishes at the finger's pace on release, and holds the incoming artwork in
 * place until the track id updates (avoiding a flash back to the old cover in Connect v2 remote mode).
 */
class TrackSwipeController(
    private val scope: CoroutineScope,
    private val flickPxPerSec: Float,
    private val haptics: Haptics,
    private val motionEnabled: () -> Boolean,
    private val canSkipNext: () -> Boolean,
    private val canSkipPrevious: () -> Boolean,
    private val currentTrackId: () -> String?,
    private val nextTrackId: () -> String? = { null },
    private val previousTrackId: () -> String? = { null },
    private val onSkipNext: () -> Unit,
    private val onSkipPrevious: () -> Unit,
) : HorizontalDragHandler {
    val offset = Animatable(0f)
    var stridePx by mutableFloatStateOf(1f)
    var dragging by mutableStateOf(false)
        private set

    /**
     * The track id active when a swipe committed, held as Compose state so [visualOffset] and [isSwipedInto] flip to
     * 0f / true synchronously on the very first frame after `state.trackId` changes — before [LaunchedEffect] runs —
     * preventing a 1-frame flash of the next-next slot.
     */
    private var pendingFrom by mutableStateOf<String?>(null)
    private var settleJob: Job? = null

    /** Set to the track id handed off by a swipe so its Cover skips the crossfade (it is already on screen). */
    var swipedIntoTrackId by mutableStateOf<String?>(null)
        private set

    /** Coil memory-cache (url, key) of the preloaded adjacent covers (plain fields, never trigger recomposition). */
    internal var nextCached: Pair<String, MemoryCache.Key>? = null
    internal var prevCached: Pair<String, MemoryCache.Key>? = null

    /** Cache entry of the incoming cover captured at swipe commit so the center Cover paints synchronously on frame 1. */
    private var handoffCached: Pair<String, MemoryCache.Key>? = null

    /** Returns the preloaded cache key only when [url] matches the cover that slid into center. */
    fun handoffCacheKeyFor(url: String?): MemoryCache.Key? =
        if (url != null && handoffCached?.first == url) handoffCached?.second else null

    /** Draw-phase offset for [trackId]: snaps visually to 0f the instant [trackId] differs from [pendingFrom]. */
    fun visualOffset(trackId: String?): Float {
        val from = pendingFrom
        return if (from != null && trackId != from) 0f else offset.value
    }

    /** True when [trackId] is the song that just slid into center via a swipe. */
    fun isSwipedInto(trackId: String?): Boolean {
        if (trackId == null) return false
        val from = pendingFrom
        return swipedIntoTrackId == trackId || (from != null && trackId != from)
    }

    /** Called from LaunchedEffect(trackId) to finish resetting [offset] to 0f after a swipe handoff. */
    suspend fun onTrackChanged(newTrackId: String?) {
        val from = pendingFrom
        if (from != null && newTrackId != from) {
            settleJob?.cancel()
            swipedIntoTrackId = newTrackId
            // snap offset to 0f BEFORE clearing pendingFrom so visualOffset() stays 0f across every frame
            offset.snapTo(0f)
            pendingFrom = null
        } else if (newTrackId != swipedIntoTrackId) {
            swipedIntoTrackId = null
            handoffCached = null
        }
    }

    override fun onStart() {
        settleJob?.cancel()
        pendingFrom = null
        dragging = true
    }

    override fun onDrag(deltaXFromStart: Float) {
        val stride = stridePx.coerceAtLeast(1f)
        val allowed = (deltaXFromStart < 0f && canSkipNext()) || (deltaXFromStart > 0f && canSkipPrevious())
        val mapped = if (allowed) {
            deltaXFromStart.coerceIn(-stride, stride)
        } else {
            rubberBand(deltaXFromStart, stride * 0.18f)
        }
        scope.launch { offset.snapTo(mapped) }
    }

    override fun onEnd(velocityX: Float) {
        dragging = false
        val stride = stridePx.coerceAtLeast(1f)
        val cur = offset.value
        val threshold = stride * 0.30f
        // positive dir = next (swiped left, negative offset/velocity); negative dir = previous (swiped right)
        val dir = when {
            cur < 0f && canSkipNext() && ((abs(cur) > threshold && velocityX < flickPxPerSec) || velocityX < -flickPxPerSec) -> 1
            cur > 0f && canSkipPrevious() && ((abs(cur) > threshold && velocityX > -flickPxPerSec) || velocityX > flickPxPerSec) -> -1
            else -> 0
        }
        settle(dir, velocityX)
    }

    override fun onCancel() {
        dragging = false
        settle(0, 0f)
    }

    private fun settle(dir: Int, velocityX: Float) {
        settleJob?.cancel()
        val stride = stridePx.coerceAtLeast(1f)
        if (dir == 0) {
            settleJob = scope.launch {
                if (!motionEnabled()) offset.snapTo(0f)
                else offset.animateTo(0f, releaseSpec(abs(offset.value), abs(velocityX)))
            }
            return
        }
        val target = if (dir > 0) -stride else stride
        val speedTowards = (if (dir > 0) -velocityX else velocityX).coerceAtLeast(0f)
        if (!motionEnabled()) {
            haptics.dragEnd()
            swipedIntoTrackId = null
            handoffCached = null
            settleJob = scope.launch { offset.snapTo(0f) }
            if (dir > 0) onSkipNext() else onSkipPrevious()
            return
        }
        val fromTrack = currentTrackId()
        val expectedTrack = if (dir > 0) nextTrackId() else previousTrackId()
        settleJob = scope.launch {
            val remaining = abs(target - offset.value)
            offset.animateTo(target, releaseSpec(remaining, speedTowards))
            haptics.dragEnd()
            handoffCached = if (dir > 0) nextCached else prevCached
            pendingFrom = fromTrack
            if (dir > 0) onSkipNext() else onSkipPrevious()
            // local mode updates trackId immediately (and a 1-song repeating list stays on the same trackId);
            // Connect v2 remote mode waits briefly for the server's session so the old cover does not flash back
            val now = currentTrackId()
            if (now != fromTrack || (expectedTrack != null && expectedTrack == fromTrack)) {
                swipedIntoTrackId = now
                offset.snapTo(0f)
                pendingFrom = null
            } else {
                // safety fallback if offline or the server refused the skip: spring back so the cover is never stuck
                delay(1_500)
                if (pendingFrom == fromTrack) {
                    pendingFrom = null
                    handoffCached = null
                    offset.animateTo(0f, tween(Motion.PUSH, easing = Motion.EaseOut))
                }
            }
        }
    }

    private fun releaseSpec(remaining: Float, speed: Float) =
        tween<Float>(
            durationMillis = (if (speed > 1f) (remaining / speed * 1000f).toInt() else Motion.PUSH).coerceIn(100, Motion.SHEET),
            easing = Motion.EaseOut,
        )

    companion object {
        /** Asymptotic resistance past a list boundary: smooth from 0, never hits a hard stop. */
        fun rubberBand(delta: Float, maxOffset: Float): Float {
            if (delta == 0f || maxOffset <= 0f) return 0f
            val r = abs(delta)
            return sign(delta) * (maxOffset * r / (r + maxOffset * 2f))
        }
    }
}

@Composable
fun rememberTrackSwipe(): TrackSwipeController {
    val player = LocalPlayer.current
    val state by player.state.collectAsState()
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    val motion = LocalMotion.current
    val flick = with(LocalDensity.current) { 700.dp.toPx() }
    val motionRef = rememberUpdatedState(motion)
    val controller = remember(player, scope, haptics, flick) {
        TrackSwipeController(
            scope = scope,
            flickPxPerSec = flick,
            haptics = haptics,
            motionEnabled = { motionRef.value },
            canSkipNext = { player.canSkipNext },
            canSkipPrevious = { player.canSkipPrevious },
            currentTrackId = { player.state.value.trackId },
            nextTrackId = { player.nextTrackId },
            previousTrackId = { player.previousTrackId },
            onSkipNext = player::next,
            onSkipPrevious = player::previousTrack,
        )
    }
    LaunchedEffect(state.trackId) {
        controller.onTrackChanged(state.trackId)
    }
    return controller
}

/**
 * Full-width swipeable cover carousel for the phone's full player (with [verticalDrag] to dismiss) and the tablet's
 * right panel (with [verticalDrag] null so the panel keeps scrolling vertically). Adjacent covers are rendered beside
 * the current cover and positioned strictly in draw-phase [graphicsLayer] blocks so dragging causes zero recomposition.
 */
@Composable
fun SwipeableCover(
    track: Track?,
    modifier: Modifier = Modifier,
    coverModifier: Modifier = Modifier,
    verticalDrag: VerticalDragHandler? = null,
    horizontalInset: Dp = 0.dp,
    pageGap: Dp = 20.dp,
    shadowElevation: Dp = 0.dp,
    clip: Boolean = true,
    tag: String = "player-cover",
) {
    val session = LocalSession.current
    val player = LocalPlayer.current
    val state by player.state.collectAsState()
    val swipe = rememberTrackSwipe()
    val nextTrack = remember(state.queueVersion, state.trackId, state.order) { player.nextTrackId?.let(session.lib::track) }
    val prevTrack = remember(state.queueVersion, state.trackId, state.order) { player.previousTrackId?.let(session.lib::track) }
    val canNext = remember(state.queueVersion, state.trackId, state.order) { player.canSkipNext }
    val canPrev = remember(state.queueVersion, state.trackId, state.order) { player.canSkipPrevious }

    BoxWithConstraints(
        modifier
            .then(if (clip) Modifier.clipToBounds() else Modifier)
            .directionalDrag(key = tag, vertical = verticalDrag, horizontal = swipe)
            .testTag(tag),
        contentAlignment = Alignment.Center,
    ) {
        val density = LocalDensity.current
        val side = minOf((maxWidth - horizontalInset * 2).coerceAtLeast(1.dp), maxHeight)
        val stridePx = with(density) { (side + pageGap).toPx() }
        val shadowPx = with(density) { shadowElevation.toPx() }
        SideEffect { swipe.stridePx = stridePx }
        val px = side.px()
        val shape = RoundedCornerShape(Shapes.panel)
        val trackId = track?.id
        val swipedHere = swipe.isSwipedInto(trackId)
        val prevUrl = prevTrack?.let { session.trackCoverUrl(it, px) }
        val nextUrl = nextTrack?.let { session.trackCoverUrl(it, px) }
        val curUrl = track?.let { session.trackCoverUrl(it, px) }

        if (canPrev) {
            Box(
                Modifier
                    .graphicsLayer {
                        val ox = swipe.visualOffset(trackId)
                        val active = ox != 0f || swipe.dragging
                        translationX = ox - stridePx
                        alpha = if (active) 1f else 0f
                        this.shadowElevation = if (active) shadowPx else 0f
                        this.shape = shape
                        this.clip = false
                    }
                    .size(side)
                    .clearAndSetSemantics {},
            ) {
                Cover(
                    prevUrl,
                    side,
                    Modifier.fillMaxSize(),
                    shape = shape,
                    placeholder = if (prevTrack == null) "shuffle" else "album",
                    instant = true,
                    onCacheKey = { key -> if (prevUrl != null && key != null) swipe.prevCached = prevUrl to key },
                )
            }
        }
        if (canNext) {
            Box(
                Modifier
                    .graphicsLayer {
                        val ox = swipe.visualOffset(trackId)
                        val active = ox != 0f || swipe.dragging
                        translationX = ox + stridePx
                        alpha = if (active) 1f else 0f
                        this.shadowElevation = if (active) shadowPx else 0f
                        this.shape = shape
                        this.clip = false
                    }
                    .size(side)
                    .clearAndSetSemantics {},
            ) {
                Cover(
                    nextUrl,
                    side,
                    Modifier.fillMaxSize(),
                    shape = shape,
                    placeholder = if (nextTrack == null) "shuffle" else "album",
                    instant = true,
                    onCacheKey = { key -> if (nextUrl != null && key != null) swipe.nextCached = nextUrl to key },
                )
            }
        }
        Box(
            Modifier
                .graphicsLayer { translationX = swipe.visualOffset(trackId) }
                .then(coverModifier)
                .size(side)
                .then(if (shadowElevation > 0.dp) Modifier.shadow(shadowElevation, shape) else Modifier),
        ) {
            Cover(
                curUrl,
                side,
                Modifier.fillMaxSize(),
                shape = shape,
                follows = true,
                instant = swipedHere,
                placeholderKey = if (swipedHere) swipe.handoffCacheKeyFor(curUrl) else null,
            )
        }
    }
}

/**
 * The mini player's song strip (cover + title + subtitle) that slides horizontally with [swipe] while the mini
 * player's background, buttons and progress line stay put. All drag offset reads stay in [graphicsLayer] so dragging
 * never recomposes the mini player.
 */
@Composable
fun SwipeableMiniTrack(
    track: Track,
    swipe: TrackSwipeController,
    coverModifier: Modifier,
    modifier: Modifier = Modifier,
) {
    val session = LocalSession.current
    val player = LocalPlayer.current
    val state by player.state.collectAsState()
    val nextTrack = remember(state.queueVersion, state.trackId, state.order) { player.nextTrackId?.let(session.lib::track) }
    val prevTrack = remember(state.queueVersion, state.trackId, state.order) { player.previousTrackId?.let(session.lib::track) }
    val canNext = remember(state.queueVersion, state.trackId, state.order) { player.canSkipNext }
    val canPrev = remember(state.queueVersion, state.trackId, state.order) { player.canSkipPrevious }
    val trackId = track.id
    val swipedHere = swipe.isSwipedInto(trackId)
    val miniPx = 44.dp.px()
    val prevUrl = prevTrack?.let { session.trackCoverUrl(it, miniPx) }
    val nextUrl = nextTrack?.let { session.trackCoverUrl(it, miniPx) }
    val curUrl = session.trackCoverUrl(track, miniPx)

    Box(
        modifier
            .clipToBounds()
            .onSizeChanged { if (it.width > 0) swipe.stridePx = it.width.toFloat() },
    ) {
        if (canPrev) {
            MiniTrackRow(
                track = prevTrack,
                coverUrl = prevUrl,
                fallbackTitle = "随机上一首",
                isCurrent = false,
                coverModifier = Modifier,
                instant = true,
                onCacheKey = { key -> if (prevUrl != null && key != null) swipe.prevCached = prevUrl to key },
                modifier = Modifier
                    .fillMaxWidth()
                    .graphicsLayer {
                        val ox = swipe.visualOffset(trackId)
                        translationX = ox - swipe.stridePx
                        alpha = if (ox != 0f || swipe.dragging) 1f else 0f
                    }
                    .clearAndSetSemantics {},
            )
        }
        if (canNext) {
            MiniTrackRow(
                track = nextTrack,
                coverUrl = nextUrl,
                fallbackTitle = "随机下一首",
                isCurrent = false,
                coverModifier = Modifier,
                instant = true,
                onCacheKey = { key -> if (nextUrl != null && key != null) swipe.nextCached = nextUrl to key },
                modifier = Modifier
                    .fillMaxWidth()
                    .graphicsLayer {
                        val ox = swipe.visualOffset(trackId)
                        translationX = ox + swipe.stridePx
                        alpha = if (ox != 0f || swipe.dragging) 1f else 0f
                    }
                    .clearAndSetSemantics {},
            )
        }
        MiniTrackRow(
            track = track,
            coverUrl = curUrl,
            fallbackTitle = "",
            isCurrent = true,
            coverModifier = coverModifier,
            instant = swipedHere,
            placeholderKey = if (swipedHere) swipe.handoffCacheKeyFor(curUrl) else null,
            modifier = Modifier
                .fillMaxWidth()
                .graphicsLayer { translationX = swipe.visualOffset(trackId) },
        )
    }
}

@Composable
private fun MiniTrackRow(
    track: Track?,
    coverUrl: String?,
    fallbackTitle: String,
    isCurrent: Boolean,
    coverModifier: Modifier,
    instant: Boolean,
    placeholderKey: MemoryCache.Key? = null,
    onCacheKey: ((MemoryCache.Key?) -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val c = Sonus.colors
    val state by LocalPlayer.current.state.collectAsState()
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        if (track != null) {
            Box(coverModifier.size(44.dp)) {
                Cover(
                    coverUrl,
                    44.dp,
                    Modifier.fillMaxSize(),
                    follows = isCurrent,
                    instant = instant,
                    placeholderKey = placeholderKey,
                    onCacheKey = onCacheKey,
                )
            }
        } else {
            Box(
                Modifier.size(44.dp).clip(RoundedCornerShape(Shapes.smallCover)).background(c.panel),
                contentAlignment = Alignment.Center,
            ) {
                KitIcon("shuffle", size = 18.dp, tint = c.textMuted)
            }
        }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(track?.title ?: fallbackTitle, style = Sonus.type.cardTitle, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (isCurrent && showsWhereLine()) {
                WhereLine()
            } else {
                Text(
                    if (isCurrent && state.status == PlayerStatus.Error) state.error.orEmpty() else track?.artist ?: "随机播放",
                    style = Sonus.type.caption,
                    color = if (isCurrent && state.status == PlayerStatus.Error) c.bad else c.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}
