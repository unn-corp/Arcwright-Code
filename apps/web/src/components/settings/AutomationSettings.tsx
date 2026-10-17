import { useAtomValue } from "@effect/atom-react";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { SettingsIcon } from "lucide-react";
import { useState } from "react";
import { type ModelSelection, ProviderDriverKind } from "@t3tools/contracts";
import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_INACTIVE_WORKTREE_AGE_DAYS,
  MAX_INACTIVE_WORKTREE_CLEANUP_INTERVAL_DAYS,
  MAX_DECISION_FOLLOW_UP_LIMIT,
  MAX_DECISION_FOLLOW_UP_REMINDER_DAYS,
  MAX_PRODUCT_OPPORTUNITY_CANDIDATES,
  MAX_PULL_REQUEST_ROLLUP_IDLE_DAYS,
  MAX_PULL_REQUEST_ROLLUP_INTERVAL_DAYS,
  MAX_PULL_REQUEST_ROLLUP_LIMIT,
  MAX_PULL_REQUEST_ROLLUP_REPAIR_ATTEMPTS,
  MIN_INACTIVE_WORKTREE_AGE_DAYS,
  MIN_INACTIVE_WORKTREE_CLEANUP_INTERVAL_DAYS,
  MIN_DECISION_FOLLOW_UP_LIMIT,
  MIN_DECISION_FOLLOW_UP_REMINDER_DAYS,
  MIN_PRODUCT_OPPORTUNITY_CANDIDATES,
  MIN_PULL_REQUEST_ROLLUP_IDLE_DAYS,
  MIN_PULL_REQUEST_ROLLUP_INTERVAL_DAYS,
  MIN_PULL_REQUEST_ROLLUP_LIMIT,
  MIN_PULL_REQUEST_ROLLUP_REPAIR_ATTEMPTS,
} from "@t3tools/contracts/settings";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { createModelSelection } from "@t3tools/shared/model";
import * as Equal from "effect/Equal";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { primaryServerProvidersAtom } from "../../state/server";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { resolveBackgroundActivityProfileOption } from "./SettingsPanels.logic";
import {
  PolicyTooltip,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

import {
  BACKGROUND_ACTIVITY_PROFILE_LABELS,
  BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS,
  BACKGROUND_ACTIVITY_PROFILE_DESCRIPTIONS,
  ADVANCED_BACKGROUND_ACTIVITY_DESCRIPTION,
  resetBackgroundActivitySettings,
  backgroundActivityProfileSettings,
  BackgroundActivityAdvancedDialog,
} from "./BackgroundActivitySettings";

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");

function AutomationModelControl({
  selection,
  ariaLabel,
  onChange,
}: {
  readonly selection: ModelSelection;
  readonly ariaLabel: string;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const settings = usePrimarySettings();
  const environmentId = usePrimaryEnvironmentId();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings, null),
  );
  const instanceEntry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
  const provider = instanceEntry?.driverKind ?? DEFAULT_DRIVER_KIND;
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    selection.instanceId,
    selection.model,
  );

  return (
    <div className="flex w-full min-w-0 flex-wrap items-center justify-end gap-1.5 sm:w-auto">
      <ProviderModelPicker
        activeInstanceId={selection.instanceId}
        model={selection.model}
        lockedProvider={null}
        instanceEntries={instanceEntries}
        modelOptionsByInstance={modelOptionsByInstance}
        environmentId={environmentId}
        triggerClassName="min-w-0 max-w-full shrink-0 text-foreground/90 hover:text-foreground"
        triggerAriaLabel={`${ariaLabel} provider account and model`}
        onInstanceModelChange={(instanceId, model) => {
          const options =
            instanceId === selection.instanceId && model === selection.model
              ? selection.options
              : undefined;
          onChange(createModelSelection(instanceId, model, options));
        }}
      />
      <TraitsPicker
        provider={provider}
        models={instanceEntry?.models ?? []}
        model={selection.model}
        prompt=""
        onPromptChange={() => {}}
        modelOptions={selection.options}
        allowPromptInjectedEffort={false}
        planModeEnabled={settings.planModeEnabled}
        triggerClassName="min-w-0 max-w-full shrink-0 text-foreground/90 hover:text-foreground"
        onModelOptionsChange={(options) =>
          onChange(createModelSelection(selection.instanceId, selection.model, options))
        }
      />
    </div>
  );
}

function AutomationIntegerControl({
  value,
  min,
  max,
  label,
  unit,
  onChange,
}: {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly label: string;
  readonly unit: string;
  readonly onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <NumberField
        value={value}
        min={min}
        max={max}
        step={1}
        size="sm"
        className="w-28"
        onValueChange={(next) => {
          if (next === null || !Number.isInteger(next) || next < min || next > max) return;
          onChange(next);
        }}
      >
        <NumberFieldGroup>
          <NumberFieldDecrement aria-label={`Decrease ${label}`} />
          <NumberFieldInput aria-label={label} />
          <NumberFieldIncrement aria-label={`Increase ${label}`} />
        </NumberFieldGroup>
      </NumberField>
      <span className="text-xs text-muted-foreground">{unit}</span>
    </div>
  );
}

