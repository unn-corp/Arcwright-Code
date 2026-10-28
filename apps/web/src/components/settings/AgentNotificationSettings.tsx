import { useStableCallback } from "../../hooks/useStableCallback";
import {
  AGENT_NOTIFICATION_SOUND_IDS,
  type AgentNotificationKind,
  type AgentNotificationSoundId,
  type AgentNotificationSounds,
} from "@t3tools/contracts";
import { PlayIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useClientSettings, updateClientSettings } from "../../hooks/useSettings";
import { usePrimaryEnvironment } from "../../state/environments";
import {
  agentNotificationSoundLabel,
  playAgentNotificationSoundId,
} from "../../agentNotifications/sound";
import {
  getBrowserNotificationStatus,
  requestBrowserNotificationPermission,
  showBrowserNotificationPreview,
  subscribeBrowserPush,
  unsubscribeBrowserPush,
  type BrowserNotificationStatus,
} from "../../agentNotifications/browserNotifications";
import {
  getPwaPushSubscriptionId,
  getPwaPushRelayProfile,
  isPwaPushAuthorityResetRequired,
  isPwaPushRemovalPending,
  getPwaPushRemovalState,
  PwaPushRemovalPendingError,
  resetPwaPushAuthority,
  hasPendingPwaPushCleanup,
  markPendingPwaPushCleanup,
  registerPwaPushSubscription,
  removePwaPushSubscription,
  testPwaPushSubscription,
} from "../../agentNotifications/pwaPushRelay";
import { usePwaNotificationSetup } from "../../agentNotifications/usePwaNotificationSetup";
import { usePwaPushSubscriptionSync } from "../../agentNotifications/usePwaPushSubscriptionSync";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export const AGENT_NOTIFICATION_SOUND_ROWS: readonly {
  readonly kind: AgentNotificationKind;
  readonly title: string;
}[] = [
  { kind: "agent_completed", title: "Agent finished sound" },
  { kind: "plan_ready", title: "Plan ready sound" },
  { kind: "input_required", title: "Needs input sound" },
  { kind: "agent_failed", title: "Agent failed sound" },
];

