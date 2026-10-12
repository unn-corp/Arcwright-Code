package com.devotek.t3code.pwa

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class NotificationReadinessRecoveryTest {
    private class Sdk : ConnectAuthSdk {
        override val states = MutableStateFlow(ConnectSdkState(true, ConnectAccount("user", "session")))
        override fun current() = states.value
        override fun initialize() {}
        override suspend fun signIn() {}
        override suspend fun handleCallback(uri: String) = false
        override suspend fun relayToken(template: String, forceRefresh: Boolean) = "native-jwt"
        override suspend fun signOut() {}
        override fun reset() { states.value = ConnectSdkState(true) }
    }
    private class Markers : ConnectAuthMarkers { override var pendingSignIn = false; override var pendingSignOut = false }
    private fun config(revision: String = "current") = JSONObject().put("mode", "managed").put("registrationRevision", revision)
        .put("userId", "user").put("sessionId", "session")
    private fun approval() = JSONObject().put("id", "approval").put("latestRunId", "run").put("status", "waiting")
        .put("activityRunStatus", JSONObject.NULL).put("archivedAt", JSONObject.NULL).put("deletedAt", JSONObject.NULL)
        .put("pendingRuntimeRequest", JSONObject().put("id", "request").put("kind", "command_approval"))
    private fun snapshot() = JSONObject().put("kind", "snapshot").put("snapshot", JSONObject().put("threads", JSONArray().put(approval())))
    private class Fixture(val auth: ConnectAuth, val expected: JSONObject) {
        val fence = auth.accountFence()
        val lock = Any()
        var selected: JSONObject? = expected
        var saved: String? = null
        val queue = PhoneAlertQueue()
        val owner = queue.connection("env")
        val presence = NetworkNotificationPresence().apply { configure(setOf("env"), 0) }
        val state = ThreadAlertState("{}")
        var posts = 0
        var retries = 0
        var discarded = 0
        val guard = NotificationFrameState(lock, { selected }, auth::isCurrent, { _, value -> saved = value }, auth::owns)
        fun consume(item: JSONObject, now: Long): Int {
            owner.reconcile(item)
            val alerts = state.consume(item)
            for (index in 0 until alerts.length()) {
                val alert = alerts.getJSONObject(index)
                owner.offer(alert.getJSONObject("thread"), alert.getString("kind"), now)
            }
            return alerts.length()
        }
        fun persist() = guard.persist("env", expected, fence, state.save())
        fun recover(authorized: Boolean = guard.current("env", expected, fence)) = NotificationConnectionRecovery.admit(
            authorized, guard.owned("env", expected, fence), { retries++ }, { discarded++; owner.close() },
        )
        fun flush(now: Long) = queue.flush(now, presence.suppressed(now), presence.ready(now)) { id, thread, kind ->
            assertEquals("approval", thread.getString("id")); assertEquals("input_required", kind)
            guard.publish(id, expected, fence) { posts++ }
        }
    }
    @Test fun rejectedPublicationRetainsSavedApprovalUntilSameSdkSessionRecovers() = runTest {
        val sdk = Sdk(); val auth = ConnectAuth(sdk, backgroundScope, Markers(), "configured", true); runCurrent()
        val fixture = Fixture(auth, config())
        assertEquals(1, fixture.consume(snapshot(), 0)); assertTrue(fixture.persist())
        fixture.flush(1); assertEquals(0, fixture.posts)
        sdk.states.value = ConnectSdkState(false); runCurrent()
        assertTrue(auth.owns(fixture.fence)); assertFalse(auth.isCurrent(fixture.fence))
        fixture.flush(45_000); fixture.flush(45_001); assertEquals(0, fixture.posts)
        assertNull(ThreadAlertState(fixture.saved).update(approval()))
        sdk.states.value = ConnectSdkState(true, ConnectAccount("user", "session")); runCurrent()
        assertEquals(fixture.fence.generation, auth.accountFence().generation)
        fixture.flush(45_002); fixture.flush(45_003); assertEquals(1, fixture.posts)
        assertEquals(0, fixture.consume(snapshot(), 45_004)); assertTrue(fixture.persist())
        fixture.flush(45_005); assertEquals(1, fixture.posts)
    }
    @Test fun unrelatedFrameFinalRejectionRetainsEarlierPendingApprovalAndParsedStateThroughRetry() = runTest {
        val sdk = Sdk(); val auth = ConnectAuth(sdk, backgroundScope, Markers(), "configured", true); runCurrent()
        val fixture = Fixture(auth, config())
        assertEquals(1, fixture.consume(snapshot(), 0)); assertTrue(fixture.persist())
        val priorReceipt = fixture.saved
        assertTrue(fixture.recover()) // Actual frame admission succeeds before SDK readiness changes.
        assertEquals(0, fixture.consume(JSONObject().put("kind", "thread.updated").put("thread", JSONObject()
            .put("id", "unrelated").put("latestRunId", "other-run").put("status", "running")
            .put("activityRunStatus", JSONObject.NULL).put("archivedAt", JSONObject.NULL).put("deletedAt", JSONObject.NULL)), 1))
        sdk.states.value = ConnectSdkState(false, error = true); runCurrent()
        assertFalse(fixture.persist()); assertEquals(priorReceipt, fixture.saved)
        assertFalse(fixture.recover(false)); assertEquals(1, fixture.retries); assertEquals(0, fixture.discarded)
        fixture.flush(45_000); assertEquals(0, fixture.posts)
        sdk.states.value = ConnectSdkState(true, ConnectAccount("user", "session")); runCurrent()
        assertTrue(fixture.recover()); assertEquals(0, fixture.consume(snapshot(), 45_001)); assertTrue(fixture.persist())
        fixture.flush(45_002); fixture.flush(45_003); assertEquals(1, fixture.posts)
    }
    @Test fun staleReplacementAndAccountSwitchCannotRecoverOrTransferRejectedWork() = runTest {
        for (accountSwitch in listOf(false, true)) {
            val sdk = Sdk(); val auth = ConnectAuth(sdk, backgroundScope, Markers(), "configured", true); runCurrent()
            val fixture = Fixture(auth, config())
            assertEquals(1, fixture.consume(snapshot(), 0)); assertTrue(fixture.persist())
            sdk.states.value = ConnectSdkState(false); runCurrent(); fixture.flush(45_000)
            if (accountSwitch) {
                sdk.states.value = ConnectSdkState(true, ConnectAccount("other", "other-session")); runCurrent()
            } else {
                synchronized(fixture.lock) {
                    NotificationRegistrationPolicy.reprime(fixture.selected, config("replacement")) { fixture.saved = null }
                    fixture.selected = config("replacement")
                }
                sdk.states.value = ConnectSdkState(true, ConnectAccount("user", "session")); runCurrent()
            }
            assertFalse(fixture.recover()); assertEquals(0, fixture.retries); assertEquals(1, fixture.discarded)
            fixture.flush(45_001); assertEquals(0, fixture.posts)
            assertFalse(fixture.persist())
        }
    }
    @Test fun transientFinalFrameRejectionDoesNotReprimeAnAlreadyDeliveredApproval() = runTest {
        val sdk = Sdk(); val auth = ConnectAuth(sdk, backgroundScope, Markers(), "configured", true); runCurrent()
        val fixture = Fixture(auth, config())
        assertEquals(1, fixture.consume(snapshot(), 0)); assertTrue(fixture.persist())
        fixture.flush(45_000); assertEquals(1, fixture.posts)
        sdk.states.value = ConnectSdkState(false); runCurrent()
        assertFalse(fixture.persist()); assertFalse(fixture.recover(false)); assertEquals(0, fixture.discarded)
        sdk.states.value = ConnectSdkState(true, ConnectAccount("user", "session")); runCurrent()
        assertTrue(fixture.recover()); assertEquals(0, fixture.consume(snapshot(), 45_001)); assertTrue(fixture.persist())
        fixture.flush(45_002); assertEquals(1, fixture.posts)
    }
    @Test fun rejectedAlertsKeepOriginalExpiryAndViewedSuppression() = runTest {
        for (viewed in listOf(false, true)) {
            val sdk = Sdk(); val auth = ConnectAuth(sdk, backgroundScope, Markers(), "configured", true); runCurrent()
            val fixture = Fixture(auth, config())
            assertEquals(1, fixture.consume(snapshot(), 0)); assertTrue(fixture.persist())
            sdk.states.value = ConnectSdkState(false); runCurrent(); fixture.flush(45_000); fixture.flush(119_999)
            if (viewed) fixture.queue.flush(119_999, true, true) { _, _, _ -> throw AssertionError("Visible alerts are consumed without publication") }
            sdk.states.value = ConnectSdkState(true, ConnectAccount("user", "session")); runCurrent()
            fixture.flush(if (viewed) 119_999 else 120_000); assertEquals(0, fixture.posts)
        }
    }
}
