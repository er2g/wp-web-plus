package com.wp.panel.mobile.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.wp.panel.mobile.data.TokenStore
import com.wp.panel.mobile.data.api.MobileNotificationSettings
import com.wp.panel.mobile.data.api.MobileNotificationSettingsUpdate
import com.wp.panel.mobile.data.repo.ApiResult
import com.wp.panel.mobile.data.repo.AuthRepository
import com.wp.panel.mobile.data.repo.SettingsRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    settingsRepository: SettingsRepository,
    tokenStore: TokenStore,
    authRepository: AuthRepository,
    onBack: () -> Unit,
    onLoggedOut: () -> Unit
) {
    val scope = rememberCoroutineScope()

    var baseUrl by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    var settings by remember { mutableStateOf<MobileNotificationSettings?>(null) }
    var enabled by remember { mutableStateOf(true) }
    var showName by remember { mutableStateOf(true) }
    var showPhoto by remember { mutableStateOf(true) }
    var showPreview by remember { mutableStateOf(true) }

    LaunchedEffect(Unit) {
        baseUrl = tokenStore.getBaseUrl()
        when (val res = settingsRepository.getGlobal()) {
            is ApiResult.Ok -> {
                settings = res.value
                enabled = (res.value.enabled ?: 1) != 0
                showName = (res.value.showSenderName ?: 1) != 0
                showPhoto = (res.value.showSenderPhoto ?: 1) != 0
                showPreview = (res.value.showMessagePreview ?: 1) != 0
                loading = false
            }
            is ApiResult.Err -> {
                error = res.message
                loading = false
            }
        }
    }

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text("Settings") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Filled.ArrowBack, contentDescription = "Back")
                    }
                }
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            if (loading) {
                Text("Loading...")
                return@Column
            }

            if (error != null) {
                Text(error ?: "")
            }

            Text("Backend Base URL")
            OutlinedTextField(
                value = baseUrl,
                onValueChange = { baseUrl = it },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                placeholder = { Text("http://10.0.2.2:3000/") }
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = {
                    scope.launch(Dispatchers.Main) {
                        tokenStore.setBaseUrl(baseUrl.trim())
                    }
                }) { Text("Save URL") }
                Button(onClick = {
                    scope.launch(Dispatchers.Main) {
                        authRepository.logoutLocal()
                        onLoggedOut()
                    }
                }) { Text("Logout") }
            }

            Spacer(Modifier.height(8.dp))
            Text("Notifications (server-side)")

            SwitchRow("Enabled", enabled) { enabled = it }
            SwitchRow("Show sender name", showName) { showName = it }
            SwitchRow("Show sender photo", showPhoto) { showPhoto = it }
            SwitchRow("Show message preview", showPreview) { showPreview = it }

            Button(
                modifier = Modifier.fillMaxWidth(),
                onClick = {
                    scope.launch(Dispatchers.Main) {
                        error = null
                        val update = MobileNotificationSettingsUpdate(
                            enabled = enabled,
                            showSenderName = showName,
                            showSenderPhoto = showPhoto,
                            showMessagePreview = showPreview
                        )
                        when (val res = settingsRepository.updateGlobal(update)) {
                            is ApiResult.Ok -> {
                                settings = res.value.settings
                            }
                            is ApiResult.Err -> {
                                error = res.message
                            }
                        }
                    }
                }
            ) {
                Text("Save notification settings")
            }

            if (settings != null) {
                Text("Saved.")
            }
        }
    }
}

@Composable
private fun SwitchRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(label)
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

