import type {
  AgentNotificationEvent,
  AgentNotificationKind,
  AgentNotificationSoundId,
} from "@t3tools/contracts";
import { useClientSettings, updateClientSettings } from "../../hooks/useSettings";
import { isAndroidPwa, isElectron } from "../../env";
import {
  playAgentNotificationSound,
  playAgentNotificationSoundId,
} from "../../agentNotifications/sound";
import {
  PwaNotificationSettings,
  AgentNotificationSoundRow,
  AGENT_NOTIFICATION_SOUND_ROWS,
} from "./AgentNotificationSettings";
import { AndroidNotificationSettings } from "./AndroidNotificationSettings";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { stackedThreadToast, toastManager } from "../ui/toast";
export function NotificationSettings() {
  const notificationPreferences = useClientSettings((value) => value.agentNotifications);
  const sendNotificationTest = () => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.showAgentNotification !== "function") return;

    const event: AgentNotificationEvent = {
      eventId: `desktop-notification-test:${Date.now()}` as AgentNotificationEvent["eventId"],
      environmentId: "desktop-notification-test" as AgentNotificationEvent["environmentId"],
      threadId: "desktop-notification-test" as AgentNotificationEvent["threadId"],
      kind: "agent_completed",
      occurredAt: new Date().toISOString(),
      deepLink:
        "/threads/desktop-notification-test/desktop-notification-test" as AgentNotificationEvent["deepLink"],
      threadTitle: "Arcwright Code notification test",
    };

    void bridge.showAgentNotification(event).then((outcome) => {
      if (outcome === "attempted") {
        if (notificationPreferences.playSound) {
          playAgentNotificationSound("agent_completed", notificationPreferences.sounds);
        }
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "Test notification sent",
            description: "Check your system notification center if no banner appears.",
          }),
        );
      } else {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not send test notification",
            description: `Notification result: ${outcome}.`,
          }),
        );
      }
    });
  };
  const setNotificationSound = (kind: AgentNotificationKind, soundId: AgentNotificationSoundId) => {
    updateClientSettings({
      agentNotifications: {
        ...notificationPreferences,
        sounds: { ...notificationPreferences.sounds, [kind]: soundId },
      },
    });
    // Play the new choice immediately: picking a sound you cannot hear is
    // guesswork, and this is the only place it is auditioned in context.
    playAgentNotificationSoundId(soundId);
  };

  return isElectron ? (
    <SettingsSection id="notifications" title="Notifications">
      <SettingsRow
        title="Desktop notifications"
        description="Notify when an agent finishes, has a plan ready, needs input, or fails. Notifications are suppressed while Arcwright Code is focused."
        control={
          <Switch
            checked={notificationPreferences.enabled}
            onCheckedChange={(checked) =>
              updateClientSettings({
                agentNotifications: { ...notificationPreferences, enabled: Boolean(checked) },
              })
            }
            aria-label="Enable desktop agent notifications"
          />
        }
      />
      {notificationPreferences.enabled ? (
        <>
          <SettingsRow
            title="Test notification"
            description="Sends a native desktop notification now."
            control={
              <Button size="xs" variant="outline" onClick={sendNotificationTest}>
                Send test notification
              </Button>
            }
          />
          <SettingsRow
            title="Play notification sounds"
            description="Play a sound alongside the system notification while Arcwright Code is running."
            control={
              <Switch
                checked={notificationPreferences.playSound}
                onCheckedChange={(checked) =>
                  updateClientSettings({
                    agentNotifications: {
                      ...notificationPreferences,
                      playSound: Boolean(checked),
                    },
                  })
                }
                aria-label="Play agent notification sounds"
              />
            }
          />
          {notificationPreferences.playSound
            ? AGENT_NOTIFICATION_SOUND_ROWS.map((row) => (
                <AgentNotificationSoundRow
                  key={row.kind}
                  kind={row.kind}
                  title={row.title}
                  sounds={notificationPreferences.sounds}
                  onChange={setNotificationSound}
                />
              ))
            : null}
          {(
            [
              ["notifyOnCompletion", "Agent finished", "Notify when agent work completes."],
              [
                "notifyOnPlanReady",
                "Plan ready",
                "Notify when an agent proposes a plan for review.",
              ],
              [
                "notifyOnInput",
                "Input needed",
                "Notify when an agent needs approval or a response.",
              ],
              ["notifyOnFailure", "Agent failed", "Notify when an agent run ends with an error."],
              [
                "showProjectAndThreadNames",
                "Show project and thread names",
                "Turn this off to keep notification content generic on your desktop.",
              ],
            ] as const
          ).map(([key, title, description]) => (
            <SettingsRow
              key={key}
              title={title}
              description={description}
              control={
                <Switch
                  checked={notificationPreferences[key]}
                  onCheckedChange={(checked) =>
                    updateClientSettings({
                      agentNotifications: {
                        ...notificationPreferences,
                        [key]: Boolean(checked),
                      },
                    })
                  }
                  aria-label={title}
                />
              }
            />
          ))}
        </>
      ) : null}
    </SettingsSection>
  ) : isAndroidPwa ? (
    <AndroidNotificationSettings />
  ) : (
    <PwaNotificationSettings />
  );
}
