package com.devotek.t3code.pwa

import java.io.IOException
import java.text.SimpleDateFormat
import java.text.ParsePosition
import java.util.Locale
import java.util.TimeZone
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

interface NativeManagedAccount {
    fun capture(userId: String, sessionId: String): ConnectAuthStatus
    fun current(fence: ConnectAuthStatus): Boolean
    fun validate(fence: ConnectAuthStatus) { if (!current(fence)) throw ManagedAuthRejected() }
    fun relayToken(forceRefresh: Boolean): String
}
class ManagedAuthRejected : IOException("Managed account authorization rejected")
class ManagedProtocolRejected : IOException("Managed environment protocol rejected")

/** Worker-only, serialized cache; nothing persisted except account/session/environment references. */
class NativeManagedEnvironmentSession(
    relay: String,
    private val account: NativeManagedAccount,
    private val key: NativeDpopKey,
    http: OkHttpClient,
    private val clock: () -> Long = System::currentTimeMillis,
    private val appVersion: String = BuildConfig.VERSION_NAME,
) {
    data class Ticket(val address: HttpUrl, val fence: ConnectAuthStatus, val renewAt: Long)
    private data class Session(val fence: ConnectAuthStatus, val base: HttpUrl, val ws: HttpUrl, val token: String, val expiresAt: Long, val registrationRevision: String)
    private val http = http.newBuilder().followRedirects(false).followSslRedirects(false).callTimeout(20, java.util.concurrent.TimeUnit.SECONDS).build()
    private val relayBase = secureBase(relay.trim().trimEnd('/') + "/")
    private val cache = mutableMapOf<String, Session>()
    private val calls = java.util.concurrent.ConcurrentHashMap<Call, ConnectAuthStatus>()
    fun cancelObsolete(current: () -> ConnectAuthStatus) { calls.forEach { (call, fence) -> if (!sameFence(fence, current())) call.cancel() } }
    private val nonces = mutableMapOf<String, String>()
    companion object {
        private fun sameFence(left: ConnectAuthStatus, right: ConnectAuthStatus) = left.generation == right.generation && left.userId == right.userId && left.sessionId == right.sessionId
        private const val GRANT = "urn:ietf:params:oauth:grant-type:token-exchange"
        private const val ACCESS = "urn:ietf:params:oauth:token-type:access_token"
        fun secureBase(raw: String): HttpUrl {
            val uri = try { java.net.URI(raw) } catch (_: Exception) { throw ManagedProtocolRejected() }
            if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null || uri.host == null) throw ManagedProtocolRejected()
            val url = raw.toHttpUrlOrNull() ?: throw ManagedProtocolRejected()
            if (url.scheme != "https" || url.username.isNotEmpty() || url.password.isNotEmpty() || url.query != null || url.fragment != null || url.encodedPath != "/") throw ManagedProtocolRejected()
            return url
        }
        fun validEnvironmentId(value: String) = value.length in 1..256 && value.matches(Regex("[A-Za-z0-9][A-Za-z0-9._:-]*"))
    }
    @Synchronized fun remove(id: String, revision: String, fence: ConnectAuthStatus? = null) {
        val cached = cache[id] ?: return
        if (cached.registrationRevision == revision && (fence == null || sameFence(cached.fence, fence))) cache.remove(id)
    }
    @Synchronized fun clearObsolete(current: () -> ConnectAuthStatus) {
        val latest = current()
        cache.entries.removeAll { !sameFence(it.value.fence, latest) }
        nonces.clear()
    }
    fun isCurrent(ticket: Ticket) = account.current(ticket.fence)
    private fun checkFence(fence: ConnectAuthStatus) { account.validate(fence) }
    @Synchronized fun ticket(environmentId: String, userId: String, sessionId: String, registrationRevision: String = ""): Ticket {
        if (!validEnvironmentId(environmentId)) throw ManagedProtocolRejected()
        val fence = account.capture(userId, sessionId); checkFence(fence)
        for (attempt in 0..1) {
            try {
                val cached = cache[environmentId]
                val session = if (cached != null && sameFence(cached.fence, fence) && cached.registrationRevision == registrationRevision && cached.expiresAt > clock() + 5_000) cached else establish(environmentId, fence, attempt > 0, registrationRevision).also { cache[environmentId] = it }
                val result = request(session.base.resolve("/api/auth/websocket-ticket")!!, "POST", ByteArray(0).toRequestBody(null), fence, session.token)
                val ticket = secret(result, "ticket")
                expiry(result.getString("expiresAt"), 300_000)
                checkFence(fence)
                val address = session.ws.newBuilder().addQueryParameter("wsTicket", ticket)
                    .addQueryParameter("orchestrationProtocol", "2").addQueryParameter("clientSurface", "mobile")
                    .addQueryParameter("clientOs", "android").addQueryParameter("clientAppVersion", appVersion)
                    .addQueryParameter("connectionMethod", "relay").build()
                return Ticket(address, fence, session.expiresAt - minOf(5_000, maxOf(1, (session.expiresAt - clock()) / 2)))
            } catch (_: org.json.JSONException) { throw ManagedProtocolRejected()
            } catch (rejected: ManagedAuthRejected) {
                remove(environmentId, registrationRevision, fence)
                checkFence(fence)
                if (attempt == 1) throw rejected
            }
        }
        throw ManagedAuthRejected()
    }
    private fun establish(id: String, fence: ConnectAuthStatus, force: Boolean, registrationRevision: String): Session {
        val relayToken = token(request(relayBase.resolve("/v1/client/dpop-token")!!, "POST", form(mapOf(
            "grant_type" to GRANT, "subject_token" to account.relayToken(force), "subject_token_type" to "urn:ietf:params:oauth:token-type:jwt",
            "requested_token_type" to ACCESS, "resource" to relayBase.toString().removeSuffix("/"), "scope" to "environment:connect", "client_id" to "t3-mobile")), fence), "environment:connect")
        val connectUrl = relayBase.newBuilder().addPathSegments("v1/environments").addPathSegment(id).addPathSegment("connect").build()
        val connected = request(connectUrl, "POST", JSONObject().put("clientProofKeyThumbprint", key.thumbprint).toString().toRequestBody("application/json".toMediaType()), fence, relayToken.first)
        if (connected.getString("environmentId") != id) throw ManagedProtocolRejected()
        expiry(connected.getString("expiresAt"), 3_600_000)
        val endpoint = connected.getJSONObject("endpoint")
        if (endpoint.getString("providerKind") !in setOf("manual", "cloudflare_tunnel", "t3_relay")) throw ManagedProtocolRejected()
        val base = secureBase(endpoint.getString("httpBaseUrl"))
        val wsRaw = endpoint.getString("wsBaseUrl")
        if (!wsRaw.startsWith("wss://")) throw ManagedProtocolRejected()
        val ws = ("https://" + wsRaw.removePrefix("wss://")).toHttpUrlOrNull() ?: throw ManagedProtocolRejected()
        if (ws.host != base.host || ws.port != base.port || ws.username.isNotEmpty() || ws.password.isNotEmpty() || ws.query != null || ws.fragment != null || ws.encodedPath !in setOf("/", "/ws")) throw ManagedProtocolRejected()
        val descriptor = request(base.resolve("/.well-known/t3/environment")!!, "GET", null, fence, proof = false)
        if (descriptor.getString("environmentId") != id || descriptor.opt("orchestrationProtocolVersion") != 2 || descriptor.optJSONObject("capabilities") == null) throw ManagedProtocolRejected()
        secret(descriptor, "label"); secret(descriptor, "serverVersion")
        val platform = descriptor.getJSONObject("platform")
        if (platform.getString("os") !in setOf("darwin", "linux", "windows", "unknown") || platform.getString("arch") !in setOf("arm64", "x64", "other")) throw ManagedProtocolRejected()
        val capabilities = descriptor.getJSONObject("capabilities")
        if (capabilities.has("repositoryIdentity") && capabilities.opt("repositoryIdentity") !is Boolean) throw ManagedProtocolRejected()
        val access = token(request(base.resolve("/oauth/token")!!, "POST", form(mapOf(
            "grant_type" to GRANT, "subject_token" to secret(connected, "credential"), "subject_token_type" to "urn:t3:params:oauth:token-type:environment-bootstrap",
            "requested_token_type" to ACCESS, "scope" to "orchestration:read", "client_label" to "Arcwright Code Android background alerts", "client_device_type" to "mobile", "client_os" to "android")), fence), "orchestration:read")
        checkFence(fence)
        return Session(fence, base, ws.newBuilder().encodedPath("/ws").build(), access.first, access.second, registrationRevision)
    }
    private fun form(values: Map<String, String>) = FormBody.Builder().apply { for ((name, value) in values) add(name, value) }.build()
    private fun token(result: JSONObject, scope: String): Pair<String, Long> {
        if (result.getString("token_type") != "DPoP" || result.getString("issued_token_type") != ACCESS || result.getString("scope").trim().split(Regex("\\s+")).toSet() != setOf(scope)) throw ManagedProtocolRejected()
        val seconds = (result.opt("expires_in") as? Number)?.toDouble() ?: throw ManagedProtocolRejected()
        if (!seconds.isFinite() || seconds % 1 != 0.0 || seconds <= 0 || seconds > 86_400) throw ManagedProtocolRejected()
        val access = secret(result, "access_token")
        if (access.any { it.isWhitespace() || it.code < 32 || it.code == 127 }) throw ManagedProtocolRejected()
        return access to (clock() + (seconds * 1000).toLong())
    }
    private fun secret(result: JSONObject, name: String): String = ((result.opt(name) as? String) ?: throw ManagedProtocolRejected()).also { if (it.isBlank() || it.length > 32768) throw ManagedProtocolRejected() }
    private fun expiry(raw: String, max: Long): Long {
        // Server UTC wire timestamps; avoid java.time, unavailable on supported Android 24/25.
        if (!raw.matches(Regex("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{3})?Z"))) throw ManagedProtocolRejected()
        val format = SimpleDateFormat(if (raw.contains('.')) "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'" else "yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC"); isLenient = false }
        val position = ParsePosition(0)
        val millis = format.parse(raw, position)?.time ?: throw ManagedProtocolRejected()
        if (position.index != raw.length || millis <= clock() || millis > clock() + max) throw ManagedProtocolRejected()
        return millis
    }
    private fun request(url: HttpUrl, method: String, body: RequestBody?, fence: ConnectAuthStatus, token: String? = null, proof: Boolean = true): JSONObject {
        val origin = "${url.scheme}://${url.host}:${url.port}"
        for (attempt in 0..1) {
            checkFence(fence)
            val builder = Request.Builder().url(url).method(method, body)
            if (token != null) builder.header("Authorization", "DPoP $token")
            if (proof) builder.header("DPoP", key.proof(method, url.toString(), clock(), token, nonces[origin]))
            val call = http.newCall(builder.build())
            calls[call] = fence
            try {
                call.execute().use { response ->
                    checkFence(fence)
                    val nonce = response.header("DPoP-Nonce")
                    if (proof && response.code in setOf(400, 401) && nonce != null && nonce.length in 1..1024 && attempt == 0) { nonces[origin] = nonce; return@use }
                    if (proof && response.code in setOf(400, 401) && nonce != null) throw ManagedAuthRejected()
                    if (response.code == 401) throw ManagedAuthRejected()
                    if (response.code == 403) throw ManagedProtocolRejected() // Scope denial/revocation is terminal, never a network retry.
                    if (response.code in 300..399) throw ManagedProtocolRejected()
                    if (!response.isSuccessful) throw IOException("Managed host unavailable")
                    val source = response.body.source()
                    if (source.request(65_537)) throw ManagedProtocolRejected()
                    return try { JSONObject(source.readUtf8()) } catch (_: Exception) { throw ManagedProtocolRejected() }
                }
            } finally { calls.remove(call) }
        }
        throw ManagedAuthRejected()
    }
}
