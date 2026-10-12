package com.devotek.t3code.pwa

import org.json.JSONObject

/** Orders native bridge writes and preserves dormant direct credentials under managed selection. */
object NotificationRegistrationPolicy {
    @JvmStatic fun managedReference(payload: JSONObject, auth: ConnectAuth): JSONObject {
        if (payload.keys().asSequence().toSet() != setOf("environmentId", "userId", "sessionId", "generation", "configurationId", "sequence")) throw ManagedProtocolRejected()
        val id = payload.opt("environmentId") as? String ?: throw ManagedProtocolRejected()
        if (!NativeManagedEnvironmentSession.validEnvironmentId(id)) throw ManagedProtocolRejected()
        val fence = auth.accountFence()
        if (payload.opt("userId") != fence.userId || payload.opt("sessionId") != fence.sessionId || (payload.opt("generation") as? Number)?.toDouble() != fence.generation.toDouble() || !auth.isCurrent(fence)) throw ManagedAuthRejected()
        return JSONObject().put("mode", "managed").put("userId", fence.userId).put("sessionId", fence.sessionId).put("registrationRevision", java.util.UUID.randomUUID().toString())
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
            listOf("mode", "registrationRevision", "httpBaseUrl", "token", "userId", "sessionId").all { previous.optString(it) == current.optString(it) }
        if (!same) clear.run()
    }
    @JvmStatic fun accepts(configurationId: String, versions: JSONObject, id: String, payload: JSONObject): Boolean {
        if (payload.optString("configurationId") != configurationId || configurationId.isEmpty()) return false
        val sequence = payload.optLong("sequence", -1)
        return sequence > 0 && sequence > versions.optLong(id, 0)
    }
    @JvmStatic fun combine(direct: JSONObject, preferred: JSONObject, managed: JSONObject): JSONObject {
        val result = JSONObject(direct.toString())
        preferred.keys().forEach { result.remove(it) }
        managed.keys().forEach { result.put(it, managed.getJSONObject(it)) }
        return result
    }
    @JvmStatic fun reconcile(managed: JSONObject, status: ConnectAuthStatus): Set<String> {
        if (status.phase !in setOf("signedIn", "signedOut", "unavailable")) return emptySet()
        return managed.keys().asSequence().filter { id ->
            val ref = managed.optJSONObject(id)
            ref == null || ref.optString("userId") != status.userId || ref.optString("sessionId") != status.sessionId
        }.toSet().also { removed -> removed.forEach { managed.remove(it) } }
    }
}
