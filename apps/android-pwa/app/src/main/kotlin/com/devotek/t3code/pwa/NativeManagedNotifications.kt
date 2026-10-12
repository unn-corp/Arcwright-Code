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
    private val authority get() = app.connectAuthority?.notificationStamp
    private val registered = ConcurrentHashMap<String, String>().apply {
        synchronized(NotificationCredentials::class.java) {
            val saved = NotificationCredentials.read(app, STORAGE)
            saved.keys().forEach { id ->
                val ref = saved.optJSONObject(id)
                if (NotificationRegistrationPolicy.belongs(ref, authority)) put(id, ref!!.getString("registrationRevision"))
            }
        }
    }
    private val auth get() = app.connectAuth
    private val sessionDelegate = lazy {
        NativeManagedEnvironmentSession(BuildConfig.RELAY_URL, ConnectManagedAccount(auth), NativeDpopKey.androidKey(), OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS).callTimeout(20, TimeUnit.SECONDS)
            .followRedirects(false).followSslRedirects(false).build(), authorityStamp = requireNotNull(authority))
    }
    private val session get() = sessionDelegate.value
    private val frameState = NotificationFrameState(
        NotificationCredentials::class.java,
        { id -> if (NativeNotifications.read(app, "preferences").optBoolean("enabled")) connections(app).optJSONObject(id) else null },
        { auth.isCurrent(it) },
        { id, state -> NativeNotifications.store(app).edit().putString("state:$id", state).apply() },
        { auth.owns(it) },
        { authority },
    )
    fun currentConnection(id: String, config: JSONObject, fence: ConnectAuthStatus?) = frameState.current(id, config, fence)
    fun ownedConnection(id: String, config: JSONObject, fence: ConnectAuthStatus?) = frameState.owned(id, config, fence)
    fun publishAlert(id: String, config: JSONObject, fence: ConnectAuthStatus?, thread: JSONObject, kind: String) = frameState.publish(id, config, fence) {
        NativeNotifications.alert(app, id, thread, kind)
    }
    fun persistState(id: String, config: JSONObject, fence: ConnectAuthStatus?, state: String) = frameState.persist(id, config, fence, state)
    private val cleanup = ManagedRegistrationCleanup(
        NotificationCredentials::class.java,
        { NotificationCredentials.read(app, STORAGE) },
        { NotificationCredentials.write(app, STORAGE, it) },
        { auth.isCurrent(it) },
        { id, ref, fence ->
            val revision = ref.getString("registrationRevision")
            registered.remove(id, revision)
            NativeNotifications.store(app).edit().remove("state:$id").apply()
            if (sessionDelegate.isInitialized()) app.authScope.launch(Dispatchers.IO) { session.remove(id, revision, fence) }
        },
        { authority },
    )
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
                        if (sessionDelegate.isInitialized()) launch(Dispatchers.IO) { session.cancelObsolete(auth::accountFence); session.clearObsolete(auth::accountFence) }
                    }
                }
            }
        }
    }
    fun operationFence(id: String, config: JSONObject): ConnectAuthStatus {
        if (!NotificationRegistrationPolicy.belongs(config, authority)) throw ManagedAuthRejected()
        val fence = ConnectManagedAccount(auth).capture(config.getString("userId"), config.getString("sessionId"))
        if (!current(id, config)) throw ManagedAuthRejected()
        return fence
    }
    fun ticket(id: String, config: JSONObject): NativeManagedEnvironmentSession.Ticket {
        operationFence(id, config) // Admission precedes Keystore/cache/HTTP creation.
        return session.ticket(id, config.getString("userId"), config.getString("sessionId"), config.getString("registrationRevision"))
    }
    fun reject(id: String, config: JSONObject, fence: ConnectAuthStatus): Boolean = cleanup.reject(id, config, fence)
    fun isCurrent(ticket: NativeManagedEnvironmentSession.Ticket) = ticket.authorityStamp == authority && sessionDelegate.isInitialized() && session.isCurrent(ticket)
    fun current(id: String, config: JSONObject): Boolean {
        val fence = auth.accountFence()
        return NotificationRegistrationPolicy.belongs(config, authority) && registered[id] == config.optString("registrationRevision") && fence.userId == config.optString("userId") && fence.sessionId == config.optString("sessionId") && auth.isCurrent(fence)
    }
    private fun reconcile(status: ConnectAuthStatus) = synchronized(NotificationCredentials::class.java) {
        val refs = NotificationCredentials.read(app, STORAGE)
        val removed = NotificationRegistrationPolicy.reconcile(refs, status, authority)
        if (removed.isNotEmpty()) {
            for (id in removed) { registered.remove(id); refs.remove(id); NativeNotifications.store(app).edit().remove("state:$id").apply() }
            try { NotificationCredentials.write(app, STORAGE, refs) }
            catch (_: Exception) {
                // Cleanup cannot leave revoked references reachable or kill the account observer.
                registered.clear()
            }
        }
    }
    companion object {
        const val STORAGE = "encryptedManagedConnections"
        @JvmStatic fun from(context: Context) = (context.applicationContext as ArcwrightApplication).managedNotifications
        @JvmStatic fun preserveDormantPreference(context: Context, managed: JSONObject, id: String) =
            NotificationRegistrationPolicy.preserveDormantPreference(managed, id, from(context).authority)
        @JvmStatic fun prefersManaged(context: Context, id: String) = synchronized(NotificationCredentials::class.java) {
            NotificationRegistrationPolicy.prefersManaged(NativeNotifications.read(context, "managedPreferred"),
                NotificationCredentials.read(context, STORAGE), id, from(context).authority)
        }
        @JvmStatic fun register(context: Context, payload: JSONObject) = synchronized(NotificationCredentials::class.java) {
            val app = context.applicationContext as ArcwrightApplication
            val ref = NotificationRegistrationPolicy.managedReference(payload, app.connectAuth, app.connectAuthority?.notificationStamp)
            val id = payload.getString("environmentId")
            val refs = NotificationCredentials.read(context, STORAGE)
            val oldRef = refs.optJSONObject(id)
            NotificationRegistrationPolicy.reprime(oldRef, ref) { NativeNotifications.store(context).edit().remove("state:$id").apply() }
            refs.put(id, ref)
            NotificationCredentials.write(context, STORAGE, refs)
            val revision = ref.getString("registrationRevision")
            app.managedNotifications.registered[id] = revision
            val preferred = NativeNotifications.read(context, "managedPreferred").put(id, true)
            NativeNotifications.store(context).edit().putString("managedPreferred", preferred.toString()).apply()
        }
        @JvmStatic fun remove(context: Context, id: String) = synchronized(NotificationCredentials::class.java) {
            val owner = from(context)
            val refs = NotificationCredentials.read(context, STORAGE)
            val previous = refs.optJSONObject(id)
            // Explicit current-profile removal cannot erase unknown/foreign retained data.
            if (!NotificationRegistrationPolicy.belongs(previous, owner.authority)) return@synchronized
            owner.registered.remove(id)
            if (previous != null) {
                val revision = previous.getString("registrationRevision")
                if (owner.sessionDelegate.isInitialized()) owner.app.authScope.launch(Dispatchers.IO) { owner.session.remove(id, revision) }
                refs.remove(id)
                NotificationCredentials.write(context, STORAGE, refs)
                NativeNotifications.store(context).edit().remove("state:$id").apply()
            }
        }
        @JvmStatic fun connections(context: Context): JSONObject = synchronized(NotificationCredentials::class.java) {
            val owner = from(context)
            NotificationRegistrationPolicy.combine(NotificationCredentials.read(context), NativeNotifications.read(context, "managedPreferred"), NotificationCredentials.read(context, STORAGE), if (owner.auth.status.value.available) owner.authority else null)
        }
    }
}
