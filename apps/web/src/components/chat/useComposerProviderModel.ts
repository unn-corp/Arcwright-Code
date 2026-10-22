import { type DraftId } from "../../composerDraftStore";
import {
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  ProviderDriverKind,
  type ScopedThreadRef,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { type UnifiedSettings } from "@t3tools/contracts/settings";
import { getComposerPromptInjectionState, getComposerProviderState } from "./composerProviderState";
import { useThreadComposerSelection } from "../ChatView.logic";

const NO_PROVIDER_MODELS: ServerProvider["models"] = [];

/**
 * The provider instances the composer offers, which one is selected, and the model and options
 * the draft resolves to on it. The draft store is read first so every derivation follows the only
 * hook here; in the composer body they would straddle its later hooks and lose their cache.
 */
export function useComposerProviderModel(input: {
  readonly candidateInstanceIds: ReadonlyArray<ProviderInstanceId | null | undefined>;
  readonly lockedInstanceId: ProviderInstanceId | null | undefined;
  readonly lockedProvider: ProviderDriverKind | null;
  readonly requiredInstanceId?: ProviderInstanceId;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
  readonly activeProjectId: ProjectId | null;
  readonly threadRef: ScopedThreadRef | DraftId;
  readonly serverThread: Parameters<typeof useThreadComposerSelection>[0]["serverThread"];
  readonly threadModelSelection: ModelSelection | null | undefined;
  readonly projectModelSelection: ModelSelection | null | undefined;
  readonly promptInjectionState: ReturnType<typeof getComposerPromptInjectionState>;
}) {
  const {
    providerStatuses,
    settings,
    activeProjectId,
    threadRef,
    threadModelSelection,
    projectModelSelection,
    promptInjectionState,
    lockedProvider,
  } = input;
  const providerInstanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(providerStatuses),
      settings,
      activeProjectId,
    ),
  );
  const selection = useThreadComposerSelection({
    threadRef,
    serverThread: input.serverThread,
    threadModelSelection,
    projectModelSelection,
    entries: providerInstanceEntries,
    providers: providerStatuses,
    lockedProvider,
    settings,
  });
  const { selectedInstanceId, selectedProvider } = selection;
  const modelState = selection;
  const selectedProviderModels = selection.selectedProviderEntry?.models ?? NO_PROVIDER_MODELS;
  const composerProviderState = getComposerProviderState({
    provider: selectedProvider,
    model: modelState.selectedModel,
    models: selectedProviderModels,
    promptInjectionState,
    modelOptions: modelState.modelOptions?.[selectedInstanceId],
    planModeEnabled: settings.planModeEnabled,
  });
  return {
    providerInstanceEntries,
    ...selection,
    selectedInstanceId,
    selectedProvider,
    selectedProviderModels,
    composerModelOptions: modelState.modelOptions,
    selectedModel: modelState.selectedModel,
    composerProviderState,
  };
}
