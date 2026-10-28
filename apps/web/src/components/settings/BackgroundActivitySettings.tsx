import { useEffect, useRef, useState } from "react";
import { SettingsIcon } from "lucide-react";
import * as Equal from "effect/Equal";
import { useSettingsScope } from "./SettingsScopeContext";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { type BackgroundActivityProfile } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import * as Duration from "effect/Duration";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  backgroundActivityOverrideSettings,
  backgroundActivitySharedPolicySettings,
  durationToSeconds,
  normalizeIntervalSeconds,
  PROVIDER_HEALTH_INTERVAL_STEP_SECONDS,
  resolveBackgroundActivityProfileOption,
} from "./SettingsPanels.logic";
import { searchableSetting } from "./settingsSearch";
import {
  SettingsSearchTarget,
  useSettingsSearchTargetId,
  PolicyTooltip,
  SettingResetButton,
  SettingsRow,
} from "./settingsLayout";

export const BACKGROUND_ACTIVITY_ADVANCED_TARGET_IDS: ReadonlySet<string> = new Set([
  "background-shared-policy",
  "git-fetch-interval",
  "provider-health-check-interval",
  "host-power-active-interval",
  "host-power-idle-interval",
  "pause-when-host-locked",
  "pause-when-host-low-power",
  "pause-when-client-low-power",
  "pause-when-on-battery",
]);

export function BackgroundActivitySearchOpener({
  enabled,
  onOpen,
}: {
  enabled: boolean;
  onOpen: (open: boolean) => void;
}) {
  const target = useSettingsSearchTargetId();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the advanced settings dialog for a router search target that is mounted inside it
  useEffect(() => {
    if (enabled && target !== null && BACKGROUND_ACTIVITY_ADVANCED_TARGET_IDS.has(target))
      onOpen(true);
  }, [enabled, onOpen, target]);
  return null;
}

export const BACKGROUND_ACTIVITY_PROFILE_LABELS: Record<BackgroundActivityProfile, string> = {
  balanced: "Balanced",
  performance: "Performance",
  "battery-saver": "Battery saver",
};

export type BackgroundActivityProfileOption = BackgroundActivityProfile | "advanced";

export const BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS: Record<
  BackgroundActivityProfileOption,
  string
> = {
  ...BACKGROUND_ACTIVITY_PROFILE_LABELS,
  advanced: "Advanced",
};

export const BACKGROUND_ACTIVITY_PROFILE_DESCRIPTIONS: Record<BackgroundActivityProfile, string> = {
  balanced: "Pauses probes for idle clients, locked hosts, or low power mode.",
  performance: "Allows scoped background probes while any subscribed client remains connected.",
  "battery-saver": "Also pauses background probes when the host or client is on battery.",
};

export const ADVANCED_BACKGROUND_ACTIVITY_DESCRIPTION = "Uses custom intervals.";

const BACKGROUND_ACTIVITY_BOOLEAN_OVERRIDES: ReadonlyArray<{
  readonly key:
    | "pauseWhenHostLocked"
    | "pauseWhenHostLowPower"
    | "pauseWhenClientLowPower"
    | "pauseWhenOnBattery";
  readonly label: string;
  readonly targetId: string;
}> = [
  {
    key: "pauseWhenHostLocked",
    label: "Pause when host is locked",
    targetId: "pause-when-host-locked",
  },
  {
    key: "pauseWhenHostLowPower",
    label: "Pause on host low power",
    targetId: "pause-when-host-low-power",
  },
  {
    key: "pauseWhenClientLowPower",
    label: "Pause on client low power",
    targetId: "pause-when-client-low-power",
  },
  { key: "pauseWhenOnBattery", label: "Pause on battery", targetId: "pause-when-on-battery" },
];

export function resetBackgroundActivitySettings() {
  return {
    backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
  };
}

export function backgroundActivityProfileSettings(profile: BackgroundActivityProfile) {
  return {
    backgroundActivity: {
      schemaVersion: 1 as const,
      profile,
      overrides: {},
    },
  };
}

export function BackgroundActivityAdvancedDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const searchTargetId = useSettingsSearchTargetId();
  const initialTarget = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- retains the router search target for the imperative dialog initial-focus callback after the hash clears
  useEffect(() => {
    if (searchTargetId && BACKGROUND_ACTIVITY_ADVANCED_TARGET_IDS.has(searchTargetId)) {
      initialTarget.current = searchTargetId;
    } else if (!open) {
      initialTarget.current = null;
    }
  }, [open, searchTargetId]);
  const canWriteSettings = useScopedSettingsWriteAllowed();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const activeProfile = resolvedBackgroundActivity.profile;
  const automaticGitFetchIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.automaticGitFetchInterval,
  );
  const providerHealthRefreshIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.providerHealthRefreshInterval,
  );
  const hostPowerMonitorActiveIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.hostPowerMonitorActiveInterval,
  );
  const hostPowerMonitorIdleIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.hostPowerMonitorIdleInterval,
  );

  return (
    <Dialog open={open && canWriteSettings} onOpenChange={onOpenChange}>
      <DialogPopup
        className="max-w-xl"
        initialFocus={() =>
          (initialTarget.current ? document.getElementById(initialTarget.current) : null) ?? true
        }
      >
        <DialogHeader>
          <DialogTitle>Background Activity</DialogTitle>
          <DialogDescription>
            Tune the shared power policy and the background intervals that feed it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset
            disabled={!canWriteSettings}
            className="min-w-0 overflow-hidden rounded-xl border bg-card text-card-foreground"
          >
            <SettingsSearchTarget
              id="background-shared-policy"
              className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">Shared policy</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Controls whether background work may run after a subscribed interval fires.
                </p>
              </div>
              <Select
                value={activeProfile}
                onValueChange={(value) => {
                  if (
                    value === "balanced" ||
                    value === "performance" ||
                    value === "battery-saver"
                  ) {
                    updateSettings({
                      backgroundActivity: backgroundActivitySharedPolicySettings(settings, value),
                    });
                  }
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-40"
                  aria-label="Shared background policy"
                >
                  <SelectValue>{BACKGROUND_ACTIVITY_PROFILE_LABELS[activeProfile]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="balanced">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS.balanced}
                  </SelectItem>
                  <SelectItem hideIndicator value="performance">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS.performance}
                  </SelectItem>
                  <SelectItem hideIndicator value="battery-saver">
                    {BACKGROUND_ACTIVITY_PROFILE_LABELS["battery-saver"]}
                  </SelectItem>
                </SelectPopup>
              </Select>
            </SettingsSearchTarget>

            <SettingsSearchTarget
              id="git-fetch-interval"
              className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">
                  {searchableSetting("git-fetch-interval").title}
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Refresh remote branch status in the background.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <NumberField
                  value={automaticGitFetchIntervalSeconds}
                  min={0}
                  step={5}
                  size="sm"
                  className="w-32"
                  onValueChange={(value) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        {
                          automaticGitFetchInterval: Duration.seconds(
                            normalizeIntervalSeconds(value),
                          ),
                        },
                      ),
                    )
                  }
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement aria-label="Decrease Git fetch interval" />
                    <NumberFieldInput aria-label="Git fetch interval in seconds" />
                    <NumberFieldIncrement aria-label="Increase Git fetch interval" />
                  </NumberFieldGroup>
                </NumberField>
                <span className="text-xs text-muted-foreground">seconds</span>
              </div>
            </SettingsSearchTarget>

            <SettingsSearchTarget
              id="provider-health-check-interval"
              className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">Provider health interval</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Refresh provider availability, versions, and auth state. Model catalog updates
                  follow Provider update checks.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <NumberField
                  value={providerHealthRefreshIntervalSeconds}
                  min={0}
                  step={PROVIDER_HEALTH_INTERVAL_STEP_SECONDS}
                  size="sm"
                  className="w-32"
                  onValueChange={(value) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        {
                          providerHealthRefreshInterval: Duration.seconds(
                            normalizeIntervalSeconds(value),
                          ),
                        },
                      ),
                    )
                  }
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement aria-label="Decrease provider health interval" />
                    <NumberFieldInput aria-label="Provider health interval in seconds" />
                    <NumberFieldIncrement aria-label="Increase provider health interval" />
                  </NumberFieldGroup>
                </NumberField>
                <span className="text-xs text-muted-foreground">seconds</span>
              </div>
            </SettingsSearchTarget>

            <SettingsSearchTarget
              id="host-power-active-interval"
              className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">Host power monitor</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Poll host power state while clients are active.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <NumberField
                  value={hostPowerMonitorActiveIntervalSeconds}
                  min={5}
                  step={5}
                  size="sm"
                  className="w-32"
                  onValueChange={(value) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        {
                          hostPowerMonitorActiveInterval: Duration.seconds(
                            normalizeIntervalSeconds(value, 5),
                          ),
                        },
                      ),
                    )
                  }
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement aria-label="Decrease active host power interval" />
                    <NumberFieldInput aria-label="Active host power interval in seconds" />
                    <NumberFieldIncrement aria-label="Increase active host power interval" />
                  </NumberFieldGroup>
                </NumberField>
                <span className="text-xs text-muted-foreground">seconds</span>
              </div>
            </SettingsSearchTarget>

            <SettingsSearchTarget
              id="host-power-idle-interval"
              className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">Idle host monitor</div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Poll host power state when no foreground client is active.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <NumberField
                  value={hostPowerMonitorIdleIntervalSeconds}
                  min={5}
                  step={30}
                  size="sm"
                  className="w-32"
                  onValueChange={(value) =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        {
                          hostPowerMonitorIdleInterval: Duration.seconds(
                            normalizeIntervalSeconds(value, 5),
                          ),
                        },
                      ),
                    )
                  }
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement aria-label="Decrease idle host power interval" />
                    <NumberFieldInput aria-label="Idle host power interval in seconds" />
                    <NumberFieldIncrement aria-label="Increase idle host power interval" />
                  </NumberFieldGroup>
                </NumberField>
                <span className="text-xs text-muted-foreground">seconds</span>
              </div>
            </SettingsSearchTarget>

            <div className="grid gap-0 border-t sm:grid-cols-2">
              {BACKGROUND_ACTIVITY_BOOLEAN_OVERRIDES.map(({ key, label, targetId }) => (
                <SettingsSearchTarget
                  key={key}
                  id={targetId}
                  className="flex items-center justify-between gap-3 border-b px-4 py-3 last:border-b-0 sm:border-r sm:even:border-r-0"
                >
                  <label className="flex w-full items-center justify-between gap-3">
                    <span className="text-sm font-medium">{label}</span>
                    <Switch
                      checked={resolvedBackgroundActivity[key]}
                      onCheckedChange={(checked) =>
                        updateSettings(
                          backgroundActivityOverrideSettings(
                            settings.backgroundActivity,
                            resolvedBackgroundActivity,
                            {
                              [key]: Boolean(checked),
                            },
                          ),
                        )
                      }
                      aria-label={label}
                    />
                  </label>
                </SettingsSearchTarget>
              ))}
            </div>
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={!canWriteSettings}
            onClick={() => updateSettings(resetBackgroundActivitySettings())}
          >
            Reset all
          </Button>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function BackgroundActivitySettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { scope, environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const isEnvironmentScope = scope.environmentIds.length === 1 && environmentId !== null;
  const [backgroundActivityDialogOpen, setBackgroundActivityDialogOpen] = useState(false);
  const mixedBackgroundActivity = useScopedSettingsMixed(["backgroundActivity"]);
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const activeBackgroundActivityProfile = resolvedBackgroundActivity.profile;
  const backgroundActivityProfileOption = resolveBackgroundActivityProfileOption(settings);
  const backgroundActivityDescription =
    backgroundActivityProfileOption === "advanced"
      ? `${ADVANCED_BACKGROUND_ACTIVITY_DESCRIPTION} Shared policy: ${
          BACKGROUND_ACTIVITY_PROFILE_LABELS[activeBackgroundActivityProfile]
        }.`
      : BACKGROUND_ACTIVITY_PROFILE_DESCRIPTIONS[resolvedBackgroundActivity.profile];
  const canResetBackgroundActivity = !Equal.equals(
    settings.backgroundActivity,
    DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
  );

  return (
    <>
      <BackgroundActivitySearchOpener
        enabled={isEnvironmentScope}
        onOpen={setBackgroundActivityDialogOpen}
      />
      <SettingsRow
        serverScoped
        settingKeys={["backgroundActivity"]}
        id={searchableSetting("background-activity").id}
        title={
          <span className="inline-flex items-center gap-1.5">
            {searchableSetting("background-activity").title}
            <PolicyTooltip>
              This shared policy gates background work such as Git refreshes and provider health
              probes after their individual intervals elapse.
            </PolicyTooltip>
          </span>
        }
        description={backgroundActivityDescription}
        resetAction={
          canResetBackgroundActivity ? (
            <SettingResetButton
              label="background activity"
              onClick={() => updateSettings(resetBackgroundActivitySettings())}
            />
          ) : null
        }
        control={
          <>
            <Select
              value={mixedBackgroundActivity ? null : backgroundActivityProfileOption}
              onValueChange={(value) => {
                if (value === "advanced") {
                  if (isEnvironmentScope) setBackgroundActivityDialogOpen(true);
                  return;
                }
                if (value === "balanced" || value === "performance" || value === "battery-saver") {
                  updateSettings(backgroundActivityProfileSettings(value));
                }
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-40"
                aria-label="Background activity profile"
              >
                <SelectValue>
                  {(value: BackgroundActivityProfileOption | null) =>
                    value === null ? "Mixed" : BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS[value]
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="balanced">
                  {BACKGROUND_ACTIVITY_PROFILE_LABELS.balanced}
                </SelectItem>
                <SelectItem hideIndicator value="performance">
                  {BACKGROUND_ACTIVITY_PROFILE_LABELS.performance}
                </SelectItem>
                <SelectItem hideIndicator value="battery-saver">
                  {BACKGROUND_ACTIVITY_PROFILE_LABELS["battery-saver"]}
                </SelectItem>
                <SelectItem hideIndicator value="advanced" disabled={!isEnvironmentScope}>
                  {isEnvironmentScope
                    ? BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS.advanced
                    : `${BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS.advanced} (one environment)`}
                </SelectItem>
              </SelectPopup>
            </Select>
            {backgroundActivityProfileOption === "advanced" && isEnvironmentScope ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="outline"
                      aria-label="Configure advanced background activity"
                      onClick={() => setBackgroundActivityDialogOpen(true)}
                    >
                      <SettingsIcon className="size-4" />
                    </Button>
                  }
                />
                <TooltipPopup side="top">Configure background activity</TooltipPopup>
              </Tooltip>
            ) : null}
            <BackgroundActivityAdvancedDialog
              open={backgroundActivityDialogOpen && isEnvironmentScope}
              onOpenChange={setBackgroundActivityDialogOpen}
            />
          </>
        }
      />
    </>
  );
}
