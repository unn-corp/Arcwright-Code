package com.devotek.t3code.pwa

import java.io.IOException
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ConnectManagedAccountTest {
    private class Sdk : ConnectAuthSdk {
        override val states = MutableStateFlow(ConnectSdkState(false))
        var template: String? = null
        var force = false
        override fun current() = states.value
        override fun initialize() {}
        override suspend fun signIn() {}
        override suspend fun handleCallback(uri: String) = false
        override suspend fun relayToken(template: String, forceRefresh: Boolean): String { this.template = template; force = forceRefresh; return "sdk-relay-jwt" }
        override suspend fun signOut() {}
        override fun reset() { states.value = ConnectSdkState(true) }
    }
    private class Markers : ConnectAuthMarkers { override var pendingSignIn = false; override var pendingSignOut = false }
    @Test fun coldProcessWaitsForSdkThenRehydratesSameSessionWithFreshGenerationAndConfiguredTemplateWithoutWebView() = runTest {
        val sdk = Sdk(); val auth = ConnectAuth(sdk, backgroundScope, Markers(), "only-native-configured-template", true)
        val account = ConnectManagedAccount(auth, UnconfinedTestDispatcher(testScheduler))
        runCurrent(); assertThrows(IOException::class.java) { account.capture("user", "session") }
        val refs = JSONObject().put("env", JSONObject().put("userId", "user").put("sessionId", "session").put("generation", 999))
        assertTrue(NotificationRegistrationPolicy.reconcile(refs, auth.status.value).isEmpty())
        sdk.states.value = ConnectSdkState(true, ConnectAccount("user", "session")); runCurrent()
        val fence = account.capture("user", "session")
        assertEquals(1L, fence.generation); assertTrue(account.current(fence))
        val payload = JSONObject().put("environmentId", "env").put("userId", "user").put("sessionId", "session").put("generation", fence.generation).put("configurationId", "config").put("sequence", 1)
        assertEquals(setOf("mode", "userId", "sessionId"), NotificationRegistrationPolicy.managedReference(payload, auth).keys().asSequence().toSet())
        assertThrows(ManagedAuthRejected::class.java) { NotificationRegistrationPolicy.managedReference(JSONObject(payload.toString()).put("userId", "forged"), auth) }
        assertThrows(ManagedAuthRejected::class.java) { NotificationRegistrationPolicy.managedReference(JSONObject(payload.toString()).put("generation", 999), auth) }
        assertThrows(ManagedProtocolRejected::class.java) { NotificationRegistrationPolicy.managedReference(JSONObject(payload.toString()).put("httpBaseUrl", "https://attacker.test"), auth) }
        assertThrows(ManagedProtocolRejected::class.java) { NotificationRegistrationPolicy.managedReference(JSONObject(payload.toString()).put("template", "admin"), auth) }
        assertTrue(NotificationRegistrationPolicy.reconcile(refs, auth.status.value).isEmpty())
        assertEquals("sdk-relay-jwt", account.relayToken(true)); assertEquals("only-native-configured-template", sdk.template); assertTrue(sdk.force)
        sdk.states.value = ConnectSdkState(false, error = true); runCurrent()
        assertThrows(IOException::class.java) { account.validate(fence) }
        assertTrue(NotificationRegistrationPolicy.reconcile(refs, auth.status.value).isEmpty())
        sdk.states.value = ConnectSdkState(true, ConnectAccount("user", "session")); runCurrent(); account.validate(fence)
        sdk.states.value = ConnectSdkState(true, ConnectAccount("other", "other-session")); runCurrent()
        assertThrows(ManagedAuthRejected::class.java) { account.validate(fence) }
        assertThrows(ManagedAuthRejected::class.java) { account.capture("user", "session") }
        auth.signOut(); runCurrent()
        assertThrows(ManagedAuthRejected::class.java) { account.capture("other", "other-session") }
    }
}
