package com.devotek.t3code.pwa

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NotificationFrameStateTest {
    private val fence = ConnectAuthStatus(true, "signedIn", 7, "user", "session")
    private fun managed(revision: String) = JSONObject().put("mode", "managed").put("authority", "fixture-authority").put("userId", "user").put("sessionId", "session").put("registrationRevision", revision)
    private fun direct(revision: String? = "direct") = JSONObject().put("httpBaseUrl", "http://tailnet.test/").put("token", "direct-pairing").apply {
        if (revision != null) put("registrationRevision", revision)
    }
    private fun approval() = JSONObject().put("id", "thread").put("latestRunId", "run").put("status", "waiting")
        .put("activityRunStatus", JSONObject.NULL).put("archivedAt", JSONObject.NULL).put("deletedAt", JSONObject.NULL)
        .put("hasActionableProposedPlan", false).put("pendingRuntimeRequest", JSONObject().put("id", "approval").put("kind", "command_approval"))
    private class Store(initial: JSONObject) {
        val lock = Any()
        var selected: JSONObject? = initial
        var state: String? = null
        var account = ConnectAuthStatus(true, "signedIn", 7, "user", "session")
        var posts = 0
        var accountChecks = 0
        val guard = NotificationFrameState(lock,
            { assertTrue(Thread.holdsLock(lock)); selected },
            { captured -> accountChecks++; account.phase == "signedIn" && account.generation == captured.generation && account.userId == captured.userId && account.sessionId == captured.sessionId },
            { _, receipt -> assertTrue(Thread.holdsLock(lock)); state = receipt }, authority = { "fixture-authority" })
        fun publish(expected: JSONObject, fence: ConnectAuthStatus?) = guard.publish("env", expected, fence) {
            assertTrue(Thread.holdsLock(lock)); posts++
        }
    }
    private fun parsedReceipt(previous: String? = null): String {
        val frame = JSONObject().put("_tag", "Chunk").put("requestId", "1").put("values", JSONArray().put(JSONObject().put("kind", "thread.updated").put("thread", approval())))
        val decoded = JSONObject(frame.toString())
        val state = ThreadAlertState(previous ?: "{}")
        assertEquals("input_required", state.consume(decoded.getJSONArray("values").getJSONObject(0)).getJSONObject(0).getString("kind"))
        return state.save()
    }
    private fun afterAdmission(store: Store, expected: JSONObject, captured: ConnectAuthStatus?, mutation: () -> Unit) {
        val parsed = CountDownLatch(1); val resume = CountDownLatch(1)
        val executor = Executors.newSingleThreadExecutor()
        try {
            val frame = executor.submit<Pair<Boolean, Boolean>> {
                assertTrue(store.guard.current("env", expected, captured))
                val receipt = parsedReceipt()
                parsed.countDown(); assertTrue(resume.await(5, TimeUnit.SECONDS))
                store.guard.persist("env", expected, captured, receipt) to store.publish(expected, captured)
            }
            assertTrue(parsed.await(5, TimeUnit.SECONDS))
            synchronized(store.lock) { mutation() }
            resume.countDown()
            assertEquals(false to false, frame.get(5, TimeUnit.SECONDS))
            assertEquals(0, store.posts)
        } finally { resume.countDown(); executor.shutdownNow() }
    }
    @Test fun pausedManagedFrameCannotRecreateWatermarksAfterLogoutOrRemoval() {
        for (logout in listOf(true, false)) {
            val old = managed("old"); val store = Store(old)
            afterAdmission(store, old, fence) {
                if (logout) store.account = ConnectAuthStatus(true, "signedOut", 8)
                store.selected = null; store.state = null
            }
            assertNull(store.state)
            assertEquals("input_required", ThreadAlertState(store.state ?: "{}").update(approval()))
        }
    }
    @Test fun pausedManagedFrameCannotOverwriteReplacementWatermarksOrSuppressItsApproval() {
        val old = managed("old"); val store = Store(old)
        afterAdmission(store, old, fence) { store.selected = managed("new"); store.state = "{}" }
        assertEquals("{}", store.state)
        assertEquals("input_required", ThreadAlertState(store.state).update(approval()))
    }
    @Test fun pausedManagedFrameCannotPersistAcrossNativeGenerationChange() {
        val old = managed("same"); val store = Store(old)
        afterAdmission(store, old, fence) { store.account = store.account.copy(generation = 8); store.state = null }
        assertNull(store.state)
    }
    @Test fun pausedDirectFrameRejectsManagedSelectionAndLaterDirectRevisionWithoutConsultingClerk() {
        for (replacement in listOf(managed("managed"), direct("new-direct"))) {
            val old = direct(); val store = Store(old)
            afterAdmission(store, old, null) { store.selected = replacement; store.state = "replacement" }
            assertEquals("replacement", store.state); assertEquals(0, store.accountChecks)
        }
    }
    @Test fun validManagedFramePersistsAndPublishesWhileReconnectRetainsDeduplication() {
        val config = managed("current"); val store = Store(config); val receipt = parsedReceipt()
        assertTrue(store.guard.persist("env", config, fence, receipt)); assertTrue(store.publish(config, fence))
        assertEquals(receipt, store.state); assertEquals(1, store.posts)
        assertNull(ThreadAlertState(store.state).update(approval()))
    }
    @Test fun unchangedDirectAndLegacyCredentialsPersistAndPublishAcrossClerkLogout() {
        for (revision in listOf("direct", null)) {
            val config = direct(revision); val store = Store(config); val receipt = parsedReceipt()
            store.account = ConnectAuthStatus(true, "signedOut", 8)
            assertTrue(store.guard.current("env", config, null)); assertTrue(store.guard.persist("env", config, null, receipt))
            assertTrue(store.publish(config, null)); assertEquals(receipt, store.state); assertEquals(1, store.posts); assertEquals(0, store.accountChecks)
        }
    }
    @Test fun cleanupCannotInterleaveBetweenFinalCheckAndWatermarkWrite() {
        val lock = Any(); val writing = CountDownLatch(1); val release = CountDownLatch(1); val cleanupStarted = CountDownLatch(1)
        val expected = managed("current"); var selected: JSONObject? = expected; var saved: String? = null
        val guard = NotificationFrameState(lock, { assertTrue(Thread.holdsLock(lock)); selected }, { true }, { _, state ->
            assertTrue(Thread.holdsLock(lock)); writing.countDown(); assertTrue(release.await(5, TimeUnit.SECONDS)); saved = state
        }, authority = { "fixture-authority" })
        val executor = Executors.newFixedThreadPool(2)
        try {
            val receipt = parsedReceipt()
            val frame = executor.submit<Boolean> { guard.persist("env", expected, fence, receipt) }
            assertTrue(writing.await(5, TimeUnit.SECONDS))
            val cleanup = executor.submit { cleanupStarted.countDown(); synchronized(lock) { selected = null; saved = null } }
            assertTrue(cleanupStarted.await(5, TimeUnit.SECONDS)); release.countDown()
            assertTrue(frame.get(5, TimeUnit.SECONDS)); cleanup.get(5, TimeUnit.SECONDS)
            assertNull(saved); assertFalse(guard.persist("env", expected, fence, receipt)); assertNull(saved)
        } finally { release.countDown(); executor.shutdownNow() }
    }
    @Test fun actualPublicationIsSerializedWithSelectionReplacement() {
        val lock = Any(); val posting = CountDownLatch(1); val release = CountDownLatch(1); val replacementStarted = CountDownLatch(1)
        val old = direct(); var selected: JSONObject? = old; var posts = 0
        val guard = NotificationFrameState(lock, { assertTrue(Thread.holdsLock(lock)); selected }, { throw AssertionError("Direct publication must not consult Clerk") }, { _, _ -> }, authority = { "fixture-authority" })
        val executor = Executors.newFixedThreadPool(2)
        try {
            val publication = executor.submit<Boolean> { guard.publish("env", old, null) {
                assertTrue(Thread.holdsLock(lock)); posting.countDown(); assertTrue(release.await(5, TimeUnit.SECONDS)); posts++
            } }
            assertTrue(posting.await(5, TimeUnit.SECONDS))
            val replacement = executor.submit { replacementStarted.countDown(); synchronized(lock) { selected = managed("replacement") } }
            assertTrue(replacementStarted.await(5, TimeUnit.SECONDS)); release.countDown()
            assertTrue(publication.get(5, TimeUnit.SECONDS)); replacement.get(5, TimeUnit.SECONDS)
            assertFalse(guard.publish("env", old, null) { posts++ }); assertEquals(1, posts)
        } finally { release.countDown(); executor.shutdownNow() }
    }
    @Test fun directRegistrationProducerPreservesUnchangedRevisionAndRefreshesAfterModeChange() {
        val legacy = direct(null)
        val adopted = NotificationRegistrationPolicy.directReference(legacy, false, legacy.getString("httpBaseUrl"), legacy.getString("token"))
        assertEquals(legacy.getString("httpBaseUrl"), adopted.getString("httpBaseUrl")); assertEquals(legacy.getString("token"), adopted.getString("token"))
        assertFalse(adopted.getString("registrationRevision").isEmpty())
        val unchanged = NotificationRegistrationPolicy.directReference(adopted, false, adopted.getString("httpBaseUrl"), adopted.getString("token"))
        assertEquals(adopted.getString("registrationRevision"), unchanged.getString("registrationRevision"))
        val returned = NotificationRegistrationPolicy.directReference(unchanged, true, unchanged.getString("httpBaseUrl"), unchanged.getString("token"))
        assertNotEquals(unchanged.getString("registrationRevision"), returned.getString("registrationRevision"))
    }
}
