package com.devotek.t3code.pwa

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NotificationRegistrationPolicyTest {
    private fun ref(user: String = "user", session: String = "session") = JSONObject().put("mode", "managed").put("authority", "fixture-authority").put("userId", user).put("sessionId", session).put("registrationRevision", "revision")
    @Test fun managedLogoutAndAccountSwitchRemoveOnlyManagedRefsAndNeverResurrectDormantDirect() {
        val direct = JSONObject().put("managed", JSONObject().put("token", "paired-direct")).put("direct", JSONObject().put("token", "another-direct"))
        val preferred = JSONObject().put("managed", true)
        for (status in listOf(ConnectAuthStatus(true, "signedOut"), ConnectAuthStatus(true, "signedIn", 2, "other", "other-session"))) {
            val managed = JSONObject().put("managed", ref())
            assertEquals(setOf("managed"), NotificationRegistrationPolicy.reconcile(managed, status, "fixture-authority"))
            val selected = NotificationRegistrationPolicy.combine(direct, preferred, managed, "fixture-authority")
            assertFalse(selected.has("managed")); assertEquals("another-direct", selected.getJSONObject("direct").getString("token"))
            assertEquals("paired-direct", direct.getJSONObject("managed").getString("token"))
        }
    }
    @Test fun pendingSdkRestoreAndNetworkFailureRetainRefsAndSameEstablishedIdentityIgnoresOldProcessGeneration() {
        val refs = JSONObject().put("managed", ref()).put("other", ref("other", "other-session"))
        for (status in listOf(ConnectAuthStatus(true, "initializing"), ConnectAuthStatus(true, "error"))) {
            assertTrue(NotificationRegistrationPolicy.reconcile(refs, status, "fixture-authority").isEmpty()); assertEquals(2, refs.length())
        }
        assertEquals(setOf("other"), NotificationRegistrationPolicy.reconcile(refs, ConnectAuthStatus(true, "signedIn", 1, "user", "session"), "fixture-authority"))
        assertTrue(refs.has("managed"))
    }
    @Test fun currentOrderedDirectSelectionReplacesManagedWhileLateManagedAndOldConfigurationsAreRejected() {
        val versions = JSONObject().put("env", 10)
        val current = JSONObject().put("configurationId", "current").put("sequence", 11)
        assertTrue(NotificationRegistrationPolicy.accepts("current", versions, "env", current))
        versions.put("env", 11)
        assertFalse(NotificationRegistrationPolicy.accepts("current", versions, "env", current))
        assertFalse(NotificationRegistrationPolicy.accepts("current", versions, "env", JSONObject().put("configurationId", "old").put("sequence", 100)))
        val direct = JSONObject().put("env", JSONObject().put("token", "direct"))
        val refs = JSONObject().put("env", ref()); val preferred = JSONObject().put("env", true)
        assertEquals("managed", NotificationRegistrationPolicy.combine(direct, preferred, refs, "fixture-authority").getJSONObject("env").getString("mode"))
        refs.remove("env"); preferred.remove("env")
        assertEquals("direct", NotificationRegistrationPolicy.combine(direct, preferred, refs, "fixture-authority").getJSONObject("env").getString("token"))
    }
}
