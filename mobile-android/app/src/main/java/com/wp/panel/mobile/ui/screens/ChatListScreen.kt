package com.wp.panel.mobile.ui.screens

import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.rememberAsyncImagePainter
import com.wp.panel.mobile.data.api.Chat
import com.wp.panel.mobile.data.TokenStore
import com.wp.panel.mobile.data.repo.ApiResult
import com.wp.panel.mobile.data.repo.ChatRepository
import androidx.compose.foundation.shape.CircleShape
import com.wp.panel.mobile.ui.util.resolveUrl
import com.wp.panel.mobile.realtime.WpSocket
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatListScreen(
    chatRepository: ChatRepository,
    baseUrl: String,
    tokenStore: TokenStore,
    onOpenChat: (chatId: String) -> Unit,
    onOpenSettings: () -> Unit
) {
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var chats by remember { mutableStateOf<List<Chat>>(emptyList()) }
    val scope = rememberCoroutineScope()
    val accessToken by tokenStore.accessTokenFlow.collectAsState(initial = null)
    val accountId by tokenStore.accountIdFlow.collectAsState(initial = null)
    val socket = remember(baseUrl) { WpSocket(baseUrl) }

    LaunchedEffect(Unit) {
        loading = true
        error = null
        when (val res = chatRepository.listChats()) {
            is ApiResult.Ok -> {
                chats = res.value
                loading = false
            }
            is ApiResult.Err -> {
                error = res.message
                loading = false
            }
        }
    }

    DisposableEffect(accessToken, accountId, baseUrl) {
        val token = accessToken
        if (!token.isNullOrBlank() && baseUrl.isNotBlank()) {
            socket.connect(token = token, accountId = accountId) {
                // Any new message: refresh chat list for unread/last message.
                // (Throttling can be added if needed.)
                scope.launch {
                    when (val res = chatRepository.listChats()) {
                        is ApiResult.Ok -> chats = res.value
                        is ApiResult.Err -> {}
                    }
                }
            }
        }
        onDispose { socket.disconnect() }
    }

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text("Chats") },
                actions = {
                    IconButton(onClick = onOpenSettings) {
                        Icon(Icons.Filled.Settings, contentDescription = "Settings")
                    }
                }
            )
        }
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            when {
                loading -> {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(24.dp),
                        horizontalArrangement = Arrangement.Center
                    ) {
                        CircularProgressIndicator()
                    }
                }
                error != null -> {
                    Text(
                        text = error ?: "Error",
                        modifier = Modifier.padding(16.dp)
                    )
                }
                else -> {
                    LazyColumn(modifier = Modifier.fillMaxSize()) {
                        items(chats, key = { it.chatId }) { chat ->
                            ChatRow(chat = chat, baseUrl = baseUrl, onClick = { onOpenChat(chat.chatId) })
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ChatRow(chat: Chat, baseUrl: String, onClick: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        val painter = rememberAsyncImagePainter(resolveUrl(baseUrl, chat.profilePic))
        Image(
            painter = painter,
            contentDescription = "Profile",
            modifier = Modifier.size(44.dp).clip(CircleShape)
        )
        Spacer(Modifier.size(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(text = chat.name ?: chat.chatId, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.height(2.dp))
            Text(
                text = chat.lastMessage ?: "",
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
        val unread = chat.unreadCount ?: 0
        if (unread > 0) {
            Spacer(Modifier.size(8.dp))
            Text(text = unread.toString())
        }
    }
}
