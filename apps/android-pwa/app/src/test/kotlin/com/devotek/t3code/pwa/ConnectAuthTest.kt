package com.devotek.t3code.pwa

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ConnectAuthTest {
    private class Markers : ConnectAuthMarkers {
        override var pendingSignIn = false
        override var pendingSignOut = false
    }
    private class Sdk : ConnectAuthSdk {
        override val states = MutableStateFlow(ConnectSdkState(true))
        val login = CompletableDeferred<Unit>()
        var resets = 0
        var initialized = 0
        var callbacks = 0
        var signOutError = false
        var logoutWaiter: CompletableDeferred<Unit>? = null
        var token = CompletableDeferred<String>()
        var requestedTemplate: String? = null
        var forced = false
        var requiresInitializationBeforeReset = false
        override fun current() = states.value
        override fun initialize() { initialized++ }
        override suspend fun signIn() { login.await() }
        override suspend fun handleCallback(uri: String): Boolean {
            callbacks++
            if (!uri.contains("state=valid")) return true // SDK validates PKCE/state; forged callbacks keep its login pending.
            states.value = ConnectSdkState(true, ConnectAccount("user1", "session1"))
            login.complete(Unit)
            return true
        }
        override suspend fun relayToken(template: String, forceRefresh: Boolean): String {
            requestedTemplate = template; forced = forceRefresh; return token.await()
        }
        override suspend fun signOut() { logoutWaiter?.await(); if (signOutError) error("network") }
        override fun reset() { check(!requiresInitializationBeforeReset || initialized > 0); resets++; states.value = ConnectSdkState(true) }
    }

    @Test fun liveLoginAndWrongDuplicateCallbacks() = runTest {
        val sdk = Sdk(); val markers = Markers()
        val auth = ConnectAuth(sdk, backgroundScope, markers, "t3-relay-fixture", true)
        runCurrent(); auth.signIn(); runCurrent()
        assertTrue(markers.pendingSignIn)
        assertFalse(auth.handleCallback("https://evil.test/auth/callback?state=valid"))
        assertFalse(auth.handleCallback("com.devotek.t3code.pwa://auth/other?state=valid"))
        assertTrue(auth.handleCallback(ConnectAuth.REDIRECT_URL + "?state=wrong"))
        assertEquals("signingIn", auth.status.value.phase)
        assertTrue(auth.handleCallback(ConnectAuth.REDIRECT_URL + "?state=valid&code=fixture"))
        runCurrent(); assertEquals("signedIn", auth.status.value.phase)
        assertEquals("user1", auth.status.value.userId); assertFalse(markers.pendingSignIn)
        assertTrue(auth.handleCallback(ConnectAuth.REDIRECT_URL + "?state=valid&code=fixture"))
        assertEquals(2, sdk.callbacks)
    }
    @Test fun canceledLoginDoesNotRemoveAnEstablishedAccountAndCanRetry() = runTest {
        val sdk = Sdk(); val auth = ConnectAuth(sdk, backgroundScope, Markers(), "fixture", true)
        runCurrent(); auth.signIn(); runCurrent(); sdk.login.cancel(); runCurrent()
        assertEquals("signedOut", auth.status.value.phase); assertNotNull(auth.status.value.error)
        assertEquals(0, sdk.resets)
    }
    @Test fun processDeathConsumesStaleCallbackWithoutRecoveringPkceAndRestoresEstablishedSession() = runTest {
        val sdk = Sdk(); val markers = Markers().apply { pendingSignIn = true }
        val auth = ConnectAuth(sdk, backgroundScope, markers, "fixture", true)
        runCurrent(); assertNotNull(auth.status.value.error)
        assertTrue(auth.handleCallback(ConnectAuth.REDIRECT_URL + "?state=old&code=old"))
        assertEquals(0, sdk.callbacks); assertEquals(0, sdk.resets)
        sdk.states.value = ConnectSdkState(true, ConnectAccount("restored", "restored-session")); runCurrent()
        assertEquals("signedIn", auth.status.value.phase); assertEquals("restored", auth.status.value.userId)
    }
    @Test fun networkReadinessFailureKeepsAccountAndAuthoritativeRevocationClearsIt() = runTest {
        val sdk = Sdk().apply { states.value = ConnectSdkState(true, ConnectAccount("u", "s")) }
        val auth = ConnectAuth(sdk, backgroundScope, Markers(), "fixture", true)
        runCurrent(); val fence = auth.accountFence()
        sdk.states.value = ConnectSdkState(false, error = true); runCurrent()
        assertEquals("signedIn", auth.status.value.phase); assertEquals(fence.generation, auth.status.value.generation)
        sdk.states.value = ConnectSdkState(true); runCurrent()
        assertEquals("signedOut", auth.status.value.phase); assertFalse(auth.isCurrent(fence))
    }
    @Test fun renewalAndAccountSwitchFenceRejectsStaleToken() = runTest {
        val sdk = Sdk().apply { states.value = ConnectSdkState(true, ConnectAccount("u", "s")) }
        val auth = ConnectAuth(sdk, backgroundScope, Markers(), "only-configured-template", true)
        runCurrent(); val request = async { runCatching { auth.getRelayToken(true) } }; runCurrent()
        sdk.states.value = ConnectSdkState(true, ConnectAccount("u2", "s2")); runCurrent()
        sdk.token.complete("stale-secret"); assertTrue(request.await().isFailure)
        assertEquals("only-configured-template", sdk.requestedTemplate); assertTrue(sdk.forced)
    }
    @Test fun replacementSessionForSameUserInvalidatesOldFence() = runTest {
        val sdk = Sdk().apply { states.value = ConnectSdkState(true, ConnectAccount("u", "s1")) }
        val auth = ConnectAuth(sdk, backgroundScope, Markers(), "fixture", true)
        runCurrent(); val fence = auth.accountFence()
        sdk.states.value = ConnectSdkState(true, ConnectAccount("u", "s2")); runCurrent()
        assertFalse(auth.isCurrent(fence)); assertTrue(auth.status.value.generation > fence.generation)
    }
    @Test fun logoutClearsLocalSdkAfterRemoteFailureAndRejectsPendingRenewal() = runTest {
        val sdk = Sdk().apply { states.value = ConnectSdkState(true, ConnectAccount("u", "s")); signOutError = true }
        val markers = Markers(); val auth = ConnectAuth(sdk, backgroundScope, markers, "fixture", true)
        runCurrent(); val request = async { runCatching { auth.getRelayToken() } }; runCurrent()
        val fence = auth.accountFence(); val logout = auth.signOut()
        assertFalse(auth.isCurrent(fence)); assertNull(auth.status.value.userId); assertTrue(markers.pendingSignOut)
        runCurrent(); logout.await(); sdk.token.complete("late"); assertTrue(request.await().isFailure)
        assertEquals(1, sdk.resets); assertFalse(markers.pendingSignOut)
    }
    @Test fun hungRemoteLogoutIsBoundedAndStillClearsLocalSdk() = runTest {
        val sdk = Sdk().apply { states.value = ConnectSdkState(true, ConnectAccount("u", "s")); logoutWaiter = CompletableDeferred() }
        val markers = Markers(); val auth = ConnectAuth(sdk, backgroundScope, markers, "fixture", true)
        runCurrent(); val logout = auth.signOut(); runCurrent()
        advanceTimeBy(8_001); runCurrent(); logout.await()
        assertEquals(1, sdk.resets); assertNull(auth.status.value.userId); assertFalse(markers.pendingSignOut)
    }
    @Test fun logoutCancelsHostedLoginAndDeathDuringLogoutCannotRestoreIt() = runTest {
        val sdk = Sdk(); val markers = Markers(); val auth = ConnectAuth(sdk, backgroundScope, markers, "fixture", true)
        runCurrent(); auth.signIn(); runCurrent(); val logout = auth.signOut(); runCurrent(); logout.await()
        assertEquals("signedOut", auth.status.value.phase); assertEquals(1, sdk.resets)
        val sdk2 = Sdk().apply { requiresInitializationBeforeReset = true; states.value = ConnectSdkState(true, ConnectAccount("old", "old-session")) }
        val auth2 = ConnectAuth(sdk2, backgroundScope, Markers().apply { pendingSignOut = true }, "fixture", true)
        runCurrent(); assertNull(auth2.status.value.userId); assertEquals(1, sdk2.resets)
    }
    @Test fun absentConfigurationNeverInitializesSdk() = runTest {
        val sdk = Sdk(); val auth = ConnectAuth(sdk, backgroundScope, Markers(), "", false)
        runCurrent(); assertFalse(auth.status.value.available); assertEquals(0, sdk.initialized)
        assertEquals("unavailable", auth.status.value.phase)
    }
    @Test fun callbackBoundaryRejectsCredentialsPortsFragmentsEncodingAndOversizedUris() {
        for (uri in listOf("com.devotek.t3code.pwa://attacker@auth/callback", "com.devotek.t3code.pwa://auth:443/callback", "com.devotek.t3code.pwa://auth/callback#fragment", "com.devotek.t3code.pwa://auth/%63allback", "com.devotek.t3code.pwa://auth/callback/", ConnectAuth.REDIRECT_URL + "?" + "a".repeat(8192))) assertFalse(uri.take(80), ConnectAuth.acceptsCallback(uri))
    }
}
