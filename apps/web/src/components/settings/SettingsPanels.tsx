import { GeneralThreadDefaultsSettings } from "./GeneralThreadDefaultsSettings";
import { ParticipantProfileSettings } from "./ParticipantProfileSettings";
import { ClientBuildIdentity } from "./ClientBuildIdentity";
import { AppUpdateSettings } from "./AppUpdateSettings";
import { PwaAppUpdateSettings } from "./PwaAppUpdateSettings";
import {
  PwaNotificationSettings,
  AgentNotificationSoundRow,
  AGENT_NOTIFICATION_SOUND_ROWS,
} from "./AgentNotificationSettings";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import { SettingsGroup } from "./SettingsGroup";
import { resolvePrivacyPolicy } from "../../legalLinks";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import {
  IDLE_COMPACTION_MODES,
  globalIdleCompaction,
  type AgentNotificationEvent,
  type AgentNotificationKind,
  type AgentNotificationSoundId,
  type SidebarProjectGroupingMode,
} from "@t3tools/contracts";
import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  type ResponseStreamingMode,
  type QuitConfirmationMode,
  SidebarProjectSortOrder,
} from "@t3tools/contracts/settings";

import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";
import { CliCommandSettingsRow } from "./CliCommandSettingsRow";
import { MobileAppSettingsRow } from "./MobileAppSettingsRow";

import { isAndroidPwa, isElectron } from "../../env";
import { AndroidNotificationSettings } from "./AndroidNotificationSettings";

import {
  readAppearanceModePreference,
  readThemeHalves,
  readThemePreference,
  useTheme,
} from "../../hooks/useTheme";

import { useClientSettings, updateClientSettings } from "../../hooks/useSettings";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { isMacPlatform } from "../../lib/utils";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { ScopedSwitch } from "./ScopedSwitch";
import { stackedThreadToast, toastManager } from "../ui/toast";

import {
  getChangedBrowserSettingLabels,
  getChangedTypographySettingLabels,
  hasChangedBackgroundActivitySettings,
  isProjectGroupingEnabled,
  projectGroupingModeFromToggle,
  readLastEnabledProjectGroupingMode,
  rememberEnabledProjectGroupingMode,
} from "./SettingsPanels.logic";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useSettingsSearchTarget,
  useSettingsSearchTargetId,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

import {
  playAgentNotificationSound,
  playAgentNotificationSoundId,
} from "../../agentNotifications/sound";

import { AboutVersionSection, AboutVersionTitle } from "./AboutVersionSettings";
import { BackgroundActivitySettingsRow } from "./BackgroundActivitySettings";
import { scopedIdleCompaction } from "./scopedSettings";

const RESPONSE_STREAMING_MODE_LABELS: Record<ResponseStreamingMode, string> = {
  turn: "Wait for the full response",
  paragraph: "Show finished paragraphs",
};

const RESPONSE_STREAMING_MODE_DESCRIPTIONS: Record<ResponseStreamingMode, string> = {
  turn: "Text appears once the agent finishes its turn.",
  paragraph: "Each paragraph or code block appears as soon as it is complete.",
};

const SIDEBAR_PROJECT_SORT_ORDER_LABELS: Record<SidebarProjectSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
  manual: "Manual",
};
const isSidebarProjectSortOrder = Schema.is(SidebarProjectSortOrder);

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

const QUIT_CONFIRMATION_MODE_LABELS: Record<QuitConfirmationMode, string> = {
  direct: "Direct",
  hold: "Hold",
  "double-click": "Double press",
};