export function PwaNotificationSettings() {
  const primaryEnvironment = usePrimaryEnvironment();
  const notificationPreferences = useClientSettings((value) => value.agentNotifications);
  const [status, setStatus] = useState<BrowserNotificationStatus>(() =>
    getBrowserNotificationStatus(),
  );
  const {
    vapidPublicKey,
    isConfigLoading,
    setupState,
    hasBrowserSubscription,
    retry: retryNotificationSetup,
  } = usePwaNotificationSetup();
  const [isSaving, setIsSaving] = useState(false);
  const actionRef = useRef(0);
  const mountedRef = useRef(false);
  const remoteRemovalRef = useRef<Promise<void> | null>(null);
  const [remoteCleanupState, setRemoteCleanupState] = useState(getPwaPushRemovalState);
  const enableControllerRef = useRef<AbortController | null>(null);
  const [localCleanupRequired, setLocalCleanupRequired] = useState(false);
  const [bindingMismatch, setBindingMismatch] = useState(false);
  const [cleanupPending, setCleanupPending] = useState(hasPendingPwaPushCleanup);
  const subscriptionId = getPwaPushSubscriptionId();
  const localCleanupNeeded =
    localCleanupRequired || (!notificationPreferences.enabled && hasBrowserSubscription === true);
  const needsReset =
    localCleanupNeeded ||
    bindingMismatch ||
    setupState === "reset-required" ||
    isPwaPushAuthorityResetRequired() ||
    remoteCleanupState === "uncertain";

  const refreshStatus = useStableCallback(() => {
    setStatus(getBrowserNotificationStatus());
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns notification focus listeners and cancels the active push operation when the settings surface unmounts
  useEffect(() => {
    mountedRef.current = true;
    window.addEventListener("focus", refreshStatus);
    document.addEventListener("visibilitychange", refreshStatus);
    return () => {
      mountedRef.current = false;
      ++actionRef.current;
      enableControllerRef.current?.abort();
      window.removeEventListener("focus", refreshStatus);
      document.removeEventListener("visibilitychange", refreshStatus);
    };
  }, [refreshStatus]);

  const updatePreferences = (patch: Partial<typeof notificationPreferences>) => {
    updateClientSettings({
      agentNotifications: { ...notificationPreferences, ...patch },
    });
  };

  const persistRemoteSubscription = async (
    subscription: PushSubscription,
    preferences: typeof notificationPreferences,
    explicitEnable = false,
    signal?: AbortSignal,
  ) => {
    if (!primaryEnvironment) throw new Error("Connect this PWA to an Arcwright Code server first.");
    if (!vapidPublicKey) throw new Error("Remote notifications are unavailable.");
    return await (async () => {
      await registerPwaPushSubscription({
        environmentId: primaryEnvironment.environmentId,
        subscription,
        preferences,
        applicationServerKey: vapidPublicKey,
        explicitEnable,
        signal,
      });
    })().finally(() => {
      if (mountedRef.current) setRemoteCleanupState(getPwaPushRemovalState());
    });
  };

  const enableNotifications = async () => {
    if (isPwaPushRemovalPending()) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Remote cleanup is pending",
          description: new PwaPushRemovalPendingError(getPwaPushRemovalState() === "uncertain")
            .message,
        }),
      );
      return;
    }
    if (needsReset || setupState === "unavailable") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Remote notifications are unavailable",
          description: needsReset
            ? "Reset this browser subscription before enabling notifications again."
            : "This Connect profile does not offer anonymous PWA push. Local previews remain available.",
        }),
      );
      return;
    }
    if (!vapidPublicKey || setupState !== "ready") {
      if (!isConfigLoading) retryNotificationSetup();
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Remote notifications are unavailable",
          description: isConfigLoading
            ? "The relay configuration is still loading. Try again in a moment."
            : "Retrying this device's notification setup. Tap Enable notifications again once setup finishes.",
        }),
      );
      return;
    }
    const action = ++actionRef.current;
    enableControllerRef.current?.abort();
    const controller = new AbortController();
    enableControllerRef.current = controller;
    setIsSaving(true);
    return await (async () => {
      // This is intentionally the first awaited browser operation in the click handler:
      // iOS only permits PushManager.subscribe while the direct user gesture is still valid.
      const result = await subscribeBrowserPush({ applicationServerKey: vapidPublicKey });
      if (result.state !== "subscribed" || result.subscription === null) {
        setStatus(
          result.state === "permission-blocked" ? "permission-blocked" : "permission-needed",
        );
        throw new Error(
          result.state === "not-installed"
            ? "Install Arcwright Code on your Home Screen before enabling push notifications."
            : result.state === "worker-failed"
              ? "Preparing this device for notifications. Tap Enable notifications again in a moment."
              : result.state === "permission-granted"
                ? "Permission is granted. Tap Enable notifications once more to subscribe this installation."
                : "Allow notifications for Arcwright Code, then try again.",
        );
      }
      if (action !== actionRef.current) return;
      const preferences = { ...notificationPreferences, enabled: true };
      await persistRemoteSubscription(result.subscription, preferences, true, controller.signal);
      if (action !== actionRef.current) return;
      setBindingMismatch(false);
      updateClientSettings({ agentNotifications: preferences });
      setStatus("ready");
      toastManager.add(
        stackedThreadToast({ type: "success", title: "Remote notifications enabled" }),
      );
    })()
      .catch((error: unknown) => {
        if (action !== actionRef.current) return;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not enable notifications",
            description:
              error instanceof Error ? error.message : "Try again after reloading the PWA.",
          }),
        );
      })
      .finally(() => {
        if (action === actionRef.current) setIsSaving(false);
      });
  };

  const synchronizeSubscription = (subscription: PushSubscription, signal: AbortSignal) =>
    persistRemoteSubscription(subscription, notificationPreferences, false, signal);
  const repairMissingSubscription = () => {
    updatePreferences({ enabled: false });
    markPendingPwaPushCleanup();
    setCleanupPending(true);
  };
  const reportBindingMismatch = () => setBindingMismatch(true);
  usePwaPushSubscriptionSync({
    enabled: notificationPreferences.enabled && setupState === "ready" && !bindingMismatch,
    applicationServerKey: vapidPublicKey,
    onSubscription: synchronizeSubscription,
    onMissingSubscription: repairMissingSubscription,
    onBindingMismatch: reportBindingMismatch,
  });

  const disableNotifications = async (intent: "disable" | "reset" = "disable") => {
    const action = ++actionRef.current;
    const profile = getPwaPushRelayProfile();
    enableControllerRef.current?.abort();
    updatePreferences({ enabled: false });
    setIsSaving(true);
    // Remote completion never owns the local busy state. Repeated local retries share
    // one module-bound removal; pending enrollment is fenced until that request settles.
    if (subscriptionId) {
      const pending = removePwaPushSubscription(subscriptionId);
      if (remoteRemovalRef.current !== pending) {
        remoteRemovalRef.current = pending;
        setRemoteCleanupState(getPwaPushRemovalState());
        markPendingPwaPushCleanup();
        setCleanupPending(true);
        void pending
          .catch(() => {
            // The persistent advisory and saved record retain unresolved cleanup.
          })
          .finally(() => {
            if (remoteRemovalRef.current !== pending) return;
            remoteRemovalRef.current = null;
            if (mountedRef.current) setRemoteCleanupState(getPwaPushRemovalState());
          });
      }
    } else {
      markPendingPwaPushCleanup();
      setCleanupPending(true);
    }
    const localResult = await unsubscribeBrowserPush().then(
      () => ({ status: "fulfilled" as const }),
      () => ({ status: "rejected" as const }),
    );
    if (action !== actionRef.current) return;
    setLocalCleanupRequired(localResult.status === "rejected");
    return await (async () => {
      if (localResult.status === "rejected")
        throw new Error(
          "Your notification preference is off, but browser push cleanup is incomplete. Retry Disable or Reset browser push.",
        );
      // Local Disable never authorizes credential rotation, even if remote cleanup
      // became uncertain while unsubscribe was pending. Reset is a separate tap.
      if (intent === "reset") resetPwaPushAuthority(profile);
      setRemoteCleanupState(getPwaPushRemovalState());
      setBindingMismatch(false);
    })()
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not reset browser push",
            description:
              error instanceof Error
                ? error.message
                : "Retry Reset browser push when the browser and local storage are ready.",
          }),
        );
      })
      .finally(() => {
        retryNotificationSetup();
        setIsSaving(false);
      });
  };

  const remoteTest = () => {
    if (!subscriptionId) return;
    void (async () => {
      try {
        await testPwaPushSubscription(subscriptionId);
        toastManager.add(stackedThreadToast({ type: "success", title: "Remote test queued" }));
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not queue remote test",
            description:
              error instanceof Error ? error.message : "Try enabling notifications again.",
          }),
        );
      }
    })();
  };

  const previewNotification = () => {
    // A local preview may request permission even when this profile has no remote relay.
    void requestBrowserNotificationPermission()
      .then((permission) => {
        if (permission !== "ready")
          throw new Error("Allow browser notifications before sending a preview.");
        return showBrowserNotificationPreview();
      })
      .then((nextStatus) => {
        setStatus(nextStatus);
        if (nextStatus === "ready") {
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: "Preview notification sent",
              description: "Check this device's notification center if no banner appears.",
            }),
          );
          return;
        }
        throw new Error("Browser notifications are not ready.");
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not send preview notification",
            description:
              error instanceof Error ? error.message : "Try enabling notifications again.",
          }),
        );
      });
  };

  const statusDescription: Record<BrowserNotificationStatus, string> = {
    unsupported: "Notifications are not supported by this browser or device.",
    "permission-needed": "Allow notifications to enable alerts on this browser or PWA.",
    "permission-blocked": "Notifications are blocked by your browser or system settings.",
    ready: notificationPreferences.enabled
      ? "Notifications are on for this browser or PWA."
      : "Notifications are available on this browser or PWA.",
  };
  const canManagePreferences = status === "ready" && notificationPreferences.enabled;

  return (
    <SettingsSection {...searchableSetting("notifications")}>
      <SettingsRow
        title="Notifications on this device"
        description={
          localCleanupNeeded
            ? "Your notification preference is off, but browser push cleanup is still required. Retry Disable or Reset browser push."
            : needsReset
              ? "This device's saved notification registration needs reset. Reset browser push, then enable it with a separate tap. Previous service cleanup may remain pending."
              : setupState === "unavailable"
                ? "Anonymous PWA push is unavailable for this Connect profile. Local previews remain available."
                : setupState === "offline"
                  ? "The notification service is temporarily unavailable. Saved settings are preserved."
                  : statusDescription[status]
        }
        control={
          <Switch
            checked={notificationPreferences.enabled}
            disabled={status === "unsupported" || isSaving}
            onCheckedChange={(checked) => {
              if (checked) {
                void enableNotifications();
              } else {
                void disableNotifications();
              }
            }}
            aria-label="Enable notifications on this device"
          />
        }
      />

      {setupState === "offline" || setupState === "unavailable" ? (
        <SettingsRow
          title="Retry notification setup"
          description="Checks this profile's notification capability again."
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={isSaving}
              onClick={retryNotificationSetup}
            >
              Retry setup
            </Button>
          }
        />
      ) : null}
      {needsReset ? (
        <SettingsRow
          title="Reset browser push"
          description="Unsubscribes locally. Then tap Enable notifications separately."
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={isSaving}
              onClick={() => void disableNotifications("reset")}
            >
              Reset browser push
            </Button>
          }
        />
      ) : null}
      {status !== "unsupported" && !canManagePreferences ? (
        <SettingsRow
          title="Preview notification"
          description="Sends a local browser notification on this installation."
          control={
            <Button size="xs" variant="outline" onClick={previewNotification}>
              Send preview
            </Button>
          }
        />
      ) : null}
      {!canManagePreferences &&
      (notificationPreferences.enabled ||
        needsReset ||
        cleanupPending ||
        setupState === "unavailable" ||
        setupState === "offline") ? (
        <SettingsRow
          title="Disable notifications"
          description="Turns off this device's notification preference and unsubscribes locally."
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={isSaving}
              onClick={() => void disableNotifications()}
            >
              Disable
            </Button>
          }
        />
      ) : null}
      {remoteCleanupState !== "none" ? (
        <p className="px-4 pb-2 text-xs text-muted-foreground">
          {remoteCleanupState === "uncertain"
            ? "Remote notification setup or cleanup has an uncertain outcome. Local Disable and Reset remain available. In owned mode, Reset preserves the old authority and prepares fresh enrollment; legacy credentials cannot be safely renewed until old service setup and cleanup are confirmed."
            : "Remote notification setup or cleanup is pending. Local Disable and Reset remain available. Enable notifications again after the remote request finishes."}
        </p>
      ) : null}
      {cleanupPending ? (
        <p className="px-4 pb-2 text-xs text-muted-foreground">
          Previous remote registration cleanup may still be pending. Reset and Disable attempt local
          unsubscription; retry if browser cleanup fails. They cannot revoke a previous service
          while it is unavailable.
        </p>
      ) : null}
      {canManagePreferences ? (
        <>
          <SettingsRow
            title="Preview notification"
            description="Sends a local browser notification on this installation."
            control={
              <Button size="xs" variant="outline" onClick={previewNotification}>
                Send preview
              </Button>
            }
          />
          <SettingsRow
            title="Remote test"
            description="Queues a remote notification for this anonymous PWA installation."
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={
                  subscriptionId === null || isSaving || needsReset || setupState !== "ready"
                }
                onClick={remoteTest}
              >
                Send remote test
              </Button>
            }
          />
          <SettingsRow
            title="Agent finished"
            description="Notify when agent work completes."
            control={
              <Switch
                checked={notificationPreferences.notifyOnCompletion}
                onCheckedChange={(checked) =>
                  updatePreferences({ notifyOnCompletion: Boolean(checked) })
                }
                aria-label="Notify when an agent finishes"
              />
            }
          />
          <SettingsRow
            title="Plan ready"
            description="Notify when an agent proposes a plan for review."
            control={
              <Switch
                checked={notificationPreferences.notifyOnPlanReady}
                onCheckedChange={(checked) =>
                  updatePreferences({ notifyOnPlanReady: Boolean(checked) })
                }
                aria-label="Notify when a plan is ready"
              />
            }
          />
          <SettingsRow
            title="Input needed"
            description="Notify when an agent needs approval or a response."
            control={
              <Switch
                checked={notificationPreferences.notifyOnInput}
                onCheckedChange={(checked) =>
                  updatePreferences({ notifyOnInput: Boolean(checked) })
                }
                aria-label="Notify when agent input is needed"
              />
            }
          />
          <SettingsRow
            title="Agent failed"
            description="Notify when an agent run ends with an error."
            control={
              <Switch
                checked={notificationPreferences.notifyOnFailure}
                onCheckedChange={(checked) =>
                  updatePreferences({ notifyOnFailure: Boolean(checked) })
                }
                aria-label="Notify when an agent fails"
              />
            }
          />
          <SettingsRow
            title="Show project and thread names"
            description="Turn this off to hide work names in notifications and on your lock screen."
            control={
              <Switch
                checked={notificationPreferences.showProjectAndThreadNames}
                onCheckedChange={(checked) =>
                  updatePreferences({ showProjectAndThreadNames: Boolean(checked) })
                }
                aria-label="Show project and thread names in notifications"
              />
            }
          />
          <SettingsRow
            title="Disable notifications"
            description="Turns off notifications for this browser or PWA installation."
            control={
              <Button size="xs" variant="outline" onClick={() => void disableNotifications()}>
                Disable
              </Button>
            }
          />
        </>
      ) : null}
      <p className="px-4 pb-2 text-xs text-muted-foreground">
        These settings apply only to this browser or PWA installation, not to your desktop app or
        other devices.
      </p>
    </SettingsSection>
  );
}

