package com.devotek.t3code.pwa;

import org.junit.Test;
import static org.junit.Assert.*;

public final class ConnectionNotificationStateTest {
    @Test public void repeatedAppRefreshDoesNotRestartTheNotification() {
        ConnectionNotificationState state = new ConnectionNotificationState();
        assertTrue(state.start());
        assertFalse(state.start());
        assertFalse(state.start());
    }

    @Test public void aNewServiceInstancePostsItsRequiredInitialNotification() {
        ConnectionNotificationState first = new ConnectionNotificationState();
        first.start();
        assertTrue(new ConnectionNotificationState().start());
    }
}
