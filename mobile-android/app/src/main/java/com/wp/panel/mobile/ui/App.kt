package com.wp.panel.mobile.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.wp.panel.mobile.WpPanelApp
import com.wp.panel.mobile.ui.screens.ChatDetailScreen
import com.wp.panel.mobile.ui.screens.ChatListScreen
import com.wp.panel.mobile.ui.screens.LoginScreen
import com.wp.panel.mobile.ui.screens.SettingsScreen

@Composable
fun App() {
    val context = LocalContext.current
    val container = (context.applicationContext as WpPanelApp).container
    val navController = rememberNavController()

    val accessToken by container.tokenStore.accessTokenFlow.collectAsState(initial = null)
    val baseUrl by container.tokenStore.baseUrlFlow.collectAsState(initial = "")
    val isAuthed = !accessToken.isNullOrBlank()

    val start = if (isAuthed) Routes.Chats else Routes.Login

    NavHost(navController = navController, startDestination = start) {
        composable(Routes.Login) {
            LoginScreen(
                authRepository = container.authRepository,
                tokenStore = container.tokenStore,
                onLoggedIn = {
                    navController.navigate(Routes.Chats) {
                        popUpTo(Routes.Login) { inclusive = true }
                    }
                }
            )
        }
        composable(Routes.Chats) {
            ChatListScreen(
                chatRepository = container.chatRepository,
                baseUrl = baseUrl,
                tokenStore = container.tokenStore,
                onOpenChat = { chatId ->
                    navController.navigate("${Routes.ChatDetail}/$chatId")
                },
                onOpenSettings = {
                    navController.navigate(Routes.Settings)
                }
            )
        }
        composable("${Routes.ChatDetail}/{chatId}") { backStackEntry ->
            val chatId = backStackEntry.arguments?.getString("chatId") ?: return@composable
            ChatDetailScreen(
                chatId = chatId,
                chatRepository = container.chatRepository,
                tokenStore = container.tokenStore,
                baseUrl = baseUrl,
                onBack = { navController.popBackStack() }
            )
        }
        composable(Routes.Settings) {
            SettingsScreen(
                settingsRepository = container.settingsRepository,
                tokenStore = container.tokenStore,
                authRepository = container.authRepository,
                onBack = { navController.popBackStack() },
                onLoggedOut = {
                    navController.navigate(Routes.Login) {
                        popUpTo(0) { inclusive = true }
                    }
                }
            )
        }
    }
}

object Routes {
    const val Login = "login"
    const val Chats = "chats"
    const val ChatDetail = "chat"
    const val Settings = "settings"
}
