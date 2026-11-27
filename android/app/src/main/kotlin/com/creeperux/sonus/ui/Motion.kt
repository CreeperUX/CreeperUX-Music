package com.creeperux.sonus.ui

import android.os.SystemClock
import android.provider.Settings
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import kotlinx.coroutines.delay
import kotlin.math.min

/**
 * The app's motion, as the Windows app's Motion.cs has it: the same durations and foobar2k's ease-out curve. Pages and
 * their first rows come in (a fade, a short rise), pressed things give a little, a like pops, the player follows the
 * finger. With the system's animations off (Settings › Accessibility › Remove animations, or an animator duration scale
 * of 0) Compose's own animations finish at once, and what is drawn here only for show (the entrances, the level bars)
 * is left out: things just appear, as with Windows' animation effects off.
 */
object Motion {
    /** foobar2k's ease-out (--cx-ease-out: cubic-bezier(.2, .8, .2, 1)): quick, then settling. */
    val EaseOut = CubicBezierEasing(0.2f, 0.8f, 0.2f, 1f)
    const val PRESS = 60 // --cx-motion-press
    const val RELEASE = 120 // --cx-motion-release
    const val ENTER = 140 // --cx-motion-enter
    const val EXIT = 90 // --cx-motion-exit
    const val CONTROL = 200 // --cx-motion-control
    const val PUSH = 220 // --cx-motion-push
    const val SHEET = 320 // --cx-motion-sheet: bigger moves
    const val CLOSE = 200 // a sheet leaving: quicker than it came, speeding up
    const val TINT = 600 // the page colour's change
}

/** Whether things move (the system's animator duration scale is not 0); read again when the app comes back. */
val LocalMotion = compositionLocalOf { true }

@Composable
fun rememberMotionEnabled(): Boolean {
    val context = LocalContext.current
    fun read() = Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) > 0f
    var enabled by remember { mutableStateOf(read()) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { enabled = read() }
    return enabled
}

/** When the page on screen first appeared (uptime ms), for its first rows' entrance ([entrance]); null: no entrance. */
val LocalPageShown = compositionLocalOf<Long?> { null }

/**
 * One of a page's first rows or cards coming in, as the Windows app's Stagger: it fades in while it rises 16 dp into
 * place, a little after the one before (24 ms; the first eight, the rest with the eighth). Only while the page itself
 * is appearing: a row scrolled into view later is simply there.
 */
@Composable
fun Modifier.entrance(index: Int): Modifier {
    val shown = LocalPageShown.current ?: return this
    if (!LocalMotion.current) return this
    val fresh = remember { SystemClock.uptimeMillis() - shown < 350 }
    if (!fresh || index > 24) return this
    val progress = remember { Animatable(0f) }
    LaunchedEffect(Unit) {
        delay(min(index, 8) * 24L)
        progress.animateTo(1f, tween(300, easing = Motion.EaseOut))
    }
    return graphicsLayer {
        val p = progress.value
        alpha = min(1f, p * 1.6f) // the fade is quicker than the rise (180 of 300 ms)
        translationY = (1f - p) * 16.dp.toPx()
    }
}

/** A pressed thing gives a little (0.96), quickly, and comes back a little slower: Motion.cs's press and release. */
@Composable
fun Modifier.pressScale(source: MutableInteractionSource, pressed: Float = 0.96f): Modifier {
    val down by source.collectIsPressedAsState()
    val scale by animateFloatAsState(
        if (down) pressed else 1f,
        tween(if (down) Motion.PRESS else Motion.RELEASE, easing = if (down) LinearEasing else Motion.EaseOut),
        label = "press",
    )
    return graphicsLayer { scaleX = scale; scaleY = scale }
}

/** Light haptics on the actions that change something you hear or keep: play and pause, a like, moving playback to
 *  another device, a long press, the start and end of dragging the position. */
class Haptics(private val perform: (HapticFeedbackType) -> Unit) {
    fun tap() = perform(HapticFeedbackType.ContextClick)
    fun toggle(on: Boolean) = perform(if (on) HapticFeedbackType.ToggleOn else HapticFeedbackType.ToggleOff)
    fun confirm() = perform(HapticFeedbackType.Confirm)
    fun longPress() = perform(HapticFeedbackType.LongPress)
    fun dragStart() = perform(HapticFeedbackType.GestureThresholdActivate)
    fun dragEnd() = perform(HapticFeedbackType.GestureEnd)
}

@Composable
fun rememberHaptics(): Haptics {
    val feedback = LocalHapticFeedback.current
    return remember(feedback) { Haptics(feedback::performHapticFeedback) }
}
