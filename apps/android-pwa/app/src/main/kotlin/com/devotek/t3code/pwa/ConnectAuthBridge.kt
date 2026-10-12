package com.devotek.t3code.pwa

import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
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
                        else -> error("Unsupported account action.")
                    }
                    post(reply, JSONObject().put("id", request.id).put("result", result), page)
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) {
                    post(reply, JSONObject().put("id", request.id).put("error", "Account request did not finish. Please try again."), page)
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
    data class Request(val id: String, val action: String, val forceRefresh: Boolean)
    fun acceptsSender(origin: String, mainFrame: Boolean): Boolean = mainFrame && origin == ORIGIN
    fun parse(raw: String): Request? = try {
        if (raw.length > 2048) null else {
            val json = JSONObject(raw)
            val id = json.get("id") as? String
            val action = json.get("action") as? String
            val keys = json.keys().asSequence().toSet()
            val actions = setOf("status", "subscribe", "signIn", "getRelayToken", "signOut")
            if (id == null || !id.matches(Regex("[A-Za-z0-9_-]{1,80}")) || action !in actions ||
                !setOf("id", "action", "forceRefresh").containsAll(keys) ||
                (json.has("forceRefresh") && (action != "getRelayToken" || json.get("forceRefresh") !is Boolean))) null
            else Request(id, action!!, json.optBoolean("forceRefresh", false))
        }
    } catch (_: Exception) { null }
}
