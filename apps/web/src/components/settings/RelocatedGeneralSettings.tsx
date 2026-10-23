import { WorktreeSubmoduleSettings } from "./GeneralThreadDefaultsSettings";
import { RunLimitsSettings } from "./RunLimitsSettings";
import { useNavigate } from "@tanstack/react-router";
import { ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type DiffLayout } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import * as Equal from "effect/Equal";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
  selectsPlanAgent,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { ScopedSwitch } from "./ScopedSwitch";
import { toastManager } from "../ui/toast";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { DictationMicrophonePicker } from "./DictationMicrophonePicker";
import { DictationKeybindRecorder } from "./DictationKeybindRecorder";
import { DictationSetupAgentButton } from "./DictationSetupAgentButton";

export function VoiceDictationSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <>
      <SettingsRow
        {...searchableSetting("dictation-microphone")}
        description="Choose the microphone used for voice dictation. Detect requests access so Arcwright Code can display specific device names."
        resetAction={
          settings.dictationMicrophoneDeviceId !==
          DEFAULT_UNIFIED_SETTINGS.dictationMicrophoneDeviceId ? (
            <SettingResetButton
              label="dictation microphone"
              onClick={() =>
                updateSettings({
                  dictationMicrophoneDeviceId: DEFAULT_UNIFIED_SETTINGS.dictationMicrophoneDeviceId,
                })
              }
            />
          ) : null
        }
        control={
          <div className="flex w-full min-w-0 flex-col items-stretch gap-2 sm:w-80 sm:items-end">
            <DictationMicrophonePicker
              value={settings.dictationMicrophoneDeviceId}
              onValueChange={(dictationMicrophoneDeviceId) =>
                updateSettings({ dictationMicrophoneDeviceId })
              }
            />
            <DictationSetupAgentButton />
          </div>
        }
      />

      <SettingsRow
        {...searchableSetting("dictation-keybinds")}
        title="Dictation keybinds"
        description="Record the shortcuts sent to the focused desktop app when dictation starts and ends."
        resetAction={
          settings.dictationStartKeybinds.length > 0 || settings.dictationEndKeybinds.length > 0 ? (
            <SettingResetButton
              label="dictation keybinds"
              onClick={() =>
                updateSettings({
                  dictationStartKeybinds: DEFAULT_UNIFIED_SETTINGS.dictationStartKeybinds,
                  dictationEndKeybinds: DEFAULT_UNIFIED_SETTINGS.dictationEndKeybinds,
                })
              }
            />
          ) : null
        }
        control={
          <div className="flex w-full min-w-0 flex-col gap-2 sm:w-72">
            <DictationKeybindRecorder
              label="Start"
              value={settings.dictationStartKeybinds}
              onValueChange={(dictationStartKeybinds) => updateSettings({ dictationStartKeybinds })}
            />
            <DictationKeybindRecorder
              label="End"
              value={settings.dictationEndKeybinds}
              onValueChange={(dictationEndKeybinds) => updateSettings({ dictationEndKeybinds })}
            />
          </div>
        }
      />
    </>
  );
}

export function SourceControlWorktreeSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <>
      <WorktreeSubmoduleSettings />
      <SettingsRow
        serverScoped
        settingKeys={["newWorktreesStartFromOrigin"]}
        {...searchableSetting("start-from-origin")}
        description="Uses the latest commit of the base branch’s tracked remote branch, even if its name differs. Otherwise uses the same-named branch on origin. Uses your local branch if that remote branch is missing."
        resetAction={
          settings.newWorktreesStartFromOrigin !==
          DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin ? (
            <SettingResetButton
              label="new worktrees start from remote"
              onClick={() =>
                updateSettings({
                  newWorktreesStartFromOrigin: DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
                })
              }
            />
          ) : null
        }
        control={
          <ScopedSwitch
            settingKeys={["newWorktreesStartFromOrigin"]}
            checked={settings.newWorktreesStartFromOrigin}
            onCheckedChange={(checked) =>
              updateSettings({ newWorktreesStartFromOrigin: Boolean(checked) })
            }
            aria-label="Start new worktrees from remote by default"
          />
        }
      />
    </>
  );
}

