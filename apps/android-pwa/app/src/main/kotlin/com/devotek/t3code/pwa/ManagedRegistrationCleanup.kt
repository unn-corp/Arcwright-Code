package com.devotek.t3code.pwa

import org.json.JSONObject

/** A rejected exchange owns one registration revision, never every registration for that environment. */
class ManagedRegistrationCleanup(
    private val lock: Any,
    private val read: () -> JSONObject,
    private val write: (JSONObject) -> Unit,
    private val current: (ConnectAuthStatus) -> Boolean,
    private val removeDependents: (String, JSONObject, ConnectAuthStatus) -> Unit,
    private val authority: () -> String? = { null },
) {
    fun reject(id: String, expected: JSONObject, fence: ConnectAuthStatus): Boolean = synchronized(lock) {
        val revision = expected.optString("registrationRevision")
        if (!NotificationRegistrationPolicy.belongs(expected, authority())) return@synchronized false
        if (revision.isEmpty() || expected.optString("userId") != fence.userId || expected.optString("sessionId") != fence.sessionId || !current(fence)) return@synchronized false
        val refs = read()
        val actual = refs.optJSONObject(id) ?: return@synchronized false
        if (!NotificationRegistrationPolicy.belongs(actual, authority())) return@synchronized false
        if (actual.optString("registrationRevision") != revision || actual.optString("userId") != fence.userId || actual.optString("sessionId") != fence.sessionId) return@synchronized false
        refs.remove(id)
        write(refs)
        // State removal is inside the same lock as registration writes. Deferred eviction must
        // additionally compare this revision/fence when it eventually reaches the token cache.
        removeDependents(id, actual, fence)
        true
    }
}
