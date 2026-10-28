import { useEffect } from "react";

import { getExistingBrowserPushSubscription } from "./browserNotifications";
import { canSyncPwaPushSubscription } from "./pwaPushRelay";

/** Enabled preferences are intent, never authority to enroll an existing browser endpoint. */
export function usePwaPushSubscriptionSync({
  enabled,
  applicationServerKey,
  onSubscription,
  onMissingSubscription,
  onBindingMismatch,
}: {
  readonly enabled: boolean;
  readonly applicationServerKey: string | null;
  readonly onSubscription: (subscription: PushSubscription, signal: AbortSignal) => Promise<void>;
  readonly onMissingSubscription: () => void;
  readonly onBindingMismatch: () => void;
}) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- synchronizes the browser push subscription with its server binding and aborts the mounted request on cleanup
  useEffect(() => {
    if (!enabled || !applicationServerKey) return;
    let cancelled = false;
    const controller = new AbortController();
    void getExistingBrowserPushSubscription()
      .then((subscription) => {
        if (cancelled) return;
        if (subscription) {
          if (!canSyncPwaPushSubscription(subscription, applicationServerKey)) {
            onBindingMismatch();
            return;
          }
          return onSubscription(subscription, controller.signal);
        }
        // Re-enabling must remain an explicit tap to satisfy iOS push activation.
        onMissingSubscription();
      })
      .catch(() => {
        // Offline does not prove that the subscription or its binding is gone.
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [enabled, applicationServerKey, onSubscription, onMissingSubscription, onBindingMismatch]);
}
