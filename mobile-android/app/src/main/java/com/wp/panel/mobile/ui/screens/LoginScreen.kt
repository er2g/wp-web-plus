package com.wp.panel.mobile.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.wp.panel.mobile.data.TokenStore
import com.wp.panel.mobile.data.repo.ApiResult
import com.wp.panel.mobile.data.repo.AuthRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import androidx.compose.runtime.rememberCoroutineScope

@Composable
fun LoginScreen(
    authRepository: AuthRepository,
    tokenStore: TokenStore,
    onLoggedIn: () -> Unit
) {
    var username by remember { mutableStateOf("admin") }
    var password by remember { mutableStateOf("") }
    var baseUrl by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        baseUrl = tokenStore.getBaseUrl()
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(text = "WpPanel Mobile")
        Spacer(Modifier.height(24.dp))

        OutlinedTextField(
            value = baseUrl,
            onValueChange = { baseUrl = it },
            label = { Text("Server URL") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("http://10.0.2.2:3000/") }
        )
        Spacer(Modifier.height(12.dp))

        OutlinedTextField(
            value = username,
            onValueChange = { username = it },
            label = { Text("Username") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text("Password") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth()
        )
        Spacer(Modifier.height(16.dp))
        Button(
            enabled = !loading,
            onClick = {
                loading = true
                error = null
                scope.launch(Dispatchers.Main) {
                    tokenStore.setBaseUrl(baseUrl.trim())
                    when (val res = authRepository.login(username.trim(), password)) {
                        is ApiResult.Ok -> onLoggedIn()
                        is ApiResult.Err -> {
                            error = res.message
                            loading = false
                        }
                    }
                }
            }
        ) {
            Text(if (loading) "Signing in..." else "Login")
        }
        Spacer(Modifier.height(12.dp))
        if (error != null) {
            Text(text = error ?: "", modifier = Modifier.padding(8.dp))
        }
    }
}
