package com.wp.panel.mobile

import android.app.Application
import com.wp.panel.mobile.data.AppContainer

class WpPanelApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}