export function useSettingsRestore(onRestored?: () => void) {
  const {
    theme,
    setTheme,
    followSystem,
    setFollowSystem,
    setThemeHalf,
    clearThemeHalves,
    themeHalves,
  } = useTheme();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();

  const isTextGenerationModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const isBackgroundActivityDirty = hasChangedBackgroundActivitySettings(settings);

  const changedSettingLabels = [
    ...(theme !== "system" ? ["Theme"] : []),
    ...(!followSystem ? ["Follow system"] : []),
    ...(themeHalves !== null ? ["Theme mix"] : []),
    ...(settings.appearanceContrast !== DEFAULT_UNIFIED_SETTINGS.appearanceContrast
      ? ["Contrast"]
      : []),
    ...(settings.glassOpacity !== DEFAULT_UNIFIED_SETTINGS.glassOpacity ? ["Glass opacity"] : []),
    ...(settings.diffColorScheme !== DEFAULT_UNIFIED_SETTINGS.diffColorScheme
      ? ["Diff colors"]
      : []),
    ...(settings.alwaysCompactComposer !== DEFAULT_UNIFIED_SETTINGS.alwaysCompactComposer
      ? ["Always compact composer"]
      : []),
    ...(settings.assistantMessageBubbles !== DEFAULT_UNIFIED_SETTINGS.assistantMessageBubbles
      ? ["AI message bubbles"]
      : []),
    ...(!Equal.equals(
      settings.continuousImprovement,
      DEFAULT_UNIFIED_SETTINGS.continuousImprovement,
    )
      ? ["Continuous Improvement Mode"]
      : []),
    ...(!Equal.equals(settings.pullRequestRollup, DEFAULT_UNIFIED_SETTINGS.pullRequestRollup)
      ? ["Pull request rollup"]
      : []),
    ...(!Equal.equals(settings.repositoryReview, DEFAULT_UNIFIED_SETTINGS.repositoryReview)
      ? ["Repository review model"]
      : []),
    ...(settings.chatWidth !== DEFAULT_UNIFIED_SETTINGS.chatWidth ? ["Chat width"] : []),
    ...(settings.mathRenderingEnabled !== DEFAULT_UNIFIED_SETTINGS.mathRenderingEnabled
      ? ["Render math"]
      : []),
    ...(settings.panelAnimationDurationMs !== DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs
      ? ["Panel animations"]
      : []),
    ...(settings.environmentIdentificationMode !==
    DEFAULT_UNIFIED_SETTINGS.environmentIdentificationMode
      ? ["Environment identification"]
      : []),
    ...(settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat
      ? ["Time format"]
      : []),
    ...(settings.notificationMode !== DEFAULT_UNIFIED_SETTINGS.notificationMode
      ? ["Thread notifications"]
      : []),
    ...(settings.inAppNotificationsEnabled !== DEFAULT_UNIFIED_SETTINGS.inAppNotificationsEnabled
      ? ["In-app notifications"]
      : []),
    ...(settings.sidebarThreadPreviewCount !== DEFAULT_UNIFIED_SETTINGS.sidebarThreadPreviewCount
      ? ["Visible threads"]
      : []),
    ...(settings.sidebarProjectGroupingMode !== DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode
      ? ["Project Grouping"]
      : []),
    ...(settings.sidebarProjectSortOrder !== DEFAULT_UNIFIED_SETTINGS.sidebarProjectSortOrder
      ? ["Project order"]
      : []),
    ...(settings.sidebarWorkingShelfEnabled !== DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled
      ? ["Working section"]
      : []),
    ...(settings.sidebarAutoSettleAfterDays !== DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays
      ? ["Auto-settle inactive threads"]
      : []),
    ...(settings.sidebarAutoSettleKeepPullRequests !==
    DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleKeepPullRequests
      ? ["Keep threads with a PR"]
      : []),
    ...(settings.sidebarAutoSettleOnMerge !== DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge
      ? ["Auto-settle merged threads"]
      : []),
    ...(settings.autoResumeLimitedThreads !== DEFAULT_UNIFIED_SETTINGS.autoResumeLimitedThreads
      ? ["Auto-resume limited threads"]
      : []),
    ...(settings.snoozeLimitedThreads !== DEFAULT_UNIFIED_SETTINGS.snoozeLimitedThreads
      ? ["Snooze limited threads"]
      : []),
    ...(settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? ["Word wrap"] : []),
    ...(settings.persistComposerContextStrip !==
    DEFAULT_UNIFIED_SETTINGS.persistComposerContextStrip
      ? ["Composer context"]
      : []),
    ...getChangedTypographySettingLabels(settings),
    ...(settings.diffFilesCollapsed !== DEFAULT_UNIFIED_SETTINGS.diffFilesCollapsed
      ? ["Default diff file state"]
      : []),
    ...(settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace
      ? ["Diff whitespace changes"]
      : []),
    ...(settings.diffLayout !== DEFAULT_UNIFIED_SETTINGS.diffLayout ? ["Diff layout"] : []),
    ...(settings.proactivePanelsEnabled !== DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled
      ? ["Proactive panels"]
      : []),
    ...(settings.showSkillsInSlashMenu !== DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu
      ? ["Show skills in slash menu"]
      : []),
    ...(settings.composerCollapseOnScroll !== DEFAULT_UNIFIED_SETTINGS.composerCollapseOnScroll
      ? ["Collapse composer on scroll"]
      : []),
    ...(settings.composerRichTextEnabled !== DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled
      ? ["Rich text composer"]
      : []),
    ...(settings.sendShortcut !== DEFAULT_UNIFIED_SETTINGS.sendShortcut ? ["Send shortcut"] : []),
    ...(settings.followUpBehavior !== DEFAULT_UNIFIED_SETTINGS.followUpBehavior
      ? ["Follow-up behavior"]
      : []),
    ...(settings.contextWindowMeterEnabled !== DEFAULT_UNIFIED_SETTINGS.contextWindowMeterEnabled
      ? ["Context window indicator"]
      : []),
    ...(settings.responseStreamingMode !== DEFAULT_UNIFIED_SETTINGS.responseStreamingMode
      ? ["Response streaming"]
      : []),
    ...(settings.enableProviderUpdateChecks !== DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks
      ? ["Provider update checks"]
      : []),
    ...(settings.continueThreadsAfterServerUpdate !==
    DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate
      ? ["Continue threads after restarts"]
      : []),
    ...(isBackgroundActivityDirty ? ["Background activity"] : []),
    ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode
      ? ["New thread mode"]
      : []),
    ...(settings.newWorktreesStartFromOrigin !==
    DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin
      ? ["New worktrees start from remote"]
      : []),
    ...(settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory
      ? ["Add project base directory"]
      : []),
    ...(settings.confirmThreadUnpin !== DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin
      ? ["Unpin confirmation"]
      : []),
    ...(settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive
      ? ["Archive confirmation"]
      : []),
    ...(settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete
      ? ["Delete confirmation"]
      : []),
    ...(settings.confirmQuit !== DEFAULT_UNIFIED_SETTINGS.confirmQuit ? ["Quit shortcut"] : []),
    ...(isTextGenerationModelDirty ? ["Text generation model"] : []),
    ...getChangedBrowserSettingLabels(settings),
    ...(settings.enableAgentBrowserAccess !== DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess
      ? ["Agent browser access"]
      : []),
  ];

  const restoreDefaults = async () => {
    if (changedSettingLabels.length === 0) return;
    const api = readLocalApi();
    const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
      ["Restore default settings?", `This will reset: ${changedSettingLabels.join(", ")}.`].join(
        "\n",
      ),
      { variant: "destructive" },
    );
    if (!confirmed) return;

    // Only touch the theme keys that are actually dirty, so a theme-storage
    // failure cannot block restoring unrelated settings. Preferences are
    // re-read after the confirmation dialog: they may have changed (another
    // tab, an OS flip) while it was open, and rollback must restore the live
    // values rather than the ones captured at render time.
    let previousTheme = theme;
    try {
      previousTheme = readThemePreference();
    } catch {}
    const liveHalves = readThemeHalves();
    const needsThemeReset = previousTheme !== "system";
    const needsMixReset = liveHalves !== null;
    const needsFollowSystemReset = readAppearanceModePreference(previousTheme) !== "system";
    const notifyThemeRestoreFailure = () => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Couldn’t restore theme settings",
          description: "Try again.",
        }),
      );
    };
    // Rollback restores the base preference first (which clears any mix) and
    // then re-applies the captured mix on top, so no failure path can leave
    // the pair of keys half-restored.
    const previousHalves = liveHalves;
    const rollbackThemeState = () => {
      if (needsThemeReset) setTheme(previousTheme);
      if (previousHalves?.light) setThemeHalf("light", previousHalves.light);
      if (previousHalves?.dark) setThemeHalf("dark", previousHalves.dark);
    };
    if (needsThemeReset && !setTheme("system")) {
      notifyThemeRestoreFailure();
      return;
    }
    if (needsMixReset && !clearThemeHalves()) {
      rollbackThemeState();
      notifyThemeRestoreFailure();
      return;
    }
    if (needsFollowSystemReset && !setFollowSystem(true)) {
      rollbackThemeState();
      notifyThemeRestoreFailure();
      return;
    }
    updateSettings({
      appearanceContrast: DEFAULT_UNIFIED_SETTINGS.appearanceContrast,
      diffColorScheme: DEFAULT_UNIFIED_SETTINGS.diffColorScheme,
      chatWidth: DEFAULT_UNIFIED_SETTINGS.chatWidth,
      alwaysCompactComposer: DEFAULT_UNIFIED_SETTINGS.alwaysCompactComposer,
      assistantMessageBubbles: DEFAULT_UNIFIED_SETTINGS.assistantMessageBubbles,
      mathRenderingEnabled: DEFAULT_UNIFIED_SETTINGS.mathRenderingEnabled,
      timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
      wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap,
      persistComposerContextStrip: DEFAULT_UNIFIED_SETTINGS.persistComposerContextStrip,
      diffFilesCollapsed: DEFAULT_UNIFIED_SETTINGS.diffFilesCollapsed,
      diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
      diffLayout: DEFAULT_UNIFIED_SETTINGS.diffLayout,
      proactivePanelsEnabled: DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled,
      showSkillsInSlashMenu: DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu,
      composerCollapseOnScroll: DEFAULT_UNIFIED_SETTINGS.composerCollapseOnScroll,
      composerRichTextEnabled: DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled,
      sendShortcut: DEFAULT_UNIFIED_SETTINGS.sendShortcut,
      followUpBehavior: DEFAULT_UNIFIED_SETTINGS.followUpBehavior,
      contextWindowMeterEnabled: DEFAULT_UNIFIED_SETTINGS.contextWindowMeterEnabled,
      environmentIdentificationMode: DEFAULT_UNIFIED_SETTINGS.environmentIdentificationMode,
      glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity,
      panelAnimationDurationMs: DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs,
      sidebarThreadPreviewCount: DEFAULT_UNIFIED_SETTINGS.sidebarThreadPreviewCount,
      sidebarProjectGroupingMode: DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode,
      sidebarProjectSortOrder: DEFAULT_UNIFIED_SETTINGS.sidebarProjectSortOrder,
      sidebarWorkingShelfEnabled: DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled,
      sidebarAutoSettleAfterDays: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays,
      sidebarAutoSettleKeepPullRequests: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleKeepPullRequests,
      sidebarAutoSettleOnMerge: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge,
      dictationMicrophoneDeviceId: DEFAULT_UNIFIED_SETTINGS.dictationMicrophoneDeviceId,
      dictationStartKeybinds: DEFAULT_UNIFIED_SETTINGS.dictationStartKeybinds,
      dictationEndKeybinds: DEFAULT_UNIFIED_SETTINGS.dictationEndKeybinds,
      autoOpenPlanSidebar: DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar,
      enableLegacyTokenStreaming: DEFAULT_UNIFIED_SETTINGS.enableLegacyTokenStreaming,
      autoResumeLimitedThreads: DEFAULT_UNIFIED_SETTINGS.autoResumeLimitedThreads,
      snoozeLimitedThreads: DEFAULT_UNIFIED_SETTINGS.snoozeLimitedThreads,
      responseStreamingMode: DEFAULT_UNIFIED_SETTINGS.responseStreamingMode,
      enableProviderUpdateChecks: DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
      continuousImprovement: DEFAULT_UNIFIED_SETTINGS.continuousImprovement,
      pullRequestRollup: DEFAULT_UNIFIED_SETTINGS.pullRequestRollup,
      repositoryReview: DEFAULT_UNIFIED_SETTINGS.repositoryReview,
      backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
      backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
      automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
      providerHealthRefreshInterval: DEFAULT_UNIFIED_SETTINGS.providerHealthRefreshInterval,
      defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
      newWorktreesStartFromOrigin: DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
      addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
      confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
      confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
      confirmThreadUnpin: DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin,
      confirmQuit: DEFAULT_UNIFIED_SETTINGS.confirmQuit,
      textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
      fontFamilySans: DEFAULT_UNIFIED_SETTINGS.fontFamilySans,
      fontFamilyComposer: DEFAULT_UNIFIED_SETTINGS.fontFamilyComposer,
      fontFamilyCode: DEFAULT_UNIFIED_SETTINGS.fontFamilyCode,
      fontFamilyTerminal: DEFAULT_UNIFIED_SETTINGS.fontFamilyTerminal,
      fontSizeInterface: DEFAULT_UNIFIED_SETTINGS.fontSizeInterface,
      fontSizePrompt: DEFAULT_UNIFIED_SETTINGS.fontSizePrompt,
      fontSizeCode: DEFAULT_UNIFIED_SETTINGS.fontSizeCode,
      fontSizeTerminal: DEFAULT_UNIFIED_SETTINGS.fontSizeTerminal,
      browserDefaultViewport: DEFAULT_UNIFIED_SETTINGS.browserDefaultViewport,
      browserDefaultZoomFactor: DEFAULT_UNIFIED_SETTINGS.browserDefaultZoomFactor,
      browserDefaultAppearance: DEFAULT_UNIFIED_SETTINGS.browserDefaultAppearance,
      browserRecordingFrameRate: DEFAULT_UNIFIED_SETTINGS.browserRecordingFrameRate,
      browserRecordingShowKeyPresses: DEFAULT_UNIFIED_SETTINGS.browserRecordingShowKeyPresses,
      browserRecordingShowMousePresses: DEFAULT_UNIFIED_SETTINGS.browserRecordingShowMousePresses,
      browserLinkTarget: DEFAULT_UNIFIED_SETTINGS.browserLinkTarget,
      browserSearchEngine: DEFAULT_UNIFIED_SETTINGS.browserSearchEngine,
      browserCustomSearchUrl: DEFAULT_UNIFIED_SETTINGS.browserCustomSearchUrl,
      browserAutoShowFloatingPreview: DEFAULT_UNIFIED_SETTINGS.browserAutoShowFloatingPreview,
      pullRequestLinksOpenInApp: DEFAULT_UNIFIED_SETTINGS.pullRequestLinksOpenInApp,
      enableAgentBrowserAccess: DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess,
    });
    onRestored?.();
  };

  return {
    changedSettingLabels,
    restoreDefaults,
  };
}

