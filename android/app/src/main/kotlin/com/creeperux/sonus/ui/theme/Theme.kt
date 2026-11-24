package com.creeperux.sonus.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.creeperux.sonus.R
import com.creeperux.sonus.data.ThemeMode

/**
 * The CreeperUX colours as Sonus uses them: dark as the Windows app (App.xaml), light as the web client and the kit's
 * light mode (web/src/styles.css, web/vendor/creeperux-gui/tokens.json).
 */
@Immutable
data class SonusColors(
    val isDark: Boolean,
    val window: Color,
    val panel: Color,
    val raised: Color,
    val raisedHover: Color,
    val hover: Color,
    val tile: Color,
    val divider: Color,
    val text: Color,
    val textMuted: Color,
    val textQuiet: Color,
    val accent: Color,
    val accentPressed: Color,
    val onAccent: Color,
    /** The accent as text or a small mark (the light mode's fill colour is too pale for text). */
    val accentText: Color,
    val bad: Color,
    val good: Color,
    val warn: Color,
    val info: Color,
    val toast: Color,
    val selected: Color,
    /** The play button of the player bar: white in the dark, ink in the light. */
    val playButton: Color,
    val onPlayButton: Color,
)

val DarkColors = SonusColors(
    isDark = true,
    window = Color(0xFF040607), panel = Color(0xFF151B1F), raised = Color(0xFF20272C), raisedHover = Color(0xFF2A3338),
    hover = Color(0x12EFEBE5), tile = Color(0x17F4F1EB), divider = Color(0x24EFEBE5),
    text = Color(0xFFF4F1EB), textMuted = Color(0xFFA9B0B3), textQuiet = Color(0xFF839196),
    accent = Color(0xFFF8B700), accentPressed = Color(0xFFFFC522), onAccent = Color(0xFF111416), accentText = Color(0xFFF8B700),
    bad = Color(0xFFC1877C), good = Color(0xFF80AB9E), warn = Color(0xFFD9A441), info = Color(0xFF6497A7),
    toast = Color(0xFF1B2227), selected = Color(0x1FFFFFFF), playButton = Color(0xFFF4F1EB), onPlayButton = Color(0xFF111416),
)

val LightColors = SonusColors(
    isDark = false,
    window = Color(0xFFDAD4CA), panel = Color(0xFFF8F6F1), raised = Color(0xFFECE7DF), raisedHover = Color(0xFFE3DDD3),
    hover = Color(0x0F050607), tile = Color(0x14111416), divider = Color(0x26050607),
    text = Color(0xFF111416), textMuted = Color(0xFF5C6265), textQuiet = Color(0xFF5F6466),
    accent = Color(0xFFF8B700), accentPressed = Color(0xFFE5A800), onAccent = Color(0xFF111416), accentText = Color(0xFF6C4C00),
    bad = Color(0xFF944E46), good = Color(0xFF326D5D), warn = Color(0xFF805B00), info = Color(0xFF406878),
    toast = Color(0xFF20272C), selected = Color(0x14050607), playButton = Color(0xFF111416), onPlayButton = Color(0xFFF8F6F1),
)

/** The fixed tints of pages without a cover (ViewParts.cs). */
object Tints {
    val Neutral = Color(0xFF3A4148)
    val Liked = Color(0xFF8A6200)
    val Library = Color(0xFF3C4F59)
    val Search = Color(0xFF2B3439)
}

/** Chakra Petch SemiBold for titles (Latin only; Chinese falls back to the system font, drawn bold to match). */
val Display = FontFamily(Font(R.font.chakra_petch_semibold, FontWeight.Bold))

@Immutable
data class SonusType(
    val hero: TextStyle,
    val pageTitle: TextStyle,
    val section: TextStyle,
    val panelHeading: TextStyle,
    val cardTitle: TextStyle,
    val body: TextStyle,
    val bodySmall: TextStyle,
    val muted: TextStyle,
    val caption: TextStyle,
    val numbers: TextStyle,
    val nowPlaying: TextStyle,
    val lyric: TextStyle,
)

private val tabular = "tnum"

val Type = SonusType(
    hero = TextStyle(fontFamily = Display, fontWeight = FontWeight.Bold, fontSize = 40.sp, lineHeight = 46.sp),
    pageTitle = TextStyle(fontFamily = Display, fontWeight = FontWeight.Bold, fontSize = 28.sp, lineHeight = 34.sp),
    section = TextStyle(fontFamily = Display, fontWeight = FontWeight.Bold, fontSize = 20.sp, lineHeight = 26.sp),
    panelHeading = TextStyle(fontWeight = FontWeight.Bold, fontSize = 15.sp, lineHeight = 20.sp),
    cardTitle = TextStyle(fontWeight = FontWeight.Bold, fontSize = 14.sp, lineHeight = 19.sp),
    body = TextStyle(fontSize = 15.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
    muted = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
    caption = TextStyle(fontSize = 12.sp, lineHeight = 16.sp),
    numbers = TextStyle(fontSize = 12.sp, lineHeight = 16.sp, fontFeatureSettings = tabular),
    nowPlaying = TextStyle(fontFamily = Display, fontWeight = FontWeight.Bold, fontSize = 22.sp, lineHeight = 28.sp),
    lyric = TextStyle(fontWeight = FontWeight.Bold, fontSize = 26.sp, lineHeight = 34.sp),
)

/** Corner radii and spacing (the Windows app's: panels and cards 8, rows 6, small covers 4, chips 16). */
object Shapes {
    val panel = 8.dp
    val row = 6.dp
    val smallCover = 4.dp
    val chip = 16.dp
    val card = 12.dp
}

val LocalColors = staticCompositionLocalOf { DarkColors }

object Sonus {
    val colors: SonusColors @Composable get() = LocalColors.current
    val type: SonusType get() = Type
}

@Composable
fun SonusTheme(mode: ThemeMode = ThemeMode.System, content: @Composable () -> Unit) {
    val dark = when (mode) {
        ThemeMode.Dark -> true
        ThemeMode.Light -> false
        ThemeMode.System -> isSystemInDarkTheme()
    }
    val c = if (dark) DarkColors else LightColors
    val scheme = if (dark) {
        darkColorScheme(
            primary = c.accent, onPrimary = c.onAccent, secondary = c.accent, onSecondary = c.onAccent,
            background = c.window, onBackground = c.text, surface = c.panel, onSurface = c.text,
            surfaceVariant = c.raised, onSurfaceVariant = c.textMuted, surfaceContainer = c.raised, surfaceContainerHigh = c.raised,
            surfaceContainerHighest = c.raisedHover, surfaceContainerLow = c.panel, outline = c.divider, outlineVariant = c.divider,
            error = c.bad, inverseSurface = c.toast, inverseOnSurface = c.text, inversePrimary = c.accent,
        )
    } else {
        lightColorScheme(
            primary = c.accent, onPrimary = c.onAccent, secondary = c.accentText, onSecondary = c.panel,
            background = c.window, onBackground = c.text, surface = c.panel, onSurface = c.text,
            surfaceVariant = c.raised, onSurfaceVariant = c.textMuted, surfaceContainer = c.raised, surfaceContainerHigh = c.raised,
            surfaceContainerHighest = c.raisedHover, surfaceContainerLow = c.panel, outline = c.divider, outlineVariant = c.divider,
            error = c.bad, inverseSurface = c.toast, inverseOnSurface = Color(0xFFF4F1EB), inversePrimary = c.accent,
        )
    }
    CompositionLocalProvider(LocalColors provides c) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}
