package com.devotek.t3code.pwa

import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ConnectAuthPublicationRaceTest {
    private class Sdk(private val monitor: Any) : ConnectAuthSdk {
        override val states = MutableStateFlow(ConnectSdkState(true, ConnectAccount("user", "session")))
        var logoutWaiter: CompletableDeferred<Unit>? = null
        private fun outsideMonitor() = assertFalse("SDK work must not run under the authorization monitor", Thread.holdsLock(monitor))
        override fun current() = states.value // Supported in-memory identity read is allowed under the monitor.
        override fun initialize() { outsideMonitor() }
        override suspend fun signIn() { outsideMonitor() }
        override suspend fun handleCallback(uri: String): Boolean { outsideMonitor(); return false }
        override suspend fun relayToken(template: String, forceRefresh: Boolean): String { outsideMonitor(); return "fixture" }
        override suspend fun signOut() { outsideMonitor(); logoutWaiter?.await() }
        override fun reset() { outsideMonitor(); states.value = ConnectSdkState(true) }
    }
    private class Markers(private val monitor: Any) : ConnectAuthMarkers {
        override var pendingSignIn = false
        override var pendingSignOut = false
            set(value) { assertTrue("Logout markers and native transition must share admission monitor", Thread.holdsLock(monitor)); field = value }
    }
    private fun managed() = JSONObject().put("mode", "managed").put("registrationRevision", "current")
        .put("userId", "user").put("sessionId", "session")
    private fun direct() = JSONObject().put("httpBaseUrl", "http://tailnet.test/").put("token", "paired").put("registrationRevision", "direct")
    private fun transitionCannotOvertakeAdmittedWork(logout: Boolean, persistence: Boolean) {
        val monitor = NotificationCredentials::class.java // Same binding as ArcwrightApplication.
        val sdk = Sdk(monitor)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val auth = ConnectAuth(sdk, scope, Markers(monitor), "fixture", true, monitor)
        assertSame(monitor, auth.authorizationMonitor)
        val expected = managed(); val fence = auth.accountFence()
        val entered = CountDownLatch(1); val release = CountDownLatch(1); val transitionStarted = CountDownLatch(1)
        val events = Collections.synchronizedList(mutableListOf<String>())
        var receipt: String? = null
        fun admittedWork() {
            assertTrue(Thread.holdsLock(monitor)); entered.countDown(); assertTrue(release.await(5, TimeUnit.SECONDS))
            assertEquals("signedIn", auth.status.value.phase)
            assertEquals(fence.generation, auth.status.value.generation)
            events.add(if (persistence) "persist" else "post")
        }
        val guard = NotificationFrameState(monitor, { expected }, auth::isCurrent, { _, value -> admittedWork(); receipt = value }, auth::owns)
        val executor = Executors.newFixedThreadPool(2)
        try {
            val work = executor.submit<Boolean> {
                if (persistence) guard.persist("env", expected, fence, "current-receipt")
                else guard.publish("env", expected, fence) { admittedWork() }
            }
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            val transition = executor.submit {
                transitionStarted.countDown()
                if (logout) runBlocking { auth.signOut().await() }
                else sdk.states.value = ConnectSdkState(true, ConnectAccount("other", "other-session"))
                events.add("transition")
            }
            assertTrue(transitionStarted.await(5, TimeUnit.SECONDS))
            // A completed auth transition cannot be published while admitted work holds its monitor.
            assertEquals(fence.generation, auth.status.value.generation)
            release.countDown(); assertTrue(work.get(5, TimeUnit.SECONDS)); transition.get(5, TimeUnit.SECONDS)
            assertEquals(listOf(if (persistence) "persist" else "post", "transition"), events)
            assertTrue(auth.status.value.generation > fence.generation)
            assertEquals(if (logout) "signedOut" else "signedIn", auth.status.value.phase)
            assertFalse(guard.publish("env", expected, fence) { throw AssertionError("Late account-fenced publication") })
            assertFalse(guard.persist("env", expected, fence, "late-receipt"))
            assertEquals(if (persistence) "current-receipt" else null, receipt)
        } finally { release.countDown(); executor.shutdownNow(); scope.cancel() }
    }
    @Test fun realNativeLogoutCannotOvertakeAnAdmittedPost() = transitionCannotOvertakeAdmittedWork(true, false)
    @Test fun realSdkAccountObservationCannotOvertakeAnAdmittedPost() = transitionCannotOvertakeAdmittedWork(false, false)
    @Test fun realNativeLogoutCannotOvertakeWatermarkPersistence() = transitionCannotOvertakeAdmittedWork(true, true)
    @Test fun realSdkAccountObservationCannotOvertakeWatermarkPersistence() = transitionCannotOvertakeAdmittedWork(false, true)

    @Test fun suspendedSdkLogoutDoesNotHoldMonitorOrInvalidateIndependentDirectPairing() {
        val monitor = NotificationCredentials::class.java
        val sdk = Sdk(monitor).apply { logoutWaiter = CompletableDeferred() }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val auth = ConnectAuth(sdk, scope, Markers(monitor), "fixture", true, monitor)
        val fence = auth.accountFence(); val selected = direct()
        var receipt: String? = null; var posts = 0
        val guard = NotificationFrameState(monitor, { selected }, { throw AssertionError("Direct pairing cannot consult Clerk") }, { _, value -> receipt = value })
        try {
            assertEquals("fixture", runBlocking { auth.getRelayToken() })
            val logout = auth.signOut()
            assertFalse(logout.isCompleted); assertEquals("signedOut", auth.status.value.phase)
            assertFalse(auth.isCurrent(fence)); assertFalse(auth.owns(fence))
            assertTrue(guard.persist("env", selected, null, "direct-receipt"))
            assertTrue(guard.publish("env", selected, null) { posts++ })
            assertEquals("direct-receipt", receipt); assertEquals(1, posts)
            sdk.logoutWaiter!!.complete(Unit); runBlocking { logout.await() }
            assertTrue(guard.publish("env", selected, null) { posts++ }); assertEquals(2, posts)
        } finally { sdk.logoutWaiter!!.complete(Unit); scope.cancel() }
    }
}
