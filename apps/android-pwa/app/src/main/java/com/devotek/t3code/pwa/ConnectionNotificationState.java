package com.devotek.t3code.pwa;

/** Reconnecting or refreshing credentials must not repost a dismissed service notification. */
final class ConnectionNotificationState {
    private boolean started;

    synchronized boolean start() {
        if (started) return false;
        started = true;
        return true;
    }
}
