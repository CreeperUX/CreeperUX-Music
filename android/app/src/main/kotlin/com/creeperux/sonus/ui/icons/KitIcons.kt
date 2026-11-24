package com.creeperux.sonus.ui.icons

import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.creeperux.sonus.ui.theme.Sonus

/** The CreeperUX kit's icons ([KitIconData]) as Compose vectors, made once each. */
object KitIcons {
    private val cache = HashMap<String, ImageVector>()

    fun get(name: String): ImageVector = synchronized(cache) {
        cache.getOrPut(name) {
            val data = KitIconData[name] ?: KitIconData.getValue("music")
            ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f)
                .addPath(PathParser().parsePathString(data).toNodes(), fill = SolidColor(Color.Black))
                .build()
        }
    }
}

/**
 * An icon of the kit. As the Windows app's KitIcon, it is drawn a quarter larger than [size] (the kit's icons leave a
 * margin on their grid), so a 16 dp icon reads like a 16 dp glyph.
 */
@Composable
fun KitIcon(name: String, modifier: Modifier = Modifier, size: Dp = 18.dp, tint: Color = Sonus.colors.text, contentDescription: String? = null) {
    Icon(KitIcons.get(name), contentDescription, modifier.size(size * 1.25f), tint = tint)
}
