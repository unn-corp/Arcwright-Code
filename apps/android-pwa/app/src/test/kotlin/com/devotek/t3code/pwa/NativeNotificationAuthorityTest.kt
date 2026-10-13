package com.devotek.t3code.pwa

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class NativeNotificationAuthorityTest {
    private fun profile(relay: String = "https://relay.arcwright.space") = ConnectAuthority.parse("owned",
        "pk_live_Y2xlcmsuYXJjd3JpZ2h0LnNwYWNlJA", "t3-relay", relay, "a".repeat(64))!!
    private val old = profile().notificationStamp
    private val next = profile("https://next.arcwright.space").notificationStamp
    private val fence = ConnectAuthStatus(true, "signedIn", 7, "user", "session")
    private fun ref(stamp: String? = old) = JSONObject().put("mode", "managed").put("userId", "user")
        .put("sessionId", "session").put("registrationRevision", "revision").put("unknownData", JSONObject().put("preserve", true))
        .apply { if (stamp != null) put("authority", stamp) }

    @Test fun sameIssuerNewRelayAndUnknownReferencesRemainRawDormantThroughLaunchReconciliationAndLogout() {
        val refs = JSONObject().put("foreign", ref()).put("unknown", ref(null)).put("malformed", "opaque-old-data")
        val raw = refs.toString(); val direct = JSONObject().put("foreign", JSONObject().put("token", "paired"))
            .put("direct", JSONObject().put("token", "working"))
        val preferred = JSONObject().put("foreign", true).put("unknown", true); val savedPreferred = preferred.toString()
        for (status in listOf(fence, ConnectAuthStatus(true, "signedOut"), ConnectAuthStatus(false, "unavailable"))) {
            assertTrue(NotificationRegistrationPolicy.reconcile(refs, status, next).isEmpty())
            val selected = NotificationRegistrationPolicy.combine(direct, preferred, refs, next)
            assertFalse(selected.has("foreign")); assertFalse(selected.has("unknown"))
            assertEquals("working", selected.getJSONObject("direct").getString("token"))
            assertEquals(raw, refs.toString()); assertEquals(savedPreferred, preferred.toString())
            assertEquals("paired", direct.getJSONObject("foreign").getString("token"))
        }
    }
    @Test fun onlyStampedCurrentAuthorityCanActivateOrBeRemovedByAccountReconciliation() {
        val refs = JSONObject().put("current", ref(next)).put("foreign", ref()).put("unknown", ref(null))
        assertEquals(setOf("current"), NotificationRegistrationPolicy.combine(JSONObject(), JSONObject(), refs, next).keys().asSequence().toSet())
        assertTrue(NotificationRegistrationPolicy.reconcile(refs, fence, next).isEmpty())
        assertEquals(setOf("current"), NotificationRegistrationPolicy.reconcile(refs, ConnectAuthStatus(true, "signedOut"), next))
        assertTrue(refs.has("foreign")); assertTrue(refs.has("unknown"))
    }
    @Test fun dormantRowsAndMissingReferenceTombstonesSuppressDirectSelectionWithoutChangingRawChoices() {
        val refs = JSONObject().put("foreign", ref()).put("unknown", ref(null)).put("opaque", "old-data")
        val preferred = JSONObject("""{ "foreign":true, "unknown":false, "opaque":"old-choice", "missing":true }""")
        val direct = JSONObject().put("foreign", JSONObject().put("token", "dormant-pairing"))
            .put("missing", JSONObject().put("token", "logout-pairing"))
        val before = refs.toString(); val choices = preferred.toString()
        assertEquals(0, NotificationRegistrationPolicy.combine(direct, preferred, refs, next).length())
        assertEquals(before, refs.toString()); assertEquals(choices, preferred.toString())
        assertFalse(NotificationRegistrationPolicy.belongs(refs.getJSONObject("foreign"), next))
        assertTrue(NotificationRegistrationPolicy.preserveDormantPreference(refs, "unknown", next))
        assertTrue(NotificationRegistrationPolicy.preserveDormantPreference(refs, "opaque", next))
    }
    @Test fun foreignOrUnknownCachedFramesWatermarksAndQueuedPostsNeverConsultAccountOrPublish() {
        for (config in listOf(ref(), ref(null))) {
            var checks = 0; var writes = 0; var posts = 0
            val guard = NotificationFrameState(Any(), { config }, { checks++; true }, { _, _ -> writes++ }, authority = { next })
            assertFalse(guard.current("env", config, fence)); assertFalse(guard.owned("env", config, fence))
            assertFalse(guard.persist("env", config, fence, "cached-frame"))
            assertFalse(guard.publish("env", config, fence) { posts++ })
            val pending = Runnable { guard.publish("env", config, fence) { posts++ } }; pending.run()
            assertEquals(0, checks); assertEquals(0, writes); assertEquals(0, posts)
        }
    }
    @Test fun authorityReplacementDuringFrameAdmissionRejectsLateFrameAndReprimesSameRevision() {
        val original = ref(); var current = original; var authority = old; var writes = 0
        val guard = NotificationFrameState(Any(), { current }, { true }, { _, _ -> writes++ }, authority = { authority })
        assertTrue(guard.current("env", original, fence))
        authority = next; current = ref(next)
        assertFalse(guard.persist("env", original, fence, "old")); assertFalse(guard.publish("env", original, fence) { error("foreign post") })
        var cleared = false
        NotificationRegistrationPolicy.reprime(original, current) { cleared = true }
        assertTrue(cleared); assertEquals(0, writes)
        assertTrue(guard.persist("env", current, fence, "fresh")); assertEquals(1, writes)
    }
    @Test fun rejectedForeignAndUnknownReferencesCannotBeDeletedOrEvictDependentCaches() {
        for (config in listOf(ref(), ref(null))) {
            val refs = JSONObject().put("env", config); val raw = refs.toString(); var writes = 0; var evictions = 0
            val cleanup = ManagedRegistrationCleanup(Any(), { refs }, { writes++ }, { error("Foreign account check") }, { _, _, _ -> evictions++ }, { next })
            assertFalse(cleanup.reject("env", config, fence)); assertEquals(raw, refs.toString()); assertEquals(0, writes); assertEquals(0, evictions)
        }
    }
    @Test fun explicitNewRegistrationUsesActualNativeAccountFenceAndCurrentCompiledAuthority() = runTest {
        val sdk = object : ConnectAuthSdk {
            override val states = MutableStateFlow(ConnectSdkState(true, ConnectAccount("user", "session")))
            override fun current() = states.value
            override fun initialize() {}
            override suspend fun signIn() {}
            override suspend fun signOut() {}
            override fun reset() {}
            override suspend fun handleCallback(uri: String) = false
            override suspend fun relayToken(template: String, forceRefresh: Boolean) = "fixture"
        }
        val markers = object : ConnectAuthMarkers { override var pendingSignIn = false; override var pendingSignOut = false }
        val auth = ConnectAuth(sdk, backgroundScope, markers, "t3-relay", true); runCurrent()
        val payload = JSONObject().put("environmentId", "env").put("userId", "user").put("sessionId", "session")
            .put("generation", auth.status.value.generation).put("configurationId", "configuration").put("sequence", 1)
        val saved = NotificationRegistrationPolicy.managedReference(payload, auth, next)
        assertEquals(next, saved.getString("authority")); assertEquals("user", saved.getString("userId"))
        assertTrue(saved.getString("registrationRevision").isNotEmpty())
        assertThrows(ManagedProtocolRejected::class.java) { NotificationRegistrationPolicy.managedReference(JSONObject(payload.toString()).put("authority", old), auth, next) }
        assertThrows(ManagedAuthRejected::class.java) { NotificationRegistrationPolicy.managedReference(payload, auth, null) }
        assertThrows(ManagedAuthRejected::class.java) { NotificationRegistrationPolicy.managedReference(JSONObject(payload.toString()).put("generation", 999), auth, next) }
    }
}
