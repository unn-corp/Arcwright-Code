package com.devotek.t3code.pwa

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NotificationRegistrationWatermarkTest {
    private fun direct(url: String = "http://tailnet.test/", token: String = "paired") =
        NotificationRegistrationPolicy.directReference(null, false, url, token)
    private fun managed(revision: String) = JSONObject().put("mode", "managed").put("registrationRevision", revision)
        .put("userId", "user").put("sessionId", "session")
    private fun snapshot(title: String): JSONObject {
        fun thread(id: String, status: String) = JSONObject().put("id", id).put("title", title)
            .put("latestRunId", "run").put("status", status).put("activityRunStatus", JSONObject.NULL)
            .put("latestRunCompletedAt", "2026-10-07T00:00:00Z").put("archivedAt", JSONObject.NULL)
            .put("deletedAt", JSONObject.NULL).put("hasActionableProposedPlan", false)
        return JSONObject().put("kind", "snapshot").put("snapshot", JSONObject().put("threads", JSONArray()
            .put(thread("approval", "waiting").put("pendingRuntimeRequest", JSONObject().put("id", "same-request").put("kind", "command_approval")))
            .put(thread("historical-completion", "completed"))))
    }
    private class Fixture(initial: JSONObject) {
        val lock = Any()
        var selected: JSONObject? = initial
        var saved: String? = null
        val fence = ConnectAuthStatus(true, "signedIn", 7, "user", "session")
        val queue = PhoneAlertQueue()
        val presence = NetworkNotificationPresence().apply { configure(setOf("env"), 0) }
        var owner = queue.connection("env")
        var state = ThreadAlertState("{}")
        val posted = mutableListOf<String>()
        val guard = NotificationFrameState(lock, { selected }, { it == fence }, { _, value ->
            assertTrue(Thread.holdsLock(lock)); saved = value
        })
        fun consume(snapshot: JSONObject, now: Long): Int {
            val config = selected!!
            owner.reconcile(snapshot)
            val alerts = state.consume(snapshot)
            for (index in 0 until alerts.length()) {
                val alert = alerts.getJSONObject(index)
                owner.offer(alert.getJSONObject("thread"), alert.getString("kind"), now)
            }
            assertTrue(guard.persist("env", config, if (config.optString("mode") == "managed") fence else null, state.save()))
            return alerts.length()
        }
        fun flush(now: Long) {
            val alerts = queue.take(now, presence.suppressed(now), presence.ready(now))
            for (index in 0 until alerts.length()) {
                val config = selected!!
                val alert = alerts.getJSONObject(index)
                assertEquals("input_required", alert.getString("kind"))
                assertTrue(guard.publish("env", config, if (config.optString("mode") == "managed") fence else null) {
                    posted.add(alert.getJSONObject("thread").getString("title"))
                })
            }
        }
        fun select(next: JSONObject?) {
            synchronized(lock) {
                NotificationRegistrationPolicy.reprime(selected, next) {
                    assertTrue(Thread.holdsLock(lock)); saved = null
                }
                selected = next
            }
            owner.close()
            owner = queue.connection("env")
            state = ThreadAlertState(saved ?: "{}")
        }
    }
    private fun approvalSurvivesReplacement(initial: JSONObject, replacement: JSONObject) {
        val fixture = Fixture(initial)
        assertEquals(1, fixture.consume(snapshot("old-connection"), 0))
        fixture.flush(1); assertTrue(fixture.posted.isEmpty()); assertNotNull(fixture.saved)
        fixture.select(replacement)
        assertNull(fixture.saved)
        fixture.flush(NetworkNotificationPresence.MAX_LEASE_MS)
        assertTrue(fixture.posted.isEmpty()) // Cleared queue never transfers old content.
        assertEquals(1, fixture.consume(snapshot("fresh-authoritative-selection"), 45_001))
        fixture.flush(45_002)
        assertEquals(listOf("fresh-authoritative-selection"), fixture.posted)
        assertEquals(0, fixture.consume(snapshot("duplicate"), 45_003))
        fixture.flush(45_004); assertEquals(1, fixture.posted.size)
    }
    @Test fun directTokenReplacementReprimesApprovalWithoutReplayingCompletedHistory() {
        val initial = direct()
        approvalSurvivesReplacement(initial, NotificationRegistrationPolicy.directReference(initial, false, initial.getString("httpBaseUrl"), "new-pairing"))
    }
    @Test fun directOriginReplacementReprimesApprovalWithoutTransferringOldAlert() {
        val initial = direct()
        approvalSurvivesReplacement(initial, NotificationRegistrationPolicy.directReference(initial, false, "http://new-tailnet.test/", initial.getString("token")))
    }
    @Test fun sameAccountManagedReregistrationReprimesApproval() = approvalSurvivesReplacement(managed("old"), managed("new"))
    @Test fun modeChangesReprimeTheFreshSelection() {
        approvalSurvivesReplacement(direct(), managed("managed"))
        approvalSurvivesReplacement(managed("managed"), direct())
    }
    @Test fun removalAndReenableCannotReuseDormantDirectWatermarks() {
        val fixture = Fixture(direct())
        assertEquals(1, fixture.consume(snapshot("before-removal"), 0))
        fixture.select(null); assertNull(fixture.saved)
        fixture.select(direct())
        assertEquals(1, fixture.consume(snapshot("reenabled"), 1))
        fixture.flush(NetworkNotificationPresence.MAX_LEASE_MS)
        assertEquals(listOf("reenabled"), fixture.posted)
    }
    @Test fun unchangedDirectRegistrationAndSocketRetryRetainReceiptAndPendingApproval() {
        val initial = direct(); val fixture = Fixture(initial)
        assertEquals(1, fixture.consume(snapshot("retained"), 0))
        val receipt = fixture.saved
        val unchanged = NotificationRegistrationPolicy.directReference(initial, false, initial.getString("httpBaseUrl"), initial.getString("token"))
        synchronized(fixture.lock) {
            NotificationRegistrationPolicy.reprime(initial, unchanged) { throw AssertionError("Unchanged selection must retain state") }
            fixture.selected = unchanged
        }
        // A socket retry retains the same Connection/queue owner and reloads its durable receipt.
        fixture.state = ThreadAlertState(fixture.saved)
        assertEquals(receipt, fixture.saved)
        assertEquals(0, fixture.consume(snapshot("reconnect"), 1))
        fixture.flush(NetworkNotificationPresence.MAX_LEASE_MS)
        assertEquals(listOf("retained"), fixture.posted)
    }
}
