package com.creeperux.sonus.ui

import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.SharedTransitionLayout
import androidx.compose.animation.SharedTransitionScope
import androidx.compose.animation.core.FastOutLinearInEasing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.SeekableTransitionState
import androidx.compose.animation.core.rememberTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.PointerInputChange
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import com.creeperux.sonus.ui.screens.FullPlayer
import com.creeperux.sonus.ui.screens.MiniPlayer
import com.creeperux.sonus.ui.theme.Shapes
import com.creeperux.sonus.ui.theme.Sonus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * The phone: the page, the mini player and the tabs, and the player over them. The player is a sheet that follows the
 * finger, as Spotify's: drag the mini player up and it comes with you; drag the player (its cover, its top) down and it
 * goes; let go past a third of the way, or with a flick, and it finishes at the finger's pace, else it settles back.
 * Opening, its cover grows out of the mini player's (one shared element); closing, the player goes down whole, cover
 * and all, quickly, and the mini player is there under it. A tap opens it, Back or the chevron closes it, and a back
 * swipe draws it down as the finger moves. One seekable transition carries all of it, so the drag, the animation and
 * the back gesture are the same motion.
 */
@Composable
internal fun PhoneShell(nav: Navigator) {
    val c = Sonus.colors
    val player = LocalPlayer.current
    val state by player.state.collectAsState()
    val open = nav.playerOpen.value
    val sheet = remember { SeekableTransitionState(open) }
    val transition = rememberTransition(sheet, label = "player")
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    var height by remember { mutableIntStateOf(1) }
    var miniHeight by remember { mutableIntStateOf(0) }
    var nextSpec by remember { mutableStateOf<FiniteAnimationSpec<Float>?>(null) } // a release's, for the effect below
    LaunchedEffect(open) {
        val spec = nextSpec ?: sheetSpec(open)
        nextSpec = null
        if (sheet.currentState != open || sheet.targetState != open) sheet.animateTo(open, spec)
    }
    val flick = with(LocalDensity.current) { 900.dp.toPx() } // per second

    // where a drag or a back swipe ends: the player open or closed, from where the finger left it, at its pace
    // ([speed], px/s towards [target]): the effect above animates a change; no change, it settles back here
    fun settle(target: Boolean, speed: Float = 0f) {
        val spec = releaseSpec(target, remaining = (1f - sheet.fraction).coerceIn(0f, 1f) * height, speed = speed, flick = flick)
        if (nav.playerOpen.value != target) {
            nextSpec = spec
            nav.playerOpen.value = target
        } else {
            scope.launch { sheet.animateTo(target, spec) }
        }
    }
    val drag = SheetDrag(sheet, scope, { height }, flick, haptics, ::settle)

    PredictiveBackHandler(enabled = open) { events ->
        if (nav.playerView.value != PlayerView.Cover) {
            // the lyrics or the queue: back shows the cover again (Navigator.back)
            events.collect {}
            nav.back()
            return@PredictiveBackHandler
        }
        try {
            events.collect { e -> sheet.seekTo(e.progress * 0.5f, targetState = false) }
            settle(false)
        } catch (e: CancellationException) {
            scope.launch { sheet.animateTo(true, tween(Motion.RELEASE, easing = Motion.EaseOut)) }
            throw e
        }
    }

    SharedTransitionLayout(Modifier.fillMaxSize().background(c.window).onSizeChanged { height = it.height }) {
        Box(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize()) {
                Box(Modifier.weight(1f).fillMaxWidth().background(c.panel)) { PageHost(nav, Modifier.fillMaxSize().background(c.panel)) }
                if (state.trackId != null) {
                    // keeps its place while the player is open: the page above does not move
                    Box(Modifier.heightIn(min = with(LocalDensity.current) { miniHeight.toDp() }).background(c.panel)) {
                        transition.AnimatedVisibility({ !it }, enter = fadeIn(tween(Motion.ENTER)), exit = fadeOut(tween(Motion.EXIT))) {
                            MiniPlayer(
                                open = { nav.playerOpen.value = true },
                                modifier = Modifier.onSizeChanged { miniHeight = it.height }.then(drag.modifier(opening = true)),
                                coverModifier = sharedCover(this@AnimatedVisibility, above = false, opening = transition.targetState),
                            )
                        }
                    }
                }
                PhoneTabs(nav)
            }
            // linear here: the transition's own pace (the finger, or animateTo's ease-out) is the one curve everything follows
            transition.AnimatedVisibility(
                { it },
                enter = slideInVertically(tween(Motion.SHEET, easing = LinearEasing)) { it },
                exit = slideOutVertically(tween(Motion.SHEET, easing = LinearEasing)) { it },
            ) {
                FullPlayer(dragModifier = drag.modifier(opening = false), coverModifier = sharedCover(this@AnimatedVisibility, above = true, opening = transition.targetState))
            }
        }
    }
}

