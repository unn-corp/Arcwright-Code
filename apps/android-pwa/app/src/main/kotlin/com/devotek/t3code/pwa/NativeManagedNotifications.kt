package com.devotek.t3code.pwa

import android.content.Context
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collect
import okhttp3.OkHttpClient
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/** Application-owned observer works without any activity or WebView. Keystore is opened lazily. */
class NativeManagedNotifications(private val app: ArcwrightApplication) {
    private val registered = ConcurrentHashMap<String, ConnectAccount>().apply {
        val saved = NotificationCredentials.read(app, STORAGE)
        saved.keys().forEach { put(it, saved.getJSONObject(it).let { ref -> ConnectAccount(ref.getString("userId"), ref.getString("sessionId")) }) }
    }
    private val auth get() = app.connectAuth
    private val sessionDelegate = lazy {
        NativeManagedEnvironmentSession(BuildConfig.RELAY_URL, ConnectManagedAccount(auth), NativeDpopKey.androidKey(), OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS).callTimeout(20, TimeUnit.SECONDS)
            .followRedirects(false).followSslRedirects(false).build())
    }
    private val session get() = sessionDelegate.value
    init {
        var observedIdentity: Triple<String?, String?, Long>? = null
        app.authScope.launch {
            auth.status.collect { status ->
                if (status.phase == "signedIn" || status.phase == "signedOut" || status.phase == "unavailable") {
                    // Generation is process-local: retain restored refs by SDK account/session identity.
                    val identity = Triple(status.userId, status.sessionId, status.generation)
                    if (identity != observedIdentity) {
                        observedIdentity = identity
                        reconcile(status)
                        AgentNotificationService.managedIdentityChanged()
                        if (sessionDelegate.isInitialized()) launch(Dispatchers.IO) { session.cancelPending(); session.clear() }
                    }
                }
            }
        }
    }
    fun ticket(id: String, config: JSONObject) = session.ticket(id, config.getString("userId"), config.getString("sessionId"))
    fun isCurrent(ticket: NativeManagedEnvironmentSession.Ticket) = session.isCurrent(ticket)
    fun current(id: String, config: JSONObject): Boolean {
        val fence = auth.accountFence()
        return registered[id] == ConnectAccount(config.optString("userId"), config.optString("sessionId")) && fence.userId == config.optString("userId") && fence.sessionId == config.optString("sessionId") && auth.isCurrent(fence)
    }
    private fun reconcile(status: ConnectAuthStatus) = synchronized(NotificationCredentials::class.java) {
        val refs = NotificationCredentials.read(app, STORAGE)
        val removed = NotificationRegistrationPolicy.reconcile(refs, status)
        if (removed.isNotEmpty()) {
            for (id in removed) { registered.remove(id); refs.remove(id); NativeNotifications.store(app).edit().remove("state:$id").apply() }
            try { NotificationCredentials.write(app, STORAGE, refs) }
            catch (_: Exception) {
                // Cleanup cannot leave revoked references reachable or kill the account observer.
                registered.clear()
                NativeNotifications.store(app).edit().remove(STORAGE).apply()
            }
        }
    }
    companion object {
        const val STORAGE = "encryptedManagedConnections"
        @JvmStatic fun from(context: Context) = (context.applicationContext as ArcwrightApplication).managedNotifications
        @JvmStatic fun register(context: Context, payload: JSONObject) = synchronized(NotificationCredentials::class.java) {
            val app = context.applicationContext as ArcwrightApplication
            val ref = NotificationRegistrationPolicy.managedReference(payload, app.connectAuth)
            val id = payload.getString("environmentId")
            val refs = NotificationCredentials.read(context, STORAGE)
            refs.put(id, ref)
            val previous = app.managedNotifications.registered[id]
            NotificationCredentials.write(context, STORAGE, refs)
            val identity = ConnectAccount(ref.getString("userId"), ref.getString("sessionId"))
            app.managedNotifications.registered[id] = identity
            val preferred = NativeNotifications.read(context, "managedPreferred").put(id, true)
            val editor = NativeNotifications.store(context).edit().putString("managedPreferred", preferred.toString())
            if (previous != identity) editor.remove("state:$id")
            editor.apply()
        }
        @JvmStatic fun remove(context: Context, id: String) = synchronized(NotificationCredentials::class.java) {
            val owner = from(context)
            owner.registered.remove(id)
            if (owner.sessionDelegate.isInitialized()) owner.app.authScope.launch(Dispatchers.IO) { owner.session.remove(id) }
            val refs = NotificationCredentials.read(context, STORAGE)
            if (refs.has(id)) {
                refs.remove(id)
                NotificationCredentials.write(context, STORAGE, refs)
                NativeNotifications.store(context).edit().remove("state:$id").apply()
            }
        }
        @JvmStatic fun connections(context: Context): JSONObject = synchronized(NotificationCredentials::class.java) {
            NotificationRegistrationPolicy.combine(NotificationCredentials.read(context), NativeNotifications.read(context, "managedPreferred"), NotificationCredentials.read(context, STORAGE))
        }
    }
}
