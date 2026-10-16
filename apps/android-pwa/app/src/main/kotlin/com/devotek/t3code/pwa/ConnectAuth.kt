package com.devotek.t3code.pwa

import java.net.URI
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*

/** No credentials in observable state. Generation binds every consumer to one account/session. */
data class ConnectAccount(val userId: String, val sessionId: String)
data class ConnectProfileAccount(val id: String, val label: String, val photo: String?)
data class ConnectParticipantProfile(val name: String, val photo: String?, val accounts: List<ConnectProfileAccount> = emptyList())
data class ConnectSdkState(val ready: Boolean, val account: ConnectAccount? = null, val error: Boolean = false)
data class ConnectAuthStatus(
    val available: Boolean,
    val phase: String,
    val generation: Long = 0,
    val userId: String? = null,
    val sessionId: String? = null,
    val error: String? = null,
)

/** Supported SDK calls only. Also usable by a future background consumer without a WebView. */
interface ConnectAuthSdk {
    val states: StateFlow<ConnectSdkState>
    fun current(): ConnectSdkState
    fun initialize()
    suspend fun signIn()
    suspend fun handleCallback(uri: String): Boolean
    suspend fun relayToken(template: String, forceRefresh: Boolean): String
    /** Public presentation only; older adapters may have no profile metadata. */
    suspend fun participantProfile(account: ConnectAccount): ConnectParticipantProfile? = null
    suspend fun setParticipantPhoto(account: ConnectAccount, photo: String?): ConnectParticipantProfile =
        throw UnsupportedOperationException("Profile updates are unavailable.")
    suspend fun signOut()
    fun reset()
}
interface ConnectAuthMarkers {
    var pendingSignIn: Boolean
    var pendingSignOut: Boolean
}

