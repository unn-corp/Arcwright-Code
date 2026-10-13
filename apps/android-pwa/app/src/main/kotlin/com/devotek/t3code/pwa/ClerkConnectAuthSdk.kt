package com.devotek.t3code.pwa

import android.app.Application
import android.net.Uri
import com.clerk.api.Clerk
import com.clerk.api.network.serialization.ClerkResult
import com.clerk.api.session.GetTokenOptions
import com.clerk.api.session.Session
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.*

/** Clerk 1.1.11 API artifact owns encrypted Android Keystore storage, PKCE and session renewal. */
class ClerkConnectAuthSdk(private val application: Application, private val key: String, scope: CoroutineScope) : ConnectAuthSdk {
    override val states by lazy { combine(Clerk.isInitialized, Clerk.initializationError, Clerk.sessionFlow, Clerk.userFlow) { _, _, _, _ -> current() }
        .stateIn(scope, SharingStarted.Eagerly, current())
    }

    override fun current(): ConnectSdkState {
        if (!Clerk.isInitialized.value) return ConnectSdkState(false, error = Clerk.initializationError.value != null)
        val session = Clerk.session
        // Bind identity to this session snapshot; the separate user flow may still be transitioning.
        val userId = session?.user?.id ?: session?.publicUserData?.userId
        if (session != null && (session.status == Session.SessionStatus.PENDING || userId == null)) {
            return ConnectSdkState(false, error = true)
        }
        return ConnectSdkState(true, if (session?.status == Session.SessionStatus.ACTIVE && userId != null) ConnectAccount(userId, session.id) else null)
    }
    override fun initialize() { Clerk.initialize(application, key) }
    override suspend fun signIn() {
        // PKCE belongs to this process; a process-owned hold prevents an idle updater replacing a live login.
        PhoneOperations.shared().begin("navigation", "connect-auth", PhoneOperations.UNTIL_ENDED)
        try { value(Clerk.auth.startHostedAuth(redirectUrl = ConnectAuth.REDIRECT_URL)) }
        finally { PhoneOperations.shared().end("navigation", "connect-auth") }
    }
    override suspend fun handleCallback(uri: String): Boolean = Clerk.auth.handle(Uri.parse(uri))
    override suspend fun relayToken(template: String, forceRefresh: Boolean): String = value(Clerk.auth.getToken(GetTokenOptions(template = template, skipCache = forceRefresh)))
    override suspend fun participantProfile(account: ConnectAccount): ConnectParticipantProfile? {
        val session = Clerk.session ?: return null
        if (session.id != account.sessionId || session.status != Session.SessionStatus.ACTIVE) return null
        // Only the session's own user snapshot supplies metadata; userFlow can lag a session switch.
        val user = session.user?.takeIf { it.id == account.userId }
        val publicUser = session.publicUserData?.takeIf { it.userId == account.userId }
        if (user == null && publicUser == null) return null
        val accounts = user?.externalAccounts.orEmpty().take(20).map { external ->
            val label = external.username?.takeIf { it.isNotBlank() }
                ?: external.emailAddress.takeIf { it.isNotBlank() } ?: "Account"
            ConnectProfileAccount(
                id = external.id.take(256),
                label = "${external.provider}: $label".take(200),
                photo = profilePhoto(external.imageUrl),
            )
        }
        val name = listOfNotNull(user?.firstName ?: publicUser?.firstName, user?.lastName ?: publicUser?.lastName)
            .filter { it.isNotBlank() }.joinToString(" ").ifBlank { user?.username?.takeIf { it.isNotBlank() } ?: "You" }.take(100)
        val photo = if (user?.hasImage == true) profilePhoto(user.imageUrl)
            else if (publicUser?.hasImage == true) profilePhoto(publicUser.imageUrl) else null
        return ConnectParticipantProfile(name, photo ?: accounts.firstOrNull { it.photo != null }?.photo, accounts)
    }
    override suspend fun signOut() { value(Clerk.auth.signOut()) }
    override fun reset() { Clerk.reset() }
    // Do not pass SDK errors, URLs, credentials or raw callback contents to JavaScript/logs.
    private fun <T : Any, E : Any> value(result: ClerkResult<T, E>): T = when (result) {
        is ClerkResult.Success -> result.value
        is ClerkResult.Failure -> throw IllegalStateException("Account request failed. Check your network and try again.")
    }
}

/** SDK avatar URLs only; no arbitrary URI schemes or credential-bearing URLs leave native auth. */
internal fun profilePhoto(value: String?): String? = try {
    value?.takeIf { it.length <= 2048 }?.let { java.net.URI(it) }?.takeIf {
        it.scheme == "https" && !it.host.isNullOrBlank() && it.rawUserInfo == null
    }?.toString()
} catch (_: Exception) { null }
