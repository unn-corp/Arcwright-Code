package com.devotek.t3code.pwa;

import android.app.NotificationManager;
import android.content.Intent;
import android.content.SharedPreferences;
import androidx.core.app.NotificationManagerCompat;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewFeature;
import java.nio.charset.StandardCharsets;
import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.mockito.MockedConstruction;
import org.mockito.MockedStatic;
import static org.junit.Assert.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Replays messages emitted by the actual React coordinator, choice button and JS bridge.
 * Only Android/platform transport and encrypted persistence are replaced, never the handler. */
public class NativeNotificationBridgeTest {
    private final MainActivity activity = mock(MainActivity.class);
    private final SharedPreferences prefs = mock(SharedPreferences.class);
    private final SharedPreferences.Editor editor = mock(SharedPreferences.Editor.class);
    private final NotificationManager manager = mock(NotificationManager.class);
    private final NotificationManagerCompat compat = mock(NotificationManagerCompat.class);
    private final JavaScriptReplyProxy reply = mock(JavaScriptReplyProxy.class);
    private final Map<String, Object> saved = new HashMap<>();
    private JSONObject direct = new JSONObject();
    private JSONObject refs = new JSONObject();
    private JSONObject response;
    private JSONArray requests;
    private NativeNotifications bridge;
    private MockedStatic<NotificationCredentials> credentials;
    private MockedStatic<NativeManagedNotifications> managed;
    private MockedStatic<WebViewFeature> web;
    private MockedStatic<NotificationManagerCompat> notificationManager;
    private MockedConstruction<Intent> intents;

