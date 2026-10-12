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
        // Manual direct selection is explicit: it can unselect dormant managed data without deleting it.
        preferred.remove("foreign")
        assertEquals("paired", NotificationRegistrationPolicy.combine(direct, preferred, refs, next).getJSONObject("foreign").getString("token"))
        assertEquals(raw, refs.toString())
    }
    @Test fun onlyStampedCurrentAuthorityCanActivateOrBeRemovedByAccountReconciliation() {
        val refs = JSONObject().put("current", ref(next)).put("foreign", ref()).put("unknown", ref(null))
        assertEquals(setOf("current"), NotificationRegistrationPolicy.combine(JSONObject(), JSONObject(), refs, next).keys().asSequence().toSet())
        assertTrue(NotificationRegistrationPolicy.reconcile(refs, fence, next).isEmpty())
        assertEquals(setOf("current"), NotificationRegistrationPolicy.reconcile(refs, ConnectAuthStatus(true, "signedOut"), next))
        assertTrue(refs.has("foreign")); assertTrue(refs.has("unknown"))
    }
    @Test fun automaticConfigurePruningPreservesDormantRoutePreferencesIncludingOpaqueOldRows() {
        val refs = JSONObject().put("current", ref(next)).put("foreign", ref()).put("unknown", ref(null)).put("opaque", "old-data")
        val preferred = JSONObject().put("current", true).put("foreign", true).put("unknown", false).put("opaque", "old-choice")
        val direct = JSONObject().put("foreign", JSONObject().put("token", "dormant-pairing").put("httpBaseUrl", "https://direct.test/").put("registrationRevision", "old-direct"))
            .put("ordinary", JSONObject().put("token", "disabled-pairing"))
        val before = refs.toString()
        val removable = preferred.keys().asSequence().filter { !NotificationRegistrationPolicy.preserveDormantPreference(refs, it, next) }.toList()
        removable.forEach { preferred.remove(it) }
        val directRemoved = direct.keys().asSequence().filter { !NotificationRegistrationPolicy.preserveDormantPreference(refs, it, next) }.toList()
        directRemoved.forEach { direct.remove(it) }
        assertEquals(listOf("current"), removable)
        assertEquals(3, preferred.length()); assertTrue(preferred.getBoolean("foreign")); assertFalse(preferred.getBoolean("unknown"))
        assertEquals("old-choice", preferred.getString("opaque")); assertEquals(before, refs.toString())
        assertEquals("dormant-pairing", direct.getJSONObject("foreign").getString("token")); assertFalse(direct.has("ordinary"))
        assertFalse(NotificationRegistrationPolicy.preserveDormantPreference(refs, "missing", next))
        assertTrue(NotificationRegistrationPolicy.preserveDormantPreference(refs, "current", null))
        assertFalse(NotificationRegistrationPolicy.prefersManaged(preferred, refs, "foreign", next))
        assertFalse(NotificationRegistrationPolicy.prefersManaged(preferred, refs, "unknown", next))
        assertFalse(NotificationRegistrationPolicy.combine(direct, preferred, refs, next).has("foreign"))
        // A new direct registration is an intentional selection; mere configure above was not.
        val previous = direct.getJSONObject("foreign")
        val selected = NotificationRegistrationPolicy.directReference(previous, preferred.has("foreign"), previous.getString("httpBaseUrl"), previous.getString("token"))
        assertNotEquals("old-direct", selected.getString("registrationRevision"))
        direct.put("foreign", selected); preferred.remove("foreign")
        assertEquals("dormant-pairing", NotificationRegistrationPolicy.combine(direct, preferred, refs, next).getJSONObject("foreign").getString("token"))
        assertEquals(before, refs.toString())
        val currentPreferred = JSONObject().put("current", true)
        assertTrue(NotificationRegistrationPolicy.prefersManaged(currentPreferred, refs, "current", next))
        refs.remove("current") // Current-profile logout does not silently resurrect dormant direct data.
        assertTrue(NotificationRegistrationPolicy.prefersManaged(currentPreferred, refs, "current", next))
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
