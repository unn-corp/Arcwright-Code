package com.devotek.t3code.pwa

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class PhoneAlertQueueConnectionTest {
    private fun thread(id: String) = JSONObject().put("id", id).put("latestRunId", "run")
        .put("status", "completed").put("activityRunStatus", JSONObject.NULL)
        .put("latestRunCompletedAt", "2026-10-07T00:00:00Z")
        .put("archivedAt", JSONObject.NULL).put("deletedAt", JSONObject.NULL)
    private fun direct(revision: String) = JSONObject().put("registrationRevision", revision)
        .put("httpBaseUrl", "http://tailnet.test/").put("token", "paired")
    private fun managed() = JSONObject().put("mode", "managed").put("authority", "fixture-authority").put("registrationRevision", "managed")
        .put("userId", "user").put("sessionId", "session")

    private fun replacementDoesNotInheritOldDirectAlerts(replacement: JSONObject) {
        val queue = PhoneAlertQueue()
        val presence = NetworkNotificationPresence().apply { configure(setOf("env", "other"), 0) }
        val old = queue.connection("env")
        old.offer(thread("old-direct"), "agent_completed", 0)
        queue.connection("other").offer(thread("unrelated"), "agent_completed", 0)
        assertEquals(0, queue.take(1, presence.suppressed(1), presence.ready(1)).length())

        // Service sync closes the previous Connection before creating its replacement. The final
        // publication guard uses the current Connection, so queue cleanup must reject old work.
        old.close()
        val current = queue.connection("env")
        current.offer(thread("current"), "agent_completed", 2)
        old.offer(thread("late-old-direct"), "agent_completed", 3)
        old.close() // A repeated old close must not erase the new owner's pending work.
        val fence = ConnectAuthStatus(true, "signedIn", 7, "user", "session")
        var accountChecks = 0
        val guard = NotificationFrameState(Any(), { replacement }, { accountChecks++; it == fence }, { _, _ -> }, authority = { "fixture-authority" })
        val published = mutableListOf<String>()
        val readyAt = NetworkNotificationPresence.MAX_LEASE_MS
        val ready = queue.take(readyAt, presence.suppressed(readyAt), presence.ready(readyAt))
        for (index in 0 until ready.length()) {
            val alert = ready.getJSONObject(index)
            if (alert.getString("environmentId") == "env") {
                assertTrue(guard.publish("env", replacement, if (replacement.optString("mode") == "managed") fence else null) {
                    published.add(alert.getJSONObject("thread").getString("id"))
                })
            } else assertEquals("unrelated", alert.getJSONObject("thread").getString("id"))
        }
        assertEquals(2, ready.length())
        assertEquals(listOf("current"), published)
        assertEquals(if (replacement.optString("mode") == "managed") 1 else 0, accountChecks)
        assertEquals(0, queue.take(readyAt + 1, false, true).length())
    }
    @Test fun delayedDirectAlertsCannotMoveToManagedReplacement() = replacementDoesNotInheritOldDirectAlerts(managed())
    @Test fun delayedDirectAlertsCannotMoveToAnotherDirectRevision() = replacementDoesNotInheritOldDirectAlerts(direct("new"))

    @Test fun removedConnectionDiscardsPresenceDelayedAlerts() {
        val queue = PhoneAlertQueue()
        val presence = NetworkNotificationPresence().apply { configure(setOf("env"), 0) }
        val owner = queue.connection("env")
        owner.offer(thread("removed"), "agent_completed", 0)
        assertEquals(0, queue.take(1, presence.suppressed(1), presence.ready(1)).length())
        owner.close()
        assertEquals(0, queue.take(NetworkNotificationPresence.MAX_LEASE_MS, false, true).length())
    }

    @Test fun sameDirectConnectionRetainsAlertsThroughSocketRetryAndClerkLogout() {
        val queue = PhoneAlertQueue()
        val presence = NetworkNotificationPresence().apply { configure(setOf("env"), 0) }
        val owner = queue.connection("env")
        owner.offer(thread("before-retry"), "agent_completed", 0)
        assertEquals(0, queue.take(1, presence.suppressed(1), presence.ready(1)).length())
        // Socket cancellation/backoff retains the Connection and this queue owner, while Clerk
        // can be unavailable or signed out independently of the direct paired connection.
        owner.reconcile(JSONObject().put("kind", "thread.updated").put("thread", thread("before-retry")))
        val config = direct("unchanged")
        val guard = NotificationFrameState(Any(), { config }, { throw AssertionError("Direct alerts must not consult Clerk") }, { _, _ -> }, authority = { "fixture-authority" })
        var posts = 0
        val readyAt = NetworkNotificationPresence.MAX_LEASE_MS
        val ready = queue.take(readyAt, presence.suppressed(readyAt), presence.ready(readyAt))
        assertEquals(1, ready.length())
        assertTrue(guard.publish("env", config, null) { posts++ })
        assertEquals(1, posts)
        assertEquals("before-retry", ready.getJSONObject(0).getJSONObject("thread").getString("id"))
        assertEquals(0, queue.take(readyAt + 1, false, true).length())
    }
}
