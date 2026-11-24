package com.creeperux.sonus.ui.components

import android.graphics.Bitmap
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil3.SingletonImageLoader
import coil3.request.ImageRequest
import coil3.request.SuccessResult
import coil3.request.allowHardware
import coil3.toBitmap
import com.creeperux.sonus.ui.theme.Sonus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * The colour of a cover as the Windows app takes it (Ui.cs): the average of the cover scaled to 12×12, darkened when it
 * is bright (luminance above 120 of 255). [url] is the cover at 64 px. Null until it is known.
 */
@Composable
fun rememberCoverColor(url: String?): Color? {
    val context = LocalContext.current
    val color by produceState<Color?>(null, url) {
        value = null
        if (url == null) return@produceState
        val result = SingletonImageLoader.get(context).execute(ImageRequest.Builder(context).data(url).size(12).allowHardware(false).build())
        val bitmap = (result as? SuccessResult)?.image?.toBitmap() ?: return@produceState
        value = withContext(Dispatchers.Default) { average(bitmap) }
    }
    return color
}

private fun average(b: Bitmap): Color {
    val small = if (b.width == 12 && b.height == 12) b else Bitmap.createScaledBitmap(b, 12, 12, true)
    var r = 0L
    var g = 0L
    var bl = 0L
    val px = IntArray(144)
    small.getPixels(px, 0, 12, 0, 0, 12, 12)
    for (p in px) {
        r += (p shr 16) and 0xff
        g += (p shr 8) and 0xff
        bl += p and 0xff
    }
    var rr = r / 144.0
    var gg = g / 144.0
    var bb = bl / 144.0
    val luma = 0.299 * rr + 0.587 * gg + 0.114 * bb
    if (luma > 120) {
        val k = 120 / luma
        rr *= k; gg *= k; bb *= k
    }
    return Color(rr.toFloat() / 255f, gg.toFloat() / 255f, bb.toFloat() / 255f)
}

/** A colour made darker by [amount] (0–1). */
fun Color.shade(amount: Float): Color = lerp(this, Color.Black, amount)

/**
 * The page tint behind a page's header (Ui.cs): the colour mixed 66 % into the panel at the top, a darker shade mixed
 * 46 % at 55 % of the height, the panel at the bottom; it fades in over 600 ms. It is drawn from the top of its box
 * downwards over [height] and scrolls with the page.
 */
@Composable
fun Modifier.pageTint(color: Color?, height: Dp = 420.dp): Modifier {
    val c = Sonus.colors
    val alpha = remember { Animatable(0f) }
    LaunchedEffect(color) {
        if (color != null) alpha.animateTo(1f, tween(600))
    }
    val panel = c.panel
    // the Windows app is dark only; on the light panel the same mix reads muddy, so it is lighter there
    val strength = if (c.isDark) 1f else 0.45f
    return this.drawBehind {
        val tint = color ?: return@drawBehind
        val h = height.toPx()
        val top = lerp(panel, tint, 0.66f * strength)
        val middle = lerp(panel, tint.shade(0.5f), 0.46f * strength)
        drawRect(
            Brush.verticalGradient(0f to top, 0.55f to middle, 1f to panel, startY = 0f, endY = h),
            size = androidx.compose.ui.geometry.Size(size.width, h),
            alpha = alpha.value,
        )
    }
}

/** A full-width box carrying the tint, for pages that put it behind their own content. */
@Composable
fun TintBox(color: Color?, height: Dp = 420.dp) {
    Box(Modifier.fillMaxWidth().height(1.dp).pageTint(color, height))
}
