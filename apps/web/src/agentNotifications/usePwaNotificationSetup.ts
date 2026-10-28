import { useEffect, useState } from "react";

import { registerPwaServiceWorker } from "../pwa";
import { getExistingBrowserPushSubscription } from "./browserNotifications";
import {
  canSyncPwaPushSubscription,
  getPwaPushConfig,
  getPwaPushRelayProfile,
  PwaPushUnavailableError,
} from "./pwaPushRelay";

export type PwaNotificationSetupState =
  | "loading"
  | "ready"
  | "reset-required"
  | "offline"
  | "unavailable";

/** Preload push setup so subscribing can remain the first await in the next direct iOS tap. */
export function usePwaNotificationSetup() {
  const [vapidPublicKey, setVapidPublicKey] = useState<string | null>(null);
  const [setupState, setSetupState] = useState<PwaNotificationSetupState>("loading");
  const [hasBrowserSubscription, setHasBrowserSubscription] = useState<boolean | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = () => {
    setVapidPublicKey(null);
    setSetupState("loading");
    setAttempt((value) => value + 1);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns service-worker push discovery and focus/online listeners while the notification setup surface is mounted
  useEffect(() => {
    let cancelled = false;
    let configLoaded = false;
    let configLoading = false;
    let unavailable = false;
    const prepare = () => {
      void registerPwaServiceWorker();
      if (cancelled || configLoaded || configLoading || unavailable) return;
      const browserSubscription = getExistingBrowserPushSubscription().then((subscription) => {
        if (!cancelled) setHasBrowserSubscription(subscription !== null);
        return subscription;
      });
      if (getPwaPushRelayProfile().type === "blocked") {
        unavailable = true;
        setSetupState("unavailable");
        void browserSubscription.catch(() => {
          /* Local cleanup remains available when inspection fails. */
        });
        return;
      }
      configLoading = true;
      setSetupState("loading");
      void Promise.all([getPwaPushConfig(), browserSubscription])
        .then(([key, subscription]) => {
          configLoaded = true;
          if (cancelled) return;
          setVapidPublicKey(key);
          setSetupState(
            subscription && !canSyncPwaPushSubscription(subscription, key)
              ? "reset-required"
              : "ready",
          );
        })
        .catch((error: unknown) => {
          unavailable = error instanceof PwaPushUnavailableError;
          if (!cancelled) setSetupState(unavailable ? "unavailable" : "offline");
        })
        .finally(() => {
          configLoading = false;
        });
    };
    const prepareWhenVisible = () => {
      if (document.visibilityState === "visible") prepare();
    };
    prepare();
    window.addEventListener("online", prepare);
    window.addEventListener("focus", prepareWhenVisible);
    document.addEventListener("visibilitychange", prepareWhenVisible);
    return () => {
      cancelled = true;
      window.removeEventListener("online", prepare);
      window.removeEventListener("focus", prepareWhenVisible);
      document.removeEventListener("visibilitychange", prepareWhenVisible);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Explicit retry restarts this cancelled preparation scope.
  }, [attempt]);

  return {
    vapidPublicKey,
    setupState,
    hasBrowserSubscription,
    isConfigLoading: setupState === "loading",
    retry,
  };
}
