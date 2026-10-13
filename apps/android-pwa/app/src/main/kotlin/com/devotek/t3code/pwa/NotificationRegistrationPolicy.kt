package com.devotek.t3code.pwa

import org.json.JSONObject

/** Orders native bridge writes and preserves dormant direct credentials under managed selection. */
object NotificationRegistrationPolicy {
    @JvmStatic fun managedReference(payload: JSONObject, auth: ConnectAuth, authority: String?): JSONObject {
        if (authority.isNullOrEmpty()) throw ManagedAuthRejected()
        if (payload.keys().asSequence().toSet() != setOf("environmentId", "userId", "sessionId", "generation", "configurationId", "sequence")) throw ManagedProtocolRejected()
        val id = payload.opt("environmentId") as? String ?: throw ManagedProtocolRejected()
        if (!NativeManagedEnvironmentSession.validEnvironmentId(id)) throw ManagedProtocolRejected()
        val fence = auth.accountFence()
        if (payload.opt("userId") != fence.userId || payload.opt("sessionId") != fence.sessionId || (payload.opt("generation") as? Number)?.toDouble() != fence.generation.toDouble() || !auth.isCurrent(fence)) throw ManagedAuthRejected()
        return JSONObject().put("mode", "managed").put("userId", fence.userId).put("sessionId", fence.sessionId)
            .put("authority", authority).put("registrationRevision", java.util.UUID.randomUUID().toString())
    }
    @JvmStatic fun directReference(previous: JSONObject?, managedPreferred: Boolean, httpBaseUrl: String, token: String): JSONObject {
        val sameDirect = !managedPreferred && previous != null && previous.optString("httpBaseUrl") == httpBaseUrl &&
            previous.optString("token") == token && previous.optString("registrationRevision").isNotEmpty()
        val revision = if (sameDirect) previous.getString("registrationRevision") else java.util.UUID.randomUUID().toString()
        return JSONObject().put("httpBaseUrl", httpBaseUrl).put("token", token).put("registrationRevision", revision)
    }
    /** Run under the registration monitor with the credential write. Replacement drops queued
     * alerts, so its fresh snapshot must re-prime outstanding requests rather than inherit receipts. */
    @JvmStatic fun reprime(previous: JSONObject?, current: JSONObject?, clear: Runnable) {
        val same = previous != null && current != null && current.optString("registrationRevision").isNotEmpty() &&
            listOf("mode", "registrationRevision", "httpBaseUrl", "token", "userId", "sessionId", "authority").all { previous.optString(it) == current.optString(it) }
        if (!same) clear.run()
    }
    @JvmStatic fun accepts(configurationId: String, versions: JSONObject, id: String, payload: JSONObject): Boolean {
        if (payload.optString("configurationId") != configurationId || configurationId.isEmpty()) return false
        val sequence = payload.optLong("sequence", -1)
        return sequence > 0 && sequence > versions.optLong(id, 0)
    }
    @JvmStatic fun belongs(ref: JSONObject?, authority: String?): Boolean = !authority.isNullOrEmpty() && ref != null &&
        ref.optString("mode") == "managed" && ref.optString("authority") == authority && ref.optString("registrationRevision").isNotEmpty()
    @JvmStatic fun preserveDormantPreference(managed: JSONObject, id: String, authority: String?): Boolean =
        managed.has(id) && !belongs(managed.optJSONObject(id), authority)
    @JvmStatic fun combine(direct: JSONObject, preferred: JSONObject, managed: JSONObject, authority: String?): JSONObject {
        val result = JSONObject(direct.toString())
        // Profile changes and fresh automatic registrations are not consent to revive old direct
        // notifications. Only the explicit native selectDirect action clears its saved preference.
        preferred.keys().forEach { result.remove(it) }
        managed.keys().forEach { if (belongs(managed.optJSONObject(it), authority)) result.put(it, managed.getJSONObject(it)) }
        return result
    }
    @JvmStatic fun reconcile(managed: JSONObject, status: ConnectAuthStatus, authority: String?): Set<String> {
        if (!status.available || status.phase !in setOf("signedIn", "signedOut")) return emptySet()
        return managed.keys().asSequence().filter { id ->
            val ref = managed.optJSONObject(id)
            belongs(ref, authority) && (ref!!.optString("userId") != status.userId || ref.optString("sessionId") != status.sessionId)
        }.toSet().also { removed -> removed.forEach { managed.remove(it) } }
    }
}