const AUTO_SETTLE_DEFAULT_DAYS = DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays ?? 3;

function AutoSettleDaysInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (days: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [draftSource, setDraftSource] = useState(value);
  if (draftSource !== value) {
    setDraftSource(value);
    setDraft(String(value));
  }

  return (
    <Input
      size="sm"
      type="number"
      min={MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      max={MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      className="w-full sm:w-24"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        const parsed = Number(event.target.value);
        if (
          Number.isInteger(parsed) &&
          parsed >= MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS &&
          parsed <= MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS
        ) {
          onCommit(parsed);
        }
      }}
      onBlur={() => setDraft(String(value))}
      aria-label="Days of inactivity before auto-settle"
    />
  );
}

const LEGACY_FEATURE_TARGET_IDS: ReadonlySet<string> = new Set([
  "legacy-plan-mode",
  "legacy-context-window-indicator",
  "legacy-token-streaming",
  "legacy-sidebar",
]);

export function CompatibilitySettingsSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const [open, setOpen] = useState(false);
  const searchTargetId = useSettingsSearchTargetId();
  const targetRef = useSettingsSearchTarget<HTMLElement>("legacy-features");
  const lastExpandedTargetRef = useRef<string | null>(null);
  useEffect(() => {
    if (searchTargetId === null) {
      lastExpandedTargetRef.current = null;
      return;
    }
    if (!LEGACY_FEATURE_TARGET_IDS.has(searchTargetId)) return;
    if (lastExpandedTargetRef.current === searchTargetId) return;
    lastExpandedTargetRef.current = searchTargetId;
    setOpen(true);
  }, [searchTargetId]);

  return (
    <section
      data-settings-section="Compatibility"
      id="legacy-features"
      ref={targetRef}
      tabIndex={-1}
      className="space-y-2.5"
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="group flex min-h-8 w-full items-center gap-2 px-3 sm:px-4">
          <h2 className="text-sm font-normal text-foreground/70 transition-colors group-hover:text-foreground">
            Compatibility
          </h2>
          <ChevronRightIcon className="size-4 text-muted-foreground transition-transform duration-200 group-data-panel-open:rotate-90" />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <SettingsGroup>
            <SettingsRow
              {...searchableSetting("legacy-plan-mode")}
              description="Restore Build/Plan, /plan, /default, and Shift+Tab. Off uses build mode."
              control={
                <Switch
                  checked={settings.planModeEnabled}
                  onCheckedChange={(checked) => {
                    updateSettings({ planModeEnabled: Boolean(checked) });
                  }}
                  aria-label="Plan mode (legacy)"
                />
              }
            />
            <SettingsRow
              {...searchableSetting("legacy-context-window-indicator")}
              description="Shows context window usage as a circular indicator in the composer."
              control={
                <Switch
                  checked={settings.contextWindowMeterEnabled}
                  onCheckedChange={(checked) =>
                    updateSettings({ contextWindowMeterEnabled: Boolean(checked) })
                  }
                  aria-label="Context window indicator (legacy)"
                />
              }
            />
            <SettingsRow
              serverScoped
              settingKeys={["enableLegacyTokenStreaming"]}
              {...searchableSetting("legacy-token-streaming")}
              description="Stream output token by token. This legacy mode is slower and harder to follow."
              control={
                <ScopedSwitch
                  settingKeys={["enableLegacyTokenStreaming"]}
                  checked={settings.enableLegacyTokenStreaming}
                  onCheckedChange={(checked) => {
                    if (!checked) {
                      updateSettings({ enableLegacyTokenStreaming: false });
                      return;
                    }
                    void (async () => {
                      const api = readLocalApi();
                      const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
                        [
                          "Turn on token-by-token output?",
                          "It is significantly slower than the default buffered output and hurts the reading experience. This switch exists only for backwards compatibility.",
                        ].join("\n"),
                      );
                      if (confirmed) updateSettings({ enableLegacyTokenStreaming: true });
                    })();
                  }}
                  aria-label="Stream token by token (legacy)"
                />
              }
            />
            <SettingsRow
              {...searchableSetting("legacy-sidebar")}
              description="Restore per-project thread trees instead of the default flat sidebar."
              control={
                <Switch
                  checked={settings.legacySidebarEnabled}
                  onCheckedChange={(checked) =>
                    updateSettings({ legacySidebarEnabled: Boolean(checked) })
                  }
                  aria-label="Sidebar (legacy)"
                />
              }
            />
          </SettingsGroup>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}

