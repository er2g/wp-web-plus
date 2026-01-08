package com.wp.panel.mobile.realtime

import io.socket.client.IO
import io.socket.client.Socket
import org.json.JSONObject
import java.net.URI

class WpSocket(private val baseUrl: String) {
    private var socket: Socket? = null

    fun connect(token: String, accountId: String?, onMessage: (JSONObject) -> Unit) {
        disconnect()

        var uri: URI? = null
        try {
            uri = URI(baseUrl.trim().trimEnd('/'))
        } catch (e: Exception) {
            e.printStackTrace()
            return
        }
        
        val baseUri = uri!!
        // E.g. https://rammfire.com/wp -> path = "/wp"
        val basePath = if (baseUri.path.isNullOrEmpty() || baseUri.path == "/") "" else baseUri.path
        val socketPath = if (basePath.isEmpty()) "/socket.io/" else "$basePath/socket.io/"

        // Origin for IO.socket should be scheme + host + port (without path)
        val origin = "${baseUri.scheme}://${baseUri.authority}"

        val opts = IO.Options().apply {
            path = socketPath
            forceNew = true
            reconnection = true
            extraHeaders = buildMap<String, List<String>> {
                put("Authorization", listOf("Bearer $token"))
                if (!accountId.isNullOrBlank()) {
                    put("X-Account-Id", listOf(accountId))
                }
            }
        }

        val s = IO.socket(origin, opts)
        socket = s
        s.on("message") { args ->
            val obj = args.firstOrNull() as? JSONObject ?: return@on
            onMessage(obj)
        }
        s.connect()
    }

    fun disconnect() {
        socket?.off()
        socket?.disconnect()
        socket = null
    }
}

