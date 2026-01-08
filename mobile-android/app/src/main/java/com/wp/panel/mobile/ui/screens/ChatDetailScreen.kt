package com.wp.panel.mobile.ui.screens

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
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.wp.panel.mobile.data.TokenStore
import com.wp.panel.mobile.data.api.Message
import com.wp.panel.mobile.data.repo.ApiResult
import com.wp.panel.mobile.data.repo.ChatRepository
import com.wp.panel.mobile.realtime.WpSocket
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatDetailScreen(
    chatId: String,
    chatRepository: ChatRepository,
    tokenStore: TokenStore,
    baseUrl: String,
    onBack: () -> Unit
) {
    val scope = rememberCoroutineScope()
    val accessToken by tokenStore.accessTokenFlow.collectAsState(initial = null)
    val accountId by tokenStore.accountIdFlow.collectAsState(initial = null)
    val socket = remember(baseUrl) { WpSocket(baseUrl) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var messages by remember { mutableStateOf<List<Message>>(emptyList()) }
    var draft by remember { mutableStateOf("") }

    fun refresh() {
        scope.launch(Dispatchers.Main) {
            loading = true
            error = null
            when (val res = chatRepository.getMessages(chatId, limit = 50, offset = 0)) {
                is ApiResult.Ok -> {
                    // API returns latest first
                    messages = res.value.messages.reversed()
                    loading = false
                }
                is ApiResult.Err -> {
                    error = res.message
                    loading = false
                }
            }
        }
    }

    LaunchedEffect(chatId) {
        refresh()
    }

    DisposableEffect(accessToken, accountId, chatId, baseUrl) {
        val token = accessToken
        if (!token.isNullOrBlank() && baseUrl.isNotBlank()) {
            socket.connect(token = token, accountId = accountId) { json ->
                val incomingChatId = json.optString("chatId", "")
                if (incomingChatId == chatId) {
                    refresh()
                }
            }
        }
        onDispose {
            socket.disconnect()
        }
    }

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text(chatId) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Filled.ArrowBack, contentDescription = "Back")
                    }
                }
            )
        },
        bottomBar = {
            Row(
                modifier = Modifier.fillMaxWidth().padding(12.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                OutlinedTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("Message") },
                    singleLine = true
                )
                Spacer(Modifier.size(8.dp))
                IconButton(
                    enabled = draft.trim().isNotEmpty(),
                    onClick = {
                        val text = draft.trim()
                        draft = ""
                        scope.launch(Dispatchers.Main) {
                            when (chatRepository.sendText(chatId, text)) {
                                is ApiResult.Ok -> refresh()
                                is ApiResult.Err -> {
                                    error = "Send failed"
                                }
                            }
                        }
                    }
                ) {
                    Icon(Icons.Filled.Send, contentDescription = "Send")
                }
            }
        }
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            if (loading) {
                Text(text = "Loading...", modifier = Modifier.padding(16.dp))
                return@Column
            }
            if (error != null) {
                Text(text = error ?: "", modifier = Modifier.padding(16.dp))
            }

            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(horizontal = 12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                items(messages, key = { it.messageId ?: "${it.timestamp}-${it.body}" }) { msg ->
                    MessageBubble(message = msg)
                }
                item { Spacer(Modifier.height(12.dp)) }
            }
        }
    }
}

@Composable
private fun MessageBubble(message: Message) {
    val fromMe = message.isFromMe == 1
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (fromMe) Arrangement.End else Arrangement.Start
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 6.dp)
        ) {
            if (!fromMe && !message.fromName.isNullOrBlank()) {
                Text(text = message.fromName!!, modifier = Modifier.padding(bottom = 2.dp))
            }
            Text(text = message.body ?: "")
        }
    }
}