/** Main-scope state transitions share the native publication monitor. SDK work runs outside it. */
class ConnectAuth(
    private val sdk: ConnectAuthSdk?,
    private val scope: CoroutineScope,
    private val markers: ConnectAuthMarkers,
    private val template: String,
    configured: Boolean,
    val authorizationMonitor: Any = NotificationCredentials::class.java,
    unavailableReason: String? = null,
) {
    companion object {
        // New flows use Clerk's manifest-registered callback so its browser manager owns completion.
        // Retain strict acceptance of the old endpoint for already-issued callbacks.
        const val REDIRECT_URL = "com.devotek.t3code.pwa://auth/callback"
        fun acceptsCallback(raw: String?): Boolean = try {
            if (raw == null || raw.length > 8192) false else URI(raw).let {
                it.scheme == "com.devotek.t3code.pwa" && it.host == "auth" &&
                    it.rawPath == "/callback" && it.port == -1 && it.rawUserInfo == null && it.rawFragment == null
            }
        } catch (_: Exception) { false }
    }

    private val mutableStatus = MutableStateFlow(ConnectAuthStatus(configured, if (configured) "initializing" else "unavailable", error = unavailableReason))
    val status: StateFlow<ConnectAuthStatus> = mutableStatus.asStateFlow()
    private var login: Job? = null
    private var logout: Deferred<Unit>? = null
    private val callbacks = mutableSetOf<String>()
    private var loggingOut = false
    private var attemptId = 0L

    init {
        if (configured) {
            requireNotNull(sdk)
            if (markers.pendingSignOut) {
                // First initialize SDK storage synchronously; reset before first initialize cannot clear persisted state.
                // No adapter observer is mounted until the recovered local account has been reset.
                try {
                    sdk.initialize()
                    sdk.reset()
                    markers.pendingSignOut = false
                } catch (_: Exception) {
                    // Keep the recovery marker and suppress cached SDK state if public configuration is invalid.
                    synchronized(authorizationMonitor) {
                        loggingOut = true
                        mutableStatus.value = mutableStatus.value.copy(phase = "signedOut", error = "Local account cleanup could not finish. Update the app configuration and retry.")
                    }
                }
            }
            if (markers.pendingSignIn) {
                markers.pendingSignIn = false
                synchronized(authorizationMonitor) { mutableStatus.value = mutableStatus.value.copy(error = "Sign-in was interrupted. Please try again.") }
            }
            scope.launch { sdk.states.collect { observe(it) } }
            initialize()
        }
    }

    fun initialize() {
        if (!synchronized(authorizationMonitor) { status.value.available && !loggingOut }) return
        try { sdk!!.initialize() }
        catch (_: Exception) { synchronized(authorizationMonitor) { mutableStatus.value = status.value.copy(phase = "error", error = "Could not start account sign-in. Please try again.") } }
    }

    private fun observe(next: ConnectSdkState) {
        synchronized(authorizationMonitor) {
            if (loggingOut) return
            val current = status.value
            if (!next.ready) {
                // Readiness/network errors do not establish a signed-out account transition.
                mutableStatus.value = current.copy(
                    phase = if (current.userId != null) "signedIn" else if (next.error) "error" else "initializing",
                    error = if (next.error) "Account connection failed. Check your network and try again." else current.error,
                )
                return
            }
            val account = next.account
            val changed = current.userId != account?.userId || current.sessionId != account?.sessionId
            mutableStatus.value = current.copy(
                phase = if (account != null) "signedIn" else if (login?.isActive == true) "signingIn" else "signedOut",
                generation = current.generation + if (changed) 1 else 0,
                userId = account?.userId, sessionId = account?.sessionId,
                error = if (account != null) null else current.error,
            )
        }
    }

    fun signIn() {
        val ready = synchronized(authorizationMonitor) {
            check(status.value.available) { "Arcwright Connect is not configured in this build." }
            check(!loggingOut) { "Sign-out is finishing. Please try again." }
            if (login?.isCompleted == false || status.value.userId != null) return
            sdk!!.current().ready
        }
        if (!ready) { initialize(); throw IllegalStateException("Account sign-in is not ready. Please try again.") }
        val pendingLogin = synchronized(authorizationMonitor) {
            check(!loggingOut) { "Sign-out is finishing. Please try again." }
            if (login?.isCompleted == false || status.value.userId != null) return
            val generation = status.value.generation
            val attempt = ++attemptId
            markers.pendingSignIn = true
            mutableStatus.value = status.value.copy(phase = "signingIn", error = null)
            scope.launch(start = CoroutineStart.LAZY) {
                try {
                    withTimeout(5 * 60 * 1000L) { sdk!!.signIn() }
                    synchronized(authorizationMonitor) {
                        if (attemptId == attempt && !loggingOut) observe(sdk!!.current())
                    }
                } catch (cancelled: CancellationException) {
                    synchronized(authorizationMonitor) {
                        if (attemptId == attempt && status.value.generation == generation && !loggingOut) {
                            mutableStatus.value = status.value.copy(phase = "signedOut", error = "Sign-in was canceled. Please try again.")
                        }
                    }
                    throw cancelled
                } catch (_: Exception) {
                    synchronized(authorizationMonitor) {
                        if (attemptId == attempt && status.value.generation == generation && !loggingOut) {
                            mutableStatus.value = status.value.copy(phase = "signedOut", error = "Sign-in did not finish. Please try again.")
                        }
                    }
                } finally {
                    synchronized(authorizationMonitor) {
                        if (attemptId == attempt) markers.pendingSignIn = false
                        if (attemptId == attempt && !loggingOut && status.value.phase == "signingIn") {
                            mutableStatus.value = status.value.copy(phase = "signedOut", error = "Sign-in did not finish. Please try again.")
                        }
                    }
                }
            }.also { login = it }
        }
        pendingLogin.start()
    }

    suspend fun handleCallback(raw: String): Boolean {
        if (!acceptsCallback(raw)) return false
        synchronized(authorizationMonitor) {
            // Consume stale native callbacks without reconstructing SDK PKCE.
            if (!status.value.available || loggingOut || login?.isActive != true) {
                if (status.value.userId == null && !loggingOut && status.value.available) {
                    mutableStatus.value = status.value.copy(error = "This sign-in expired or was interrupted. Please try again.")
                }
                return true
            }
            if (callbacks.size >= 8 || !callbacks.add(raw)) return true
        }
        try { sdk!!.handleCallback(raw) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) {
            synchronized(authorizationMonitor) { mutableStatus.value = status.value.copy(error = "Sign-in callback could not finish. Please try again.") }
        } finally { synchronized(authorizationMonitor) { callbacks.remove(raw) } }
        return true
    }

    /** The caller captures a fence before renewal; stale tokens never leave this process. */
    fun accountFence(): ConnectAuthStatus = synchronized(authorizationMonitor) { status.value }
    /** Ownership survives SDK network/readiness gaps; this never authorizes a request or post. */
    fun owns(fence: ConnectAuthStatus): Boolean = synchronized(authorizationMonitor) {
        val current = status.value
        !loggingOut && current.phase == "signedIn" && current.generation == fence.generation &&
            current.userId == fence.userId && current.sessionId == fence.sessionId
    }
    fun isCurrent(fence: ConnectAuthStatus): Boolean = synchronized(authorizationMonitor) {
        val current = status.value
        if (!current.available || loggingOut || current.phase != "signedIn") return@synchronized false
        val account = sdk!!.current().account
        !loggingOut && current.phase == "signedIn" && current.generation == fence.generation &&
            current.userId == fence.userId && current.sessionId == fence.sessionId &&
            account?.userId == fence.userId && account?.sessionId == fence.sessionId
    }
    suspend fun getRelayToken(forceRefresh: Boolean = false): String {
        val fence = accountFence()
        check(isCurrent(fence)) { "Account session is not ready." }
        return try {
            val token = sdk!!.relayToken(template, forceRefresh)
            check(isCurrent(fence)) { "Account changed while renewing its token." }
            token
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) {
            if (status.value.available) observe(sdk!!.current()) // SDK authoritative revocation may clear its session; network failure does not.
            throw error
        }
    }

    suspend fun getParticipantProfile(fence: ConnectAuthStatus): ConnectParticipantProfile? {
        check(isCurrent(fence)) { "Account session is not ready." }
        val profile = sdk!!.participantProfile(ConnectAccount(requireNotNull(fence.userId), requireNotNull(fence.sessionId)))
        check(isCurrent(fence)) { "Account changed while reading its profile." }
        return profile
    }

    suspend fun setProfilePhoto(fence: ConnectAuthStatus, photo: String?): ConnectParticipantProfile {
        check(isCurrent(fence)) { "Account session is not ready." }
        require(photo == null || ConnectAuthProtocol.validPhoto(photo)) { "Invalid profile image." }
        val profile = sdk!!.setParticipantPhoto(ConnectAccount(requireNotNull(fence.userId), requireNotNull(fence.sessionId)), photo)
        check(isCurrent(fence)) { "Account changed while updating its profile." }
        return profile
    }

    /** Local reset is mandatory even if remote sign-out hangs or fails. Direct pairing storage is untouched. */
    fun signOut(): Deferred<Unit> {
        val (previousLogin, pendingLogout) = synchronized(authorizationMonitor) {
            if (!status.value.available) return CompletableDeferred(Unit)
            logout?.takeIf { !it.isCompleted }?.let { return it }
            loggingOut = true
            markers.pendingSignOut = true
            markers.pendingSignIn = false
            attemptId++
            val previousLogin = login
            login = null
            callbacks.clear()
            mutableStatus.value = status.value.copy(phase = "signedOut", generation = status.value.generation + 1, userId = null, sessionId = null, error = null)
            val pendingLogout = scope.async(start = CoroutineStart.LAZY) {
                try { withTimeout(8_000) { previousLogin?.join(); sdk!!.signOut() } }
                catch (_: Exception) { /* Local logout still completes. */ }
                finally {
                    sdk!!.reset()
                    synchronized(authorizationMonitor) {
                        markers.pendingSignOut = false
                        loggingOut = false
                    }
                    initialize()
                }
            }.also { logout = it }
            previousLogin to pendingLogout
        }
        // Never run cancellation handlers or a suspending SDK operation under the publication lock.
        previousLogin?.cancel()
        pendingLogout.start()
        return pendingLogout
    }
}
