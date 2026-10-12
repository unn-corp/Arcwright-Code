package com.devotek.t3code.pwa

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ManagedRegistrationCleanupTest {
    private val fence = ConnectAuthStatus(true, "signedIn", 7, "user", "session")
    private fun ref(revision: String, user: String = "user", session: String = "session") = JSONObject()
        .put("mode", "managed").put("userId", user).put("sessionId", session).put("registrationRevision", revision)
    private class Store {
        val lock = Any()
        var refs = JSONObject()
        var direct = "independent-pairing"
        var state: String? = "old-state"
        var evictions = 0
        var writes = 0
        var account = ConnectAuthStatus(true, "signedIn", 7, "user", "session")
        val cleanup = ManagedRegistrationCleanup(lock,
            { assertTrue(Thread.holdsLock(lock)); JSONObject(refs.toString()) },
            { assertTrue(Thread.holdsLock(lock)); refs = JSONObject(it.toString()); writes++ },
            { captured -> account.generation == captured.generation && account.userId == captured.userId && account.sessionId == captured.sessionId && account.phase == "signedIn" },
            { _, _, _ -> assertTrue(Thread.holdsLock(lock)); state = null; evictions++ },
        )
    }
    private fun lateCleanup(store: Store, expected: JSONObject, newer: () -> Unit): Boolean {
        val ready = CountDownLatch(1); val rejected = CountDownLatch(1)
        val executor = Executors.newSingleThreadExecutor()
        try {
            val operation = executor.submit<Boolean> {
                // The operation captured its reference/fence before a blocked network response.
                ready.countDown(); assertTrue(rejected.await(5, TimeUnit.SECONDS))
                store.cleanup.reject("env", expected, fence)
            }
            assertTrue(ready.await(5, TimeUnit.SECONDS))
            synchronized(store.lock) { newer() }
            rejected.countDown()
            return operation.get(5, TimeUnit.SECONDS)
        } finally { rejected.countDown(); executor.shutdownNow() }
    }
    @Test fun newerAccountReferenceAndDependentStateSurviveOldRejection() {
        val store = Store(); val old = ref("old"); store.refs.put("env", old)
        assertFalse(lateCleanup(store, old) {
            store.account = ConnectAuthStatus(true, "signedIn", 8, "other", "other-session")
            store.refs.put("env", ref("new", "other", "other-session")); store.state = "new-state"
        })
        assertEquals("new", store.refs.getJSONObject("env").getString("registrationRevision"))
        assertEquals("new-state", store.state); assertEquals(0, store.evictions); assertEquals(0, store.writes)
    }
    @Test fun sameAccountManagedDirectManagedRevisionAndStateSurviveOldRejection() {
        val store = Store(); val old = ref("old"); store.refs.put("env", old)
        assertFalse(lateCleanup(store, old) {
            store.refs.remove("env") // Deliberate direct selection.
            store.direct = "new-direct-pairing"
            store.refs.put("env", ref("new")); store.state = "new-managed-state"
        })
        assertEquals("new", store.refs.getJSONObject("env").getString("registrationRevision"))
        assertEquals("new-managed-state", store.state); assertEquals("new-direct-pairing", store.direct)
        assertEquals(0, store.evictions); assertEquals(0, store.writes)
    }
    @Test fun newerDirectSelectionAndStateSurviveOldManagedRejection() {
        val store = Store(); val old = ref("old"); store.refs.put("env", old)
        assertFalse(lateCleanup(store, old) {
            store.refs.remove("env"); store.direct = "new-direct-pairing"; store.state = "direct-state"
        })
        assertFalse(store.refs.has("env")); assertEquals("new-direct-pairing", store.direct)
        assertEquals("direct-state", store.state); assertEquals(0, store.evictions); assertEquals(0, store.writes)
    }
    @Test fun unchangedRejectedRegistrationIsRemovedOnceWithoutTouchingDirectPairing() {
        val store = Store(); val old = ref("old"); store.refs.put("env", old)
        assertTrue(store.cleanup.reject("env", old, fence))
        assertFalse(store.refs.has("env")); assertNull(store.state); assertEquals(1, store.evictions)
        assertEquals("independent-pairing", store.direct)
        assertFalse(store.cleanup.reject("env", old, fence)); assertEquals(1, store.evictions)
    }
    @Test fun currentProcessGenerationMustMatchEvenWhenPersistedIdentityAndRevisionMatch() {
        val store = Store(); val old = ref("old"); store.refs.put("env", old)
        store.account = store.account.copy(generation = 8)
        assertFalse(store.cleanup.reject("env", old, fence))
        assertEquals("old-state", store.state); assertEquals(0, store.writes); assertEquals(0, store.evictions)
    }
    @Test fun registrationCannotInterleaveBetweenCleanupComparisonAndDependentRemoval() {
        val lock = Any(); val compared = CountDownLatch(1); val release = CountDownLatch(1); val writerStarted = CountDownLatch(1)
        var refs = JSONObject().put("env", ref("old")); var state: String? = "old-state"
        val cleanup = ManagedRegistrationCleanup(lock, {
            assertTrue(Thread.holdsLock(lock)); compared.countDown(); assertTrue(release.await(5, TimeUnit.SECONDS)); JSONObject(refs.toString())
        }, { assertTrue(Thread.holdsLock(lock)); refs = it }, { true }, { _, _, _ -> assertTrue(Thread.holdsLock(lock)); state = null })
        val executor = Executors.newFixedThreadPool(2)
        try {
            val rejected = executor.submit<Boolean> { cleanup.reject("env", ref("old"), fence) }
            assertTrue(compared.await(5, TimeUnit.SECONDS))
            val registration = executor.submit {
                writerStarted.countDown()
                synchronized(lock) { refs.put("env", ref("new")); state = "new-state" }
            }
            assertTrue(writerStarted.await(5, TimeUnit.SECONDS)); release.countDown()
            assertTrue(rejected.get(5, TimeUnit.SECONDS)); registration.get(5, TimeUnit.SECONDS)
            assertEquals("new", refs.getJSONObject("env").getString("registrationRevision")); assertEquals("new-state", state)
        } finally { release.countDown(); executor.shutdownNow() }
    }
}
