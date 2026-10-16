package com.devotek.t3code.pwa

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ConnectParticipantProfileTest {
    @Test fun explicitImageRemovalDoesNotRestoreAnOlderSessionPublicAvatar() {
        assertNull(participantPhoto(false, "https://example.test/default.png", true, "https://example.test/old.png"))
        assertEquals("https://example.test/current.png", participantPhoto(true, "https://example.test/current.png", true, "https://example.test/old.png"))
        assertEquals("https://example.test/old.png", participantPhoto(null, null, true, "https://example.test/old.png"))
    }
    private class Markers : ConnectAuthMarkers {
        override var pendingSignIn = false
        override var pendingSignOut = false
    }
    private class Sdk : ConnectAuthSdk {
        override val states = MutableStateFlow(ConnectSdkState(true, ConnectAccount("alice", "session-a")))
        val profile = CompletableDeferred<ConnectParticipantProfile?>()
        var readAccount: ConnectAccount? = null
        var updatedAccount: ConnectAccount? = null
        override fun current() = states.value
        override fun initialize() {}
        override suspend fun signIn() {}
        override suspend fun handleCallback(uri: String) = true
        override suspend fun relayToken(template: String, forceRefresh: Boolean) = "unused"
        override suspend fun participantProfile(account: ConnectAccount): ConnectParticipantProfile? {
            readAccount = account
            return profile.await()
        }
        override suspend fun setParticipantPhoto(account: ConnectAccount, photo: String?): ConnectParticipantProfile {
            updatedAccount = account
            return requireNotNull(profile.await())
        }
        override suspend fun signOut() {}
        override fun reset() { states.value = ConnectSdkState(true) }
    }
    @Test fun publicProfileReadIsBoundToTheCapturedNativeSession() = runTest {
        val sdk = Sdk(); val auth = ConnectAuth(sdk, backgroundScope, Markers(), "fixture", true)
        runCurrent(); val fence = auth.accountFence()
        val result = async { auth.getParticipantProfile(fence) }; runCurrent()
        assertEquals(ConnectAccount("alice", "session-a"), sdk.readAccount)
        val profile = ConnectParticipantProfile("Alice", "https://example.test/alice.png", listOf(ConnectProfileAccount("google", "google: Alice", null)))
        sdk.profile.complete(profile)
        assertEquals(profile, result.await())
    }
    @Test fun photoMutationIsBoundToTheCapturedSessionAndCannotPublishAfterReplacement() = runTest {
        val sdk = Sdk(); val auth = ConnectAuth(sdk, backgroundScope, Markers(), "fixture", true)
        runCurrent(); val fence = auth.accountFence()
        val result = async { runCatching { auth.setProfilePhoto(fence, null) } }; runCurrent()
        assertEquals(ConnectAccount("alice", "session-a"), sdk.updatedAccount)
        sdk.states.value = ConnectSdkState(true, ConnectAccount("bob", "session-b")); runCurrent()
        sdk.profile.complete(ConnectParticipantProfile("Alice", null))
        assertTrue(result.await().isFailure)
        sdk.updatedAccount = null
        assertTrue(runCatching { auth.setProfilePhoto(fence, null) }.isFailure)
        assertNull(sdk.updatedAccount)
    }
    @Test fun replacementAndReturnToTheSameAccountRejectAnOldProfileRead() = runTest {
        val sdk = Sdk(); val auth = ConnectAuth(sdk, backgroundScope, Markers(), "fixture", true)
        runCurrent(); val fence = auth.accountFence()
        val result = async { runCatching { auth.getParticipantProfile(fence) } }; runCurrent()
        sdk.states.value = ConnectSdkState(true, ConnectAccount("bob", "session-b")); runCurrent()
        sdk.states.value = ConnectSdkState(true, ConnectAccount("alice", "session-a")); runCurrent()
        sdk.profile.complete(ConnectParticipantProfile("Old Alice", null))
        assertTrue(result.await().isFailure)
    }
    @Test fun signedOutAndUnavailableAuthCannotReadMetadata() = runTest {
        val sdk = Sdk(); val auth = ConnectAuth(sdk, backgroundScope, Markers(), "fixture", true)
        runCurrent(); val fence = auth.accountFence()
        auth.signOut().await()
        assertTrue(runCatching { auth.getParticipantProfile(fence) }.isFailure)
        assertNull(sdk.readAccount)
        val unavailable = ConnectAuth(null, backgroundScope, Markers(), "", false)
        assertTrue(runCatching { unavailable.getParticipantProfile(unavailable.accountFence()) }.isFailure)
    }
    @Test fun avatarBoundaryRejectsNonHttpsCredentialsMalformedAndOversizedUrls() {
        assertEquals("https://example.test/avatar.png", profilePhoto("https://example.test/avatar.png"))
        for (url in listOf("http://example.test/a", "https://user:password@example.test/a", "data:image/svg+xml,unsafe", "https://", "https://example.test/" + "a".repeat(2048))) assertNull(profilePhoto(url))
    }
}
