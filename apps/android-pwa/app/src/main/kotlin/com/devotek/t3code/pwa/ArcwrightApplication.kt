package com.devotek.t3code.pwa

import android.app.Application
import kotlinx.coroutines.*
import java.net.URI

/** One SDK runtime per process, initialized before activities or background work. */
class ArcwrightApplication : Application() {
    val authScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    lateinit var connectAuth: ConnectAuth
        private set

    lateinit var managedNotifications: NativeManagedNotifications
        private set

    override fun onCreate() {
        super.onCreate()
        val preferences = getSharedPreferences("connect_auth_navigation", MODE_PRIVATE)
        val markers = object : ConnectAuthMarkers {
            override var pendingSignIn: Boolean
                get() = preferences.getBoolean("pendingSignIn", false)
                set(value) { preferences.edit().putBoolean("pendingSignIn", value).commit() }
            override var pendingSignOut: Boolean
                get() = preferences.getBoolean("pendingSignOut", false)
                set(value) { preferences.edit().putBoolean("pendingSignOut", value).commit() }
        }
        val configured = BuildConfig.CLERK_PUBLISHABLE_KEY.isNotBlank() && BuildConfig.CLERK_JWT_TEMPLATE.isNotBlank() && secureRelay(BuildConfig.RELAY_URL)
        connectAuth = ConnectAuth(ClerkConnectAuthSdk(this, BuildConfig.CLERK_PUBLISHABLE_KEY, authScope), authScope, markers, BuildConfig.CLERK_JWT_TEMPLATE, configured, NotificationCredentials::class.java)
        managedNotifications = NativeManagedNotifications(this)
    }

    private fun secureRelay(raw: String): Boolean = try {
        URI(raw).let { it.scheme.equals("https", ignoreCase = true) && it.host != null && it.userInfo == null &&
            it.query.isNullOrEmpty() && it.fragment.isNullOrEmpty() && (it.path.isNullOrEmpty() || it.path.matches(Regex("/+"))) }
    } catch (_: Exception) { false }
}
