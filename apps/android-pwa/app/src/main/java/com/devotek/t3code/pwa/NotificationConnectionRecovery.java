package com.devotek.t3code.pwa;

/** Denied admission retries the same owner only while its registration/account fence survives. */
final class NotificationConnectionRecovery {
    static boolean admit(boolean authorized, boolean owned, Runnable retry, Runnable discard) {
        if (!owned) { discard.run(); return false; }
        if (!authorized) { retry.run(); return false; }
        return true;
    }
}
