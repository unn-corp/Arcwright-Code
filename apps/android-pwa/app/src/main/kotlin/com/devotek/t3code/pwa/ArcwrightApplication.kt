package com.devotek.t3code.pwa

import android.app.Application
import com.clerk.api.Constants as PublicConstants
import kotlinx.coroutines.*

/** One SDK runtime per process, initialized before activities or background work. */
class ArcwrightApplication : Application() {
    val authScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    lateinit var connectAuth: ConnectAuth
        private set

    lateinit var managedNotifications: NativeManagedNotifications
        private set
    var connectAuthority: ConnectAuthority? = null
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
        connectAuthority = ConnectAuthority.parse(BuildConfig.CONNECT_MODE, BuildConfig.CLERK_PUBLISHABLE_KEY,
            BuildConfig.CLERK_JWT_TEMPLATE, BuildConfig.RELAY_URL, BuildConfig.CONNECT_PROFILE_DIGEST)
        val authorityPreferences = getSharedPreferences("connect_sdk_authority", MODE_PRIVATE)
        val receipt = object : ConnectAuthorityReceipt {
            override fun read(): String? = if (authorityPreferences.all.isEmpty()) null else authorityPreferences.getString("receipt", "") ?: ""
            override fun commit(receipt: String) = authorityPreferences.edit().putString("receipt", receipt).commit()
        }
        connectAuth = ConnectAuthStartup.create(BuildConfig.CONNECT_MODE, connectAuthority, receipt,
            // Inspect only emptiness, using the public SDK filename. Never decrypt or alter SDK data.
            { getSharedPreferences(PublicConstants.Storage.CLERK_PREFERENCES_FILE_NAME, MODE_PRIVATE).all.isEmpty() },
            { ClerkConnectAuthSdk(this, BuildConfig.CLERK_PUBLISHABLE_KEY, authScope) },
            authScope, markers, BuildConfig.CLERK_JWT_TEMPLATE)
        managedNotifications = NativeManagedNotifications(this)
    }
}