export function AgentNotificationSoundRow({
  kind,
  title,
  sounds,
  onChange,
}: {
  readonly kind: AgentNotificationKind;
  readonly title: string;
  readonly sounds: AgentNotificationSounds;
  readonly onChange: (kind: AgentNotificationKind, soundId: AgentNotificationSoundId) => void;
}) {
  const selected = sounds[kind];
  return (
    <SettingsRow
      title={title}
      description="Pick the sound this notification plays, or turn it off with None."
      control={
        <div className="flex w-full items-center gap-2 sm:w-56">
          <Select
            value={selected}
            onValueChange={(value) => onChange(kind, value as AgentNotificationSoundId)}
          >
            <SelectTrigger className="w-full" aria-label={title}>
              <SelectValue>{agentNotificationSoundLabel(selected)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {AGENT_NOTIFICATION_SOUND_IDS.map((soundId) => (
                <SelectItem hideIndicator key={soundId} value={soundId}>
                  {agentNotificationSoundLabel(soundId)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Button
            size="xs"
            variant="outline"
            className="shrink-0"
            disabled={selected === "none"}
            onClick={() => playAgentNotificationSoundId(selected)}
            aria-label={`Preview ${title}`}
          >
            <PlayIcon className="size-3.5" />
          </Button>
        </div>
      }
    />
  );
}