    @Before public void setup() throws Exception {
        String replay = System.getenv("T3_NATIVE_NOTIFICATION_REPLAY_PATH");
        try (InputStream input = replay == null ? getClass().getResourceAsStream("/android-notification-requests.json") : new FileInputStream(replay)) {
            assertNotNull(input);
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(); byte[] chunk = new byte[4096]; int count;
            while ((count = input.read(chunk)) != -1) bytes.write(chunk, 0, count);
            requests = new JSONArray(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
        }
        when(activity.getSharedPreferences(anyString(), anyInt())).thenReturn(prefs);
        when(activity.getSystemService(NotificationManager.class)).thenReturn(manager);
        when(prefs.getString(anyString(), anyString())).thenAnswer(a -> saved.getOrDefault(a.getArgument(0), a.getArgument(1)));
        when(prefs.getBoolean(anyString(), anyBoolean())).thenAnswer(a -> saved.getOrDefault(a.getArgument(0), a.getArgument(1)));
        when(prefs.edit()).thenReturn(editor);
        when(editor.putString(anyString(), anyString())).thenAnswer(a -> { assertTrue(Thread.holdsLock(NotificationCredentials.class)); saved.put(a.getArgument(0), a.getArgument(1)); return editor; });
        when(editor.putBoolean(anyString(), anyBoolean())).thenAnswer(a -> { saved.put(a.getArgument(0), a.getArgument(1)); return editor; });
        when(editor.remove(anyString())).thenAnswer(a -> { assertTrue(Thread.holdsLock(NotificationCredentials.class)); saved.remove(a.getArgument(0)); return editor; });
        credentials = mockStatic(NotificationCredentials.class);
        credentials.when(() -> NotificationCredentials.read(activity)).thenAnswer(a -> new JSONObject(direct.toString()));
        credentials.when(() -> NotificationCredentials.read(activity, NativeManagedNotifications.STORAGE)).thenAnswer(a -> new JSONObject(refs.toString()));
        credentials.when(() -> NotificationCredentials.write(eq(activity), any(JSONObject.class))).thenAnswer(a -> { assertTrue(Thread.holdsLock(NotificationCredentials.class)); direct = new JSONObject(a.<JSONObject>getArgument(1).toString()); return null; });
        managed = mockStatic(NativeManagedNotifications.class);
        managed.when(() -> NativeManagedNotifications.connections(activity)).thenAnswer(a -> NotificationRegistrationPolicy.combine(direct, preferred(), refs, "current"));
        managed.when(() -> NativeManagedNotifications.preserveDormantPreference(eq(activity), any(JSONObject.class), anyString())).thenAnswer(a -> NotificationRegistrationPolicy.preserveDormantPreference(a.getArgument(1), a.getArgument(2), "current"));
        // Production remove is a no-op for unknown/foreign rows and absent logout tombstones.
        managed.when(() -> NativeManagedNotifications.remove(eq(activity), anyString())).thenAnswer(a -> {
            String id = a.getArgument(1);
            if (NotificationRegistrationPolicy.belongs(refs.optJSONObject(id), "current")) refs.remove(id);
            return null;
        });
        web = mockStatic(WebViewFeature.class);
        web.when(() -> WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)).thenReturn(true);
        notificationManager = mockStatic(NotificationManagerCompat.class);
        notificationManager.when(() -> NotificationManagerCompat.from(activity)).thenReturn(compat);
        when(compat.areNotificationsEnabled()).thenReturn(true);
        intents = mockConstruction(Intent.class);
        doAnswer(a -> { response = new JSONObject(a.<String>getArgument(0)); return null; }).when(reply).postMessage(anyString());
        bridge = new NativeNotifications(activity);
    }
    @After public void cleanup() {
        intents.close(); notificationManager.close(); web.close(); managed.close(); credentials.close();
    }
    private JSONObject preferred() throws org.json.JSONException { return new JSONObject((String) saved.getOrDefault("managedPreferred", "{}")); }
    private JSONObject request(int index) throws org.json.JSONException { return new JSONObject(requests.getJSONObject(index).toString()); }
    private void handle(JSONObject request) { response = null; bridge.handle(request.toString(), reply); assertNotNull("Actual handler must reply", response); }
    private void handle(int index) throws org.json.JSONException { handle(request(index)); }
    private void seed(boolean tombstone) throws org.json.JSONException {
        refs = new JSONObject();
        if (!tombstone) refs.put("env", new JSONObject().put("mode", "managed").put("authority", "foreign").put("registrationRevision", "old-managed").put("unknown", "preserved"));
        direct = new JSONObject().put("env", new JSONObject().put("httpBaseUrl", "https://saved-direct.test/").put("token", "saved-pairing").put("registrationRevision", "old-direct"));
        saved.clear(); saved.put("managedPreferred", "{ \"env\":true, \"other\":\"preserve-choice\" }"); saved.put("state:env", "old-queued-state");
    }
    @Test public void automaticMountAndAccountChangeNeverReplaceForeignChoiceOrLogoutTombstone() throws Exception {
        for (boolean tombstone : new boolean[]{false, true}) {
            seed(tombstone); String choices = (String) saved.get("managedPreferred"); String rawRefs = refs.toString(); String rawDirect = direct.toString();
            handle(0); handle(1); handle(2);
            assertFalse(response.has("error")); assertEquals(choices, saved.get("managedPreferred")); assertEquals(rawRefs, refs.toString()); assertEquals(rawDirect, direct.toString());
            assertFalse(NativeManagedNotifications.connections(activity).has("env")); assertEquals("old-queued-state", saved.get("state:env"));
        }
    }
    @Test public void configureAbsentEnvironmentPreservesRawPreferencesAndDormantDirectCredentials() throws Exception {
        for (boolean tombstone : new boolean[]{false, true}) {
            seed(tombstone); String choices = (String) saved.get("managedPreferred"); String rawDirect = direct.toString(); String rawRefs = refs.toString();
            handle(4);
            assertFalse(response.has("error")); assertEquals(choices, saved.get("managedPreferred")); assertEquals(rawDirect, direct.toString()); assertEquals(rawRefs, refs.toString());
            assertFalse(NativeManagedNotifications.connections(activity).has("env"));
        }
    }
    @Test public void actualUserClickSelectsCurrentPairedRouteWithNewRevisionAndClearsOnlyItsChoice() throws Exception {
        for (boolean tombstone : new boolean[]{false, true}) {
            seed(tombstone); String rawRefs = refs.toString(); handle(0); handle(1); handle(3);
            assertFalse(response.has("error")); assertFalse(preferred().has("env")); assertEquals("preserve-choice", preferred().getString("other"));
            assertEquals(rawRefs, refs.toString()); assertTrue(NativeManagedNotifications.connections(activity).has("env"));
            assertNotEquals("old-direct", direct.getJSONObject("env").getString("registrationRevision")); assertFalse(saved.containsKey("state:env"));
        }
    }
    @Test public void virginDirectRegistrationStillWorksAndKeepsItsRevisionOnAutomaticAccountChange() throws Exception {
        String unrelatedChoices = "{ \"other\":\"preserve-foreign-choice\" }";
        saved.put("managedPreferred", unrelatedChoices);
        handle(0); handle(1); assertFalse(response.has("error")); assertTrue(NativeManagedNotifications.connections(activity).has("env"));
        String revision = direct.getJSONObject("env").getString("registrationRevision"); handle(2);
        assertEquals(revision, direct.getJSONObject("env").getString("registrationRevision")); assertEquals("saved-pairing", direct.getJSONObject("env").getString("token"));
        assertEquals(unrelatedChoices, saved.get("managedPreferred"));
    }
    @Test public void failedExplicitCredentialWriteKeepsSuppressionReferenceAndQueuedState() throws Exception {
        seed(false); handle(0); String choices = (String) saved.get("managedPreferred"); String rawRefs = refs.toString(); String rawDirect = direct.toString();
        credentials.when(() -> NotificationCredentials.write(eq(activity), any(JSONObject.class))).thenThrow(new IllegalStateException("fixture storage unavailable"));
        handle(3); assertTrue(response.has("error"));
        assertEquals(choices, saved.get("managedPreferred")); assertEquals(rawRefs, refs.toString()); assertEquals(rawDirect, direct.toString());
        assertEquals("old-queued-state", saved.get("state:env")); assertFalse(NativeManagedNotifications.connections(activity).has("env"));
    }
    @Test public void explicitChoiceRejectsDisabledRemovedPermissionDeniedStaleAndMalformedRequests() throws Exception {
        seed(true); String choices = (String) saved.get("managedPreferred"); String rawDirect = direct.toString();
        handle(0); handle(5); handle(3); assertTrue(response.has("error")); verify(manager).cancelAll();
        handle(4); JSONObject removed = request(3); removed.getJSONObject("payload").put("configurationId", saved.get("configurationId")).put("sequence", 100); handle(removed); assertTrue(response.has("error"));
        handle(0); when(compat.areNotificationsEnabled()).thenReturn(false); handle(3); assertTrue(response.has("error")); when(compat.areNotificationsEnabled()).thenReturn(true);
        JSONObject stale = request(3); stale.getJSONObject("payload").put("configurationId", "old-config"); handle(stale); assertTrue(response.has("error"));
        saved.put("registrationVersions", "{\"env\":100}"); handle(3); assertTrue(response.has("error")); saved.put("registrationVersions", "{}");
        JSONObject malformed = request(3); malformed.getJSONObject("payload").put("authority", "caller-selected"); handle(malformed); assertTrue(response.has("error"));
        assertEquals(choices, saved.get("managedPreferred")); assertEquals(rawDirect, direct.toString()); assertEquals("old-queued-state", saved.get("state:env"));
        verify(activity, atLeastOnce()).stopService(any(Intent.class));
    }
}
