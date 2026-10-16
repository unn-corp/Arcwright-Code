package com.devotek.t3code.pwa

import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import org.json.JSONArray
import kotlinx.coroutines.*

/** One restricted capability. External documents, browser-agent tabs and subframes never get it. */
class ConnectAuthBridge(private val activity: MainActivity, private val webView: WebView) {
    private val app = activity.application as ArcwrightApplication
    private val auth = app.connectAuth
    private val jobs = mutableMapOf<String, Job>()
    private var subscription: JavaScriptReplyProxy? = null
    private var epoch = 0L
    private var listener: Job? = null

    fun install() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        WebViewCompat.addWebMessageListener(webView, "t3ConnectAuth", setOf(ConnectAuthProtocol.ORIGIN)) { _, message, origin, mainFrame, reply ->
            if (!ConnectAuthProtocol.acceptsSender(origin.toString(), mainFrame)) return@addWebMessageListener
            val request = ConnectAuthProtocol.parse(message.data ?: return@addWebMessageListener) ?: return@addWebMessageListener
            if (jobs.size >= 32 || jobs.containsKey(request.id)) return@addWebMessageListener
            val page = epoch
            val job = app.authScope.launch(start = CoroutineStart.LAZY) {
                try {
                    val result = when (request.action) {
                        "status" -> statusJson(auth.status.value)
                        "subscribe" -> { subscription = reply; statusJson(auth.status.value) }
                        "signIn" -> { auth.signIn(); statusJson(auth.status.value) }
                        "signOut" -> { auth.signOut().await(); statusJson(auth.status.value) }
                        "getRelayToken" -> {
                            val fence = auth.accountFence()
                            val token = auth.getRelayToken(request.forceRefresh)
                            check(auth.isCurrent(fence)) { "Account changed." }
                            JSONObject().put("token", token).put("generation", fence.generation).put("userId", fence.userId).put("sessionId", fence.sessionId)
                        }
                        "getParticipantProfile", "setProfilePhoto" -> {
                            val fence = auth.accountFence()
                            val profile = if (request.action == "setProfilePhoto") {
                                check(request.generation == fence.generation && request.userId == fence.userId && request.sessionId == fence.sessionId) { "Account changed." }
                                auth.setProfilePhoto(fence, request.photo)
                            } else auth.getParticipantProfile(fence)
                            check(auth.isCurrent(fence)) { "Account changed." }
                            val data = profile?.let {
                                JSONObject().put("name", it.name).put("photo", it.photo ?: JSONObject.NULL)
                                    .put("accounts", JSONArray(it.accounts.map { account ->
                                        JSONObject().put("id", account.id).put("label", account.label).put("photo", account.photo ?: JSONObject.NULL)
                                    }))
                            }
                            JSONObject().put("generation", fence.generation).put("userId", fence.userId).put("sessionId", fence.sessionId)
                                .put("profile", data ?: JSONObject.NULL)
                        }
                        else -> error("Unsupported account action.")
                    }
                    post(reply, JSONObject().put("id", request.id).put("result", result), page)
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) {
                    val status = auth.status.value
                    val error = if (!status.available) status.error ?: "Arcwright Connect is unavailable in this build."
                        else "Account request did not finish. Please try again."
                    post(reply, JSONObject().put("id", request.id).put("error", error), page)
                } finally {
                    // A new document can reuse request IDs; an old canceled job must not unregister its replacement.
                    if (jobs[request.id] === currentCoroutineContext()[Job]) jobs.remove(request.id)
                }
            }
            jobs[request.id] = job
            job.start()
        }
        listener = app.authScope.launch {
            auth.status.collect { state -> subscription?.let { post(it, JSONObject().put("event", statusJson(state)), epoch) } }
        }
    }

    private fun post(reply: JavaScriptReplyProxy, data: JSONObject, page: Long) {
        if (epoch != page || !MainActivity.isAppOrigin(android.net.Uri.parse(webView.url ?: ""))) return
        try { reply.postMessage(data.toString()) } catch (_: IllegalStateException) { /* Page was replaced. */ }
    }
    fun shellNavigating() {
        epoch++
        subscription = null
        jobs.values.toList().forEach { it.cancel() }
        jobs.clear()
    }
    fun destroy() { shellNavigating(); listener?.cancel(); listener = null }

    private fun statusJson(status: ConnectAuthStatus): JSONObject = JSONObject()
        .put("protocol", 1).put("available", status.available).put("phase", status.phase).put("generation", status.generation)
        .put("userId", status.userId ?: JSONObject.NULL).put("sessionId", status.sessionId ?: JSONObject.NULL)
        .put("error", status.error ?: JSONObject.NULL)
}

/** Parse before dispatch: no caller-selected templates, URLs, credential operations or extra payload. */
object ConnectAuthProtocol {
    const val ORIGIN = "https://appassets.androidplatform.net"
    data class Request(val id: String, val action: String, val forceRefresh: Boolean,
        val photo: String? = null, val generation: Long? = null, val userId: String? = null, val sessionId: String? = null)
    fun validPhoto(photo: String): Boolean = photo.length <= 16_384 && Regex("data:image/webp;base64,[A-Za-z0-9+/]+={0,2}").matches(photo)
    fun acceptsSender(origin: String, mainFrame: Boolean): Boolean = mainFrame && origin == ORIGIN
    fun parse(raw: String): Request? = try {
        if (raw.length > 24_576) null else {
            val json = JSONObject(raw)
            val id = json.get("id") as? String
            val action = json.get("action") as? String
            val keys = json.keys().asSequence().toSet()
            val actions = setOf("status", "subscribe", "signIn", "getRelayToken", "getParticipantProfile", "setProfilePhoto", "signOut")
            val photoUpdate = action == "setProfilePhoto"
            val allowedKeys = if (photoUpdate) setOf("id", "action", "photo", "generation", "userId", "sessionId") else setOf("id", "action", "forceRefresh")
            val photo = if (json.has("photo") && !json.isNull("photo")) json.get("photo") as? String else null
            val generation = if (json.opt("generation") is Int || json.opt("generation") is Long) json.getLong("generation") else null
            val userId = json.opt("userId") as? String
            val sessionId = json.opt("sessionId") as? String
            if (id == null || !id.matches(Regex("[A-Za-z0-9_-]{1,80}")) || action !in actions ||
                !allowedKeys.containsAll(keys) || (!photoUpdate && raw.length > 2048) ||
                (photoUpdate && (keys != allowedKeys || (!json.isNull("photo") && (photo == null || !validPhoto(photo))) ||
                    generation == null || generation < 0 || generation > 9_007_199_254_740_991L ||
                    userId == null || userId.isEmpty() || userId.length > 256 || sessionId == null || sessionId.isEmpty() || sessionId.length > 256)) ||
                (json.has("forceRefresh") && (action != "getRelayToken" || json.get("forceRefresh") !is Boolean))) null
            else Request(id, action!!, json.optBoolean("forceRefresh", false), photo, generation, userId, sessionId)
        }
    } catch (_: Exception) { null }
}
