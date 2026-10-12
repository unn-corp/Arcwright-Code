package com.devotek.t3code.pwa

import org.junit.Assert.*
import org.junit.Test

class ConnectAuthProtocolTest {
    @Test fun bridgeRejectsSubframesAndForeignOrigins() {
        assertTrue(ConnectAuthProtocol.acceptsSender(ConnectAuthProtocol.ORIGIN, true))
        for (origin in listOf("https://appassets.androidplatform.net:443", "http://appassets.androidplatform.net", "https://appassets.androidplatform.net.attacker.test", "https://clerk.example.test")) assertFalse(ConnectAuthProtocol.acceptsSender(origin, true))
        assertFalse(ConnectAuthProtocol.acceptsSender(ConnectAuthProtocol.ORIGIN, false))
    }
    @Test fun onlyBoundedPublicCapabilitiesCanBeDispatched() {
        val request = ConnectAuthProtocol.parse("""{"id":"request_1","action":"getRelayToken","forceRefresh":true}""")!!
        assertEquals("getRelayToken", request.action); assertTrue(request.forceRefresh)
        for (raw in listOf("""{"id":"r","action":"fetch","url":"https://example.test"}""", """{"id":"r","action":"getRelayToken","template":"admin"}""", """{"id":"r","action":"status","forceRefresh":true}""", """{"id":"r","action":"getRelayToken","forceRefresh":"true"}""", """{"id":1,"action":"signOut"}""", """{"id":"","action":"status"}""", "x".repeat(2049))) assertNull(ConnectAuthProtocol.parse(raw))
    }
}
