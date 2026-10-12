package com.devotek.t3code.pwa

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.*
import okio.ByteString.Companion.encodeUtf8
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ConnectAuthorityTest {
    private val digest = "a".repeat(64)
    private fun authority(host: String = "clerk.arcwright.space", relay: String = "https://relay.arcwright.space", template: String = "t3-relay") =
        ConnectAuthority.parse("owned", "pk_live_" + "$host$".encodeUtf8().base64(), template, relay, digest)!!
    private class Receipt(var value: String? = null, val events: MutableList<String> = mutableListOf(), val succeeds: Boolean = true) : ConnectAuthorityReceipt {
        override fun read() = value
        override fun commit(receipt: String): Boolean { events.add("commit"); if (succeeds) value = receipt; return succeeds }
    }
    private class Markers : ConnectAuthMarkers { override var pendingSignIn = false; override var pendingSignOut = false }
    private class Sdk(val receipt: Receipt) : ConnectAuthSdk {
        private val state = MutableStateFlow(ConnectSdkState(true, ConnectAccount("user", "session")))
        val store = mutableMapOf("DEVICE_ID" to "same-device", "session" to "same-session")
        val events = receipt.events
        init { events.add("construct"); check(receipt.value != null) }
        override val states get() = state.also { events.add("observe") }
        override fun current() = state.value.also { events.add("current") }
        override fun initialize() { check(receipt.value != null); events.add("initialize") }
        override suspend fun signIn() { events.add("login"); state.value = ConnectSdkState(true, ConnectAccount("user", "next-session")) }
        override suspend fun handleCallback(uri: String) = true.also { events.add("callback") }
        override suspend fun relayToken(template: String, forceRefresh: Boolean) = "fixture".also { events.add("token") }
        override suspend fun signOut() { events.add("logout") }
        override fun reset() {
            check("initialize" in events) // Public pre-initialize reset is a no-op, not a migration mechanism.
            events.add("reset"); store.remove("session"); state.value = ConnectSdkState(true)
        }
    }
    @Test fun unknownNonemptyAndKnownForeignReceiptsNeverConstructCallOrObserveSdkIncludingPendingLogout() = runTest {
        for (mode in listOf("owned", "legacy")) for (stored in listOf<String?>(null, authority("foreign.example").clerkReceipt, "invalid-receipt")) {
            val receipt = Receipt(stored); var inspected = 0; var constructed = 0
            val markers = Markers().apply { pendingSignIn = true; pendingSignOut = true }
            val auth = ConnectAuthStartup.create(mode, authority(), receipt, { inspected++; false }, { constructed++; Sdk(receipt) }, backgroundScope, markers, "t3-relay")
            runCurrent(); auth.initialize(); auth.signOut().await()
            assertTrue(auth.handleCallback(ConnectAuth.REDIRECT_URL + "?state=stale"))
            assertFalse(auth.isCurrent(auth.accountFence())); assertFalse(auth.owns(auth.accountFence()))
            assertTrue(runCatching { auth.signIn() }.isFailure)
            assertTrue(runCatching { auth.getRelayToken() }.isFailure)
            assertEquals(0, constructed); assertTrue(receipt.events.isEmpty()); assertEquals(stored, receipt.value)
            assertEquals(if (stored == null) 1 else 0, inspected)
            assertTrue(markers.pendingSignIn); assertTrue(markers.pendingSignOut)
            assertFalse(auth.status.value.available); assertEquals(ConnectAuthStartup.BLOCKED, auth.status.value.error)
        }
    }
    @Test fun cloudlessAndInvalidCompiledProfileNeverInspectOrTouchSdkOrReceipt() = runTest {
        for ((mode, profile) in listOf("cloudless" to authority(), "owned" to null)) {
            val receipt = object : ConnectAuthorityReceipt {
                override fun read(): String? = error("Must preserve receipt")
                override fun commit(receipt: String): Boolean = error("Must preserve receipt")
            }
            val auth = ConnectAuthStartup.create(mode, profile, receipt, { error("Must not inspect SDK") }, { error("Must not construct SDK") }, backgroundScope, Markers(), "template")
            runCurrent(); auth.initialize(); auth.signOut().await()
            assertFalse(auth.isCurrent(auth.accountFence())); assertFalse(auth.status.value.available)
        }
    }
    @Test fun freshEmptyReceiptMustCommitBeforeSdkConstructionAndInitialization() = runTest {
        val receipt = Receipt(); var sdk: Sdk? = null
        val auth = ConnectAuthStartup.create("owned", authority(), receipt, { true }, { Sdk(receipt).also { sdk = it } }, backgroundScope, Markers(), "t3-relay")
        runCurrent()
        assertEquals(authority().clerkReceipt, receipt.value)
        assertEquals(listOf("commit", "construct", "initialize"), receipt.events.take(3))
        assertEquals("signedIn", auth.status.value.phase); assertNotNull(sdk)
    }
    @Test fun checkedCommitFailureBlocksBeforeFactoryAndLeavesUnstampedState() = runTest {
        val receipt = Receipt(succeeds = false)
        val auth = ConnectAuthStartup.create("owned", authority(), receipt, { true }, { error("No durable receipt") }, backgroundScope, Markers(), "t3-relay")
        runCurrent(); assertFalse(auth.status.value.available); assertNull(receipt.value); assertEquals(listOf("commit"), receipt.events)
    }
    @Test fun coldAThenBBlocksAndSameARestoresWithoutRewritingReceiptOrInspectingStore() = runTest {
        val receipt = Receipt(authority().clerkReceipt)
        for (target in listOf(authority("foreign.example"), authority())) {
            var constructions = 0
            val auth = ConnectAuthStartup.create("owned", target, receipt, { error("Known receipt needs no inspection") }, { constructions++; Sdk(receipt) }, backgroundScope, Markers(), "t3-relay")
            runCurrent(); assertEquals(if (target == authority()) 1 else 0, constructions)
            assertEquals(target == authority(), auth.status.value.available)
        }
        assertEquals(authority().clerkReceipt, receipt.value); assertFalse("commit" in receipt.events)
    }
    @Test fun sameProfileLoginLogoutResetReinitializeStayBoundAndRetainSdkDeviceId() = runTest {
        val receipt = Receipt(authority().clerkReceipt); val sdk = Sdk(receipt)
        val auth = ConnectAuthStartup.create("owned", authority(), receipt, { error("Known receipt") }, { sdk }, backgroundScope, Markers(), "t3-relay")
        runCurrent(); auth.signOut().await(); runCurrent()
        assertEquals("same-device", sdk.store["DEVICE_ID"]); assertFalse(sdk.store.containsKey("session"))
        auth.signIn(); runCurrent(); assertEquals("next-session", auth.status.value.sessionId)
        assertEquals(authority().clerkReceipt, receipt.value); assertFalse("commit" in receipt.events)
        assertTrue("logout" in sdk.events && "reset" in sdk.events && "login" in sdk.events)
    }
    @Test fun sameProfilePendingLogoutResetsBeforeAdapterObservation() = runTest {
        val receipt = Receipt(authority().clerkReceipt); val sdk = Sdk(receipt)
        val markers = Markers().apply { pendingSignOut = true }
        val auth = ConnectAuthStartup.create("owned", authority(), receipt, { error("Known receipt") }, { sdk }, backgroundScope, markers, "t3-relay")
        runCurrent(); assertNull(auth.status.value.userId); assertFalse(markers.pendingSignOut)
        assertTrue(sdk.events.indexOf("initialize") < sdk.events.indexOf("reset"))
        assertTrue(sdk.events.indexOf("reset") < sdk.events.indexOf("observe")); assertEquals("same-device", sdk.store["DEVICE_ID"])
    }
    @Test fun stableProductionIssuerAndNormalizedRelayDoNotUseBuildDigestAsSessionAuthority() {
        val key = "pk_live_Y2xlcmsuYXJjd3JpZ2h0LnNwYWNlJA"
        val first = ConnectAuthority.parse("owned", key, "t3-relay", "https://relay.arcwright.space", digest)!!
        assertEquals("clerk-v1\n$key\nhttps://clerk.arcwright.space", first.clerkReceipt)
        assertEquals(first, ConnectAuthority.parse("owned", key, "t3-relay", "HTTPS://RELAY.arcwright.space:443///", "b".repeat(64)))
        val next = ConnectAuthority.parse("owned", key, "t3-relay", "https://next.arcwright.space", digest)!!
        assertEquals(first.clerkReceipt, next.clerkReceipt); assertNotEquals(first.notificationStamp, next.notificationStamp)
        assertNotEquals(first.notificationStamp, ConnectAuthority.parse("owned", key, "other-template", "https://relay.arcwright.space", digest)!!.notificationStamp)
        for ((badKey, badTemplate, badRelay, badDigest) in listOf(
            listOf("pk_live_invalid", "t3-relay", "https://relay.example", digest),
            listOf(key, "", "https://relay.example", digest),
            listOf(key, "t3-relay", "http://relay.example", digest),
            listOf(key, "t3-relay", "https://user@relay.example", digest),
            listOf(key, "t3-relay", "https://relay.example/path", digest),
            listOf(key, "t3-relay", "https://relay.example", "invalid"))) {
            assertNull(ConnectAuthority.parse("owned", badKey, badTemplate, badRelay, badDigest))
        }
    }
}
