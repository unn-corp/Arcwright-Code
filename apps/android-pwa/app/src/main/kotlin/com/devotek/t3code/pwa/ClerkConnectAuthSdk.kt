package com.devotek.t3code.pwa

import android.app.Application
import android.net.Uri
import android.graphics.BitmapFactory
import android.util.Base64
import com.clerk.api.Clerk
import com.clerk.api.network.serialization.ClerkResult
import com.clerk.api.session.GetTokenOptions
import com.clerk.api.session.Session
import com.clerk.api.user.reload
import com.clerk.api.user.setProfileImage
import com.clerk.api.user.deleteProfileImage
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Clerk 1.1.11 API artifact owns encrypted Android Keystore storage, PKCE and session renewal. */
class ClerkConnectAuthSdk(private val application: Application, private val key: String, scope: CoroutineScope) : ConnectAuthSdk {
    private val profileUpdates = Mutex()
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
        try { value(Clerk.auth.startHostedAuth()) }
        finally { PhoneOperations.shared().end("navigation", "connect-auth") }
    }
    override suspend fun handleCallback(uri: String): Boolean = Clerk.auth.handle(Uri.parse(uri))
    override suspend fun relayToken(template: String, forceRefresh: Boolean): String = value(Clerk.auth.getToken(GetTokenOptions(template = template, skipCache = forceRefresh)))
    override suspend fun participantProfile(account: ConnectAccount): ConnectParticipantProfile? {
        val session = Clerk.session ?: return null
        if (session.id != account.sessionId || session.status != Session.SessionStatus.ACTIVE) return null
        // Only the session's own user snapshot supplies metadata; userFlow can lag a session switch.
        val user = (Clerk.user?.takeIf { it.id == account.userId } ?: session.user?.takeIf { it.id == account.userId })?.let { value(it.reload()) }
        check(current().account == account) { "Account changed." }
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
        val photo = participantPhoto(user?.hasImage, user?.imageUrl, publicUser?.hasImage, publicUser?.imageUrl)
        return ConnectParticipantProfile(name, photo, accounts)
    }
    override suspend fun setParticipantPhoto(account: ConnectAccount, photo: String?): ConnectParticipantProfile = profileUpdates.withLock {
        check(current().account == account) { "Account changed." }
        val user = Clerk.user?.takeIf { it.id == account.userId }
            ?: Clerk.session?.user?.takeIf { it.id == account.userId }
            ?: error("Account is not ready.")
        PhoneOperations.shared().begin("navigation", "connect-profile-photo", PhoneOperations.UNTIL_ENDED)
        try {
            if (photo == null) value(user.deleteProfileImage())
            else {
                require(ConnectAuthProtocol.validPhoto(photo)) { "Invalid profile image." }
                val bytes = Base64.decode(photo.substringAfter(','), Base64.NO_WRAP)
                require(bytes.size in 12..12_288 && bytes.copyOfRange(0, 4).contentEquals("RIFF".toByteArray()) &&
                    bytes.copyOfRange(8, 12).contentEquals("WEBP".toByteArray())) { "Invalid profile image." }
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                require(bounds.outWidth in 1..96 && bounds.outHeight in 1..96 && bounds.outMimeType == "image/webp") { "Invalid profile image." }
                val file = File.createTempFile("account-photo-", ".webp", application.cacheDir)
                try {
                    file.writeBytes(bytes)
                    check(current().account == account) { "Account changed." }
                    value(user.setProfileImage(file))
                } finally { file.delete() }
            }
            check(current().account == account) { "Account changed." }
            requireNotNull(participantProfile(account)) { "Profile update was unavailable." }
        } finally { PhoneOperations.shared().end("navigation", "connect-profile-photo") }
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

internal fun participantPhoto(hasImage: Boolean?, image: String?, publicHasImage: Boolean?, publicImage: String?): String? =
    if (hasImage != null) { if (hasImage) profilePhoto(image) else null }
    else if (publicHasImage == true) profilePhoto(publicImage) else null