export function SourceControlDiffSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <>
      <SettingsRow
        {...searchableSetting("diff-layout")}
        description="Show diffs stacked or side by side. The toggle in the diff toolbar changes this too."
        resetAction={
          settings.diffLayout !== DEFAULT_UNIFIED_SETTINGS.diffLayout ? (
            <SettingResetButton
              label="diff layout"
              onClick={() => updateSettings({ diffLayout: DEFAULT_UNIFIED_SETTINGS.diffLayout })}
            />
          ) : null
        }
        control={
          <Select
            value={settings.diffLayout}
            onValueChange={(value) => {
              if (value === "stacked" || value === "split") {
                updateSettings({ diffLayout: value });
              }
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Diff layout">
              <SelectValue>{DIFF_LAYOUT_LABELS[settings.diffLayout]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="stacked">
                {DIFF_LAYOUT_LABELS.stacked}
              </SelectItem>
              <SelectItem hideIndicator value="split">
                {DIFF_LAYOUT_LABELS.split}
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />

      <SettingsRow
        {...searchableSetting("hide-whitespace-changes")}
        description="Set whether the diff panel ignores whitespace-only edits by default."
        resetAction={
          settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace ? (
            <SettingResetButton
              label="diff whitespace changes"
              onClick={() =>
                updateSettings({
                  diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.diffIgnoreWhitespace}
            onCheckedChange={(checked) =>
              updateSettings({ diffIgnoreWhitespace: Boolean(checked) })
            }
            aria-label="Hide whitespace changes by default"
          />
        }
      />
    </>
  );
}

export function ProviderTextGenerationSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
  const { environment, target, connectedEnvironments } = useSettingsScope();
  const hasServerTargets = connectedEnvironments.length > 0;
  const environmentId = environment?.environmentId ?? null;
  const providersByEnvironment = useEnvironmentProviders();
  const serverProviders =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const textGenerationProviders = serverProviders.filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const textGenerationModelSelection = resolveAppModelSelectionState(
    settings,
    textGenerationProviders,
  );
  const textGenInstanceId = textGenerationModelSelection.instanceId;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;
  const textGenerationModelInstanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(textGenerationProviders),
      settings,
      target?.projectId ?? null,
    ),
  );
  const hasTextGenerationProvider = textGenerationModelInstanceEntries.some(
    (entry) => entry.enabled && entry.isAvailable,
  );
  const textGenInstanceEntry = textGenerationModelInstanceEntries.find(
    (entry) => entry.instanceId === textGenInstanceId,
  );
  const textGenProvider: ProviderDriverKind =
    textGenInstanceEntry?.driverKind ?? ProviderDriverKind.make("codex");
  const textGenerationModelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    textGenerationProviders,
    textGenInstanceId,
    textGenModel,
  );
  const isTextGenerationModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const textGenerationModelDisabledReason = useScopedModelDisabledReason(
    settings,
    textGenerationModelInstanceEntries,
  );
  const mixedTextGenerationModel = useScopedSettingsMixed(["textGenerationModelSelection"]);
  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["textGenerationModelSelection"]}
        {...searchableSetting("text-generation-model")}
        description="Used for thread titles and other generated text on connected devices with this provider. Source control can override it."
        resetAction={
          hasServerTargets && isTextGenerationModelDirty ? (
            <SettingResetButton
              label="text generation model"
              onClick={() =>
                updateSettings({
                  textGenerationModelSelection:
                    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                })
              }
            />
          ) : null
        }
        control={
          !hasServerTargets ? (
            <span className="text-sm text-muted-foreground">
              Connect an environment to choose its text generation model.
            </span>
          ) : !hasTextGenerationProvider ? (
            <span className="text-sm text-muted-foreground">
              No text generation providers available.
            </span>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <ProviderModelPicker
                environmentId={environmentId}
                activeInstanceId={textGenInstanceId}
                model={textGenModel}
                lockedProvider={null}
                instanceEntries={textGenerationModelInstanceEntries}
                modelOptionsByInstance={textGenerationModelOptionsByInstance}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                {...(mixedTextGenerationModel ? { triggerLabel: "Mixed" } : {})}
                getModelDisabledReason={textGenerationModelDisabledReason}
                {...(environmentId
                  ? {
                      onOpenProviderSetup: (instanceId: ProviderInstanceId) => {
                        void navigate({
                          to: "/settings/providers",
                          search: { environmentId, instanceId },
                        });
                      },
                    }
                  : {})}
                onInstanceModelChange={(instanceId, model) => {
                  const reason = textGenerationModelDisabledReason(instanceId, model);
                  if (reason) {
                    toastManager.add({
                      type: "error",
                      title: "Text generation model not saved",
                      description: reason,
                    });
                    return;
                  }
                  updateSettings({
                    textGenerationModelSelection: resolveAppModelSelectionState(
                      {
                        ...settings,
                        textGenerationModelSelection: createModelSelection(instanceId, model),
                      },
                      textGenerationProviders,
                    ),
                  });
                }}
              />
              {textGenInstanceEntry ? (
                <TraitsPicker
                  provider={textGenProvider}
                  models={textGenInstanceEntry?.models ?? []}
                  model={textGenModel}
                  modelOptions={textGenModelOptions}
                  allowPromptInjectedEffort={false}
                  planModeEnabled={
                    settings.planModeEnabled || selectsPlanAgent(textGenModelOptions)
                  }
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  onModelOptionsChange={(nextOptions) => {
                    updateSettings({
                      textGenerationModelSelection: resolveAppModelSelectionState(
                        {
                          ...settings,
                          textGenerationModelSelection: createModelSelection(
                            textGenInstanceId,
                            textGenModel,
                            nextOptions,
                          ),
                        },
                        textGenerationProviders,
                      ),
                    });
                  }}
                />
              ) : null}
            </div>
          )
        }
      />
    </>
  );
}

export function ProviderDiscoverySettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["enableProviderUpdateChecks"]}
        {...searchableSetting("provider-update-checks")}
        description="Check installed provider CLIs for newer available versions and fetch model catalog updates. When off, new models may not appear."
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
          <ScopedSwitch
            settingKeys={["enableProviderUpdateChecks"]}
            checked={settings.enableProviderUpdateChecks}
            onCheckedChange={(checked) =>
              updateSettings({ enableProviderUpdateChecks: Boolean(checked) })
            }
            aria-label="Check provider versions"
          />
        }
      />
    </>
  );
}

export function ProviderRunLimitsSettings() {
  return <RunLimitsSettings />;
}

const DIFF_LAYOUT_LABELS: Record<DiffLayout, string> = { stacked: "Stacked", split: "Split" };