export function GeneralSettingsPanel() {
  const modifierLabel = isMacPlatform(navigator.platform) ? "⌘" : "Ctrl";
  const sendShortcutOptions = [
    { value: "enter", label: "Enter" },
    { value: "mod-enter-multiline", label: `${modifierLabel} + Enter for multiline prompts` },
    { value: "mod-enter", label: `${modifierLabel} + Enter always` },
  ] as const;
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { connectedEnvironments, targets } = useSettingsScope();
  const idleCompaction = scopedIdleCompaction(targets.length > 0 ? targets : [{ settings }]);
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
  const mixedResponseStreamingMode = useScopedSettingsMixed(["responseStreamingMode"]);
  const lastEnabledProjectGroupingMode = useRef<SidebarProjectGroupingMode>(
    readLastEnabledProjectGroupingMode(),
  );
  const supportsAutoSettlement =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (target) => target.serverConfig?.environment.capabilities.threadAutoSettlement === true,
    );
  const supportsAutoSettlementScope = connectedEnvironments.every(
    (target) => target.serverConfig?.environment.capabilities.threadAutoSettlementScope === true,
  );
  const supportsRestartContinuation =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (target) => target.serverConfig?.environment.capabilities.threadRestartContinuation === true,
    );

  const mixedAddProjectBaseDirectory = useScopedSettingsMixed(["addProjectBaseDirectory"]);

  return (
    <SettingsPageContainer>
      <ParticipantProfileSettings />
      <SettingsSection id="interface-sidebar" title="Interface & sidebar">
        <SettingsRow
          {...searchableSetting("time-format")}
          description="System default follows your browser or OS clock preference."
          resetAction={
            settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
              <SettingResetButton
                label="time format"
                onClick={() =>
                  updateSettings({
                    timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value === "locale" || value === "12-hour" || value === "24-hour") {
                  updateSettings({ timestampFormat: value });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Timestamp format">
                <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="locale">
                  {TIMESTAMP_FORMAT_LABELS.locale}
                </SelectItem>
                <SelectItem hideIndicator value="12-hour">
                  {TIMESTAMP_FORMAT_LABELS["12-hour"]}
                </SelectItem>
                <SelectItem hideIndicator value="24-hour">
                  {TIMESTAMP_FORMAT_LABELS["24-hour"]}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          {...searchableSetting("project-grouping")}
          description="Combine matching repositories across environments."
          resetAction={
            settings.sidebarProjectGroupingMode !==
            DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode ? (
              <SettingResetButton
                label="project grouping"
                onClick={() =>
                  updateSettings({
                    sidebarProjectGroupingMode: DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={isProjectGroupingEnabled(settings.sidebarProjectGroupingMode)}
              onCheckedChange={(checked) => {
                if (!checked && settings.sidebarProjectGroupingMode !== "separate") {
                  lastEnabledProjectGroupingMode.current = settings.sidebarProjectGroupingMode;
                  rememberEnabledProjectGroupingMode(settings.sidebarProjectGroupingMode);
                }
                updateSettings({
                  sidebarProjectGroupingMode: projectGroupingModeFromToggle(
                    checked,
                    lastEnabledProjectGroupingMode.current,
                  ),
                });
              }}
              aria-label="Project grouping"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("project-order")}
          description="Order of projects in the sidebar project picker and command palette."
          resetAction={
            settings.sidebarProjectSortOrder !==
            DEFAULT_UNIFIED_SETTINGS.sidebarProjectSortOrder ? (
              <SettingResetButton
                label="project order"
                onClick={() =>
                  updateSettings({
                    sidebarProjectSortOrder: DEFAULT_UNIFIED_SETTINGS.sidebarProjectSortOrder,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.sidebarProjectSortOrder}
              onValueChange={(value) => {
                if (isSidebarProjectSortOrder(value)) {
                  updateSettings({ sidebarProjectSortOrder: value });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-44" aria-label="Project order">
                <SelectValue>
                  {SIDEBAR_PROJECT_SORT_ORDER_LABELS[settings.sidebarProjectSortOrder]}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {SidebarProjectSortOrder.literals.map((sortOrder) => (
                  <SelectItem hideIndicator key={sortOrder} value={sortOrder}>
                    {SIDEBAR_PROJECT_SORT_ORDER_LABELS[sortOrder]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          {...searchableSetting("working-shelf")}
          description="Fold working and monitoring threads into a Working section. They return to the top of the inbox when they need you."
          resetAction={
            settings.sidebarWorkingShelfEnabled !==
            DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled ? (
              <SettingResetButton
                label="working section"
                onClick={() =>
                  updateSettings({
                    sidebarWorkingShelfEnabled: DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.sidebarWorkingShelfEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ sidebarWorkingShelfEnabled: Boolean(checked) })
              }
              aria-label="Working section (beta)"
            />
          }
        />
        {isElectron ? (
          <SettingsRow
            {...searchableSetting("quit-confirmation")}
            description="Hold mode also quits on two quick presses."
            resetAction={
              settings.confirmQuit !== DEFAULT_UNIFIED_SETTINGS.confirmQuit ? (
                <SettingResetButton
                  label="quit shortcut behavior"
                  onClick={() =>
                    updateSettings({ confirmQuit: DEFAULT_UNIFIED_SETTINGS.confirmQuit })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.confirmQuit}
                onValueChange={(value) => {
                  if (value === "direct" || value === "hold" || value === "double-click") {
                    updateSettings({ confirmQuit: value });
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-40"
                  aria-label="Quit shortcut behavior"
                >
                  <SelectValue>{QUIT_CONFIRMATION_MODE_LABELS[settings.confirmQuit]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {Object.entries(QUIT_CONFIRMATION_MODE_LABELS).map(([value, label]) => (
                    <SelectItem hideIndicator key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        ) : null}
      </SettingsSection>
      <SettingsSection id="composer" title="Composer">
        <SettingsRow
          {...searchableSetting("composer-rich-text")}
          description="Show formatted Markdown as you type."
          resetAction={
            settings.composerRichTextEnabled !==
            DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled ? (
              <SettingResetButton
                label="rich text composer"
                onClick={() =>
                  updateSettings({
                    composerRichTextEnabled: DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.composerRichTextEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ composerRichTextEnabled: Boolean(checked) })
              }
              aria-label="Rich text composer"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("skills-in-slash-menu")}
          description="Also include skills in the / command menu. Skills always appear when you type $."
          resetAction={
            settings.showSkillsInSlashMenu !== DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu ? (
              <SettingResetButton
                label="skills in slash menu"
                onClick={() =>
                  updateSettings({
                    showSkillsInSlashMenu: DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.showSkillsInSlashMenu}
              onCheckedChange={(checked) =>
                updateSettings({ showSkillsInSlashMenu: Boolean(checked) })
              }
              aria-label="Show skills in slash menu"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("send-shortcut")}
          description="Choose when Enter sends a prompt or inserts a new line"
          resetAction={
            settings.sendShortcut !== DEFAULT_UNIFIED_SETTINGS.sendShortcut ? (
              <SettingResetButton
                label="send shortcut"
                onClick={() =>
                  updateSettings({ sendShortcut: DEFAULT_UNIFIED_SETTINGS.sendShortcut })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.sendShortcut}
              onValueChange={(value) => {
                const option = sendShortcutOptions.find((option) => option.value === value);
                if (option) updateSettings({ sendShortcut: option.value });
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-auto min-w-0 max-w-full"
                aria-label="Send shortcut"
              >
                <SelectValue>
                  {
                    sendShortcutOptions.find((option) => option.value === settings.sendShortcut)
                      ?.label
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {sendShortcutOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <span className="flex items-center justify-between gap-4">
                      {option.label}
                      {settings.sendShortcut === option.value && <CheckIcon aria-hidden="true" />}
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          {...searchableSetting("follow-up-behavior")}
          description={
            "Queue follow-ups while the agent runs or steer the current run. " +
            (settings.sendShortcut === "mod-enter-multiline"
              ? `Press ${modifierLabel} + Enter for single-line prompts or ${modifierLabel} + Shift + Enter for multiline prompts to do the opposite for one message.`
              : `Press ${modifierLabel}${settings.sendShortcut === "mod-enter" ? " + Shift" : ""} + Enter to do the opposite for one message.`)
          }
          resetAction={
            settings.followUpBehavior !== DEFAULT_UNIFIED_SETTINGS.followUpBehavior ? (
              <SettingResetButton
                label="follow-up behavior"
                onClick={() =>
                  updateSettings({
                    followUpBehavior: DEFAULT_UNIFIED_SETTINGS.followUpBehavior,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.followUpBehavior}
              onValueChange={(value) => {
                if (value === "queue" || value === "steer") {
                  updateSettings({ followUpBehavior: value });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-auto min-w-0" aria-label="Follow-up behavior">
                <SelectValue>
                  {settings.followUpBehavior === "queue" ? "Queue" : "Steer"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="queue">Queue</SelectItem>
                <SelectItem value="steer">Steer</SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          {...searchableSetting("composer-collapse")}
          description="Rest the composer of an existing thread into a single line when you scroll the conversation. Focus the composer or start typing to expand it again."
          resetAction={
            settings.composerCollapseOnScroll !==
            DEFAULT_UNIFIED_SETTINGS.composerCollapseOnScroll ? (
              <SettingResetButton
                label="collapse composer on scroll"
                onClick={() =>
                  updateSettings({
                    composerCollapseOnScroll: DEFAULT_UNIFIED_SETTINGS.composerCollapseOnScroll,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.composerCollapseOnScroll}
              onCheckedChange={(checked) =>
                updateSettings({ composerCollapseOnScroll: Boolean(checked) })
              }
              aria-label="Collapse composer on scroll"
            />
          }
        />
        <SettingsRow
          {...searchableSetting("always-compact-composer")}
          description="Keep the composer compact, including in new chats. Multiline drafts, errors, and drawers still expand when needed."
          resetAction={
            settings.alwaysCompactComposer !== DEFAULT_UNIFIED_SETTINGS.alwaysCompactComposer ? (
              <SettingResetButton
                label="Always compact composer"
                onClick={() => updateSettings({ alwaysCompactComposer: false })}
              />
            ) : null
          }
          control={
            <Switch
              aria-label="Always compact composer"
              checked={settings.alwaysCompactComposer}
              onCheckedChange={(alwaysCompactComposer) => updateSettings({ alwaysCompactComposer })}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("composer-context")}
          description="Keep branch and worktree controls below the composer after a thread starts."
          resetAction={
            settings.persistComposerContextStrip !==
            DEFAULT_UNIFIED_SETTINGS.persistComposerContextStrip ? (
              <SettingResetButton
                label="composer context"
                onClick={() =>
                  updateSettings({
                    persistComposerContextStrip:
                      DEFAULT_UNIFIED_SETTINGS.persistComposerContextStrip,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.persistComposerContextStrip}
              onCheckedChange={(checked) =>
                updateSettings({ persistComposerContextStrip: Boolean(checked) })
              }
              aria-label="Keep composer context visible in active threads"
            />
          }
        />
      </SettingsSection>
      <SettingsSection id="conversation-panels" title="Conversation & panels">
        <SettingsRow
          serverScoped
          settingKeys={["responseStreamingMode"]}
          {...searchableSetting("response-streaming")}
          description={
            mixedResponseStreamingMode
              ? "The selected targets use different streaming modes."
              : RESPONSE_STREAMING_MODE_DESCRIPTIONS[settings.responseStreamingMode]
          }
          resetAction={
            settings.responseStreamingMode !== DEFAULT_UNIFIED_SETTINGS.responseStreamingMode ? (
              <SettingResetButton
                label="response streaming"
                onClick={() =>
                  updateSettings({
                    responseStreamingMode: DEFAULT_UNIFIED_SETTINGS.responseStreamingMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={mixedResponseStreamingMode ? null : settings.responseStreamingMode}
              onValueChange={(value) => {
                if (value === "turn" || value === "paragraph") {
                  updateSettings({ responseStreamingMode: value });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Response streaming">
                <SelectValue>
                  {(value: ResponseStreamingMode | null) =>
                    value === null ? "Mixed" : RESPONSE_STREAMING_MODE_LABELS[value]
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="turn">
                  {RESPONSE_STREAMING_MODE_LABELS.turn}
                </SelectItem>
                <SelectItem hideIndicator value="paragraph">
                  {RESPONSE_STREAMING_MODE_LABELS.paragraph}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          {...searchableSetting("auto-open-task-panel")}
          description="Open the right-side plan and task panel automatically when steps appear."
          resetAction={
            settings.autoOpenPlanSidebar !== DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar ? (
              <SettingResetButton
                label="auto-open task panel"
                onClick={() =>
                  updateSettings({
                    autoOpenPlanSidebar: DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.autoOpenPlanSidebar}
              onCheckedChange={(checked) =>
                updateSettings({ autoOpenPlanSidebar: Boolean(checked) })
              }
              aria-label="Open the task panel automatically"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("proactive-panels")}
          description="Open linked pull requests first. Otherwise, open Changes for edits to at least 3 files or 50 lines."
          resetAction={
            settings.proactivePanelsEnabled !== DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled ? (
              <SettingResetButton
                label="proactive panels"
                onClick={() =>
                  updateSettings({
                    proactivePanelsEnabled: DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.proactivePanelsEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ proactivePanelsEnabled: Boolean(checked) })
              }
              aria-label="Proactive panels"
            />
          }
        />
      </SettingsSection>
      <GeneralThreadDefaultsSettings>
        <SettingsRow
          serverScoped
          settingKeys={["addProjectBaseDirectory"]}
          {...searchableSetting("add-project-starts-in")}
          description='Leave empty to use "~/" when the Add Project browser opens.'
          resetAction={
            settings.addProjectBaseDirectory !==
            DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory ? (
              <SettingResetButton
                label="add project base directory"
                onClick={() =>
                  updateSettings({
                    addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
                  })
                }
              />
            ) : null
          }
          control={
            <DraftInput
              size="sm"
              className="w-full sm:w-72"
              value={mixedAddProjectBaseDirectory ? "" : settings.addProjectBaseDirectory}
              onCommit={(next) => updateSettings({ addProjectBaseDirectory: next })}
              placeholder={mixedAddProjectBaseDirectory ? "Mixed" : "~/"}
              spellCheck={false}
              aria-label="Add project base directory"
            />
          }
        />
      </GeneralThreadDefaultsSettings>
      <SettingsSection id="thread-organization" title="Thread organization">
        <SettingsRow
          serverScoped
          {...searchableSetting("snooze-limited-threads")}
          description="Snooze usage-limit stops until the reported reset time. Combine with auto-resume to continue when they wake."
          settingKeys={["snoozeLimitedThreads"]}
          control={
            <ScopedSwitch
              settingKeys={["snoozeLimitedThreads"]}
              checked={settings.snoozeLimitedThreads}
              onCheckedChange={(checked) =>
                updateSettings({ snoozeLimitedThreads: Boolean(checked) })
              }
              aria-label="Snooze limited threads"
            />
          }
        />

        <SettingsRow
          serverScoped
          {...searchableSetting("auto-resume-limited-threads")}
          description="Resume usage-limit stops at the reported reset time. Each thread can cancel its scheduled continuation."
          settingKeys={["autoResumeLimitedThreads"]}
          control={
            <ScopedSwitch
              settingKeys={["autoResumeLimitedThreads"]}
              checked={settings.autoResumeLimitedThreads}
              onCheckedChange={(checked) =>
                updateSettings({ autoResumeLimitedThreads: Boolean(checked) })
              }
              aria-label="Auto-resume limited threads"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("continue-threads-after-server-update")}
          serverScoped
          settingKeys={["continueThreadsAfterServerUpdate"]}
          description="Recover supported interrupted threads after a crash or machine restart. Fork updates wait for stopped work and never interrupt agents to create an installation window."
          status={
            !supportsRestartContinuation
              ? "All selected connected environments must support restart continuation."
              : undefined
          }
          resetAction={
            supportsRestartContinuation &&
            settings.continueThreadsAfterServerUpdate !==
              DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate ? (
              <SettingResetButton
                label="continue threads after restarts"
                onClick={() =>
                  updateSettings({
                    continueThreadsAfterServerUpdate:
                      DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate,
                  })
                }
              />
            ) : null
          }
          control={
            <ScopedSwitch
              settingKeys={["continueThreadsAfterServerUpdate"]}
              checked={settings.continueThreadsAfterServerUpdate}
              disabled={!supportsRestartContinuation}
              onCheckedChange={(checked) =>
                updateSettings({ continueThreadsAfterServerUpdate: Boolean(checked) })
              }
              aria-label="Continue threads after restarts"
            />
          }
        />
        <SettingsRow
          serverScoped
          settingKeys={["idleCompaction", "compactIdleThreads"]}
          mixed={idleCompaction.mixed}
          {...searchableSetting("compact-idle-threads")}
          description="When to compact an idle Claude thread over 200,000 tokens: after you return, just before its prompt cache expires, or never. Each Claude provider can override this."
          resetAction={
            globalIdleCompaction(settings) !== globalIdleCompaction(DEFAULT_UNIFIED_SETTINGS) ? (
              <SettingResetButton
                label="compact idle threads"
                onClick={() =>
                  updateSettings({ idleCompaction: globalIdleCompaction(DEFAULT_UNIFIED_SETTINGS) })
                }
              />
            ) : null
          }
          control={
            <Select
              value={idleCompaction.mixed ? null : globalIdleCompaction(settings)}
              onValueChange={(value) => {
                const mode = IDLE_COMPACTION_MODES.find((candidate) => candidate.value === value);
                if (mode) updateSettings({ idleCompaction: mode.value });
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Compact idle threads">
                <SelectValue>
                  {(value: string | null) =>
                    value === null
                      ? "Mixed"
                      : IDLE_COMPACTION_MODES.find((mode) => mode.value === value)?.label
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {IDLE_COMPACTION_MODES.map((mode) => (
                  <SelectItem
                    hideIndicator
                    key={mode.value}
                    value={mode.value}
                    // A server from before modes has only the on/off switch, so it cannot store "Never".
                    disabled={mode.value === "off" && !idleCompaction.neverAvailable}
                  >
                    {mode.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        {supportsAutoSettlement ? (
          <>
            <SettingsRow
              serverScoped
              settingKeys={["sidebarAutoSettleOnMerge"]}
              {...searchableSetting("auto-settle-merged-threads")}
              description="Settle a thread when its pull request merges. Closed pull requests still settle automatically."
              resetAction={
                settings.sidebarAutoSettleOnMerge !==
                DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge ? (
                  <SettingResetButton
                    label="auto-settle on merge"
                    onClick={() =>
                      updateSettings({
                        sidebarAutoSettleOnMerge: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge,
                      })
                    }
                  />
                ) : null
              }
              control={
                <ScopedSwitch
                  settingKeys={["sidebarAutoSettleOnMerge"]}
                  checked={settings.sidebarAutoSettleOnMerge}
                  onCheckedChange={(checked) =>
                    updateSettings({ sidebarAutoSettleOnMerge: Boolean(checked) })
                  }
                  aria-label="Auto-settle merged threads"
                />
              }
            />

            <SettingsRow
              serverScoped
              settingKeys={["sidebarAutoSettleAfterDays"]}
              {...searchableSetting("auto-settle-inactive-threads")}
              description="Sidebar threads with no activity for this long settle automatically."
              resetAction={
                settings.sidebarAutoSettleAfterDays !==
                DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays ? (
                  <SettingResetButton
                    label="auto-settle"
                    onClick={() =>
                      updateSettings({
                        sidebarAutoSettleAfterDays:
                          DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays,
                      })
                    }
                  />
                ) : null
              }
              control={
                <ScopedSwitch
                  settingKeys={["sidebarAutoSettleAfterDays"]}
                  checked={settings.sidebarAutoSettleAfterDays !== null}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      sidebarAutoSettleAfterDays: checked ? AUTO_SETTLE_DEFAULT_DAYS : null,
                    })
                  }
                  aria-label="Auto-settle inactive threads"
                />
              }
            />
            {settings.sidebarAutoSettleAfterDays !== null ? (
              <SettingsRow
                serverScoped
                settingKeys={["sidebarAutoSettleAfterDays"]}
                title={searchableSetting("days-before-auto-settle").title}
                description="Any new activity un-settles a thread automatically."
                control={
                  <AutoSettleDaysInput
                    value={settings.sidebarAutoSettleAfterDays}
                    onCommit={(days) => updateSettings({ sidebarAutoSettleAfterDays: days })}
                  />
                }
              />
            ) : null}
            {settings.sidebarAutoSettleAfterDays !== null && supportsAutoSettlementScope ? (
              <SettingsRow
                serverScoped
                settingKeys={["sidebarAutoSettleKeepPullRequests"]}
                title="Keep threads with a PR"
                description="Inactivity does not settle threads with a pull request. Merge and close still do."
                control={
                  <ScopedSwitch
                    settingKeys={["sidebarAutoSettleKeepPullRequests"]}
                    checked={settings.sidebarAutoSettleKeepPullRequests}
                    onCheckedChange={(checked) =>
                      updateSettings({ sidebarAutoSettleKeepPullRequests: checked })
                    }
                    aria-label="Keep threads with a PR"
                  />
                }
              />
            ) : null}
          </>
        ) : null}
        <SettingsRow
          {...searchableSetting("unpin-confirmation")}
          description="Ask before unpinning a thread from the pinned section."
          resetAction={
            settings.confirmThreadUnpin !== DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin ? (
              <SettingResetButton
                label="unpin confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadUnpin: DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadUnpin}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadUnpin: Boolean(checked) })
              }
              aria-label="Confirm thread unpinning"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("archive-confirmation")}
          description="Require a second click on the inline archive action before a thread is archived."
          resetAction={
            settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive ? (
              <SettingResetButton
                label="archive confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadArchive}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadArchive: Boolean(checked) })
              }
              aria-label="Confirm thread archiving"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("delete-confirmation")}
          description="Ask before deleting a thread and its chat history."
          resetAction={
            settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
              <SettingResetButton
                label="delete confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadDelete}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadDelete: Boolean(checked) })
              }
              aria-label="Confirm thread deletion"
            />
          }
        />
      </SettingsSection>
      {isElectron ? (
        <SettingsSection id={searchableSetting("notifications").id} title="Notifications">
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
                  [
                    "notifyOnFailure",
                    "Agent failed",
                    "Notify when an agent run ends with an error.",
                  ],
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
      ) : (
        <>{isAndroidPwa ? <AndroidNotificationSettings /> : <PwaNotificationSettings />}</>
      )}

      <SettingsSection id="performance" title="Performance">
        <BackgroundActivitySettingsRow />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function AboutUpdatesSettingsPanel({ children }: { children?: ReactNode }) {
  const privacyPolicy = resolvePrivacyPolicy();
  return (
    <SettingsPageContainer>
      <AppUpdateSettings desktopControls={<AboutVersionSection />} />
      <SettingsSection id="about" title="About">
        <SettingsRow
          title={<AboutVersionTitle />}
          description={<ClientBuildIdentity />}
          control={
            <a href="#app-updates" className="text-sm underline">
              App updates
            </a>
          }
        />
        {isElectron ? <CliCommandSettingsRow /> : null}
        <MobileAppSettingsRow />
        <SettingsRow
          {...searchableSetting("privacy-policy")}
          description={
            privacyPolicy.ownedConnect
              ? "How Arcwright Connect handles account and connection information, including service availability."
              : "How we handle your data, including the anonymous usage data Arcwright Code collects."
          }
          control={
            <Button
              render={<a href={privacyPolicy.url} target="_blank" rel="noreferrer noopener" />}
              size="sm"
              variant="outline"
            >
              View policy
            </Button>
          }
        />
      </SettingsSection>
      <SettingsSection id="about-licenses" title="Licenses">
        <SettingsRow
          {...searchableSetting("open-source-licenses")}
          description="Notices for dependencies, assets, and optional tools used by Arcwright Code."
          control={
            <Button
              render={<Link to="/settings/open-source-licenses" />}
              size="sm"
              variant="outline"
            >
              View licenses
            </Button>
          }
        />
      </SettingsSection>

      {!isElectron ? <PwaAppUpdateSettings /> : null}
      {children}
    </SettingsPageContainer>
  );
}

export { ArchivedThreadsPanel } from "./ArchivedThreadsPanel";

export { AppearanceSettingsPanel } from "./AppearanceSettingsPanel";
