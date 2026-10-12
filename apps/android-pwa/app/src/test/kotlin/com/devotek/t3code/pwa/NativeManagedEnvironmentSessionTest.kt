package com.devotek.t3code.pwa

import java.io.IOException
import java.math.BigInteger
import java.security.*
import java.security.spec.*
import java.time.Instant
import java.util.Base64
import java.util.concurrent.Executors
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NativeManagedEnvironmentSessionTest {
    private class Account : NativeManagedAccount {
        @Volatile var fence = ConnectAuthStatus(true, "signedIn", 77, "user", "session")
        val refreshes = mutableListOf<Boolean>()
        override fun capture(userId: String, sessionId: String) = fence.also { if (it.userId != userId || it.sessionId != sessionId) throw ManagedAuthRejected() }
        override fun current(fence: ConnectAuthStatus) = this.fence == fence && fence.phase == "signedIn"
        override fun relayToken(forceRefresh: Boolean): String { refreshes.add(forceRefresh); return "clerk-jwt" }
    }
    private class Backend : Interceptor {
        var now = 1_800_000_000_000L
        val account = Account()
        val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val key = NativeDpopKey(pair)
        val paths = mutableListOf<String>()
        val proofs = mutableListOf<JSONObject>()
        val seen = mutableSetOf<String>()
        var tokenIndex = 0
        var ticketIndex = 0
        var nonceChallenge = false
        var replayReject = false
        var modify: (Request, JSONObject) -> JSONObject = { _, body -> body }
        var code: (Request) -> Int = { 200 }
        var after: (Request) -> Unit = {}
        val client = OkHttpClient.Builder().addInterceptor(this).build()
        val session = NativeManagedEnvironmentSession("https://relay.test/", account, key, client, { now }, "test-version")
        fun ticket() = session.ticket("env-1", "user", "session")
        override fun intercept(chain: Interceptor.Chain): Response {
            val request = chain.request(); val path = request.url.encodedPath
            paths.add(path)
            if (path != "/.well-known/t3/environment") verify(request)
            val values = if (request.body is FormBody) (request.body as FormBody).let { form -> (0 until form.size).associate { form.name(it) to form.value(it) } } else emptyMap()
            val body = when (path) {
                "/v1/client/dpop-token" -> {
                    assertEquals(mapOf("grant_type" to "urn:ietf:params:oauth:grant-type:token-exchange", "subject_token" to "clerk-jwt", "subject_token_type" to "urn:ietf:params:oauth:token-type:jwt", "requested_token_type" to "urn:ietf:params:oauth:token-type:access_token", "resource" to "https://relay.test", "scope" to "environment:connect", "client_id" to "t3-mobile"), values)
                    tokenIndex++; token("relay-token", "environment:connect")
                }
                "/v1/environments/env-1/connect" -> {
                    assertEquals("DPoP relay-token", request.header("Authorization"))
                    val raw = Buffer().also { request.body!!.writeTo(it) }.readUtf8()
                    assertEquals(setOf("clientProofKeyThumbprint"), JSONObject(raw).keys().asSequence().toSet())
                    assertEquals(key.thumbprint, JSONObject(raw).getString("clientProofKeyThumbprint"))
                    JSONObject().put("environmentId", "env-1").put("credential", "bootstrap")
                        .put("expiresAt", Instant.ofEpochMilli(now + 60_000).toString())
                        .put("endpoint", JSONObject().put("httpBaseUrl", "https://host.test/").put("wsBaseUrl", "wss://host.test/ws").put("providerKind", "cloudflare_tunnel"))
                }
                "/.well-known/t3/environment" -> {
                    assertNull(request.header("Authorization")); assertNull(request.header("DPoP"))
                    JSONObject().put("environmentId", "env-1").put("orchestrationProtocolVersion", 2).put("capabilities", JSONObject()).put("label", "Fixture host").put("serverVersion", "1.0.0").put("platform", JSONObject().put("os", "linux").put("arch", "x64"))
                }
                "/oauth/token" -> {
                    assertEquals(mapOf("grant_type" to "urn:ietf:params:oauth:grant-type:token-exchange", "subject_token" to "bootstrap", "subject_token_type" to "urn:t3:params:oauth:token-type:environment-bootstrap", "requested_token_type" to "urn:ietf:params:oauth:token-type:access_token", "scope" to "orchestration:read", "client_label" to "Arcwright Code Android background alerts", "client_device_type" to "mobile", "client_os" to "android"), values)
                    token("environment-token", "orchestration:read")
                }
                "/api/auth/websocket-ticket" -> {
                    assertEquals("DPoP environment-token", request.header("Authorization"))
                    ticketIndex++
                    JSONObject().put("ticket", "single-use-$ticketIndex").put("expiresAt", Instant.ofEpochMilli(now + 30_000).toString())
                }
                else -> throw AssertionError("Unexpected managed request")
            }
            after(request)
            val challenged = (nonceChallenge && path == "/api/auth/websocket-ticket" && proofs.last().optString("nonce") != "server-nonce") || replayReject
            return Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(if (challenged) 401 else code(request)).message("fixture")
                .apply { if (challenged) header("DPoP-Nonce", "server-nonce"); if (code(request) == 302) header("Location", "https://other.test/") }
                .body(modify(request, body).toString().toResponseBody("application/json".toMediaType())).build()
        }
        private fun token(value: String, scope: String) = JSONObject().put("access_token", value).put("token_type", "DPoP")
            .put("issued_token_type", "urn:ietf:params:oauth:token-type:access_token").put("expires_in", 60).put("scope", scope)
        private fun verify(request: Request) {
            val parts = request.header("DPoP")!!.split('.')
            val decoder = Base64.getUrlDecoder()
            val header = JSONObject(String(decoder.decode(parts[0])))
            assertEquals("dpop+jwt", header.getString("typ")); assertEquals("ES256", header.getString("alg"))
            val jwk = header.getJSONObject("jwk"); assertEquals(setOf("kty", "crv", "x", "y"), jwk.keys().asSequence().toSet())
            val canonical = "{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"${jwk.getString("x")}\",\"y\":\"${jwk.getString("y")}\"}"
            assertEquals(key.thumbprint, Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray())))
            val params = AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }.getParameterSpec(ECParameterSpec::class.java)
            val public = KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(BigInteger(1, decoder.decode(jwk.getString("x"))), BigInteger(1, decoder.decode(jwk.getString("y")))), params))
            val signature = decoder.decode(parts[2]); assertEquals(64, signature.size)
            fun integer(bytes: ByteArray): ByteArray { val positive = BigInteger(1, bytes).toByteArray(); return byteArrayOf(2, positive.size.toByte()) + positive }
            val integers = integer(signature.copyOfRange(0, 32)) + integer(signature.copyOfRange(32, 64))
            assertTrue(Signature.getInstance("SHA256withECDSA").apply { initVerify(public); update("${parts[0]}.${parts[1]}".toByteArray()) }.verify(byteArrayOf(0x30, integers.size.toByte()) + integers))
            val claims = JSONObject(String(decoder.decode(parts[1]))); proofs.add(claims)
            assertTrue("Proof jti replayed", seen.add(claims.getString("jti")))
            assertEquals(now / 1000, claims.getLong("iat")); assertEquals(request.url.toString(), claims.getString("htu")); assertEquals(request.method, claims.getString("htm"))
            val token = request.header("Authorization")?.removePrefix("DPoP ")
            if (token == null) assertFalse(claims.has("ath")) else assertEquals(Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(token.toByteArray())), claims.getString("ath"))
        }
    }
    @Test fun exactProtocolRealSignatureFreshTicketAndExpiryRenewal() {
        val backend = Backend(); val first = backend.ticket(); val second = backend.ticket()
        assertEquals(listOf("/v1/client/dpop-token", "/v1/environments/env-1/connect", "/.well-known/t3/environment", "/oauth/token", "/api/auth/websocket-ticket", "/api/auth/websocket-ticket"), backend.paths)
        assertNotEquals(first.address.queryParameter("wsTicket"), second.address.queryParameter("wsTicket"))
        assertEquals("relay", first.address.queryParameter("connectionMethod")); assertEquals("2", first.address.queryParameter("orchestrationProtocol"))
        assertEquals("mobile", first.address.queryParameter("clientSurface")); assertEquals("android", first.address.queryParameter("clientOs"))
        assertEquals("test-version", first.address.queryParameter("clientAppVersion"))
        backend.now += 56_000; backend.ticket(); assertEquals(2, backend.tokenIndex)
    }
    @Test fun nonceChallengeFreshProofAndReplayRejectionIsBounded() {
        val backend = Backend(); backend.nonceChallenge = true; backend.ticket()
        assertEquals("server-nonce", backend.proofs.last().getString("nonce"))
        backend.replayReject = true
        assertThrows(ManagedAuthRejected::class.java) { backend.ticket() }
        assertEquals(3, backend.tokenIndex) // The refreshed bootstrap itself gets a bounded nonce retry.
        assertEquals(listOf(false, true), backend.account.refreshes)
        assertEquals(10, backend.paths.size)
    }
    @Test fun expiredTokenRejectionRefreshesOnceThenTerminates() {
        val backend = Backend(); backend.ticket()
        var rejected = 0
        backend.code = { if (it.url.encodedPath == "/api/auth/websocket-ticket" && rejected++ == 0) 401 else 200 }
        backend.ticket(); assertEquals(2, backend.tokenIndex); assertEquals(listOf(false, true), backend.account.refreshes)
        backend.code = { if (it.url.encodedPath == "/api/auth/websocket-ticket") 401 else 200 }
        assertThrows(ManagedAuthRejected::class.java) { backend.ticket() }
        assertEquals(3, backend.tokenIndex)
    }
    @Test fun offlineRetainsSessionWhileRevocationIsTerminal() {
        val backend = Backend(); backend.ticket()
        backend.code = { if (it.url.encodedPath == "/api/auth/websocket-ticket") 503 else 200 }
        assertThrows(IOException::class.java) { backend.ticket() }
        backend.code = { 200 }; backend.ticket(); assertEquals(1, backend.tokenIndex)
        backend.code = { 403 }; assertThrows(ManagedProtocolRejected::class.java) { backend.ticket() }
        assertEquals(1, backend.tokenIndex)
    }
    @Test fun logoutAndAccountSwitchFenceInflightHttpAndOldTickets() {
        for (phase in listOf("signedIn", "signedOut")) {
            val backend = Backend(); val old = backend.ticket()
            backend.after = { backend.account.fence = ConnectAuthStatus(true, phase, 78, if (phase == "signedIn") "other" else null, null) }
            assertThrows(ManagedAuthRejected::class.java) { backend.ticket() }
            assertFalse(backend.session.isCurrent(old)); assertEquals(1, backend.tokenIndex)
        }
        val backend = Backend()
        backend.after = { backend.account.fence = backend.account.fence.copy(generation = 78) }
        assertThrows(ManagedAuthRejected::class.java) { backend.ticket() }
        assertEquals(listOf("/v1/client/dpop-token"), backend.paths)
    }
    @Test fun rejectsRedirectAndMalformedOrMismatchedResponsesBeforeSendingCredential() {
        val invalids: List<(Request, JSONObject) -> JSONObject> = listOf(
            { request, body -> if (request.url.encodedPath == "/v1/client/dpop-token") body.put("token_type", "Bearer") else body },
            { request, body -> if (request.url.encodedPath == "/oauth/token") body.put("scope", "orchestration:read orchestration:operate") else body },
            { request, body -> if (request.url.encodedPath == "/oauth/token") body.put("expires_in", -1) else body },
            { request, body -> if (request.url.encodedPath == "/oauth/token") body.put("expires_in", "60") else body },
            { request, body -> if (request.url.encodedPath == "/oauth/token") body.put("access_token", "invalid\r\nheader") else body },
            { request, body -> if (request.url.encodedPath == "/.well-known/t3/environment") body.put("orchestrationProtocolVersion", "2") else body },
            { request, body -> if (request.url.encodedPath.contains("/connect")) body.put("environmentId", "other") else body },
            { request, body -> if (request.url.encodedPath.contains("/connect")) body.apply { getJSONObject("endpoint").put("wsBaseUrl", "wss://other.test/ws") } else body },
            { request, body -> if (request.url.encodedPath == "/.well-known/t3/environment") body.put("environmentId", "other") else body },
            { request, body -> if (request.url.encodedPath == "/.well-known/t3/environment") body.put("orchestrationProtocolVersion", 1) else body },
            { request, body -> if (request.url.encodedPath.contains("/connect")) body.put("expiresAt", "yesterday") else body },
            { request, body -> if (request.url.encodedPath == "/v1/client/dpop-token") JSONObject() else body },
            { request, body -> if (request.url.encodedPath == "/v1/client/dpop-token") body.put("access_token", "x".repeat(65537)) else body },
        )
        for (invalid in invalids) { val backend = Backend(); backend.modify = invalid; assertThrows(ManagedProtocolRejected::class.java) { backend.ticket() } }
        val redirected = Backend(); redirected.code = { 302 }
        assertThrows(ManagedProtocolRejected::class.java) { redirected.ticket() }; assertEquals(1, redirected.paths.size)
        for (url in listOf("http://relay.test", "https://user@relay.test", "https://relay.test/?token=x", "https://relay.test/#fragment", "https://relay.test/path")) assertThrows(ManagedProtocolRejected::class.java) { NativeManagedEnvironmentSession.secureBase(url) }
    }
    @Test fun lateFakeHttpRejectionUsesRegistrationScopedCleanupAndPreservesReplacement() {
        val backend = Backend(); val old = JSONObject().put("mode", "managed").put("userId", "user").put("sessionId", "session").put("registrationRevision", "old")
        val lock = Any(); var refs = JSONObject().put("env-1", old); var state: String? = "old-state"; var evictions = 0
        val cleanup = ManagedRegistrationCleanup(lock, { JSONObject(refs.toString()) }, { refs = it }, backend.account::current, { _, _, _ -> state = null; evictions++ })
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        backend.after = { if (it.url.encodedPath == "/api/auth/websocket-ticket") { entered.countDown(); assertTrue(release.await(5, TimeUnit.SECONDS)) } }
        backend.code = { if (it.url.encodedPath == "/api/auth/websocket-ticket") 403 else 200 }
        val executor = Executors.newSingleThreadExecutor()
        try {
            val result = executor.submit<Boolean> {
                val captured = backend.account.capture("user", "session")
                try { backend.session.ticket("env-1", "user", "session", "old"); throw AssertionError("Expected rejection") }
                catch (_: ManagedProtocolRejected) { cleanup.reject("env-1", old, captured) }
            }
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            synchronized(lock) { refs.put("env-1", JSONObject(old.toString()).put("registrationRevision", "new")); state = "new-state" }
            release.countDown(); assertFalse(result.get(5, TimeUnit.SECONDS))
            assertEquals("new", refs.getJSONObject("env-1").getString("registrationRevision")); assertEquals("new-state", state); assertEquals(0, evictions)
        } finally { release.countDown(); executor.shutdownNow() }
    }
    @Test fun delayedRevisionOrGenerationEvictionCannotRemoveNewerSessionToken() {
        val backend = Backend(); val oldFence = backend.account.fence
        backend.session.ticket("env-1", "user", "session", "old")
        backend.session.ticket("env-1", "user", "session", "new")
        assertEquals(2, backend.tokenIndex)
        backend.session.remove("env-1", "old", oldFence) // A previously queued cleanup reaches the cache late.
        backend.session.ticket("env-1", "user", "session", "new"); assertEquals(2, backend.tokenIndex)
        backend.account.fence = oldFence.copy(generation = oldFence.generation + 1)
        backend.session.ticket("env-1", "user", "session", "new"); assertEquals(3, backend.tokenIndex)
        backend.session.remove("env-1", "new", oldFence)
        backend.session.clearObsolete { backend.account.fence }
        backend.session.ticket("env-1", "user", "session", "new"); assertEquals(3, backend.tokenIndex)
        backend.session.remove("env-1", "new", backend.account.fence)
        backend.session.ticket("env-1", "user", "session", "new"); assertEquals(4, backend.tokenIndex)
    }
    @Test fun concurrentRenewalUsesOneSessionAndSeparateTickets() {
        val backend = Backend(); val executor = Executors.newFixedThreadPool(2)
        try {
            val futures = listOf(executor.submit<NativeManagedEnvironmentSession.Ticket> { backend.ticket() }, executor.submit<NativeManagedEnvironmentSession.Ticket> { backend.ticket() })
            val tickets = futures.map { it.get() }
            assertEquals(1, backend.tokenIndex); assertNotEquals(tickets[0].address.queryParameter("wsTicket"), tickets[1].address.queryParameter("wsTicket"))
        } finally { executor.shutdownNow() }
    }
}