export function AutomationSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const [backgroundActivityDialogOpen, setBackgroundActivityDialogOpen] = useState(false);
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const activeBackgroundActivityProfile = resolvedBackgroundActivity.profile;
  const backgroundActivityProfileOption = resolveBackgroundActivityProfileOption(settings);
  const backgroundActivityDescription =
    backgroundActivityProfileOption === "advanced"
      ? `${ADVANCED_BACKGROUND_ACTIVITY_DESCRIPTION} Current shared policy: ${
          BACKGROUND_ACTIVITY_PROFILE_LABELS[activeBackgroundActivityProfile]
        }.`
      : BACKGROUND_ACTIVITY_PROFILE_DESCRIPTIONS[resolvedBackgroundActivity.profile];
  const canResetBackgroundActivity = !Equal.equals(
    settings.backgroundActivity,
    DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
  );
  const continuousModelDirty = !Equal.equals(
    settings.continuousImprovement.modelSelection,
    DEFAULT_UNIFIED_SETTINGS.continuousImprovement.modelSelection,
  );
  const repositoryReviewModelDirty = !Equal.equals(
    settings.repositoryReview.modelSelection,
    DEFAULT_UNIFIED_SETTINGS.repositoryReview.modelSelection,
  );
  const decisionFollowUpModelDirty = !Equal.equals(
    settings.decisionFollowUp.modelSelection,
    DEFAULT_UNIFIED_SETTINGS.decisionFollowUp.modelSelection,
  );
  const continuousRiskDirty =
    settings.continuousImprovement.maxRiskTier !==
    DEFAULT_UNIFIED_SETTINGS.continuousImprovement.maxRiskTier;
  const continuousConfidenceDirty =
    settings.continuousImprovement.minimumConfidence !==
    DEFAULT_UNIFIED_SETTINGS.continuousImprovement.minimumConfidence;
  const continuousConsolidatePullRequestsDirty =
    settings.continuousImprovement.consolidatePullRequests !==
    DEFAULT_UNIFIED_SETTINGS.continuousImprovement.consolidatePullRequests;
  const continuousRemoveCompletedWorktreesDirty =
    settings.continuousImprovement.removeCompletedWorktrees !==
    DEFAULT_UNIFIED_SETTINGS.continuousImprovement.removeCompletedWorktrees;
  const pullRequestRollupModelDirty = !Equal.equals(
    settings.pullRequestRollup.modelSelection,
    DEFAULT_UNIFIED_SETTINGS.pullRequestRollup.modelSelection,
  );
  const inactiveWorktreeCleanupEnabledDirty =
    settings.inactiveWorktreeCleanup.enabled !==
    DEFAULT_UNIFIED_SETTINGS.inactiveWorktreeCleanup.enabled;
  const inactiveWorktreeCleanupIntervalDirty =
    settings.inactiveWorktreeCleanup.intervalDays !==
    DEFAULT_UNIFIED_SETTINGS.inactiveWorktreeCleanup.intervalDays;
  const inactiveWorktreeCleanupAgeDirty =
    settings.inactiveWorktreeCleanup.minimumInactiveDays !==
    DEFAULT_UNIFIED_SETTINGS.inactiveWorktreeCleanup.minimumInactiveDays;
  const repositoryReviewEnabledDirty =
    settings.repositoryReview.enabled !== DEFAULT_UNIFIED_SETTINGS.repositoryReview.enabled;
  const repositoryReviewIntervalDirty =
    settings.repositoryReview.intervalMinutes !==
    DEFAULT_UNIFIED_SETTINGS.repositoryReview.intervalMinutes;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Agent automations">
        <SettingsRow
          {...searchableSetting("continuous-improvement")}
          description="Continuously starts one implementation agent at a time for open, ready-to-act findings. Each run works in an isolated branch and must deliver through a draft pull request. Arcwright Code never merges it automatically."
          resetAction={
            settings.continuousImprovement.enabled !==
            DEFAULT_UNIFIED_SETTINGS.continuousImprovement.enabled ? (
              <SettingResetButton
                label="continuous improvement"
                onClick={() =>
                  updateSettings({
                    continuousImprovement: {
                      ...settings.continuousImprovement,
                      enabled: DEFAULT_UNIFIED_SETTINGS.continuousImprovement.enabled,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.continuousImprovement.enabled}
              onCheckedChange={(checked) =>
                updateSettings({
                  continuousImprovement: {
                    ...settings.continuousImprovement,
                    enabled: Boolean(checked),
                  },
                })
              }
              aria-label="Continuous Improvement Mode"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("continuous-improvement-consolidate-prs")}
          className="bg-muted/20 sm:pl-9"
          description="Before starting work, asks the implementation agent to inspect open pull requests and extend one when its goal and affected code are coherently related. Otherwise the agent opens a new draft pull request."
          resetAction={
            continuousConsolidatePullRequestsDirty ? (
              <SettingResetButton
                label="consolidate pull requests"
                onClick={() =>
                  updateSettings({
                    continuousImprovement: {
                      ...settings.continuousImprovement,
                      consolidatePullRequests:
                        DEFAULT_UNIFIED_SETTINGS.continuousImprovement.consolidatePullRequests,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.continuousImprovement.consolidatePullRequests}
              onCheckedChange={(checked) =>
                updateSettings({
                  continuousImprovement: {
                    ...settings.continuousImprovement,
                    consolidatePullRequests: Boolean(checked),
                  },
                })
              }
              aria-label="Consolidate pull requests"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("continuous-improvement-remove-worktrees")}
          className="bg-muted/20 sm:pl-9"
          description="Safely removes an automation worktree after its draft pull request is delivered or its finding is confirmed stale. Worktrees with uncommitted changes are retained."
          resetAction={
            continuousRemoveCompletedWorktreesDirty ? (
              <SettingResetButton
                label="remove completed worktrees"
                onClick={() =>
                  updateSettings({
                    continuousImprovement: {
                      ...settings.continuousImprovement,
                      removeCompletedWorktrees:
                        DEFAULT_UNIFIED_SETTINGS.continuousImprovement.removeCompletedWorktrees,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.continuousImprovement.removeCompletedWorktrees}
              onCheckedChange={(checked) =>
                updateSettings({
                  continuousImprovement: {
                    ...settings.continuousImprovement,
                    removeCompletedWorktrees: Boolean(checked),
                  },
                })
              }
              aria-label="Remove completed worktrees"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("continuous-improvement-model")}
          className="bg-muted/20 sm:pl-9"
          description="Provider account, model, and effort used when Continuous Improvement starts an implementation agent."
          resetAction={
            continuousModelDirty ? (
              <SettingResetButton
                label="implementation agent model"
                onClick={() =>
                  updateSettings({
                    continuousImprovement: {
                      ...settings.continuousImprovement,
                      modelSelection: DEFAULT_UNIFIED_SETTINGS.continuousImprovement.modelSelection,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <AutomationModelControl
              selection={settings.continuousImprovement.modelSelection}
              ariaLabel="Implementation agent"
              onChange={(modelSelection) =>
                updateSettings({
                  continuousImprovement: {
                    ...settings.continuousImprovement,
                    modelSelection,
                  },
                })
              }
            />
          }
        />

        <SettingsRow
          {...searchableSetting("continuous-improvement-max-risk")}
          className="bg-muted/20 sm:pl-9"
          description="Highest qualified risk tier that Continuous Improvement may start without approval."
          resetAction={
            continuousRiskDirty ? (
              <SettingResetButton
                label="maximum automation risk"
                onClick={() =>
                  updateSettings({
                    continuousImprovement: {
                      ...settings.continuousImprovement,
                      maxRiskTier: DEFAULT_UNIFIED_SETTINGS.continuousImprovement.maxRiskTier,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.continuousImprovement.maxRiskTier}
              onValueChange={(value) => {
                if (
                  value !== "low" &&
                  value !== "medium" &&
                  value !== "high" &&
                  value !== "critical"
                ) {
                  return;
                }
                updateSettings({
                  continuousImprovement: {
                    ...settings.continuousImprovement,
                    maxRiskTier: value,
                  },
                });
              }}
            >
              <SelectTrigger aria-label="Maximum automation risk" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="critical">Critical</SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          {...searchableSetting("continuous-improvement-confidence")}
          className="bg-muted/20 sm:pl-9"
          description="Minimum evidence confidence required before Continuous Improvement may start work."
          resetAction={
            continuousConfidenceDirty ? (
              <SettingResetButton
                label="minimum automation confidence"
                onClick={() =>
                  updateSettings({
                    continuousImprovement: {
                      ...settings.continuousImprovement,
                      minimumConfidence:
                        DEFAULT_UNIFIED_SETTINGS.continuousImprovement.minimumConfidence,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.continuousImprovement.minimumConfidence}
              onValueChange={(value) => {
                if (value !== "low" && value !== "medium" && value !== "high") return;
                updateSettings({
                  continuousImprovement: {
                    ...settings.continuousImprovement,
                    minimumConfidence: value,
                  },
                });
              }}
            >
              <SelectTrigger aria-label="Minimum automation confidence" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          {...searchableSetting("inactive-worktree-cleanup")}
          description="Periodically removes inactive Arcwright Code worktrees only when they are settled, clean, and their current commit is confirmed on the branch's configured remote after a fetch. Local and remote branches are retained."
          resetAction={
            inactiveWorktreeCleanupEnabledDirty ? (
              <SettingResetButton
                label="inactive worktree cleanup"
                onClick={() =>
                  updateSettings({
                    inactiveWorktreeCleanup: {
                      ...settings.inactiveWorktreeCleanup,
                      enabled: DEFAULT_UNIFIED_SETTINGS.inactiveWorktreeCleanup.enabled,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.inactiveWorktreeCleanup.enabled}
              onCheckedChange={(checked) =>
                updateSettings({
                  inactiveWorktreeCleanup: {
                    ...settings.inactiveWorktreeCleanup,
                    enabled: Boolean(checked),
                  },
                })
              }
              aria-label="Inactive worktree cleanup"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("inactive-worktree-cleanup-interval")}
          className="bg-muted/20 sm:pl-9"
          description="Number of days between cleanup scans. Turning the automation on makes its first scan due immediately."
          resetAction={
            inactiveWorktreeCleanupIntervalDirty ? (
              <SettingResetButton
                label="inactive worktree cleanup interval"
                onClick={() =>
                  updateSettings({
                    inactiveWorktreeCleanup: {
                      ...settings.inactiveWorktreeCleanup,
                      intervalDays: DEFAULT_UNIFIED_SETTINGS.inactiveWorktreeCleanup.intervalDays,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <AutomationIntegerControl
              value={settings.inactiveWorktreeCleanup.intervalDays}
              min={MIN_INACTIVE_WORKTREE_CLEANUP_INTERVAL_DAYS}
              max={MAX_INACTIVE_WORKTREE_CLEANUP_INTERVAL_DAYS}
              label="Inactive worktree cleanup interval in days"
              unit="days"
              onChange={(intervalDays) =>
                updateSettings({
                  inactiveWorktreeCleanup: {
                    ...settings.inactiveWorktreeCleanup,
                    intervalDays,
                  },
                })
              }
            />
          }
        />

        <SettingsRow
          {...searchableSetting("inactive-worktree-cleanup-age")}
          className="bg-muted/20 sm:pl-9"
          description="Minimum age of both the worktree's latest Arcwright Code activity and its current commit before removal is allowed."
          resetAction={
            inactiveWorktreeCleanupAgeDirty ? (
              <SettingResetButton
                label="minimum inactive worktree age"
                onClick={() =>
                  updateSettings({
                    inactiveWorktreeCleanup: {
                      ...settings.inactiveWorktreeCleanup,
                      minimumInactiveDays:
                        DEFAULT_UNIFIED_SETTINGS.inactiveWorktreeCleanup.minimumInactiveDays,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <AutomationIntegerControl
              value={settings.inactiveWorktreeCleanup.minimumInactiveDays}
              min={MIN_INACTIVE_WORKTREE_AGE_DAYS}
              max={MAX_INACTIVE_WORKTREE_AGE_DAYS}
              label="Minimum inactive worktree age in days"
              unit="days"
              onChange={(minimumInactiveDays) =>
                updateSettings({
                  inactiveWorktreeCleanup: {
                    ...settings.inactiveWorktreeCleanup,
                    minimumInactiveDays,
                  },
                })
              }
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup")}
          description="On an N-day interval, starts an isolated agent for each GitHub repository with eligible open pull requests. The agent reviews the combined changes, repairs allowed problems, and opens one pre-release pull request. It never merges the source or rollup pull requests. Turning this off prevents future scans but does not cancel active work sessions."
          resetAction={
            settings.pullRequestRollup.enabled !==
            DEFAULT_UNIFIED_SETTINGS.pullRequestRollup.enabled ? (
              <SettingResetButton
                label="pull request rollup"
                onClick={() =>
                  updateSettings({
                    pullRequestRollup: {
                      ...settings.pullRequestRollup,
                      enabled: DEFAULT_UNIFIED_SETTINGS.pullRequestRollup.enabled,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.pullRequestRollup.enabled}
              onCheckedChange={(checked) =>
                updateSettings({
                  pullRequestRollup: {
                    ...settings.pullRequestRollup,
                    enabled: Boolean(checked),
                  },
                })
              }
              aria-label="Pull request rollup"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup-interval")}
          className="bg-muted/20 sm:pl-9"
          description="Number of days between portfolio-wide pull request scans. Turning the automation on makes the first scan due immediately."
          resetAction={
            settings.pullRequestRollup.intervalDays !==
            DEFAULT_UNIFIED_SETTINGS.pullRequestRollup.intervalDays ? (
              <SettingResetButton
                label="pull request rollup interval"
                onClick={() =>
                  updateSettings({
                    pullRequestRollup: {
                      ...settings.pullRequestRollup,
                      intervalDays: DEFAULT_UNIFIED_SETTINGS.pullRequestRollup.intervalDays,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <AutomationIntegerControl
              value={settings.pullRequestRollup.intervalDays}
              min={MIN_PULL_REQUEST_ROLLUP_INTERVAL_DAYS}
              max={MAX_PULL_REQUEST_ROLLUP_INTERVAL_DAYS}
              label="Pull request rollup interval in days"
              unit="days"
              onChange={(intervalDays) =>
                updateSettings({
                  pullRequestRollup: { ...settings.pullRequestRollup, intervalDays },
                })
              }
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup-drafts")}
          className="bg-muted/20 sm:pl-9"
          description="Include draft pull requests in the review and rollup pass."
          control={
            <Switch
              checked={settings.pullRequestRollup.includeDrafts}
              onCheckedChange={(checked) =>
                updateSettings({
                  pullRequestRollup: {
                    ...settings.pullRequestRollup,
                    includeDrafts: Boolean(checked),
                  },
                })
              }
              aria-label="Include draft pull requests"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup-ready")}
          className="bg-muted/20 sm:pl-9"
          description="Include pull requests that are ready for review."
          control={
            <Switch
              checked={settings.pullRequestRollup.includeReady}
              onCheckedChange={(checked) =>
                updateSettings({
                  pullRequestRollup: {
                    ...settings.pullRequestRollup,
                    includeReady: Boolean(checked),
                  },
                })
              }
              aria-label="Include ready pull requests"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup-idle-days")}
          className="bg-muted/20 sm:pl-9"
          description="Only include pull requests that have not changed for this many days. Use 0 to include newly updated work."
          control={
            <AutomationIntegerControl
              value={settings.pullRequestRollup.minimumIdleDays}
              min={MIN_PULL_REQUEST_ROLLUP_IDLE_DAYS}
              max={MAX_PULL_REQUEST_ROLLUP_IDLE_DAYS}
              label="Minimum pull request inactivity in days"
              unit="days"
              onChange={(minimumIdleDays) =>
                updateSettings({
                  pullRequestRollup: { ...settings.pullRequestRollup, minimumIdleDays },
                })
              }
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup-limit")}
          className="bg-muted/20 sm:pl-9"
          description="Maximum number of pull requests handled per repository in one rollup. The oldest eligible updates are handled first."
          control={
            <AutomationIntegerControl
              value={settings.pullRequestRollup.maximumPullRequests}
              min={MIN_PULL_REQUEST_ROLLUP_LIMIT}
              max={MAX_PULL_REQUEST_ROLLUP_LIMIT}
              label="Maximum pull requests per rollup"
              unit="PRs"
              onChange={(maximumPullRequests) =>
                updateSettings({
                  pullRequestRollup: { ...settings.pullRequestRollup, maximumPullRequests },
                })
              }
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup-failing-checks")}
          className="bg-muted/20 sm:pl-9"
          description="Allow the agent to diagnose failing checks and push safe repairs to a source pull request branch. Otherwise failing pull requests are excluded."
          control={
            <Switch
              checked={settings.pullRequestRollup.fixFailingChecks}
              onCheckedChange={(checked) =>
                updateSettings({
                  pullRequestRollup: {
                    ...settings.pullRequestRollup,
                    fixFailingChecks: Boolean(checked),
                  },
                })
              }
              aria-label="Repair failing pull request checks"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup-conflicts")}
          className="bg-muted/20 sm:pl-9"
          description="Allow the agent to resolve source pull request conflicts on the isolated rollup branch. Otherwise conflicting pull requests are excluded."
          control={
            <Switch
              checked={settings.pullRequestRollup.fixMergeConflicts}
              onCheckedChange={(checked) =>
                updateSettings({
                  pullRequestRollup: {
                    ...settings.pullRequestRollup,
                    fixMergeConflicts: Boolean(checked),
                  },
                })
              }
              aria-label="Resolve pull request conflicts"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup-repair-attempts")}
          className="bg-muted/20 sm:pl-9"
          description="Maximum focused repair attempts for each failing or conflicting source pull request. Use 0 to inspect and exclude without repair."
          control={
            <AutomationIntegerControl
              value={settings.pullRequestRollup.repairAttempts}
              min={MIN_PULL_REQUEST_ROLLUP_REPAIR_ATTEMPTS}
              max={MAX_PULL_REQUEST_ROLLUP_REPAIR_ATTEMPTS}
              label="Repair attempts per pull request"
              unit="attempts"
              onChange={(repairAttempts) =>
                updateSettings({
                  pullRequestRollup: { ...settings.pullRequestRollup, repairAttempts },
                })
              }
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup-target")}
          className="bg-muted/20 sm:pl-9"
          description="Base branch for eligible source pull requests and the pre-release pull request. Leave empty to use each repository's default branch."
          control={
            <DraftInput
              className="w-full sm:w-56"
              value={settings.pullRequestRollup.targetBranch}
              onCommit={(targetBranch) =>
                updateSettings({
                  pullRequestRollup: { ...settings.pullRequestRollup, targetBranch },
                })
              }
              placeholder="Default branch"
              spellCheck={false}
              aria-label="Pull request rollup target branch"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup-branch-prefix")}
          className="bg-muted/20 sm:pl-9"
          description="Prefix used for isolated pre-release rollup branches. Arcwright Code appends the date and a unique identifier."
          control={
            <DraftInput
              className="w-full sm:w-56"
              value={settings.pullRequestRollup.branchPrefix}
              maxLength={48}
              onCommit={(branchPrefix) => {
                if (branchPrefix.trim().length === 0) return;
                updateSettings({
                  pullRequestRollup: { ...settings.pullRequestRollup, branchPrefix },
                });
              }}
              spellCheck={false}
              aria-label="Pull request rollup branch prefix"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup-title")}
          className="bg-muted/20 sm:pl-9"
          description="Title used for the generated pre-release pull request."
          control={
            <DraftInput
              className="w-full sm:w-72"
              value={settings.pullRequestRollup.pullRequestTitle}
              maxLength={120}
              onCommit={(pullRequestTitle) => {
                if (pullRequestTitle.trim().length === 0) return;
                updateSettings({
                  pullRequestRollup: { ...settings.pullRequestRollup, pullRequestTitle },
                });
              }}
              aria-label="Pre-release pull request title"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup-draft-output")}
          className="bg-muted/20 sm:pl-9"
          description="Keep the generated pre-release pull request in draft until a user explicitly marks it ready."
          control={
            <Switch
              checked={settings.pullRequestRollup.openAsDraft}
              onCheckedChange={(checked) =>
                updateSettings({
                  pullRequestRollup: {
                    ...settings.pullRequestRollup,
                    openAsDraft: Boolean(checked),
                  },
                })
              }
              aria-label="Open pre-release pull request as draft"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup-remove-worktrees")}
          className="bg-muted/20 sm:pl-9"
          description="Safely remove a clean rollup worktree after Arcwright Code verifies the generated pull request."
          control={
            <Switch
              checked={settings.pullRequestRollup.removeCompletedWorktrees}
              onCheckedChange={(checked) =>
                updateSettings({
                  pullRequestRollup: {
                    ...settings.pullRequestRollup,
                    removeCompletedWorktrees: Boolean(checked),
                  },
                })
              }
              aria-label="Remove completed rollup worktrees"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup-instructions")}
          className="bg-muted/20 sm:pl-9"
          description="Optional repository-agnostic instructions added to every rollup agent, such as release-note or validation requirements."
          control={
            <DraftInput
              className="w-full sm:w-80"
              value={settings.pullRequestRollup.customInstructions}
              maxLength={4000}
              onCommit={(customInstructions) =>
                updateSettings({
                  pullRequestRollup: { ...settings.pullRequestRollup, customInstructions },
                })
              }
              placeholder="No additional instructions"
              aria-label="Pull request rollup instructions"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("pull-request-rollup-model")}
          className="bg-muted/20 sm:pl-9"
          description="Provider account, model, and effort used to review, repair, and roll up pull requests."
          resetAction={
            pullRequestRollupModelDirty ? (
              <SettingResetButton
                label="pull request rollup model"
                onClick={() =>
                  updateSettings({
                    pullRequestRollup: {
                      ...settings.pullRequestRollup,
                      modelSelection: DEFAULT_UNIFIED_SETTINGS.pullRequestRollup.modelSelection,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <AutomationModelControl
              selection={settings.pullRequestRollup.modelSelection}
              ariaLabel="Pull request rollup"
              onChange={(modelSelection) =>
                updateSettings({
                  pullRequestRollup: { ...settings.pullRequestRollup, modelSelection },
                })
              }
            />
          }
        />

        <SettingsRow
          {...searchableSetting("product-opportunity-discovery")}
          description="Adds a dedicated scout-and-critic pass for evidence-backed UX, workflow, and system capability improvements. Each project needs confirmed product context."
          control={
            <Switch
              checked={settings.productOpportunityDiscovery.enabled}
              onCheckedChange={(checked) =>
                updateSettings({
                  productOpportunityDiscovery: {
                    ...settings.productOpportunityDiscovery,
                    enabled: Boolean(checked),
                  },
                })
              }
              aria-label="Product opportunity discovery"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("product-opportunity-limit")}
          className="bg-muted/20 sm:pl-9"
          description="Maximum validated product opportunities returned during each repository review. Zero-output reviews remain valid."
          control={
            <AutomationIntegerControl
              value={settings.productOpportunityDiscovery.maximumCandidates}
              min={MIN_PRODUCT_OPPORTUNITY_CANDIDATES}
              max={MAX_PRODUCT_OPPORTUNITY_CANDIDATES}
              label="Maximum product opportunities per review"
              unit="opportunities"
              onChange={(maximumCandidates) =>
                updateSettings({
                  productOpportunityDiscovery: {
                    ...settings.productOpportunityDiscovery,
                    maximumCandidates,
                  },
                })
              }
            />
          }
        />

        <SettingsRow
          {...searchableSetting("decision-follow-up")}
          description="Starts read-only conversations for findings that need product judgment, more research, or exceed the unattended implementation risk limit."
          control={
            <Switch
              checked={settings.decisionFollowUp.enabled}
              onCheckedChange={(checked) =>
                updateSettings({
                  decisionFollowUp: {
                    ...settings.decisionFollowUp,
                    enabled: Boolean(checked),
                  },
                })
              }
              aria-label="Decision follow-up"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("decision-follow-up-interval")}
          className="bg-muted/20 sm:pl-9"
          description="How often Arcwright Code checks for findings that need a user decision."
          control={
            <Select
              value={String(settings.decisionFollowUp.intervalMinutes)}
              onValueChange={(value) => {
                const intervalMinutes = Number(value);
                if (!Number.isInteger(intervalMinutes)) return;
                updateSettings({
                  decisionFollowUp: { ...settings.decisionFollowUp, intervalMinutes },
                });
              }}
            >
              <SelectTrigger aria-label="Decision follow-up interval" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                <SelectItem value="15">Every 15 minutes</SelectItem>
                <SelectItem value="30">Every 30 minutes</SelectItem>
                <SelectItem value="60">Every hour</SelectItem>
                <SelectItem value="360">Every 6 hours</SelectItem>
                <SelectItem value="720">Every 12 hours</SelectItem>
                <SelectItem value="1440">Every day</SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          {...searchableSetting("decision-follow-up-reminders")}
          className="bg-muted/20 sm:pl-9"
          description="Minimum time before Arcwright Code may start another conversation about the same unresolved finding."
          control={
            <AutomationIntegerControl
              value={settings.decisionFollowUp.reminderDays}
              min={MIN_DECISION_FOLLOW_UP_REMINDER_DAYS}
              max={MAX_DECISION_FOLLOW_UP_REMINDER_DAYS}
              label="Decision reminder interval in days"
              unit="days"
              onChange={(reminderDays) =>
                updateSettings({
                  decisionFollowUp: { ...settings.decisionFollowUp, reminderDays },
                })
              }
            />
          }
        />

        <SettingsRow
          {...searchableSetting("decision-follow-up-limit")}
          className="bg-muted/20 sm:pl-9"
          description="Maximum new decision conversations started during one scheduled scan."
          control={
            <AutomationIntegerControl
              value={settings.decisionFollowUp.maximumConversationsPerRun}
              min={MIN_DECISION_FOLLOW_UP_LIMIT}
              max={MAX_DECISION_FOLLOW_UP_LIMIT}
              label="Maximum decision conversations per scan"
              unit="conversations"
              onChange={(maximumConversationsPerRun) =>
                updateSettings({
                  decisionFollowUp: {
                    ...settings.decisionFollowUp,
                    maximumConversationsPerRun,
                  },
                })
              }
            />
          }
        />

        <SettingsRow
          {...searchableSetting("decision-follow-up-severity")}
          className="bg-muted/20 sm:pl-9"
          description="Minimum severity for ordinary findings. Product opportunities are eligible regardless of severity."
          control={
            <Select
              value={settings.decisionFollowUp.minimumSeverity}
              onValueChange={(minimumSeverity) => {
                if (
                  minimumSeverity !== "info" &&
                  minimumSeverity !== "low" &&
                  minimumSeverity !== "medium" &&
                  minimumSeverity !== "high" &&
                  minimumSeverity !== "critical"
                ) {
                  return;
                }
                updateSettings({
                  decisionFollowUp: { ...settings.decisionFollowUp, minimumSeverity },
                });
              }}
            >
              <SelectTrigger aria-label="Decision follow-up minimum severity" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                <SelectItem value="info">Info and above</SelectItem>
                <SelectItem value="low">Low and above</SelectItem>
                <SelectItem value="medium">Medium and above</SelectItem>
                <SelectItem value="high">High and above</SelectItem>
                <SelectItem value="critical">Critical only</SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          {...searchableSetting("decision-follow-up-research")}
          className="bg-muted/20 sm:pl-9"
          description="Include findings whose next step still needs product context, external facts, or human judgment."
          control={
            <Switch
              checked={settings.decisionFollowUp.includeNeedsResearch}
              onCheckedChange={(checked) =>
                updateSettings({
                  decisionFollowUp: {
                    ...settings.decisionFollowUp,
                    includeNeedsResearch: Boolean(checked),
                  },
                })
              }
              aria-label="Include findings that need research"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("decision-follow-up-risk")}
          className="bg-muted/20 sm:pl-9"
          description="Include ready findings whose technical risk exceeds the Continuous Improvement limit. User approval does not lower that risk."
          control={
            <Switch
              checked={settings.decisionFollowUp.includeAboveRisk}
              onCheckedChange={(checked) =>
                updateSettings({
                  decisionFollowUp: {
                    ...settings.decisionFollowUp,
                    includeAboveRisk: Boolean(checked),
                  },
                })
              }
              aria-label="Include findings above the automation risk limit"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("decision-follow-up-model")}
          className="bg-muted/20 sm:pl-9"
          description="Provider account, model, and effort used to prepare and begin decision conversations."
          resetAction={
            decisionFollowUpModelDirty ? (
              <SettingResetButton
                label="decision follow-up model"
                onClick={() =>
                  updateSettings({
                    decisionFollowUp: {
                      ...settings.decisionFollowUp,
                      modelSelection: DEFAULT_UNIFIED_SETTINGS.decisionFollowUp.modelSelection,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <AutomationModelControl
              selection={settings.decisionFollowUp.modelSelection}
              ariaLabel="Decision follow-up"
              onChange={(modelSelection) =>
                updateSettings({
                  decisionFollowUp: { ...settings.decisionFollowUp, modelSelection },
                })
              }
            />
          }
        />

        <SettingsRow
          {...searchableSetting("repository-review")}
          description="Periodically inspects repositories and qualifies new or changed findings into implementation-ready work."
          resetAction={
            repositoryReviewEnabledDirty ? (
              <SettingResetButton
                label="scheduled qualification"
                onClick={() =>
                  updateSettings({
                    repositoryReview: {
                      ...settings.repositoryReview,
                      enabled: DEFAULT_UNIFIED_SETTINGS.repositoryReview.enabled,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.repositoryReview.enabled}
              onCheckedChange={(checked) =>
                updateSettings({
                  repositoryReview: {
                    ...settings.repositoryReview,
                    enabled: Boolean(checked),
                  },
                })
              }
              aria-label="Scheduled discovery and qualification"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("repository-review-interval")}
          className="bg-muted/20 sm:pl-9"
          description="How often Arcwright Code runs the read-only discovery and qualification pass while the app is open."
          resetAction={
            repositoryReviewIntervalDirty ? (
              <SettingResetButton
                label="qualification cadence"
                onClick={() =>
                  updateSettings({
                    repositoryReview: {
                      ...settings.repositoryReview,
                      intervalMinutes: DEFAULT_UNIFIED_SETTINGS.repositoryReview.intervalMinutes,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.repositoryReview.intervalMinutes)}
              onValueChange={(value) => {
                const intervalMinutes = Number(value);
                if (!Number.isInteger(intervalMinutes)) return;
                updateSettings({
                  repositoryReview: {
                    ...settings.repositoryReview,
                    intervalMinutes,
                  },
                });
              }}
            >
              <SelectTrigger aria-label="Qualification cadence" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                <SelectItem value="15">Every 15 minutes</SelectItem>
                <SelectItem value="30">Every 30 minutes</SelectItem>
                <SelectItem value="60">Every hour</SelectItem>
                <SelectItem value="120">Every 2 hours</SelectItem>
                <SelectItem value="360">Every 6 hours</SelectItem>
                <SelectItem value="720">Every 12 hours</SelectItem>
                <SelectItem value="1440">Every day</SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          {...searchableSetting("repository-review-model")}
          className="bg-muted/20 sm:pl-9"
          description="Provider account, model, and effort used for discovery and qualification."
          resetAction={
            repositoryReviewModelDirty ? (
              <SettingResetButton
                label="repository review model"
                onClick={() =>
                  updateSettings({
                    repositoryReview: {
                      ...settings.repositoryReview,
                      modelSelection: DEFAULT_UNIFIED_SETTINGS.repositoryReview.modelSelection,
                    },
                  })
                }
              />
            ) : null
          }
          control={
            <AutomationModelControl
              selection={settings.repositoryReview.modelSelection}
              ariaLabel="Discovery and qualification"
              onChange={(modelSelection) =>
                updateSettings({
                  repositoryReview: { ...settings.repositoryReview, modelSelection },
                })
              }
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Background services">
        <SettingsRow
          {...searchableSetting("provider-update-checks")}
          description="Check installed provider CLIs for newer available versions."
          resetAction={
            settings.enableProviderUpdateChecks !==
            DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks ? (
              <SettingResetButton
                label="provider update checks"
                onClick={() =>
                  updateSettings({
                    enableProviderUpdateChecks: DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enableProviderUpdateChecks}
              onCheckedChange={(checked) =>
                updateSettings({ enableProviderUpdateChecks: Boolean(checked) })
              }
              aria-label="Check provider versions"
            />
          }
        />

        <SettingsRow
          {...searchableSetting("background-activity")}
          title={
            <span className="inline-flex items-center gap-1.5">
              Background activity
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
                value={backgroundActivityProfileOption}
                onValueChange={(value) => {
                  if (value === "advanced") {
                    setBackgroundActivityDialogOpen(true);
                    return;
                  }
                  if (
                    value === "balanced" ||
                    value === "performance" ||
                    value === "battery-saver"
                  ) {
                    updateSettings(backgroundActivityProfileSettings(value));
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-40" aria-label="Background activity profile">
                  <SelectValue>
                    {BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS[backgroundActivityProfileOption]}
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
                  <SelectItem hideIndicator value="advanced">
                    {BACKGROUND_ACTIVITY_PROFILE_OPTION_LABELS.advanced}
                  </SelectItem>
                </SelectPopup>
              </Select>
              {backgroundActivityProfileOption === "advanced" ? (
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
                open={backgroundActivityDialogOpen}
                onOpenChange={setBackgroundActivityDialogOpen}
              />
            </>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
