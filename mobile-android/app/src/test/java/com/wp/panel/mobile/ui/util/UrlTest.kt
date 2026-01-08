package com.wp.panel.mobile.ui.util

import org.junit.Assert.assertEquals
import org.junit.Test

class UrlTest {
    @Test
    fun `resolveUrl handles full urls`() {
        val baseUrl = "http://example.com"
        val path = "http://other.com/image.png"
        assertEquals("http://other.com/image.png", resolveUrl(baseUrl, path))
    }

    @Test
    fun `resolveUrl handles relative paths`() {
        val baseUrl = "http://example.com"
        val path = "/image.png"
        assertEquals("http://example.com/image.png", resolveUrl(baseUrl, path))
    }

    @Test
    fun `resolveUrl handles missing slash`() {
        val baseUrl = "http://example.com"
        val path = "image.png"
        assertEquals("http://example.com/image.png", resolveUrl(baseUrl, path))
    }

    @Test
    fun `resolveUrl handles trailing slash in base`() {
        val baseUrl = "http://example.com/"
        val path = "/image.png"
        assertEquals("http://example.com/image.png", resolveUrl(baseUrl, path))
    }

    @Test
    fun `resolveUrl returns null for null or empty`() {
        assertEquals(null, resolveUrl("http://example.com", null))
        assertEquals(null, resolveUrl("http://example.com", ""))
    }
}
