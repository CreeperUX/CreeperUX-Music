package com.creeperux.sonus.ui

import android.os.SystemClock
import androidx.activity.BackEventCompat
import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * The page on screen, changing with motion (the Windows app's page push): forward, the new page comes in from the right
 * (an eighth of the way, fading in) while the one before steps back to the left; back, the other way; another tab fades
 * through. The page before keeps its state, so back returns to where it was scrolled. A back swipe (Android's predictive
 * back) draws the page a little smaller and rounder as the finger moves, and lets it go or springs it back.
 */
@Composable
fun PageHost(nav: Navigator, modifier: Modifier = Modifier) {
    val holder = rememberSaveableStateHolder()
    val motion = LocalMotion.current
    val back = remember { Animatable(0f) }
    var edge by remember { mutableIntStateOf(BackEventCompat.EDGE_LEFT) }
    val scope = rememberCoroutineScope()
    PredictiveBackHandler(enabled = nav.backIsPage) { events ->
        try {
            events.collect { e ->
                edge = e.swipeEdge
                back.snapTo(e.progress)
            }
            nav.back()
            scope.launch { back.animateTo(0f, tween(Motion.PUSH, easing = Motion.EaseOut)) }
        } catch (e: CancellationException) {
            scope.launch { back.animateTo(0f, tween(Motion.RELEASE, easing = Motion.EaseOut)) }
            throw e
        }
    }
    AnimatedContent(
        nav.current,
        modifier.graphicsLayer {
            val p = back.value
            if (p > 0f) {
                val s = 1f - 0.08f * p
                scaleX = s
                scaleY = s
                translationX = (if (edge == BackEventCompat.EDGE_LEFT) 1f else -1f) * p * 12.dp.toPx()
                shape = RoundedCornerShape(24.dp * p)
                clip = true
            }
        },
        transitionSpec = { pageTransition(nav.move.value, motion) },
        label = "page",
    ) { route ->
        // its first rows come in when it is new (forward, another tab); back, it is simply there again
        val shown = remember { if (nav.move.value == Move.Back) null else SystemClock.uptimeMillis() }
        CompositionLocalProvider(LocalPageShown provides shown) {
            holder.SaveableStateProvider(route.toString()) { Page(route) }
        }
    }
}

private fun AnimatedContentTransitionScope<Route>.pageTransition(move: Move, motion: Boolean): ContentTransform {
    if (!motion) return EnterTransition.None togetherWith ExitTransition.None
    val slide = tween<IntOffset>(Motion.PUSH, easing = Motion.EaseOut)
    val fade = fadeIn(tween(Motion.ENTER, delayMillis = 30))
    return when (move) {
        Move.Forward -> (slideInHorizontally(slide) { it / 8 } + fade) togetherWith (slideOutHorizontally(slide) { -it / 16 } + fadeOut(tween(Motion.EXIT)))
        Move.Back -> ((slideInHorizontally(slide) { -it / 16 } + fade) togetherWith (slideOutHorizontally(slide) { it / 8 } + fadeOut(tween(Motion.EXIT))))
            .apply { targetContentZIndex = -1f } // the page going away stays on top as it leaves
        Move.Tab -> fadeIn(tween(Motion.ENTER, delayMillis = 40)) togetherWith fadeOut(tween(Motion.EXIT))
    }
}
