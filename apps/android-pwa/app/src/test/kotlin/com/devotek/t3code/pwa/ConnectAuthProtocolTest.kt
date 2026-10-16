package com.devotek.t3code.pwa

import org.junit.Assert.*
import org.junit.Test

class ConnectAuthProtocolTest {
    @Test fun profileMutationOnlyAcceptsBoundedWebpAndAnExactPrincipalFence() {
        val common = """"id":"p","action":"setProfilePhoto","generation":1,"userId":"alice","sessionId":"session-a","photo":"""
        for (photo in listOf("null", "\"data:image/webp;base64,AA==\"")) {
            val request = ConnectAuthProtocol.parse("{$common$photo}")!!
            assertEquals(1L, request.generation)
            assertEquals("alice", request.userId)
            assertEquals("session-a", request.sessionId)
        }
        for (photo in listOf("\"https://example.test/a\"", "\"data:image/svg+xml;base64,AA==\"", "\"data:image/webp;base64," + "A".repeat(16_384) + "\"", "42", "{}"))
            assertNull(ConnectAuthProtocol.parse("{$common$photo}"))
        assertNull(ConnectAuthProtocol.parse("""{"id":"p","action":"setProfilePhoto","photo":null}"""))
        assertNull(ConnectAuthProtocol.parse("{$common null,\"url\":\"https://example.test\"}"))
        assertNull(ConnectAuthProtocol.parse("{$common null}".replace("\"generation\":1", "\"generation\":1.5")))
    }
    @Test fun bridgeRejectsSubframesAndForeignOrigins() {
        assertTrue(ConnectAuthProtocol.acceptsSender(ConnectAuthProtocol.ORIGIN, true))
        for (origin in listOf("https://appassets.androidplatform.net:443", "http://appassets.androidplatform.net", "https://appassets.androidplatform.net.attacker.test", "https://clerk.example.test")) assertFalse(ConnectAuthProtocol.acceptsSender(origin, true))
        assertFalse(ConnectAuthProtocol.acceptsSender(ConnectAuthProtocol.ORIGIN, false))
    }
    @Test fun onlyBoundedPublicCapabilitiesCanBeDispatched() {
        val request = ConnectAuthProtocol.parse("""{"id":"request_1","action":"getRelayToken","forceRefresh":true}""")!!
        assertEquals("getRelayToken", request.action); assertTrue(request.forceRefresh)
        assertEquals("getParticipantProfile", ConnectAuthProtocol.parse("""{"id":"profile_1","action":"getParticipantProfile"}""")!!.action)
        assertNull(ConnectAuthProtocol.parse("""{"id":"r","action":"getParticipantProfile","userId":"other"}"""))
        assertNull(ConnectAuthProtocol.parse("""{"id":"r","action":"getParticipantProfile","forceRefresh":true}"""))
        for (raw in listOf("""{"id":"r","action":"fetch","url":"https://example.test"}""", """{"id":"r","action":"getRelayToken","template":"admin"}""", """{"id":"r","action":"status","forceRefresh":true}""", """{"id":"r","action":"getRelayToken","forceRefresh":"true"}""", """{"id":1,"action":"signOut"}""", """{"id":"","action":"status"}""", "x".repeat(2049))) assertNull(ConnectAuthProtocol.parse(raw))
    }
}