/** How long the sheet takes when nothing says otherwise (a tap, Back, the chevron): opening, it settles into place;
 *  closing, it goes away quicker, speeding up, as things that leave do. */
private fun sheetSpec(open: Boolean): FiniteAnimationSpec<Float> =
    if (open) tween(Motion.SHEET, easing = Motion.EaseOut) else tween(Motion.CLOSE, easing = FastOutLinearInEasing)

/** After a drag or a back swipe: the [remaining] way (px) at the finger's [speed] (px/s), within reason. A flick goes
 *  on at its pace; a slow let-go closes quickly, speeding up, or settles into place opening. */
private fun releaseSpec(target: Boolean, remaining: Float, speed: Float, flick: Float): FiniteAnimationSpec<Float> {
    val atPace = if (speed > 0f) (remaining / speed * 1000f).toInt() else Int.MAX_VALUE
    return if (target) {
        tween(atPace.coerceIn(140, Motion.SHEET), easing = Motion.EaseOut)
    } else {
        tween(atPace.coerceIn(100, Motion.CLOSE), easing = if (speed >= flick) LinearEasing else FastOutLinearInEasing)
    }
}

/** The player's cover, shared by the mini player and the player while it [opening]s: its bounds move between the two,
 *  at the sheet's pace, both drawn at the moving bounds, opaque, the player's sharper image [above] the mini player's.
 *  Closing, it is simply part of the player going down (no flight back into the mini player). */
@Composable
private fun SharedTransitionScope.sharedCover(scope: androidx.compose.animation.AnimatedVisibilityScope, above: Boolean, opening: Boolean): Modifier =
    if (!opening) Modifier else Modifier.sharedBounds(
        rememberSharedContentState("player-cover"), scope,
        enter = EnterTransition.None, exit = ExitTransition.None,
        boundsTransform = { _, _ -> tween(Motion.SHEET, easing = LinearEasing) },
        resizeMode = SharedTransitionScope.ResizeMode.RemeasureToBounds,
        clipInOverlayDuringTransition = OverlayClip(RoundedCornerShape(Shapes.panel)),
        zIndexInOverlay = if (above) 1f else 0f,
    )

/**
 * A vertical drag that moves the sheet: up from the mini player ([opening]), down from the player. The finger is
 * followed on the screen, not in the dragged thing's own coordinates: the player moves with the finger, so there the
 * finger would hardly seem to move (the sheet lagging behind it, a flick not seen as one).
 */
private class SheetDrag(
    private val sheet: SeekableTransitionState<Boolean>,
    private val scope: CoroutineScope,
    private val height: () -> Int,
    private val flick: Float,
    private val haptics: Haptics,
    private val settle: (Boolean, Float) -> Unit,
) {
    fun modifier(opening: Boolean): Modifier {
        var where: LayoutCoordinates? = null
        return Modifier.onGloballyPositioned { where = it }.pointerInput(opening) {
            val tracker = VelocityTracker()
            var start = 0f
            var fraction = 0f
            fun onScreen(change: PointerInputChange): Float = where?.takeIf { it.isAttached }?.localToRoot(change.position)?.y ?: change.position.y
            detectVerticalDragGestures(
                onDragStart = { at ->
                    tracker.resetTracking()
                    start = where?.takeIf { it.isAttached }?.localToRoot(at)?.y ?: at.y
                    fraction = 0f
                },
                onVerticalDrag = { change, _ ->
                    val y = onScreen(change)
                    tracker.addPosition(change.uptimeMillis, Offset(0f, y))
                    fraction = ((if (opening) start - y else y - start) / height().coerceAtLeast(1)).coerceIn(0f, 1f)
                    val f = fraction
                    scope.launch { sheet.seekTo(f, targetState = opening) }
                    change.consume()
                },
                onDragEnd = {
                    val v = tracker.calculateVelocity().y // down is positive
                    val towards = if (opening) -v else v
                    val done = (fraction > 0.33f && towards > -flick) || towards > flick
                    if (done) haptics.dragEnd()
                    settle(if (done) opening else !opening, if (done) towards.coerceAtLeast(0f) else (-towards).coerceAtLeast(0f))
                },
                onDragCancel = { settle(!opening, 0f) },
            )
        }
    }
}
