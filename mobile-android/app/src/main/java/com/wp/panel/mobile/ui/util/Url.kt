package com.wp.panel.mobile.ui.util

fun resolveUrl(baseUrl: String, pathOrUrl: String?): String? {
    if (pathOrUrl.isNullOrBlank()) return null
    val raw = pathOrUrl.trim()
    if (raw.startsWith("http://") || raw.startsWith("https://")) return raw
    val base = baseUrl.trim().trimEnd('/')
    val suffix = raw.trimStart('/')
    if (base.isBlank()) return raw
    return "$base/$suffix"
}

