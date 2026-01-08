package com.wp.panel.mobile.realtime

import io.socket.client.IO
import io.socket.client.Socket
import org.json.JSONObject

class WpSocket(private val baseUrl: String) {
    private var socket: Socket? = null

    fun connect(token: String, accountId: String?, onMessage: (JSONObject) -> Unit) {
        disconnect()

        val opts = IO.Options().apply {
            path = "/socket.io/"
            forceNew = true
            reconnection = true
            extraHeaders = buildMap<String, List<String>> {
                put("Authorization", listOf("Bearer $token"))
                if (!accountId.isNullOrBlank()) {
                    put("X-Account-Id", listOf(accountId))
                }
            }
        }

        val origin = baseUrl.trim().trimEnd('/')
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

