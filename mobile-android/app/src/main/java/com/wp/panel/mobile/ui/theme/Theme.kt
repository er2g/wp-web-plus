package com.wp.panel.mobile.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val LightColors = lightColorScheme(
    primary = Color(0xFF0B8F6A),
    secondary = Color(0xFF2D6A4F),
    tertiary = Color(0xFF1B4332)
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF3DDC97),
    secondary = Color(0xFF74C69D),
    tertiary = Color(0xFF95D5B2)
)

@Composable
fun AppTheme(
    darkTheme: Boolean = true,
    content: @Composable () -> Unit
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        content = content
    )
}
