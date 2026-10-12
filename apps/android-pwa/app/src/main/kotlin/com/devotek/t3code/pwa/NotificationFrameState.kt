package com.devotek.t3code.pwa

import org.json.JSONObject

/** Parsing admission cannot authorize later watermark writes or alert publication. */
class NotificationFrameState(
    private val lock: Any,
    private val selected: (String) -> JSONObject?,
    private val accountCurrent: (ConnectAuthStatus) -> Boolean,
    private val write: (String, String) -> Unit,
) {
    private fun matches(id: String, expected: JSONObject, fence: ConnectAuthStatus?): Boolean {
        val actual = selected(id) ?: return false
        val managed = expected.optString("mode") == "managed"
        if (managed != (actual.optString("mode") == "managed") || expected.optString("registrationRevision") != actual.optString("registrationRevision")) return false
        if (!managed) return actual.optString("httpBaseUrl") == expected.optString("httpBaseUrl") && actual.optString("token") == expected.optString("token")
        return fence != null && expected.optString("registrationRevision").isNotEmpty() &&
            actual.optString("userId") == expected.optString("userId") && actual.optString("sessionId") == expected.optString("sessionId") &&
            expected.optString("userId") == fence.userId && expected.optString("sessionId") == fence.sessionId && accountCurrent(fence)
    }
    fun current(id: String, expected: JSONObject, fence: ConnectAuthStatus?): Boolean = synchronized(lock) { matches(id, expected, fence) }
    fun publish(id: String, expected: JSONObject, fence: ConnectAuthStatus?, post: () -> Unit): Boolean = synchronized(lock) {
        if (!matches(id, expected, fence)) return@synchronized false
        post()
        true
    }
    fun persist(id: String, expected: JSONObject, fence: ConnectAuthStatus?, state: String): Boolean = synchronized(lock) {
        if (!matches(id, expected, fence)) return@synchronized false
        write(id, state)
        true
    }
}
