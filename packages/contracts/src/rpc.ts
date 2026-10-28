import { CodexAuthCallbackInput, CodexAuthCallbackState } from "./providerSetup.ts";
import { ThreadExportInput, ThreadExportResult, ThreadExportError } from "./threadExport.ts";
import {
  OrchestrationV2SearchThreadError,
  OrchestrationV2SearchThreadInput,
  OrchestrationV2SearchThreadResult,
  OrchestrationV2SearchThreadsInput,
  OrchestrationV2SearchThreadsResult,
} from "./orchestrationV2.ts";
import { OrchestrationDispatchCommandError } from "./orchestrationDispatch.ts";
import {
  McpAppCallToolInput,
  McpAppCallToolResult,
  McpAppReadResourceInput,
  McpAppReadResourceResult,
  McpAppRequestError,
  McpAppToolInfo,
  McpAppToolInfoInput,
  McpAppUpdateModelContextInput,
} from "./mcpApps.ts";
import {
  PeerLink,
  PeerLinkCreateInput,
  PeerLinkError,
  PeerLinkRemoveInput,
  PeerLinkRemoveResult,
  PeerLinkRequestAnswerInput,
  PeerLinkRequestError,
  PeerLinkSummary,
} from "./peerLink.ts";
import {
  ChatGptReconnectProfileInput,
  ChatGptReconnectProfile,
  ChatGptImportProfileInput,
  ChatGptHandoffInput,
  ChatGptHandoffState,
} from "./providerSetup.ts";
import {
  ForkMaintenanceActionInput,
  ForkMaintenanceError,
  ForkRecoveryRequest,
  ForkUpdatePolicyPatch,
  ForkUpdateStatus,
} from "./maintenance.ts";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ProviderAuthCancelInput,
  ProviderAuthCompleteInput,
  ProviderAuthState,
  ProviderAuthStartInput,
  ProviderAuthRespondInput,
  ProviderInstallCancelInput,
  ProviderInstallState,
  ProviderSetupError,
  ProviderSetupInput,
} from "./providerSetup.ts";

import {
  AcpRegistryAcceptUrlAuthInput,
  AcpRegistryAcceptUrlAuthResult,
  AcpRegistryDeleteSessionInput,
  AcpRegistryDeleteSessionResult,
  AcpRegistryDisableProviderInput,
  AcpRegistryDisableProviderResult,
  AcpRegistryImportSessionInput,
  AcpRegistryImportSessionResult,
  AcpRegistryListSessionsInput,
  AcpRegistryListSessionsResult,
  AcpRegistryListProvidersInput,
  AcpRegistryListProvidersResult,
  AcpRegistryLogoutInput,
  AcpRegistryLogoutResult,
  AcpRegistryManagedBinaryUninstallInput,
  AcpRegistryManagedBinaryUninstallResult,
  AcpRegistryOperationError,
  AcpRegistryPrepareInput,
  AcpRegistryPrepareResult,
  AcpRegistrySearchInput,
  AcpRegistrySearchResult,
  AcpRegistrySetProviderInput,
  AcpRegistrySetProviderResult,
} from "./acpRegistry.ts";
import { ExternalLauncherError, LaunchEditorInput } from "./editor.ts";
import {
  AgentDashboardError,
  AgentDashboardCollectInput,
  AgentDashboardFeedCardIdInput,
  AgentDashboardGetSnapshotInput,
  AgentDashboardMutationResult,
  AgentDashboardFindingActionInput,
  AgentDashboardLinkFindingThreadInput,
  AgentDashboardRepositoryPolicyInput,
  AgentDashboardResearchWatchItemInput,
  AgentDashboardRetryRunInput,
  AgentDashboardReviewSuggestionIdInput,
  AgentDashboardReviewSuggestionActionInput,
  AgentDashboardRunInvestigationInput,
  AgentDashboardSnapshot,
} from "./agentDashboard.ts";
import {
  AuthAccessStreamError,
  AuthAccessStreamEvent,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { ClientActivityReportInput } from "./background.ts";
import {
  FilesystemGetMetadataInput,
  FilesystemGetMetadataResult,
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  FilesystemBrowseError,
} from "./filesystem.ts";
import {
  CodexSessionsListInput,
  CodexSessionsListResult,
  CodexSessionsResumeInput,
  NativeSessionResumeError,
  CodexSessionsResumeResult,
} from "./codexSessions.ts";
import {
  AgentSessionImportInput,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionImportResult,
  AgentSessionScanInput,
  AgentSessionScanResult,
  AgentSessionScanError,
} from "./agentSessions.ts";
import {
  AssetAccessError,
  AssetCreateUrlInput,
  AssetCreateUrlResult,
  AttachmentCreateUploadUrlInput,
  AttachmentCreateUploadUrlResult,
  AttachmentDeleteInput,
  AttachmentUploadSigningKeyError,
} from "./assets.ts";
import {
  PersistChatAttachmentsError,
  PersistChatAttachmentsInput,
  PersistChatAttachmentsResult,
} from "./chatAttachment.ts";
import {
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetTurnDiffError,
} from "./checkpointDiff.ts";
import {
  WorktreeSetupCancelInput,
  WorktreeSetupCancelResult,
  WorktreeSetupStreamEvent,
  WorktreeSetupSubscribeInput,
} from "./worktreeSetup.ts";
import {
  GitActionProgressEvent,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
  GitCommandError,
  VcsCreateRefInput,
  VcsCreateRefResult,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsInitInput,
  VcsListRefsInput,
  VcsListRefsResult,
  GitManagerServiceError,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  VcsPullInput,
  GitPullRequestRefInput,
  VcsPullResult,
  VcsRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  WorktreeStorageUsage,
  VcsStatusInput,
  VcsRefreshStatusInput,
  VcsStatusSubscriptionInput,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "./git.ts";
import {
  ReviewDiffFileContentsInput,
  ReviewDiffFileContentsResult,
  ReviewDiffPreviewError,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
} from "./review.ts";
import { KeybindingsConfigError } from "./keybindings.ts";
import { OrchestrationSearchThreadsError } from "./threadSearch.ts";
import {
  ProviderUploadFeedbackError,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
} from "./provider.ts";
import { ProviderInstanceId, ProviderInstanceMutation } from "./providerInstance.ts";
import {
  GuestShareCreateError,
  GuestShareCreateInput,
  GuestShareCreateResult,
} from "./guestShare.ts";
import { PullRequestReviewGuideResult } from "./pullRequestReviewGuide.ts";
import {
  PullRequestActionInput,
  PullRequestActivity,
  PullRequestChangeBreakdown,
  PullRequestCommentInput,
  PullRequestCommentUpdateInput,
  PullRequestDetail,
  PullRequestPreview,
  PullRequestChecks,
  PullRequestDiffFileContentsInput,
  PullRequestDiffFileContentsResult,
  PullRequestFilesViewedResult,
  PullRequestInvalidateInput,
  PullRequestReportStateInput,
  PullRequestListInput,
  PullRequestListResult,
  PullRequestListStatsInput,
  PullRequestListStatsResult,
  PullRequestFilterOptions,
  PullRequestFilterOptionsInput,
  PullRequestOperationError,
  PullRequestReactionInput,
  PullRequestRef,
  PullRequestRoutingResult,
  PullRequestRoutingIdentityInput,
  PullRequestRoutingIdentityResult,
  PullRequestStack,
  PullRequestLinkedThreadsResult,
  PullRequestSummary,
  PullRequestReviewerCandidateList,
  PullRequestReviewerRequestInput,
  PullRequestLabelCandidateList,
  PullRequestLabelChangeInput,
  PullRequestSetFilesViewedInput,
  PullRequestSubmitReviewInput,
  PullRequestThreadCommentsInput,
  PullRequestThreadCommentsResult,
  PullRequestThreadReplyInput,
  PullRequestThreadResolutionInput,
  PullRequestUnavailableError,
  PullRequestUpdateInput,
} from "./pullRequest.ts";
import {
  RelayClientInstallFailedError,
  RelayClientInstallProgressEventSchema,
  RelayClientStatusSchema,
} from "./relayClient.ts";
import {
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationGetWorkflowScriptError,
  OrchestrationV2StopWorkflowError,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2GetShellSnapshotError,
  OrchestrationV2CommandOutputError,
  OrchestrationV2GetThreadProjectionError,
  OrchestrationV2RpcSchemas,
  OrchestrationV2ThreadLaunchError,
} from "./orchestrationV2.ts";
import {
  ProjectCreateNewInput,
  ProjectCreateNewResult,
  ProjectEnsureScratchResult,
  ProjectListEntriesError,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectListIgnoredFilesInput,
  ProjectListIgnoredFilesResult,
  ProjectReadFileError,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectSearchContentsError,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
import {
  TerminalAttachInput,
  TerminalObserveInput,
  TerminalAttachStreamEvent,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalError,
  TerminalMetadataStreamEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal.ts";
import {
  DiscoveredLocalServerList,
  PreviewAttachInput,
  ConfiguredLocalServerUrls,
  PreviewCloseInput,
  PreviewError,
  PreviewEvent,
  PreviewFrameStreamEvent,
  PreviewInputInput,
  PreviewPickElementInput,
  PreviewPickElementResult,
  PreviewListInput,
  PreviewListResult,
  PreviewClearProfileError,
  PreviewClearProfileInput,
  PreviewReportProfilesInput,
  PreviewStopLocalServerError,
  PreviewStopLocalServerInput,
  PreviewOpenInput,
  PreviewPublishFrameInput,
  PreviewNavigateInput,
  PreviewRefreshInput,
  PreviewReportStatusInput,
  PreviewResizeInput,
  PreviewAdjustInput,
  PreviewSessionSnapshot,
} from "./preview.ts";
import {
  DeviceActionInput,
  DeviceCloseInput,
  DeviceConfigureInput,
  DeviceDetail,
  DeviceDetailInput,
  DeviceError,
  DeviceListInput,
  SshDeviceHostConfig,
  DeviceEasAccount,
  DeviceEasAccountError,
  DeviceEasAccountInput,
  DeviceHostSummary,
  DeviceOpenInput,
  DeviceServiceState,
  DeviceSession,
  DeviceShutdownInput,
} from "./device.ts";
import {
  PreviewAutomationError,
  PreviewAutomationHost,
  PreviewAutomationHostFocus,
  PreviewAutomationResponse,
  PreviewAutomationStreamEvent,
} from "./previewAutomation.ts";
import {
  ServerConfigStreamEvent,
  DesktopUpdateCommitInput,
  OtlpEndpointCheckInput,
  ServerPrepareTriageError,
  ServerPrepareTriageInput,
  ServerPrepareTriageResult,
  OtlpEndpointCheckResult,
  ServerConfig,
  ServerProviderUpdateError,
  ServerProviderUpdateInput,
  ServerLifecycleStreamEvent,
  ServerRemoveKeybindingInput,
  ServerRemoveKeybindingResult,
  ServerProviderUpdatedPayload,
  ServerSelfUpdateError,
  ServerSelfUpdateInput,
  ServerSelfUpdateProgressEvent,
  ServerSelfUpdateResult,
  ServerTraceDiagnosticsResult,
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryInput,
  ServerProcessResourceHistoryResult,
  ServerSignalProcessInput,
  ServerSignalProcessResult,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import {
  HostResourcesSnapshot,
  ResourceTelemetryHistory,
  ResourceTelemetryHistoryInput,
  ResourceTelemetryRetryResult,
  ResourceTelemetrySnapshot,
} from "./resourceTelemetry.ts";
import {
  UsageLimitSourceError,
  ProviderConsumeResetCreditInput,
  ProviderConsumeResetCreditResult,
} from "./providerUsageLimits.ts";
import { UsagePricing, UsageReadError, UsageSummary, UsageSummaryInput } from "./usage.ts";
import {
  StorageCleanupReport,
  DatabaseStorageStatus,
  ServerSettings,
  ServerSettingsError,
  ServerSettingsPatch,
} from "./settings.ts";
import {
  ScheduledTaskDeleteInput,
  ScheduledTaskDeleteResult,
  ScheduledTaskError,
  ScheduledTaskListInput,
  ScheduledTaskListResult,
  ScheduledTaskRunNowInput,
  ScheduledTaskRotateWebhookTokenInput,
  ScheduledTaskListWebhookDeliveriesInput,
  ScheduledTaskListWebhookDeliveriesResult,
  ScheduledTaskGetWebhookDeliveryInput,
  ScheduledTaskGetWebhookDeliveryResult,
  ScheduledTaskRunNowResult,
  ScheduledTaskSetEnabledInput,
  ScheduledTaskUpsertInput,
  ScheduledTaskMutationResult,
} from "./scheduledTask.ts";
import { SecretRequestAnswerInput, SecretRequestError } from "./secretRequest.ts";
import {
  ProjectCloneActionInput,
  ProjectCloneActionResult,
  ProjectCloneListEvent,
  ProjectCloneStartInput,
  ProjectCloneStartResult,
  ProjectCloneSubscribeInput,
} from "./projectClone.ts";
import {
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  SourceControlDiscoveryResult,
  SourceControlMergeProjectPullRequestInput,
  SourceControlMergeProjectPullRequestResult,
  SourceControlPublishRepositoryInput,
  SourceControlPublishRepositoryResult,
  SourceControlProjectPullRequestsInput,
  SourceControlProjectPullRequestsResult,
  SourceControlRepositoryError,
  SourceControlRepositoryInfo,
  SourceControlRepositoryLookupInput,
} from "./sourceControl.ts";
import { VcsError } from "./vcs.ts";
import {
  Organization,
  OrganizationId,
  OrganizationAuditListInput,
  OrganizationAuditListResult,
  OrganizationBindProjectInput,
  OrganizationCreateInput,
  OrganizationDetachProjectInput,
  OrganizationError,
  OrganizationGetInput,
  OrganizationPublishedConfig,
  OrganizationPublishedConfigGetInput,
  OrganizationLifecycleInput,
  OrganizationListInput,
  OrganizationListResult,
  OrganizationMutationInput,
  OrganizationPublishInput,
} from "./organizations.ts";
import {
  OrganizationIntakeAuditEntry,
  OrganizationIntakeError,
  OrganizationIntakeEventInput,
  OrganizationIntakeCorrelationStatus,
  OrganizationCorrelationJobStatus,
  OrganizationIntakeRegisterSourceInput,
  OrganizationIntakeResult,
  OrganizationIntakeSource,
  OrganizationIntakeSourceId,
  OrganizationIntakeSourceRegistration,
  OrganizationObservation,
  OrganizationObservationId,
  OrganizationTentativeFinding,
} from "./organizationIntake.ts";
import {
  OrganizationWorkCancelInput,
  OrganizationWorkDetail,
  OrganizationWorkError,
} from "./organizationWork.ts";
import {
  OrganizationWorkDrainInput,
  OrganizationWorkDrainStatusInput,
  OrganizationWorkDrainStatus,
  OrganizationWorkStatusSnapshot,
} from "./organizationWorkDrain.ts";
import {
  OrganizationEmergencyStopRequestInput,
  OrganizationEmergencyStopStatusInput,
  OrganizationEmergencyStopStatus,
} from "./organizationEmergencyStop.ts";
import {
  OrganizationStandingWorkAuthorization,
  OrganizationStandingWorkAuthorizationCreateInput,
  OrganizationStandingWorkAuthorizationError,
  OrganizationStandingWorkAuthorizationListInput,
  OrganizationStandingWorkAuthorizationListResult,
  OrganizationStandingWorkAuthorizationRevokeInput,
} from "./organizationStandingWorkAuthorization.ts";
import {
  OrganizationWorkReviewInput,
  OrganizationWorkReviewResult,
} from "./organizationWorkReview.ts";
import { OrganizationWorkApprovalDecisionInput } from "./organizationWorkApproval.ts";
import {
  OrganizationArchitectError,
  OrganizationArchitectListInput,
  OrganizationArchitectListResult,
  OrganizationArchitectSendInput,
  OrganizationArchitectSendResult,
  OrganizationArchitectApplyBatchInput,
} from "./organizationArchitect.ts";
import {
  OrganizationMemoryArchiveInput,
  OrganizationMemoryCorrectInput,
  OrganizationMemoryCreateInput,
  OrganizationMemoryError,
  OrganizationMemoryHistoryInput,
  OrganizationMemoryListInput,
  OrganizationMemoryRecord,
  OrganizationMemoryRevision,
  OrganizationMemorySupersedeInput,
} from "./organizationMemory.ts";
import {
  OrganizationObservationMode,
  OrganizationObservationModeGetInput,
  OrganizationObservationModeSetInput,
  OrganizationProposalDecisionInput,
  OrganizationProposalError,
  OrganizationProposalListInput,
  OrganizationProposalListResult,
  OrganizationWorkProposal,
} from "./organizationProposals.ts";
import {
  OrganizationDirectorAskInput,
  OrganizationDirectorAskResult,
  OrganizationDirectorError,
  OrganizationDirectorListInput,
  OrganizationDirectorListResult,
} from "./organizationDirector.ts";
import {
  OrganizationWorkIntentActivationError,
  OrganizationWorkIntentActivationInput,
  OrganizationWorkIntentActivationResult,
  OrganizationWorkIntentListInput,
  OrganizationWorkIntentListResult,
  OrganizationWorkIntentReadError,
} from "./organizationWorkIntents.ts";
import {
  OrganizationLiveWorkFailuresError,
  OrganizationLiveWorkFailuresInput,
  OrganizationLiveWorkFailuresResult,
  OrganizationLiveWorkRuntimeStatusInput,
  OrganizationLiveWorkRuntimeStatusResult,
} from "./organizationWorkFailures.ts";
import {
  OrganizationProviderBudgetConfigurationRecord,
  OrganizationProviderBudgetConfigurationRpcError,
  OrganizationProviderBudgetGetInput,
  OrganizationProviderBudgetGetResult,
  OrganizationProviderBudgetReadInput,
  OrganizationProviderBudgetReadResult,
  OrganizationProviderBudgetReadError,
  OrganizationProviderBudgetUpdateInput,
} from "./organizationProviderBudgets.ts";
import {
  OrganizationRepositoryError,
  OrganizationRepositoryLinkInput,
  OrganizationRepositoryListInput,
  OrganizationRepositoryListResult,
  OrganizationRepositoryLoadInput,
  OrganizationRepositoryPreview,
  OrganizationRepositoryPreviewInput,
  OrganizationRepositoryResolveInput,
  OrganizationRepositoryStatus,
  OrganizationRepositorySyncInput,
} from "./organizationRepository.ts";
import { Project, ProjectMutation, ProjectMutationError } from "./project.ts";

export const WS_METHODS = {
  organizationsList: "organizations.list",
  organizationsCreate: "organizations.create",
  organizationsGet: "organizations.get",
  organizationsGetPublishedConfig: "organizations.getPublishedConfig",
  organizationsMutate: "organizations.mutate",
  organizationsBindProject: "organizations.bindProject",
  organizationsDetachProject: "organizations.detachProject",
  organizationsPublish: "organizations.publish",
  organizationsSetLifecycle: "organizations.setLifecycle",
  organizationsListAudit: "organizations.listAudit",
  organizationsReadProviderBudgets: "organizations.providerBudgets.read",
  organizationsGetProviderBudget: "organizations.providerBudgets.get",
  organizationsUpdateProviderBudget: "organizations.providerBudgets.update",
  organizationsRepositoryPreview: "organizations.repository.preview",
  organizationsRepositoryLink: "organizations.repository.link",
  organizationsRepositoryLoad: "organizations.repository.load",
  organizationsRepositorySync: "organizations.repository.sync",
  organizationsRepositoryStatus: "organizations.repository.status",
  organizationsRepositoryListRecords: "organizations.repository.listRecords",
  organizationsRepositoryResolveConflict: "organizations.repository.resolveConflict",
  organizationsRegisterSource: "organizations.registerSource",
  organizationsRotateSourceSecret: "organizations.rotateSourceSecret",
  organizationsSetSourceEnabled: "organizations.setSourceEnabled",
  organizationsListSources: "organizations.listSources",
  organizationsIngestManual: "organizations.ingestManual",
  organizationsRetryCorrelation: "organizations.intake.retryCorrelation",
  organizationsListObservations: "organizations.listObservations",
  organizationsListCorrelationJobs: "organizations.intake.listCorrelationJobs",
  organizationsListFindings: "organizations.listFindings",
  organizationsListIntakeAudit: "organizations.listIntakeAudit",
  organizationsListWork: "organizations.listWork",
  organizationsListWorkIntents: "organizations.workIntents.list",
  organizationsListWorkFailures: "organizations.workFailures.list",
  organizationsGetWorkRuntimeStatus: "organizations.workRuntime.status",
  organizationsActivateWorkIntent: "organizations.workIntents.activate",
  organizationsCancelWork: "organizations.work.cancel",
  organizationsRequestWorkDrain: "organizations.work.drain",
  organizationsSubscribeWorkStatus: "organizations.work.subscribeStatus",
  organizationsGetWorkDrainStatus: "organizations.work.drainStatus",
  organizationsRequestEmergencyStop: "organizations.work.emergencyStop",
  organizationsGetEmergencyStopStatus: "organizations.work.emergencyStopStatus",
  organizationsCreateStandingWorkAuthorization: "organizations.standingWork.create",
  organizationsListStandingWorkAuthorizations: "organizations.standingWork.list",
  organizationsRevokeStandingWorkAuthorization: "organizations.standingWork.revoke",
  organizationsReviewWork: "organizations.reviewWork",
  organizationsDecideWorkApproval: "organizations.decideWorkApproval",
  organizationsArchitectList: "organizations.architect.list",
  organizationsArchitectSend: "organizations.architect.send",
  organizationsArchitectApplyBatch: "organizations.architect.applyBatch",
  organizationsMemoryList: "organizations.memory.list",
  organizationsMemoryHistory: "organizations.memory.history",
  organizationsMemoryCreate: "organizations.memory.create",
  organizationsMemoryCorrect: "organizations.memory.correct",
  organizationsMemorySupersede: "organizations.memory.supersede",
  organizationsMemoryArchive: "organizations.memory.archive",
  organizationsProposalList: "organizations.proposals.list",
  organizationsProposalDecide: "organizations.proposals.decide",
  organizationsObservationModeGet: "organizations.observationMode.get",
  organizationsObservationModeSet: "organizations.observationMode.set",
  organizationsDirectorList: "organizations.director.list",
  organizationsDirectorAsk: "organizations.director.ask",
  agentDashboardGetSnapshot: "agentDashboard.getSnapshot",
  agentDashboardDismissFeedCard: "agentDashboard.dismissFeedCard",
  agentDashboardClearFeed: "agentDashboard.clearFeed",
  agentDashboardReviewSuggestion: "agentDashboard.reviewSuggestion",
  agentDashboardRunInvestigation: "agentDashboard.runInvestigation",
  agentDashboardRetryRun: "agentDashboard.retryRun",
  agentDashboardCreateGithubIssue: "agentDashboard.createGithubIssue",
  agentDashboardApplyFindingAction: "agentDashboard.applyFindingAction",
  agentDashboardLinkFindingThread: "agentDashboard.linkFindingThread",
  agentDashboardUpdateRepositoryPolicy: "agentDashboard.updateRepositoryPolicy",
  agentDashboardCollect: "agentDashboard.collect",
  agentDashboardAddResearchWatchItem: "agentDashboard.addResearchWatchItem",
  agentDashboardListProjectPullRequests: "agentDashboard.listProjectPullRequests",
  agentDashboardMergeProjectPullRequest: "agentDashboard.mergeProjectPullRequest",
  projectsListEntries: "projects.listEntries",
  projectsListIgnoredFiles: "projects.listIgnoredFiles",
  projectsReadFile: "projects.readFile",
  projectsSearchContents: "projects.searchContents",
  projectsSearchEntries: "projects.searchEntries",
  projectsWriteFile: "projects.writeFile",
  projectsMutate: "projects.mutate",
  projectsEnsureScratch: "projects.ensureScratch",
  projectsCreateNew: "projects.createNew",

  shellOpenInEditor: "shell.openInEditor",

  filesystemBrowse: "filesystem.browse",
  // Codex session discovery (resuming conversations started outside the app)
  threadExport: "thread.export",
  codexSessionsList: "codexSessions.list",
  codexSessionsResume: "codexSessions.resume",
  filesystemGetMetadata: "filesystem.getMetadata",
  agentSessionsScan: "agentSessions.scan",
  agentSessionsImport: "agentSessions.import",
  assetsCreateUrl: "assets.createUrl",
  assetsPersistChatAttachments: "assets.persistChatAttachments",
  attachmentsCreateUploadUrl: "attachments.createUploadUrl",
  attachmentsDelete: "attachments.delete",

  mcpAppsCallTool: "mcpApps.callTool",
  mcpAppsToolInfo: "mcpApps.toolInfo",
  mcpAppsReadResource: "mcpApps.readResource",
  mcpAppsUpdateModelContext: "mcpApps.updateModelContext",

  providerUploadFeedback: "provider.uploadFeedback",
  providerAuthStart: "provider.auth.start",
  providerConsumeResetCredit: "provider.consumeResetCredit",
  providerAuthComplete: "provider.auth.complete",
  chatGptReconnectProfile: "provider.chatgpt.reconnect-profile",
  chatGptImportProfile: "provider.chatgpt.import-profile",
  codexAuthCallbackSubscribe: "codexAuthCallback.subscribe",
  chatGptHandoffSubscribe: "provider.chatgpt.handoff.subscribe",
  providerAuthRespond: "provider.auth.respond",
  providerAuthCancel: "provider.auth.cancel",
  providerAuthLogout: "provider.auth.logout",
  providerAuthSubscribe: "provider.auth.subscribe",
  providerInstallStart: "provider.install.start",
  providerInstallCancel: "provider.install.cancel",
  providerInstallSubscribe: "provider.install.subscribe",
  providerInstallRemove: "provider.install.remove",

  vcsPull: "vcs.pull",
  vcsRefreshStatus: "vcs.refreshStatus",
  vcsWorktreeStorageUsage: "vcs.worktreeStorageUsage",
  vcsListRefs: "vcs.listRefs",
  vcsCreateWorktree: "vcs.createWorktree",
  vcsRemoveWorktree: "vcs.removeWorktree",
  vcsCreateRef: "vcs.createRef",
  vcsSwitchRef: "vcs.switchRef",
  vcsInit: "vcs.init",

  gitRunStackedAction: "git.runStackedAction",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPreparePullRequestThread: "git.preparePullRequestThread",

  reviewGetDiffPreview: "review.getDiffPreview",
  reviewGetDiffFileContents: "review.getDiffFileContents",

  terminalOpen: "terminal.open",
  terminalAttach: "terminal.attach",
  terminalObserve: "terminal.observe",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalClose: "terminal.close",

  previewOpen: "preview.open",
  previewNavigate: "preview.navigate",
  previewRefresh: "preview.refresh",
  previewResize: "preview.resize",
  previewAdjust: "preview.adjust",
  previewClose: "preview.close",
  previewList: "preview.list",
  previewClearProfile: "preview.clearProfile",
  previewReportProfiles: "preview.reportProfiles",
  previewReportStatus: "preview.reportStatus",
  previewAttach: "preview.attach",
  previewPublishFrame: "preview.publishFrame",
  previewInput: "preview.input",
  previewPickElement: "preview.pickElement",
  previewAutomationConnect: "previewAutomation.connect",
  previewAutomationRespond: "previewAutomation.respond",
  previewAutomationFocusHost: "previewAutomation.focusHost",
  previewStopLocalServer: "preview.stopLocalServer",

  deviceConfigure: "device.configure",
  deviceList: "device.list",
  deviceTestHost: "device.testHost",
  deviceEasAccount: "device.easAccount",
  deviceOpen: "device.open",
  deviceClose: "device.close",
  deviceShutdown: "device.shutdown",
  deviceDetail: "device.detail",
  deviceAction: "device.action",

  serverProbe: "server.probe",
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  serverUpdateProvider: "server.updateProvider",
  serverUpdateServer: "server.updateServer",
  serverUpdateServerWithProgress: "server.updateServerWithProgress",
  serverCommitDesktopUpdate: "server.commitDesktopUpdate",
  serverGetMaintenanceStatus: "server.getMaintenanceStatus",
  serverUpdateMaintenancePolicy: "server.updateMaintenancePolicy",
  serverRunMaintenanceAction: "server.runMaintenanceAction",
  serverRecoverMaintenance: "server.recoverMaintenance",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverRemoveKeybinding: "server.removeKeybinding",
  serverRunStorageCleanup: "server.runStorageCleanup",
  serverGetStorageCleanupReport: "server.getStorageCleanupReport",
  serverGetDatabaseStorage: "server.getDatabaseStorage",
  peerLinksList: "peerLinks.list",
  peerLinksLink: "peerLinks.link",
  peerLinksUnlink: "peerLinks.unlink",
  peerLinksAnswerRequest: "peerLinks.answerRequest",
  serverUpdateSettings: "server.updateSettings",
  serverDiscoverSourceControl: "server.discoverSourceControl",
  serverSearchAcpRegistry: "server.searchAcpRegistry",
  serverPrepareAcpRegistryAgent: "server.prepareAcpRegistryAgent",
  serverUninstallAcpRegistryManagedBinary: "server.uninstallAcpRegistryManagedBinary",
  serverAcceptAcpRegistryUrlAuth: "server.acceptAcpRegistryUrlAuth",
  serverListAcpRegistrySessions: "server.listAcpRegistrySessions",
  serverImportAcpRegistrySession: "server.importAcpRegistrySession",
  serverDeleteAcpRegistrySession: "server.deleteAcpRegistrySession",
  serverListAcpRegistryProviders: "server.listAcpRegistryProviders",
  serverSetAcpRegistryProvider: "server.setAcpRegistryProvider",
  serverDisableAcpRegistryProvider: "server.disableAcpRegistryProvider",
  serverLogoutAcpRegistry: "server.logoutAcpRegistry",
  serverGetTraceDiagnostics: "server.getTraceDiagnostics",
  serverGetProcessDiagnostics: "server.getProcessDiagnostics",
  serverGetHostResources: "server.getHostResources",
  serverGetProcessResourceHistory: "server.getProcessResourceHistory",
  serverGetResourceTelemetryHistory: "server.getResourceTelemetryHistory",
  serverRetryResourceTelemetry: "server.retryResourceTelemetry",
  serverCheckOtlpEndpoint: "server.checkOtlpEndpoint",
  serverPrepareTriage: "server.prepareTriage",
  serverSignalProcess: "server.signalProcess",
  serverReportClientActivity: "server.reportClientActivity",
  serverGetUsageSummary: "server.getUsageSummary",
  serverRefreshUsageRates: "server.refreshUsageRates",

  scheduledTasksSubscribe: "scheduledTasks.subscribe",
  scheduledTasksUpsert: "scheduledTasks.upsert",
  scheduledTasksSetEnabled: "scheduledTasks.setEnabled",
  scheduledTasksDelete: "scheduledTasks.delete",
  scheduledTasksRunNow: "scheduledTasks.runNow",
  scheduledTasksRotateWebhookToken: "scheduledTasks.rotateWebhookToken",
  secretsAnswerRequest: "secrets.answerRequest",
  guestShareCreate: "guestShare.create",
  scheduledTasksListWebhookDeliveries: "scheduledTasks.listWebhookDeliveries",
  scheduledTasksGetWebhookDelivery: "scheduledTasks.getWebhookDelivery",

  cloudGetRelayClientStatus: "cloud.getRelayClientStatus",
  cloudInstallRelayClient: "cloud.installRelayClient",

  pullRequestsList: "pullRequests.list",
  pullRequestsListStats: "pullRequests.listStats",
  pullRequestsFilterOptions: "pullRequests.filterOptions",
  pullRequestsSummary: "pullRequests.summary",
  pullRequestsRouting: "pullRequests.routing",
  pullRequestsRoutingIdentity: "pullRequests.routingIdentity",
  pullRequestsStack: "pullRequests.stack",
  pullRequestsLinkedThreads: "pullRequests.linkedThreads",
  pullRequestsDetail: "pullRequests.detail",
  pullRequestsPreview: "pullRequests.preview",
  pullRequestsChecks: "pullRequests.checks",
  pullRequestsActivity: "pullRequests.activity",
  pullRequestsReviewGuide: "pullRequests.reviewGuide",
  pullRequestsGenerateReviewGuide: "pullRequests.generateReviewGuide",
  pullRequestsThreadComments: "pullRequests.threadComments",
  pullRequestsDiffFileContents: "pullRequests.diffFileContents",
  pullRequestsFilesViewed: "pullRequests.filesViewed",
  pullRequestsChangeBreakdown: "pullRequests.changeBreakdown",
  pullRequestsSetFilesViewed: "pullRequests.setFilesViewed",
  pullRequestsRunAction: "pullRequests.runAction",
  pullRequestsUpdate: "pullRequests.update",
  pullRequestsComment: "pullRequests.comment",
  pullRequestsUpdateComment: "pullRequests.updateComment",
  pullRequestsSubmitReview: "pullRequests.submitReview",
  pullRequestsReplyToThread: "pullRequests.replyToThread",
  pullRequestsSetThreadResolution: "pullRequests.setThreadResolution",
  pullRequestsSetReaction: "pullRequests.setReaction",
  pullRequestsInvalidate: "pullRequests.invalidate",
  pullRequestsReportState: "pullRequests.reportState",
  pullRequestsSubscribeRefreshes: "pullRequests.subscribeRefreshes",
  pullRequestsReviewerCandidates: "pullRequests.reviewerCandidates",
  pullRequestsRequestReviewers: "pullRequests.requestReviewers",
  pullRequestsLabelCandidates: "pullRequests.labelCandidates",
  pullRequestsSetLabels: "pullRequests.setLabels",

  sourceControlLookupRepository: "sourceControl.lookupRepository",
  sourceControlCloneRepository: "sourceControl.cloneRepository",
  sourceControlPublishRepository: "sourceControl.publishRepository",
  projectCloneStart: "projectClone.start",
  projectCloneCancel: "projectClone.cancel",
  projectCloneRetry: "projectClone.retry",
  subscribeProjectClones: "subscribeProjectClones",

  subscribeVcsStatus: "subscribeVcsStatus",
  subscribeWorktreeSetup: "subscribeWorktreeSetup",
  worktreeSetupCancel: "worktreeSetup.cancel",
  subscribeTerminalMetadata: "subscribeTerminalMetadata",
  subscribePreviewEvents: "subscribePreviewEvents",
  subscribeDiscoveredLocalServers: "subscribeDiscoveredLocalServers",
  subscribeDeviceState: "subscribeDeviceState",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",
  subscribeAuthAccess: "subscribeAuthAccess",
  subscribeResourceTelemetry: "subscribeResourceTelemetry",
} as const;

const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

const organizationRpcError = Schema.Union([OrganizationError, EnvironmentAuthorizationError]);

const WsOrganizationsListRpc = Rpc.make(WS_METHODS.organizationsList, {
  payload: OrganizationListInput,
  success: OrganizationListResult,
  error: organizationRpcError,
});
const WsOrganizationsCreateRpc = Rpc.make(WS_METHODS.organizationsCreate, {
  payload: OrganizationCreateInput,
  success: Organization,
  error: organizationRpcError,
});
const WsOrganizationsGetRpc = Rpc.make(WS_METHODS.organizationsGet, {
  payload: OrganizationGetInput,
  success: Organization,
  error: organizationRpcError,
});
const WsOrganizationsGetPublishedConfigRpc = Rpc.make(WS_METHODS.organizationsGetPublishedConfig, {
  payload: OrganizationPublishedConfigGetInput,
  success: OrganizationPublishedConfig,
  error: organizationRpcError,
});
const WsOrganizationsMutateRpc = Rpc.make(WS_METHODS.organizationsMutate, {
  payload: OrganizationMutationInput,
  success: Organization,
  error: organizationRpcError,
});
const WsOrganizationsBindProjectRpc = Rpc.make(WS_METHODS.organizationsBindProject, {
  payload: OrganizationBindProjectInput,
  success: Organization,
  error: organizationRpcError,
});
const WsOrganizationsDetachProjectRpc = Rpc.make(WS_METHODS.organizationsDetachProject, {
  payload: OrganizationDetachProjectInput,
  success: Organization,
  error: organizationRpcError,
});
const WsOrganizationsPublishRpc = Rpc.make(WS_METHODS.organizationsPublish, {
  payload: OrganizationPublishInput,
  success: Organization,
  error: organizationRpcError,
});
const WsOrganizationsSetLifecycleRpc = Rpc.make(WS_METHODS.organizationsSetLifecycle, {
  payload: OrganizationLifecycleInput,
  success: Organization,
  error: organizationRpcError,
});
const WsOrganizationsListAuditRpc = Rpc.make(WS_METHODS.organizationsListAudit, {
  payload: OrganizationAuditListInput,
  success: OrganizationAuditListResult,
  error: organizationRpcError,
});
const WsOrganizationsReadProviderBudgetsRpc = Rpc.make(
  WS_METHODS.organizationsReadProviderBudgets,
  {
    payload: OrganizationProviderBudgetReadInput,
    success: OrganizationProviderBudgetReadResult,
    error: Schema.Union([OrganizationProviderBudgetReadError, EnvironmentAuthorizationError]),
  },
);
const WsOrganizationsGetProviderBudgetRpc = Rpc.make(WS_METHODS.organizationsGetProviderBudget, {
  payload: OrganizationProviderBudgetGetInput,
  success: OrganizationProviderBudgetGetResult,
  error: Schema.Union([
    OrganizationProviderBudgetConfigurationRpcError,
    EnvironmentAuthorizationError,
  ]),
});
const WsOrganizationsUpdateProviderBudgetRpc = Rpc.make(
  WS_METHODS.organizationsUpdateProviderBudget,
  {
    payload: OrganizationProviderBudgetUpdateInput,
    success: OrganizationProviderBudgetConfigurationRecord,
    error: Schema.Union([
      OrganizationProviderBudgetConfigurationRpcError,
      EnvironmentAuthorizationError,
    ]),
  },
);

const organizationRepositoryRpcError = Schema.Union([
  OrganizationRepositoryError,
  EnvironmentAuthorizationError,
]);
const WsOrganizationsRepositoryPreviewRpc = Rpc.make(WS_METHODS.organizationsRepositoryPreview, {
  payload: OrganizationRepositoryPreviewInput,
  success: OrganizationRepositoryPreview,
  error: organizationRepositoryRpcError,
});
const WsOrganizationsRepositoryLinkRpc = Rpc.make(WS_METHODS.organizationsRepositoryLink, {
  payload: OrganizationRepositoryLinkInput,
  success: OrganizationRepositoryStatus,
  error: organizationRepositoryRpcError,
});
const WsOrganizationsRepositoryLoadRpc = Rpc.make(WS_METHODS.organizationsRepositoryLoad, {
  payload: OrganizationRepositoryLoadInput,
  success: OrganizationRepositoryStatus,
  error: organizationRepositoryRpcError,
});
const WsOrganizationsRepositorySyncRpc = Rpc.make(WS_METHODS.organizationsRepositorySync, {
  payload: OrganizationRepositorySyncInput,
  success: OrganizationRepositoryStatus,
  error: organizationRepositoryRpcError,
});
const WsOrganizationsRepositoryStatusRpc = Rpc.make(WS_METHODS.organizationsRepositoryStatus, {
  payload: OrganizationRepositorySyncInput,
  success: OrganizationRepositoryStatus,
  error: organizationRepositoryRpcError,
});
const WsOrganizationsRepositoryListRecordsRpc = Rpc.make(
  WS_METHODS.organizationsRepositoryListRecords,
  {
    payload: OrganizationRepositoryListInput,
    success: OrganizationRepositoryListResult,
    error: organizationRepositoryRpcError,
  },
);
const WsOrganizationsRepositoryResolveConflictRpc = Rpc.make(
  WS_METHODS.organizationsRepositoryResolveConflict,
  {
    payload: OrganizationRepositoryResolveInput,
    success: OrganizationRepositoryStatus,
    error: organizationRepositoryRpcError,
  },
);

const organizationIntakeRpcError = Schema.Union([
  OrganizationIntakeError,
  EnvironmentAuthorizationError,
]);
const organizationSourceInput = Schema.Struct({
  organizationId: OrganizationId,
  sourceId: OrganizationIntakeSourceId,
});
const WsOrganizationsRegisterSourceRpc = Rpc.make(WS_METHODS.organizationsRegisterSource, {
  payload: OrganizationIntakeRegisterSourceInput,
  success: OrganizationIntakeSourceRegistration,
  error: organizationIntakeRpcError,
});
const WsOrganizationsRotateSourceSecretRpc = Rpc.make(WS_METHODS.organizationsRotateSourceSecret, {
  payload: organizationSourceInput,
  success: OrganizationIntakeSourceRegistration,
  error: organizationIntakeRpcError,
});
const WsOrganizationsSetSourceEnabledRpc = Rpc.make(WS_METHODS.organizationsSetSourceEnabled, {
  payload: Schema.Struct({ ...organizationSourceInput.fields, enabled: Schema.Boolean }),
  success: OrganizationIntakeSource,
  error: organizationIntakeRpcError,
});
const WsOrganizationsListSourcesRpc = Rpc.make(WS_METHODS.organizationsListSources, {
  payload: OrganizationGetInput,
  success: Schema.Struct({ sources: Schema.Array(OrganizationIntakeSource) }),
  error: organizationIntakeRpcError,
});
const WsOrganizationsIngestManualRpc = Rpc.make(WS_METHODS.organizationsIngestManual, {
  payload: OrganizationIntakeEventInput,
  success: OrganizationIntakeResult,
  error: organizationIntakeRpcError,
});
const WsOrganizationsRetryCorrelationRpc = Rpc.make(WS_METHODS.organizationsRetryCorrelation, {
  payload: Schema.Struct({
    organizationId: OrganizationId,
    observationId: OrganizationObservationId,
  }),
  success: OrganizationIntakeCorrelationStatus,
  error: organizationIntakeRpcError,
});
const WsOrganizationsListObservationsRpc = Rpc.make(WS_METHODS.organizationsListObservations, {
  payload: OrganizationGetInput,
  success: Schema.Struct({ observations: Schema.Array(OrganizationObservation) }),
  error: organizationIntakeRpcError,
});
const WsOrganizationsListCorrelationJobsRpc = Rpc.make(
  WS_METHODS.organizationsListCorrelationJobs,
  {
    payload: OrganizationGetInput,
    success: Schema.Struct({ jobs: Schema.Array(OrganizationCorrelationJobStatus) }),
    error: organizationIntakeRpcError,
  },
);
const WsOrganizationsListFindingsRpc = Rpc.make(WS_METHODS.organizationsListFindings, {
  payload: OrganizationGetInput,
  success: Schema.Struct({ findings: Schema.Array(OrganizationTentativeFinding) }),
  error: organizationIntakeRpcError,
});
const WsOrganizationsListIntakeAuditRpc = Rpc.make(WS_METHODS.organizationsListIntakeAudit, {
  payload: OrganizationGetInput,
  success: Schema.Struct({ entries: Schema.Array(OrganizationIntakeAuditEntry) }),
  error: organizationIntakeRpcError,
});
const WsOrganizationsListWorkRpc = Rpc.make(WS_METHODS.organizationsListWork, {
  payload: OrganizationGetInput,
  success: Schema.Struct({ items: Schema.Array(OrganizationWorkDetail) }),
  error: Schema.Union([OrganizationWorkError, EnvironmentAuthorizationError]),
});
const WsOrganizationsListWorkIntentsRpc = Rpc.make(WS_METHODS.organizationsListWorkIntents, {
  payload: OrganizationWorkIntentListInput,
  success: OrganizationWorkIntentListResult,
  error: Schema.Union([OrganizationWorkIntentReadError, EnvironmentAuthorizationError]),
});
const WsOrganizationsListWorkFailuresRpc = Rpc.make(WS_METHODS.organizationsListWorkFailures, {
  payload: OrganizationLiveWorkFailuresInput,
  success: OrganizationLiveWorkFailuresResult,
  error: Schema.Union([OrganizationLiveWorkFailuresError, EnvironmentAuthorizationError]),
});
const WsOrganizationsGetWorkRuntimeStatusRpc = Rpc.make(
  WS_METHODS.organizationsGetWorkRuntimeStatus,
  {
    payload: OrganizationLiveWorkRuntimeStatusInput,
    success: OrganizationLiveWorkRuntimeStatusResult,
    error: Schema.Union([OrganizationLiveWorkFailuresError, EnvironmentAuthorizationError]),
  },
);
const WsOrganizationsActivateWorkIntentRpc = Rpc.make(WS_METHODS.organizationsActivateWorkIntent, {
  payload: OrganizationWorkIntentActivationInput,
  success: OrganizationWorkIntentActivationResult,
  error: Schema.Union([OrganizationWorkIntentActivationError, EnvironmentAuthorizationError]),
});
const WsOrganizationsCancelWorkRpc = Rpc.make(WS_METHODS.organizationsCancelWork, {
  payload: OrganizationWorkCancelInput,
  success: OrganizationWorkDetail,
  error: Schema.Union([OrganizationWorkError, EnvironmentAuthorizationError]),
});
const WsOrganizationsRequestWorkDrainRpc = Rpc.make(WS_METHODS.organizationsRequestWorkDrain, {
  payload: OrganizationWorkDrainInput,
  success: OrganizationWorkDrainStatus,
  error: Schema.Union([OrganizationWorkError, EnvironmentAuthorizationError]),
});
const WsOrganizationsGetWorkDrainStatusRpc = Rpc.make(WS_METHODS.organizationsGetWorkDrainStatus, {
  payload: OrganizationWorkDrainStatusInput,
  success: OrganizationWorkDrainStatus,
  error: Schema.Union([OrganizationWorkError, EnvironmentAuthorizationError]),
});
const WsOrganizationsSubscribeWorkStatusRpc = Rpc.make(
  WS_METHODS.organizationsSubscribeWorkStatus,
  {
    payload: OrganizationWorkDrainStatusInput,
    success: OrganizationWorkStatusSnapshot,
    error: Schema.Union([OrganizationWorkError, EnvironmentAuthorizationError]),
    stream: true,
  },
);
const WsOrganizationsRequestEmergencyStopRpc = Rpc.make(
  WS_METHODS.organizationsRequestEmergencyStop,
  {
    payload: OrganizationEmergencyStopRequestInput,
    success: OrganizationEmergencyStopStatus,
    error: Schema.Union([OrganizationWorkError, EnvironmentAuthorizationError]),
  },
);
const WsOrganizationsGetEmergencyStopStatusRpc = Rpc.make(
  WS_METHODS.organizationsGetEmergencyStopStatus,
  {
    payload: OrganizationEmergencyStopStatusInput,
    success: OrganizationEmergencyStopStatus,
    error: Schema.Union([OrganizationWorkError, EnvironmentAuthorizationError]),
  },
);
const WsOrganizationsCreateStandingWorkAuthorizationRpc = Rpc.make(
  WS_METHODS.organizationsCreateStandingWorkAuthorization,
  {
    payload: OrganizationStandingWorkAuthorizationCreateInput,
    success: OrganizationStandingWorkAuthorization,
    error: Schema.Union([
      OrganizationStandingWorkAuthorizationError,
      EnvironmentAuthorizationError,
    ]),
  },
);
const WsOrganizationsListStandingWorkAuthorizationsRpc = Rpc.make(
  WS_METHODS.organizationsListStandingWorkAuthorizations,
  {
    payload: OrganizationStandingWorkAuthorizationListInput,
    success: OrganizationStandingWorkAuthorizationListResult,
    error: Schema.Union([
      OrganizationStandingWorkAuthorizationError,
      EnvironmentAuthorizationError,
    ]),
  },
);
const WsOrganizationsRevokeStandingWorkAuthorizationRpc = Rpc.make(
  WS_METHODS.organizationsRevokeStandingWorkAuthorization,
  {
    payload: OrganizationStandingWorkAuthorizationRevokeInput,
    success: OrganizationStandingWorkAuthorization,
    error: Schema.Union([
      OrganizationStandingWorkAuthorizationError,
      EnvironmentAuthorizationError,
    ]),
  },
);
const WsOrganizationsReviewWorkRpc = Rpc.make(WS_METHODS.organizationsReviewWork, {
  payload: OrganizationWorkReviewInput,
  success: OrganizationWorkReviewResult,
  error: Schema.Union([OrganizationWorkError, EnvironmentAuthorizationError]),
});
const WsOrganizationsDecideWorkApprovalRpc = Rpc.make(WS_METHODS.organizationsDecideWorkApproval, {
  payload: OrganizationWorkApprovalDecisionInput,
  success: OrganizationWorkDetail,
  error: Schema.Union([OrganizationWorkError, EnvironmentAuthorizationError]),
});
const organizationArchitectRpcError = Schema.Union([
  OrganizationArchitectError,
  EnvironmentAuthorizationError,
]);
const WsOrganizationsArchitectListRpc = Rpc.make(WS_METHODS.organizationsArchitectList, {
  payload: OrganizationArchitectListInput,
  success: OrganizationArchitectListResult,
  error: organizationArchitectRpcError,
});
const WsOrganizationsArchitectSendRpc = Rpc.make(WS_METHODS.organizationsArchitectSend, {
  payload: OrganizationArchitectSendInput,
  success: OrganizationArchitectSendResult,
  error: organizationArchitectRpcError,
});
const WsOrganizationsArchitectApplyBatchRpc = Rpc.make(
  WS_METHODS.organizationsArchitectApplyBatch,
  {
    payload: OrganizationArchitectApplyBatchInput,
    success: Organization,
    error: organizationRpcError,
  },
);
const organizationMemoryRpcError = Schema.Union([
  OrganizationMemoryError,
  EnvironmentAuthorizationError,
]);
const WsOrganizationsMemoryListRpc = Rpc.make(WS_METHODS.organizationsMemoryList, {
  payload: OrganizationMemoryListInput,
  success: Schema.Struct({ records: Schema.Array(OrganizationMemoryRecord) }),
  error: organizationMemoryRpcError,
});
const WsOrganizationsMemoryHistoryRpc = Rpc.make(WS_METHODS.organizationsMemoryHistory, {
  payload: OrganizationMemoryHistoryInput,
  success: Schema.Struct({ revisions: Schema.Array(OrganizationMemoryRevision) }),
  error: organizationMemoryRpcError,
});
const WsOrganizationsMemoryCreateRpc = Rpc.make(WS_METHODS.organizationsMemoryCreate, {
  payload: OrganizationMemoryCreateInput,
  success: OrganizationMemoryRecord,
  error: organizationMemoryRpcError,
});
const WsOrganizationsMemoryCorrectRpc = Rpc.make(WS_METHODS.organizationsMemoryCorrect, {
  payload: OrganizationMemoryCorrectInput,
  success: OrganizationMemoryRecord,
  error: organizationMemoryRpcError,
});
const WsOrganizationsMemorySupersedeRpc = Rpc.make(WS_METHODS.organizationsMemorySupersede, {
  payload: OrganizationMemorySupersedeInput,
  success: OrganizationMemoryRecord,
  error: organizationMemoryRpcError,
});
const WsOrganizationsMemoryArchiveRpc = Rpc.make(WS_METHODS.organizationsMemoryArchive, {
  payload: OrganizationMemoryArchiveInput,
  success: OrganizationMemoryRecord,
  error: organizationMemoryRpcError,
});
const organizationProposalRpcError = Schema.Union([
  OrganizationProposalError,
  EnvironmentAuthorizationError,
]);
const WsOrganizationsProposalListRpc = Rpc.make(WS_METHODS.organizationsProposalList, {
  payload: OrganizationProposalListInput,
  success: OrganizationProposalListResult,
  error: organizationProposalRpcError,
});
const WsOrganizationsProposalDecideRpc = Rpc.make(WS_METHODS.organizationsProposalDecide, {
  payload: OrganizationProposalDecisionInput,
  success: OrganizationWorkProposal,
  error: organizationProposalRpcError,
});
const WsOrganizationsObservationModeGetRpc = Rpc.make(WS_METHODS.organizationsObservationModeGet, {
  payload: OrganizationObservationModeGetInput,
  success: OrganizationObservationMode,
  error: organizationProposalRpcError,
});
const WsOrganizationsObservationModeSetRpc = Rpc.make(WS_METHODS.organizationsObservationModeSet, {
  payload: OrganizationObservationModeSetInput,
  success: OrganizationObservationMode,
  error: organizationProposalRpcError,
});
const organizationDirectorRpcError = Schema.Union([
  OrganizationDirectorError,
  EnvironmentAuthorizationError,
]);
const WsOrganizationsDirectorListRpc = Rpc.make(WS_METHODS.organizationsDirectorList, {
  payload: OrganizationDirectorListInput,
  success: OrganizationDirectorListResult,
  error: organizationDirectorRpcError,
});
const WsOrganizationsDirectorAskRpc = Rpc.make(WS_METHODS.organizationsDirectorAsk, {
  payload: OrganizationDirectorAskInput,
  success: OrganizationDirectorAskResult,
  error: organizationDirectorRpcError,
});

const WsAgentDashboardGetSnapshotRpc = Rpc.make(WS_METHODS.agentDashboardGetSnapshot, {
  payload: AgentDashboardGetSnapshotInput,
  success: AgentDashboardSnapshot,
  error: Schema.Union([AgentDashboardError, EnvironmentAuthorizationError]),
});

const WsAgentDashboardDismissFeedCardRpc = Rpc.make(WS_METHODS.agentDashboardDismissFeedCard, {
  payload: AgentDashboardFeedCardIdInput,
  success: AgentDashboardMutationResult,
  error: Schema.Union([AgentDashboardError, EnvironmentAuthorizationError]),
});

const WsAgentDashboardClearFeedRpc = Rpc.make(WS_METHODS.agentDashboardClearFeed, {
  payload: Schema.Struct({}),
  success: AgentDashboardMutationResult,
  error: Schema.Union([AgentDashboardError, EnvironmentAuthorizationError]),
});

const WsAgentDashboardReviewSuggestionRpc = Rpc.make(WS_METHODS.agentDashboardReviewSuggestion, {
  payload: AgentDashboardReviewSuggestionActionInput,
  success: AgentDashboardMutationResult,
  error: Schema.Union([AgentDashboardError, EnvironmentAuthorizationError]),
});

const WsAgentDashboardRunInvestigationRpc = Rpc.make(WS_METHODS.agentDashboardRunInvestigation, {
  payload: AgentDashboardRunInvestigationInput,
  success: AgentDashboardMutationResult,
  error: Schema.Union([AgentDashboardError, EnvironmentAuthorizationError]),
});

const WsAgentDashboardRetryRunRpc = Rpc.make(WS_METHODS.agentDashboardRetryRun, {
  payload: AgentDashboardRetryRunInput,
  success: AgentDashboardMutationResult,
  error: Schema.Union([AgentDashboardError, EnvironmentAuthorizationError]),
});

const WsAgentDashboardApplyFindingActionRpc = Rpc.make(
  WS_METHODS.agentDashboardApplyFindingAction,
  {
    payload: AgentDashboardFindingActionInput,
    success: AgentDashboardMutationResult,
    error: Schema.Union([AgentDashboardError, EnvironmentAuthorizationError]),
  },
);

const WsAgentDashboardLinkFindingThreadRpc = Rpc.make(WS_METHODS.agentDashboardLinkFindingThread, {
  payload: AgentDashboardLinkFindingThreadInput,
  success: AgentDashboardMutationResult,
  error: Schema.Union([AgentDashboardError, EnvironmentAuthorizationError]),
});

const WsAgentDashboardUpdateRepositoryPolicyRpc = Rpc.make(
  WS_METHODS.agentDashboardUpdateRepositoryPolicy,
  {
    payload: AgentDashboardRepositoryPolicyInput,
    success: AgentDashboardMutationResult,
    error: Schema.Union([AgentDashboardError, EnvironmentAuthorizationError]),
  },
);

const WsAgentDashboardCollectRpc = Rpc.make(WS_METHODS.agentDashboardCollect, {
  payload: AgentDashboardCollectInput,
  success: AgentDashboardMutationResult,
  error: Schema.Union([AgentDashboardError, EnvironmentAuthorizationError]),
});

const WsAgentDashboardAddResearchWatchItemRpc = Rpc.make(
  WS_METHODS.agentDashboardAddResearchWatchItem,
  {
    payload: AgentDashboardResearchWatchItemInput,
    success: AgentDashboardMutationResult,
    error: Schema.Union([AgentDashboardError, EnvironmentAuthorizationError]),
  },
);

const WsAgentDashboardCreateGithubIssueRpc = Rpc.make(WS_METHODS.agentDashboardCreateGithubIssue, {
  payload: AgentDashboardReviewSuggestionIdInput,
  success: AgentDashboardMutationResult,
  error: Schema.Union([AgentDashboardError, EnvironmentAuthorizationError]),
});

const WsAgentDashboardListProjectPullRequestsRpc = Rpc.make(
  WS_METHODS.agentDashboardListProjectPullRequests,
  {
    payload: SourceControlProjectPullRequestsInput,
    success: SourceControlProjectPullRequestsResult,
    error: Schema.Union([
      SourceControlRepositoryError,
      AgentDashboardError,
      EnvironmentAuthorizationError,
    ]),
  },
);

const WsAgentDashboardMergeProjectPullRequestRpc = Rpc.make(
  WS_METHODS.agentDashboardMergeProjectPullRequest,
  {
    payload: SourceControlMergeProjectPullRequestInput,
    success: SourceControlMergeProjectPullRequestResult,
    error: Schema.Union([
      SourceControlRepositoryError,
      AgentDashboardError,
      EnvironmentAuthorizationError,
    ]),
  },
);

const WsServerRemoveKeybindingRpc = Rpc.make(WS_METHODS.serverRemoveKeybinding, {
  payload: ServerRemoveKeybindingInput,
  success: ServerRemoveKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

const WsServerProbeRpc = Rpc.make(WS_METHODS.serverProbe, {
  payload: Schema.Struct({}),
  success: Schema.Struct({}),
  error: EnvironmentAuthorizationError,
});

const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
});

export const WsServerRefreshProvidersRpc = Rpc.make(WS_METHODS.serverRefreshProviders, {
  payload: Schema.Struct({
    instanceId: Schema.optional(ProviderInstanceId),
    cwd: Schema.optional(TrimmedNonEmptyString),
    fresh: Schema.optional(Schema.Boolean),
    /** Bypass model caches; explicit rediscovery may open sessions, background refreshes must not. */
    refreshModels: Schema.optional(Schema.Boolean),
    /**
     * Reply without snapshots, or with only the requested instance's cwd snapshot. Snapshots then
     * reach the client only through these replies, so another client's scan shows on its next
     * refresh, at most one TTL later.
     */
    workspaceSnapshotsOnDemand: Schema.optional(Schema.Boolean),
    /** As on `subscribeServerConfig`: add /usage-limits to the replied snapshot. */
    usageLimitsCommand: Schema.optional(Schema.Boolean),
  }),
  success: ServerProviderUpdatedPayload,
  error: Schema.Union([EnvironmentAuthorizationError, ProviderSetupError]),
});

const WsServerUpdateProviderRpc = Rpc.make(WS_METHODS.serverUpdateProvider, {
  payload: ServerProviderUpdateInput,
  success: ServerProviderUpdatedPayload,
  error: Schema.Union([ServerProviderUpdateError, EnvironmentAuthorizationError]),
});

const ProviderSetupRpcError = Schema.Union([ProviderSetupError, EnvironmentAuthorizationError]);

const WsProviderConsumeResetCreditRpc = Rpc.make(WS_METHODS.providerConsumeResetCredit, {
  payload: ProviderConsumeResetCreditInput,
  success: ProviderConsumeResetCreditResult,
  error: Schema.Union([ProviderSetupError, UsageLimitSourceError, EnvironmentAuthorizationError]),
});

const WsProviderAuthStartRpc = Rpc.make(WS_METHODS.providerAuthStart, {
  payload: ProviderAuthStartInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});

const WsProviderAuthRespondRpc = Rpc.make(WS_METHODS.providerAuthRespond, {
  payload: ProviderAuthRespondInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});

const WsProviderAuthCompleteRpc = Rpc.make(WS_METHODS.providerAuthComplete, {
  payload: ProviderAuthCompleteInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});

const WsChatGptReconnectProfileRpc = Rpc.make(WS_METHODS.chatGptReconnectProfile, {
  payload: ChatGptReconnectProfileInput,
  success: Schema.NullOr(ChatGptReconnectProfile),
  error: ProviderSetupRpcError,
});
const WsChatGptImportProfileRpc = Rpc.make(WS_METHODS.chatGptImportProfile, {
  payload: ChatGptImportProfileInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});
const WsChatGptHandoffSubscribeRpc = Rpc.make(WS_METHODS.chatGptHandoffSubscribe, {
  payload: ChatGptHandoffInput,
  success: ChatGptHandoffState,
  error: ProviderSetupRpcError,
  stream: true,
});

const WsCodexAuthCallbackSubscribeRpc = Rpc.make(WS_METHODS.codexAuthCallbackSubscribe, {
  payload: CodexAuthCallbackInput,
  success: CodexAuthCallbackState,
  error: ProviderSetupRpcError,
  stream: true,
});

const WsProviderAuthCancelRpc = Rpc.make(WS_METHODS.providerAuthCancel, {
  payload: ProviderAuthCancelInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});

const WsProviderAuthLogoutRpc = Rpc.make(WS_METHODS.providerAuthLogout, {
  payload: ProviderSetupInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});

const WsProviderAuthSubscribeRpc = Rpc.make(WS_METHODS.providerAuthSubscribe, {
  payload: ProviderSetupInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
  stream: true,
});

const WsProviderInstallStartRpc = Rpc.make(WS_METHODS.providerInstallStart, {
  payload: ProviderSetupInput,
  success: ProviderInstallState,
  error: ProviderSetupRpcError,
});

const WsProviderInstallCancelRpc = Rpc.make(WS_METHODS.providerInstallCancel, {
  payload: ProviderInstallCancelInput,
  success: ProviderInstallState,
  error: ProviderSetupRpcError,
});

const WsProviderInstallSubscribeRpc = Rpc.make(WS_METHODS.providerInstallSubscribe, {
  payload: ProviderSetupInput,
  success: ProviderInstallState,
  error: ProviderSetupRpcError,
  stream: true,
});

const WsProviderInstallRemoveRpc = Rpc.make(WS_METHODS.providerInstallRemove, {
  payload: ProviderSetupInput,
  success: ProviderInstallState,
  error: ProviderSetupRpcError,
});

const WsServerUpdateServerRpc = Rpc.make(WS_METHODS.serverUpdateServer, {
  payload: ServerSelfUpdateInput,
  success: ServerSelfUpdateResult,
  error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
});

const WsServerUpdateServerWithProgressRpc = Rpc.make(WS_METHODS.serverUpdateServerWithProgress, {
  payload: ServerSelfUpdateInput,
  success: ServerSelfUpdateProgressEvent,
  error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsServerCommitDesktopUpdateRpc = Rpc.make(WS_METHODS.serverCommitDesktopUpdate, {
  payload: DesktopUpdateCommitInput,
  success: ServerSelfUpdateResult,
  error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
});

const WsServerGetMaintenanceStatusRpc = Rpc.make(WS_METHODS.serverGetMaintenanceStatus, {
  payload: Schema.Struct({}),
  success: ForkUpdateStatus,
  error: Schema.Union([ForkMaintenanceError, EnvironmentAuthorizationError]),
});

const WsServerUpdateMaintenancePolicyRpc = Rpc.make(WS_METHODS.serverUpdateMaintenancePolicy, {
  payload: ForkUpdatePolicyPatch,
  success: ForkUpdateStatus,
  error: Schema.Union([ForkMaintenanceError, EnvironmentAuthorizationError]),
});

const WsServerRunMaintenanceActionRpc = Rpc.make(WS_METHODS.serverRunMaintenanceAction, {
  payload: ForkMaintenanceActionInput,
  success: ForkUpdateStatus,
  error: Schema.Union([ForkMaintenanceError, EnvironmentAuthorizationError]),
});

const WsServerRecoverMaintenanceRpc = Rpc.make(WS_METHODS.serverRecoverMaintenance, {
  payload: ForkRecoveryRequest,
  success: ForkUpdateStatus,
  error: Schema.Union([ForkMaintenanceError, EnvironmentAuthorizationError]),
});

const WsServerRunStorageCleanupRpc = Rpc.make(WS_METHODS.serverRunStorageCleanup, {
  payload: Schema.Struct({}),
  success: StorageCleanupReport,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});
const WsServerGetStorageCleanupReportRpc = Rpc.make(WS_METHODS.serverGetStorageCleanupReport, {
  payload: Schema.Struct({}),
  success: Schema.NullOr(StorageCleanupReport),
  stream: true,
  error: EnvironmentAuthorizationError,
});

const WsServerGetDatabaseStorageRpc = Rpc.make(WS_METHODS.serverGetDatabaseStorage, {
  payload: Schema.Struct({}),
  success: Schema.NullOr(DatabaseStorageStatus),
  stream: true,
  error: EnvironmentAuthorizationError,
});

const WsPeerLinksListRpc = Rpc.make(WS_METHODS.peerLinksList, {
  payload: Schema.Struct({}),
  success: Schema.Struct({ links: Schema.Array(PeerLinkSummary) }),
  error: Schema.Union([PeerLinkError, EnvironmentAuthorizationError]),
});

const WsPeerLinksLinkRpc = Rpc.make(WS_METHODS.peerLinksLink, {
  payload: PeerLinkCreateInput,
  success: PeerLink,
  error: Schema.Union([PeerLinkError, EnvironmentAuthorizationError]),
});

const WsPeerLinksUnlinkRpc = Rpc.make(WS_METHODS.peerLinksUnlink, {
  payload: PeerLinkRemoveInput,
  success: PeerLinkRemoveResult,
  error: Schema.Union([PeerLinkError, EnvironmentAuthorizationError]),
});

const WsPeerLinksAnswerRequestRpc = Rpc.make(WS_METHODS.peerLinksAnswerRequest, {
  payload: PeerLinkRequestAnswerInput,
  error: Schema.Union([PeerLinkRequestError, EnvironmentAuthorizationError]),
});

const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({
    patch: ServerSettingsPatch,
    providerInstanceMutation: Schema.optionalKey(ProviderInstanceMutation),
  }),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

const WsServerDiscoverSourceControlRpc = Rpc.make(WS_METHODS.serverDiscoverSourceControl, {
  payload: Schema.Struct({}),
  success: SourceControlDiscoveryResult,
  error: EnvironmentAuthorizationError,
});

const WsServerSearchAcpRegistryRpc = Rpc.make(WS_METHODS.serverSearchAcpRegistry, {
  payload: AcpRegistrySearchInput,
  success: AcpRegistrySearchResult,
  error: Schema.Union([AcpRegistryOperationError, EnvironmentAuthorizationError]),
});

const WsServerPrepareAcpRegistryAgentRpc = Rpc.make(WS_METHODS.serverPrepareAcpRegistryAgent, {
  payload: AcpRegistryPrepareInput,
  success: AcpRegistryPrepareResult,
  error: Schema.Union([AcpRegistryOperationError, EnvironmentAuthorizationError]),
});

const WsServerUninstallAcpRegistryManagedBinaryRpc = Rpc.make(
  WS_METHODS.serverUninstallAcpRegistryManagedBinary,
  {
    payload: AcpRegistryManagedBinaryUninstallInput,
    success: AcpRegistryManagedBinaryUninstallResult,
    error: Schema.Union([AcpRegistryOperationError, EnvironmentAuthorizationError]),
  },
);

const WsServerAcceptAcpRegistryUrlAuthRpc = Rpc.make(WS_METHODS.serverAcceptAcpRegistryUrlAuth, {
  payload: AcpRegistryAcceptUrlAuthInput,
  success: AcpRegistryAcceptUrlAuthResult,
  error: EnvironmentAuthorizationError,
});

const WsServerListAcpRegistrySessionsRpc = Rpc.make(WS_METHODS.serverListAcpRegistrySessions, {
  payload: AcpRegistryListSessionsInput,
  success: AcpRegistryListSessionsResult,
  error: Schema.Union([AcpRegistryOperationError, EnvironmentAuthorizationError]),
});

const WsServerImportAcpRegistrySessionRpc = Rpc.make(WS_METHODS.serverImportAcpRegistrySession, {
  payload: AcpRegistryImportSessionInput,
  success: AcpRegistryImportSessionResult,
  error: Schema.Union([AcpRegistryOperationError, EnvironmentAuthorizationError]),
});

const WsServerDeleteAcpRegistrySessionRpc = Rpc.make(WS_METHODS.serverDeleteAcpRegistrySession, {
  payload: AcpRegistryDeleteSessionInput,
  success: AcpRegistryDeleteSessionResult,
  error: Schema.Union([AcpRegistryOperationError, EnvironmentAuthorizationError]),
});

const WsServerListAcpRegistryProvidersRpc = Rpc.make(WS_METHODS.serverListAcpRegistryProviders, {
  payload: AcpRegistryListProvidersInput,
  success: AcpRegistryListProvidersResult,
  error: Schema.Union([AcpRegistryOperationError, EnvironmentAuthorizationError]),
});

const WsServerSetAcpRegistryProviderRpc = Rpc.make(WS_METHODS.serverSetAcpRegistryProvider, {
  payload: AcpRegistrySetProviderInput,
  success: AcpRegistrySetProviderResult,
  error: Schema.Union([AcpRegistryOperationError, EnvironmentAuthorizationError]),
});

const WsServerDisableAcpRegistryProviderRpc = Rpc.make(
  WS_METHODS.serverDisableAcpRegistryProvider,
  {
    payload: AcpRegistryDisableProviderInput,
    success: AcpRegistryDisableProviderResult,
    error: Schema.Union([AcpRegistryOperationError, EnvironmentAuthorizationError]),
  },
);

const WsServerLogoutAcpRegistryRpc = Rpc.make(WS_METHODS.serverLogoutAcpRegistry, {
  payload: AcpRegistryLogoutInput,
  success: AcpRegistryLogoutResult,
  error: Schema.Union([AcpRegistryOperationError, EnvironmentAuthorizationError]),
});

const WsServerGetTraceDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetTraceDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerTraceDiagnosticsResult,
  error: EnvironmentAuthorizationError,
});

const WsServerGetProcessDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetProcessDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerProcessDiagnosticsResult,
  error: EnvironmentAuthorizationError,
});

const WsServerGetHostResourcesRpc = Rpc.make(WS_METHODS.serverGetHostResources, {
  payload: Schema.Struct({}),
  success: HostResourcesSnapshot,
  error: EnvironmentAuthorizationError,
});

const WsServerGetProcessResourceHistoryRpc = Rpc.make(WS_METHODS.serverGetProcessResourceHistory, {
  payload: ServerProcessResourceHistoryInput,
  success: ServerProcessResourceHistoryResult,
  error: EnvironmentAuthorizationError,
});

const WsServerGetResourceTelemetryHistoryRpc = Rpc.make(
  WS_METHODS.serverGetResourceTelemetryHistory,
  {
    payload: ResourceTelemetryHistoryInput,
    success: ResourceTelemetryHistory,
    error: EnvironmentAuthorizationError,
  },
);

const WsServerRetryResourceTelemetryRpc = Rpc.make(WS_METHODS.serverRetryResourceTelemetry, {
  payload: Schema.Struct({}),
  success: ResourceTelemetryRetryResult,
  error: EnvironmentAuthorizationError,
});

const WsServerCheckOtlpEndpointRpc = Rpc.make(WS_METHODS.serverCheckOtlpEndpoint, {
  payload: OtlpEndpointCheckInput,
  success: OtlpEndpointCheckResult,
  error: EnvironmentAuthorizationError,
});

const WsServerPrepareTriageRpc = Rpc.make(WS_METHODS.serverPrepareTriage, {
  payload: ServerPrepareTriageInput,
  success: ServerPrepareTriageResult,
  error: Schema.Union([ServerPrepareTriageError, EnvironmentAuthorizationError]),
});

const WsServerGetUsageSummaryRpc = Rpc.make(WS_METHODS.serverGetUsageSummary, {
  payload: UsageSummaryInput,
  success: UsageSummary,
  error: Schema.Union([EnvironmentAuthorizationError, UsageReadError]),
});

const WsServerRefreshUsageRatesRpc = Rpc.make(WS_METHODS.serverRefreshUsageRates, {
  payload: Schema.Struct({}),
  success: UsagePricing,
  error: EnvironmentAuthorizationError,
});

const WsServerSignalProcessRpc = Rpc.make(WS_METHODS.serverSignalProcess, {
  payload: ServerSignalProcessInput,
  success: ServerSignalProcessResult,
  error: EnvironmentAuthorizationError,
});

const WsCloudGetRelayClientStatusRpc = Rpc.make(WS_METHODS.cloudGetRelayClientStatus, {
  payload: Schema.Struct({}),
  success: RelayClientStatusSchema,
  error: EnvironmentAuthorizationError,
});

const WsCloudInstallRelayClientRpc = Rpc.make(WS_METHODS.cloudInstallRelayClient, {
  payload: Schema.Struct({}),
  success: RelayClientInstallProgressEventSchema,
  error: Schema.Union([RelayClientInstallFailedError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsServerReportClientActivityRpc = Rpc.make(WS_METHODS.serverReportClientActivity, {
  payload: ClientActivityReportInput,
  error: EnvironmentAuthorizationError,
});

const PullRequestRpcError = Schema.Union([
  PullRequestUnavailableError,
  PullRequestOperationError,
  EnvironmentAuthorizationError,
]);

const WsPullRequestsListRpc = Rpc.make(WS_METHODS.pullRequestsList, {
  payload: PullRequestListInput,
  success: PullRequestListResult,
  error: PullRequestRpcError,
});

// GitHub line counts cost 40-60% of the listing read; fetch separately so rows arrive first.
const WsPullRequestsListStatsRpc = Rpc.make(WS_METHODS.pullRequestsListStats, {
  payload: PullRequestListStatsInput,
  success: PullRequestListStatsResult,
  error: PullRequestRpcError,
});

const WsPullRequestsFilterOptionsRpc = Rpc.make(WS_METHODS.pullRequestsFilterOptions, {
  payload: PullRequestFilterOptionsInput,
  success: PullRequestFilterOptions,
  error: PullRequestRpcError,
});

const WsPullRequestsRoutingRpc = Rpc.make(WS_METHODS.pullRequestsRouting, {
  payload: PullRequestRef,
  success: PullRequestRoutingResult,
  error: PullRequestRpcError,
});

const WsPullRequestsRoutingIdentityRpc = Rpc.make(WS_METHODS.pullRequestsRoutingIdentity, {
  payload: PullRequestRoutingIdentityInput,
  success: PullRequestRoutingIdentityResult,
  error: PullRequestRpcError,
});

const WsPullRequestsSummaryRpc = Rpc.make(WS_METHODS.pullRequestsSummary, {
  payload: PullRequestRef,
  success: PullRequestSummary,
  error: PullRequestRpcError,
});

const WsPullRequestsStackRpc = Rpc.make(WS_METHODS.pullRequestsStack, {
  payload: PullRequestRef,
  success: Schema.NullOr(PullRequestStack),
  error: PullRequestRpcError,
});

const WsPullRequestsLinkedThreadsRpc = Rpc.make(WS_METHODS.pullRequestsLinkedThreads, {
  payload: PullRequestRef,
  success: PullRequestLinkedThreadsResult,
  error: PullRequestRpcError,
});

const WsPullRequestsDetailRpc = Rpc.make(WS_METHODS.pullRequestsDetail, {
  payload: PullRequestRef,
  success: PullRequestDetail,
  error: PullRequestRpcError,
});

const WsPullRequestsPreviewRpc = Rpc.make(WS_METHODS.pullRequestsPreview, {
  payload: PullRequestRef,
  success: PullRequestPreview,
  error: PullRequestRpcError,
});

const WsPullRequestsChecksRpc = Rpc.make(WS_METHODS.pullRequestsChecks, {
  payload: PullRequestRef,
  success: Schema.NullOr(PullRequestChecks),
  error: PullRequestRpcError,
});

const WsPullRequestsActivityRpc = Rpc.make(WS_METHODS.pullRequestsActivity, {
  payload: PullRequestRef,
  success: PullRequestActivity,
  error: PullRequestRpcError,
});

const WsPullRequestsReviewGuideRpc = Rpc.make(WS_METHODS.pullRequestsReviewGuide, {
  payload: PullRequestRef,
  success: PullRequestReviewGuideResult,
  error: PullRequestRpcError,
});

const WsPullRequestsGenerateReviewGuideRpc = Rpc.make(WS_METHODS.pullRequestsGenerateReviewGuide, {
  payload: PullRequestRef,
  success: PullRequestReviewGuideResult,
  error: PullRequestRpcError,
});

const WsPullRequestsThreadCommentsRpc = Rpc.make(WS_METHODS.pullRequestsThreadComments, {
  payload: PullRequestThreadCommentsInput,
  success: PullRequestThreadCommentsResult,
  error: PullRequestRpcError,
});

const WsPullRequestsDiffFileContentsRpc = Rpc.make(WS_METHODS.pullRequestsDiffFileContents, {
  payload: PullRequestDiffFileContentsInput,
  success: PullRequestDiffFileContentsResult,
  error: PullRequestRpcError,
});

const WsPullRequestsFilesViewedRpc = Rpc.make(WS_METHODS.pullRequestsFilesViewed, {
  payload: PullRequestRef,
  success: PullRequestFilesViewedResult,
  error: PullRequestRpcError,
});

const WsPullRequestsChangeBreakdownRpc = Rpc.make(WS_METHODS.pullRequestsChangeBreakdown, {
  payload: PullRequestRef,
  success: PullRequestChangeBreakdown,
  error: PullRequestRpcError,
});

const WsPullRequestsSetFilesViewedRpc = Rpc.make(WS_METHODS.pullRequestsSetFilesViewed, {
  payload: PullRequestSetFilesViewedInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsRunActionRpc = Rpc.make(WS_METHODS.pullRequestsRunAction, {
  payload: PullRequestActionInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsUpdateRpc = Rpc.make(WS_METHODS.pullRequestsUpdate, {
  payload: PullRequestUpdateInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsCommentRpc = Rpc.make(WS_METHODS.pullRequestsComment, {
  payload: PullRequestCommentInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsUpdateCommentRpc = Rpc.make(WS_METHODS.pullRequestsUpdateComment, {
  payload: PullRequestCommentUpdateInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsSubmitReviewRpc = Rpc.make(WS_METHODS.pullRequestsSubmitReview, {
  payload: PullRequestSubmitReviewInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsReplyToThreadRpc = Rpc.make(WS_METHODS.pullRequestsReplyToThread, {
  payload: PullRequestThreadReplyInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsSetThreadResolutionRpc = Rpc.make(WS_METHODS.pullRequestsSetThreadResolution, {
  payload: PullRequestThreadResolutionInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsSetReactionRpc = Rpc.make(WS_METHODS.pullRequestsSetReaction, {
  payload: PullRequestReactionInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsInvalidateRpc = Rpc.make(WS_METHODS.pullRequestsInvalidate, {
  payload: PullRequestInvalidateInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsReportStateRpc = Rpc.make(WS_METHODS.pullRequestsReportState, {
  payload: PullRequestReportStateInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsSubscribeRefreshesRpc = Rpc.make(WS_METHODS.pullRequestsSubscribeRefreshes, {
  payload: Schema.Struct({}),
  success: NonNegativeInt,
  error: EnvironmentAuthorizationError,
  stream: true,
});

// Fetch reviewer candidates only when the menu opens to avoid unused host requests.
const WsPullRequestsReviewerCandidatesRpc = Rpc.make(WS_METHODS.pullRequestsReviewerCandidates, {
  payload: PullRequestRef,
  success: PullRequestReviewerCandidateList,
  error: PullRequestRpcError,
});

const WsPullRequestsRequestReviewersRpc = Rpc.make(WS_METHODS.pullRequestsRequestReviewers, {
  payload: PullRequestReviewerRequestInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsLabelCandidatesRpc = Rpc.make(WS_METHODS.pullRequestsLabelCandidates, {
  payload: PullRequestRef,
  success: PullRequestLabelCandidateList,
  error: PullRequestRpcError,
});

const WsPullRequestsSetLabelsRpc = Rpc.make(WS_METHODS.pullRequestsSetLabels, {
  payload: PullRequestLabelChangeInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsSourceControlLookupRepositoryRpc = Rpc.make(WS_METHODS.sourceControlLookupRepository, {
  payload: SourceControlRepositoryLookupInput,
  success: SourceControlRepositoryInfo,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

const WsSourceControlCloneRepositoryRpc = Rpc.make(WS_METHODS.sourceControlCloneRepository, {
  payload: SourceControlCloneRepositoryInput,
  success: SourceControlCloneRepositoryResult,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

// Returns when the project exists and cloning starts; progress uses the subscription.
const WsProjectCloneStartRpc = Rpc.make(WS_METHODS.projectCloneStart, {
  payload: ProjectCloneStartInput,
  success: ProjectCloneStartResult,
  error: Schema.Union([
    SourceControlRepositoryError,
    OrchestrationDispatchCommandError,
    EnvironmentAuthorizationError,
  ]),
});

const WsProjectCloneCancelRpc = Rpc.make(WS_METHODS.projectCloneCancel, {
  payload: ProjectCloneActionInput,
  success: ProjectCloneActionResult,
  error: EnvironmentAuthorizationError,
});

const WsProjectCloneRetryRpc = Rpc.make(WS_METHODS.projectCloneRetry, {
  payload: ProjectCloneActionInput,
  success: ProjectCloneActionResult,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

const WsSubscribeProjectClonesRpc = Rpc.make(WS_METHODS.subscribeProjectClones, {
  payload: ProjectCloneSubscribeInput,
  success: ProjectCloneListEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsSourceControlPublishRepositoryRpc = Rpc.make(WS_METHODS.sourceControlPublishRepository, {
  payload: SourceControlPublishRepositoryInput,
  success: SourceControlPublishRepositoryResult,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

const WsProjectsSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: Schema.Union([ProjectSearchEntriesError, EnvironmentAuthorizationError]),
});

const WsProjectsSearchContentsRpc = Rpc.make(WS_METHODS.projectsSearchContents, {
  payload: ProjectSearchContentsInput,
  success: ProjectSearchContentsResult,
  error: Schema.Union([ProjectSearchContentsError, EnvironmentAuthorizationError]),
});

const WsProjectsListEntriesRpc = Rpc.make(WS_METHODS.projectsListEntries, {
  payload: ProjectListEntriesInput,
  success: ProjectListEntriesResult,
  error: Schema.Union([ProjectListEntriesError, EnvironmentAuthorizationError]),
});

const WsProjectsListIgnoredFilesRpc = Rpc.make(WS_METHODS.projectsListIgnoredFiles, {
  payload: ProjectListIgnoredFilesInput,
  success: ProjectListIgnoredFilesResult,
  error: Schema.Union([ProjectListEntriesError, EnvironmentAuthorizationError]),
});

const WsProjectsReadFileRpc = Rpc.make(WS_METHODS.projectsReadFile, {
  payload: ProjectReadFileInput,
  success: ProjectReadFileResult,
  error: Schema.Union([ProjectReadFileError, EnvironmentAuthorizationError]),
});

const WsProjectsWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: Schema.Union([ProjectWriteFileError, EnvironmentAuthorizationError]),
});

const WsProjectsMutateRpc = Rpc.make(WS_METHODS.projectsMutate, {
  payload: ProjectMutation,
  success: Project,
  error: Schema.Union([ProjectMutationError, EnvironmentAuthorizationError]),
});

const WsProjectsEnsureScratchRpc = Rpc.make(WS_METHODS.projectsEnsureScratch, {
  payload: Schema.Struct({}),
  success: ProjectEnsureScratchResult,
  error: Schema.Union([OrchestrationDispatchCommandError, EnvironmentAuthorizationError]),
});

const WsProjectsCreateNewRpc = Rpc.make(WS_METHODS.projectsCreateNew, {
  payload: ProjectCreateNewInput,
  success: ProjectCreateNewResult,
  error: Schema.Union([OrchestrationDispatchCommandError, EnvironmentAuthorizationError]),
});

const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: LaunchEditorInput,
  error: Schema.Union([ExternalLauncherError, EnvironmentAuthorizationError]),
});

const WsFilesystemGetMetadataRpc = Rpc.make(WS_METHODS.filesystemGetMetadata, {
  payload: FilesystemGetMetadataInput,
  success: FilesystemGetMetadataResult,
  error: EnvironmentAuthorizationError,
});

const WsFilesystemBrowseRpc = Rpc.make(WS_METHODS.filesystemBrowse, {
  payload: FilesystemBrowseInput,
  success: FilesystemBrowseResult,
  error: Schema.Union([FilesystemBrowseError, EnvironmentAuthorizationError]),
});

const WsCodexSessionsListRpc = Rpc.make(WS_METHODS.codexSessionsList, {
  payload: CodexSessionsListInput,
  success: CodexSessionsListResult,
  error: Schema.Union([ForkMaintenanceError, EnvironmentAuthorizationError]),
});

const WsCodexSessionsResumeRpc = Rpc.make(WS_METHODS.codexSessionsResume, {
  payload: CodexSessionsResumeInput,
  success: CodexSessionsResumeResult,
  error: Schema.Union([
    ForkMaintenanceError,
    EnvironmentAuthorizationError,
    NativeSessionResumeError,
  ]),
});

const WsAgentSessionsScanRpc = Rpc.make(WS_METHODS.agentSessionsScan, {
  payload: AgentSessionScanInput,
  success: AgentSessionScanResult,
  error: Schema.Union([AgentSessionScanError, EnvironmentAuthorizationError]),
});

const WsAgentSessionsImportRpc = Rpc.make(WS_METHODS.agentSessionsImport, {
  payload: AgentSessionImportInput,
  success: AgentSessionImportResult,
  error: Schema.Union([
    AgentSessionImportProjectChangedError,
    AgentSessionImportProjectNotFoundError,
    AgentSessionScanError,
    EnvironmentAuthorizationError,
  ]),
});

const WsAssetsCreateUrlRpc = Rpc.make(WS_METHODS.assetsCreateUrl, {
  payload: AssetCreateUrlInput,
  success: AssetCreateUrlResult,
  error: Schema.Union([AssetAccessError, EnvironmentAuthorizationError]),
});

const WsAssetsPersistChatAttachmentsRpc = Rpc.make(WS_METHODS.assetsPersistChatAttachments, {
  payload: PersistChatAttachmentsInput,
  success: PersistChatAttachmentsResult,
  error: Schema.Union([PersistChatAttachmentsError, EnvironmentAuthorizationError]),
});

const WsAttachmentsCreateUploadUrlRpc = Rpc.make(WS_METHODS.attachmentsCreateUploadUrl, {
  payload: AttachmentCreateUploadUrlInput,
  success: AttachmentCreateUploadUrlResult,
  error: Schema.Union([AttachmentUploadSigningKeyError, EnvironmentAuthorizationError]),
});

const WsAttachmentsDeleteRpc = Rpc.make(WS_METHODS.attachmentsDelete, {
  payload: AttachmentDeleteInput,
  error: EnvironmentAuthorizationError,
});

const WsMcpAppsCallToolRpc = Rpc.make(WS_METHODS.mcpAppsCallTool, {
  payload: McpAppCallToolInput,
  success: McpAppCallToolResult,
  error: Schema.Union([McpAppRequestError, EnvironmentAuthorizationError]),
});

const WsMcpAppsToolInfoRpc = Rpc.make(WS_METHODS.mcpAppsToolInfo, {
  payload: McpAppToolInfoInput,
  success: McpAppToolInfo,
  error: Schema.Union([McpAppRequestError, EnvironmentAuthorizationError]),
});

const WsMcpAppsUpdateModelContextRpc = Rpc.make(WS_METHODS.mcpAppsUpdateModelContext, {
  payload: McpAppUpdateModelContextInput,
  error: Schema.Union([McpAppRequestError, EnvironmentAuthorizationError]),
});

const WsMcpAppsReadResourceRpc = Rpc.make(WS_METHODS.mcpAppsReadResource, {
  payload: McpAppReadResourceInput,
  success: McpAppReadResourceResult,
  error: Schema.Union([McpAppRequestError, EnvironmentAuthorizationError]),
});

const WsProviderUploadFeedbackRpc = Rpc.make(WS_METHODS.providerUploadFeedback, {
  payload: ProviderUploadFeedbackInput,
  success: ProviderUploadFeedbackResult,
  error: Schema.Union([ProviderUploadFeedbackError, EnvironmentAuthorizationError]),
});

const WsSubscribeVcsStatusRpc = Rpc.make(WS_METHODS.subscribeVcsStatus, {
  payload: VcsStatusSubscriptionInput,
  success: VcsStatusStreamEvent,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsVcsPullRpc = Rpc.make(WS_METHODS.vcsPull, {
  payload: VcsPullInput,
  success: VcsPullResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsWorktreeStorageUsageRpc = Rpc.make(WS_METHODS.vcsWorktreeStorageUsage, {
  payload: VcsStatusInput,
  success: Schema.NullOr(WorktreeStorageUsage),
  error: EnvironmentAuthorizationError,
});

const WsVcsRefreshStatusRpc = Rpc.make(WS_METHODS.vcsRefreshStatus, {
  payload: Schema.Struct({
    ...VcsRefreshStatusInput.fields,
    localOnly: Schema.optional(Schema.Boolean),
  }),
  success: VcsStatusResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

const WsSubscribeWorktreeSetupRpc = Rpc.make(WS_METHODS.subscribeWorktreeSetup, {
  payload: WorktreeSetupSubscribeInput,
  success: WorktreeSetupStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsWorktreeSetupCancelRpc = Rpc.make(WS_METHODS.worktreeSetupCancel, {
  payload: WorktreeSetupCancelInput,
  success: WorktreeSetupCancelResult,
  error: EnvironmentAuthorizationError,
});

const WsGitRunStackedActionRpc = Rpc.make(WS_METHODS.gitRunStackedAction, {
  payload: GitRunStackedActionInput,
  success: GitActionProgressEvent,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsGitResolvePullRequestRpc = Rpc.make(WS_METHODS.gitResolvePullRequest, {
  payload: GitPullRequestRefInput,
  success: GitResolvePullRequestResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

const WsGitPreparePullRequestThreadRpc = Rpc.make(WS_METHODS.gitPreparePullRequestThread, {
  payload: GitPreparePullRequestThreadInput,
  success: GitPreparePullRequestThreadResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

const WsVcsListRefsRpc = Rpc.make(WS_METHODS.vcsListRefs, {
  payload: VcsListRefsInput,
  success: VcsListRefsResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsCreateWorktreeRpc = Rpc.make(WS_METHODS.vcsCreateWorktree, {
  // Worktrees use the managed folder; required null path preserves compatibility with older servers.
  payload: Schema.Struct({ ...VcsCreateWorktreeInput.fields, path: Schema.Null }),
  success: VcsCreateWorktreeResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsRemoveWorktreeRpc = Rpc.make(WS_METHODS.vcsRemoveWorktree, {
  payload: VcsRemoveWorktreeInput,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsCreateRefRpc = Rpc.make(WS_METHODS.vcsCreateRef, {
  payload: VcsCreateRefInput,
  success: VcsCreateRefResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsSwitchRefRpc = Rpc.make(WS_METHODS.vcsSwitchRef, {
  payload: VcsSwitchRefInput,
  success: VcsSwitchRefResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsInitRpc = Rpc.make(WS_METHODS.vcsInit, {
  payload: VcsInitInput,
  error: Schema.Union([VcsError, EnvironmentAuthorizationError]),
});

const WsReviewGetDiffPreviewRpc = Rpc.make(WS_METHODS.reviewGetDiffPreview, {
  payload: ReviewDiffPreviewInput,
  success: ReviewDiffPreviewResult,
  error: Schema.Union([ReviewDiffPreviewError, EnvironmentAuthorizationError]),
});

const WsReviewGetDiffFileContentsRpc = Rpc.make(WS_METHODS.reviewGetDiffFileContents, {
  payload: ReviewDiffFileContentsInput,
  success: ReviewDiffFileContentsResult,
  error: Schema.Union([ReviewDiffPreviewError, EnvironmentAuthorizationError]),
});

const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsTerminalAttachRpc = Rpc.make(WS_METHODS.terminalAttach, {
  payload: TerminalAttachInput,
  success: TerminalAttachStreamEvent,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsTerminalObserveRpc = Rpc.make(WS_METHODS.terminalObserve, {
  payload: TerminalObserveInput,
  success: TerminalAttachStreamEvent,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsPreviewOpenRpc = Rpc.make(WS_METHODS.previewOpen, {
  payload: PreviewOpenInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewNavigateRpc = Rpc.make(WS_METHODS.previewNavigate, {
  payload: PreviewNavigateInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewRefreshRpc = Rpc.make(WS_METHODS.previewRefresh, {
  payload: PreviewRefreshInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewResizeRpc = Rpc.make(WS_METHODS.previewResize, {
  payload: PreviewResizeInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewAdjustRpc = Rpc.make(WS_METHODS.previewAdjust, {
  payload: PreviewAdjustInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewCloseRpc = Rpc.make(WS_METHODS.previewClose, {
  payload: PreviewCloseInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewListRpc = Rpc.make(WS_METHODS.previewList, {
  payload: PreviewListInput,
  success: PreviewListResult,
  error: EnvironmentAuthorizationError,
});

const WsPreviewClearProfileRpc = Rpc.make(WS_METHODS.previewClearProfile, {
  payload: PreviewClearProfileInput,
  error: Schema.Union([PreviewClearProfileError, EnvironmentAuthorizationError]),
});

const WsPreviewReportProfilesRpc = Rpc.make(WS_METHODS.previewReportProfiles, {
  payload: PreviewReportProfilesInput,
  error: EnvironmentAuthorizationError,
});

const WsPreviewReportStatusRpc = Rpc.make(WS_METHODS.previewReportStatus, {
  payload: PreviewReportStatusInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

/**
 * Viewers that cannot render their own webview attach here. Errors stay on the
 * stream as `unavailable` events rather than failing the call, so a viewer that
 * attaches before a host connects just waits.
 */
const WsPreviewAttachRpc = Rpc.make(WS_METHODS.previewAttach, {
  payload: PreviewAttachInput,
  success: PreviewFrameStreamEvent,
  error: Schema.Union([ForkMaintenanceError, PreviewError, EnvironmentAuthorizationError]),
  stream: true,
});

/** Host to server. Fire and forget: a dropped frame is always recoverable. */
const WsPreviewPublishFrameRpc = Rpc.make(WS_METHODS.previewPublishFrame, {
  payload: PreviewPublishFrameInput,
  error: Schema.Union([ForkMaintenanceError, PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewInputRpc = Rpc.make(WS_METHODS.previewInput, {
  payload: PreviewInputInput,
  error: Schema.Union([
    ForkMaintenanceError,
    PreviewError,
    PreviewAutomationError,
    EnvironmentAuthorizationError,
  ]),
});

/** Resolves the element under a point for a viewer with no page to pick in. */
const WsPreviewPickElementRpc = Rpc.make(WS_METHODS.previewPickElement, {
  payload: PreviewPickElementInput,
  success: PreviewPickElementResult,
  error: Schema.Union([
    ForkMaintenanceError,
    PreviewError,
    PreviewAutomationError,
    EnvironmentAuthorizationError,
  ]),
});

const WsPreviewAutomationConnectRpc = Rpc.make(WS_METHODS.previewAutomationConnect, {
  payload: PreviewAutomationHost,
  success: PreviewAutomationStreamEvent,
  error: Schema.Union([PreviewAutomationError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsPreviewAutomationRespondRpc = Rpc.make(WS_METHODS.previewAutomationRespond, {
  payload: PreviewAutomationResponse,
  error: Schema.Union([PreviewAutomationError, EnvironmentAuthorizationError]),
});

const WsPreviewAutomationFocusHostRpc = Rpc.make(WS_METHODS.previewAutomationFocusHost, {
  payload: PreviewAutomationHostFocus,
  error: EnvironmentAuthorizationError,
});

const WsSubscribePreviewEventsRpc = Rpc.make(WS_METHODS.subscribePreviewEvents, {
  payload: Schema.Struct({}),
  success: PreviewEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsPreviewStopLocalServerRpc = Rpc.make(WS_METHODS.previewStopLocalServer, {
  payload: PreviewStopLocalServerInput,
  error: Schema.Union([PreviewStopLocalServerError, EnvironmentAuthorizationError]),
});

const WsSubscribeDiscoveredLocalServersRpc = Rpc.make(WS_METHODS.subscribeDiscoveredLocalServers, {
  payload: Schema.Struct({
    configuredUrls: Schema.optional(ConfiguredLocalServerUrls),
  }),
  success: DiscoveredLocalServerList,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsDeviceTestHostRpc = Rpc.make(WS_METHODS.deviceTestHost, {
  payload: SshDeviceHostConfig,
  success: DeviceHostSummary,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceEasAccountRpc = Rpc.make(WS_METHODS.deviceEasAccount, {
  payload: DeviceEasAccountInput,
  success: DeviceEasAccount,
  error: Schema.Union([DeviceEasAccountError, EnvironmentAuthorizationError]),
});

const WsDeviceListRpc = Rpc.make(WS_METHODS.deviceList, {
  payload: DeviceListInput,
  success: DeviceServiceState,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceConfigureRpc = Rpc.make(WS_METHODS.deviceConfigure, {
  payload: DeviceConfigureInput,
  success: DeviceServiceState,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceOpenRpc = Rpc.make(WS_METHODS.deviceOpen, {
  payload: DeviceOpenInput,
  success: DeviceSession,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceCloseRpc = Rpc.make(WS_METHODS.deviceClose, {
  payload: DeviceCloseInput,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceShutdownRpc = Rpc.make(WS_METHODS.deviceShutdown, {
  payload: DeviceShutdownInput,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceDetailRpc = Rpc.make(WS_METHODS.deviceDetail, {
  payload: DeviceDetailInput,
  success: DeviceDetail,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceActionRpc = Rpc.make(WS_METHODS.deviceAction, {
  payload: DeviceActionInput,
  success: DeviceDetail,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsSubscribeDeviceStateRpc = Rpc.make(WS_METHODS.subscribeDeviceState, {
  payload: Schema.Struct({}),
  success: DeviceServiceState,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsOrchestrationV2DispatchCommandRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
  payload: OrchestrationV2RpcSchemas.dispatchCommand.input,
  success: OrchestrationV2RpcSchemas.dispatchCommand.output,
  error: Schema.Union([OrchestrationV2DispatchCommandError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2GetTurnDiffRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.getTurnDiff, {
  payload: OrchestrationV2RpcSchemas.getTurnDiff.input,
  success: OrchestrationV2RpcSchemas.getTurnDiff.output,
  error: Schema.Union([OrchestrationGetTurnDiffError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2GetFullThreadDiffRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff,
  {
    payload: OrchestrationV2RpcSchemas.getFullThreadDiff.input,
    success: OrchestrationV2RpcSchemas.getFullThreadDiff.output,
    error: Schema.Union([OrchestrationGetFullThreadDiffError, EnvironmentAuthorizationError]),
  },
);

const WsOrchestrationV2SearchThreadRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.searchThread, {
  payload: OrchestrationV2SearchThreadInput,
  success: OrchestrationV2SearchThreadResult,
  error: Schema.Union([OrchestrationV2SearchThreadError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2SearchThreadStreamRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.searchThreadStream,
  {
    payload: OrchestrationV2SearchThreadInput,
    success: OrchestrationV2SearchThreadResult,
    error: Schema.Union([OrchestrationV2SearchThreadError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

const WsOrchestrationV2SearchThreadsRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.searchThreads, {
  payload: OrchestrationV2SearchThreadsInput,
  success: OrchestrationV2SearchThreadsResult,
  error: Schema.Union([OrchestrationSearchThreadsError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2GetArchivedShellSnapshotRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot,
  {
    payload: OrchestrationV2RpcSchemas.getArchivedShellSnapshot.input,
    success: OrchestrationV2RpcSchemas.getArchivedShellSnapshot.output,
    error: Schema.Union([OrchestrationV2GetShellSnapshotError, EnvironmentAuthorizationError]),
  },
);

const WsOrchestrationV2GetThreadFamilyRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.getThreadFamily, {
  payload: OrchestrationV2RpcSchemas.getThreadFamily.input,
  success: OrchestrationV2RpcSchemas.getThreadFamily.output,
  error: Schema.Union([OrchestrationV2GetShellSnapshotError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2GetWorktreeThreadIdsRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.getWorktreeThreadIds,
  {
    payload: OrchestrationV2RpcSchemas.getWorktreeThreadIds.input,
    success: OrchestrationV2RpcSchemas.getWorktreeThreadIds.output,
    error: Schema.Union([OrchestrationV2GetShellSnapshotError, EnvironmentAuthorizationError]),
  },
);

const WsOrchestrationV2GetOlderSettledThreadsRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.getOlderSettledThreads,
  {
    payload: OrchestrationV2RpcSchemas.getOlderSettledThreads.input,
    success: OrchestrationV2RpcSchemas.getOlderSettledThreads.output,
    error: Schema.Union([OrchestrationV2GetShellSnapshotError, EnvironmentAuthorizationError]),
  },
);

const WsOrchestrationV2GetThreadProjectionRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
  {
    payload: OrchestrationV2RpcSchemas.getThreadProjection.input,
    success: OrchestrationV2RpcSchemas.getThreadProjection.output,
    error: Schema.Union([OrchestrationV2GetThreadProjectionError, EnvironmentAuthorizationError]),
  },
);

const WsOrchestrationV2StopWorkflowRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.stopWorkflow, {
  payload: OrchestrationV2RpcSchemas.stopWorkflow.input,
  success: OrchestrationV2RpcSchemas.stopWorkflow.output,
  error: Schema.Union([OrchestrationV2StopWorkflowError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2GetWorkflowScriptRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.getWorkflowScript,
  {
    payload: OrchestrationV2RpcSchemas.getWorkflowScript.input,
    success: OrchestrationV2RpcSchemas.getWorkflowScript.output,
    error: Schema.Union([OrchestrationGetWorkflowScriptError, EnvironmentAuthorizationError]),
  },
);

const WsOrchestrationV2GetMessageReplyChainRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.getMessageReplyChain,
  {
    payload: OrchestrationV2RpcSchemas.getMessageReplyChain.input,
    success: OrchestrationV2RpcSchemas.getMessageReplyChain.output,
    error: Schema.Union([OrchestrationV2GetThreadProjectionError, EnvironmentAuthorizationError]),
  },
);

const WsOrchestrationV2GetTurnItemRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.getTurnItem, {
  payload: OrchestrationV2RpcSchemas.getTurnItem.input,
  success: OrchestrationV2RpcSchemas.getTurnItem.output,
  error: Schema.Union([OrchestrationV2GetThreadProjectionError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2LaunchThreadRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.launchThread, {
  payload: OrchestrationV2RpcSchemas.launchThread.input,
  success: OrchestrationV2RpcSchemas.launchThread.output,
  error: Schema.Union([OrchestrationV2ThreadLaunchError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2SubscribeShellRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.subscribeShell, {
  payload: OrchestrationV2RpcSchemas.subscribeShell.input,
  success: OrchestrationV2RpcSchemas.subscribeShell.output,
  error: Schema.Union([OrchestrationV2GetShellSnapshotError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsOrchestrationV2SubscribeThreadRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.subscribeThread, {
  payload: OrchestrationV2RpcSchemas.subscribeThread.input,
  success: OrchestrationV2RpcSchemas.subscribeThread.output,
  error: Schema.Union([OrchestrationV2GetThreadProjectionError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsOrchestrationV2SubscribeCommandOutputRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput,
  {
    payload: OrchestrationV2RpcSchemas.subscribeCommandOutput.input,
    success: OrchestrationV2RpcSchemas.subscribeCommandOutput.output,
    error: Schema.Union([OrchestrationV2CommandOutputError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

const WsSubscribeTerminalMetadataRpc = Rpc.make(WS_METHODS.subscribeTerminalMetadata, {
  payload: Schema.Struct({}),
  success: TerminalMetadataStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({
    /** Opt-in protects older clients that reject unknown theme event types. */
    environmentThemes: Schema.optional(Schema.Boolean),
    usageLimitSources: Schema.optional(Schema.Boolean),
    /** Advertise client handling before the server offers /usage-limits, or older clients send it as a prompt. */
    usageLimitsCommand: Schema.optional(Schema.Boolean),
    /** Omit per-cwd provider snapshots; the client fetches its cwd through `server.refreshProviders`. */
    workspaceSnapshotsOnDemand: Schema.optional(Schema.Boolean),
  }),
  success: ServerConfigStreamEvent,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsScheduledTasksSubscribeRpc = Rpc.make(WS_METHODS.scheduledTasksSubscribe, {
  payload: ScheduledTaskListInput,
  success: ScheduledTaskListResult,
  error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsScheduledTasksUpsertRpc = Rpc.make(WS_METHODS.scheduledTasksUpsert, {
  payload: ScheduledTaskUpsertInput,
  success: ScheduledTaskMutationResult,
  error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
});

const WsScheduledTasksSetEnabledRpc = Rpc.make(WS_METHODS.scheduledTasksSetEnabled, {
  payload: ScheduledTaskSetEnabledInput,
  success: ScheduledTaskMutationResult,
  error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
});

const WsScheduledTasksDeleteRpc = Rpc.make(WS_METHODS.scheduledTasksDelete, {
  payload: ScheduledTaskDeleteInput,
  success: ScheduledTaskDeleteResult,
  error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
});

const WsScheduledTasksRunNowRpc = Rpc.make(WS_METHODS.scheduledTasksRunNow, {
  payload: ScheduledTaskRunNowInput,
  success: ScheduledTaskRunNowResult,
  error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
});

const WsScheduledTasksRotateWebhookTokenRpc = Rpc.make(
  WS_METHODS.scheduledTasksRotateWebhookToken,
  {
    payload: ScheduledTaskRotateWebhookTokenInput,
    success: ScheduledTaskMutationResult,
    error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
  },
);

const WsGuestShareCreateRpc = Rpc.make(WS_METHODS.guestShareCreate, {
  payload: GuestShareCreateInput,
  success: GuestShareCreateResult,
  error: Schema.Union([GuestShareCreateError, EnvironmentAuthorizationError]),
});

const WsSecretsAnswerRequestRpc = Rpc.make(WS_METHODS.secretsAnswerRequest, {
  payload: SecretRequestAnswerInput,
  error: Schema.Union([SecretRequestError, EnvironmentAuthorizationError]),
});

const WsScheduledTasksListWebhookDeliveriesRpc = Rpc.make(
  WS_METHODS.scheduledTasksListWebhookDeliveries,
  {
    payload: ScheduledTaskListWebhookDeliveriesInput,
    success: ScheduledTaskListWebhookDeliveriesResult,
    error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
  },
);

const WsScheduledTasksGetWebhookDeliveryRpc = Rpc.make(
  WS_METHODS.scheduledTasksGetWebhookDelivery,
  {
    payload: ScheduledTaskGetWebhookDeliveryInput,
    success: ScheduledTaskGetWebhookDeliveryResult,
    error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
  },
);

const WsSubscribeAuthAccessRpc = Rpc.make(WS_METHODS.subscribeAuthAccess, {
  payload: Schema.Struct({}),
  success: AuthAccessStreamEvent,
  error: Schema.Union([AuthAccessStreamError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsSubscribeResourceTelemetryRpc = Rpc.make(WS_METHODS.subscribeResourceTelemetry, {
  payload: Schema.Struct({}),
  success: ResourceTelemetrySnapshot,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export class RpcScopeAuthorization extends RpcMiddleware.Service<RpcScopeAuthorization>()(
  "t3/contracts/RpcScopeAuthorization",
  // Held work is reported as a maintenance error: the token is fine, the device is mid-update.
  { error: Schema.Union([EnvironmentAuthorizationError, ForkMaintenanceError]) },
) {}

const WsThreadExportRpc = Rpc.make(WS_METHODS.threadExport, {
  payload: ThreadExportInput,
  success: ThreadExportResult,
  error: Schema.Union([ForkMaintenanceError, ThreadExportError, EnvironmentAuthorizationError]),
});

export const WsRpcGroup = RpcGroup.make(
  WsThreadExportRpc,
  WsOrganizationsListRpc,
  WsOrganizationsCreateRpc,
  WsOrganizationsGetRpc,
  WsOrganizationsGetPublishedConfigRpc,
  WsOrganizationsMutateRpc,
  WsOrganizationsBindProjectRpc,
  WsOrganizationsDetachProjectRpc,
  WsOrganizationsPublishRpc,
  WsOrganizationsSetLifecycleRpc,
  WsOrganizationsListAuditRpc,
  WsOrganizationsReadProviderBudgetsRpc,
  WsOrganizationsGetProviderBudgetRpc,
  WsOrganizationsUpdateProviderBudgetRpc,
  WsOrganizationsRepositoryPreviewRpc,
  WsOrganizationsRepositoryLinkRpc,
  WsOrganizationsRepositoryLoadRpc,
  WsOrganizationsRepositorySyncRpc,
  WsOrganizationsRepositoryStatusRpc,
  WsOrganizationsRepositoryListRecordsRpc,
  WsOrganizationsRepositoryResolveConflictRpc,
  WsOrganizationsRegisterSourceRpc,
  WsOrganizationsRotateSourceSecretRpc,
  WsOrganizationsSetSourceEnabledRpc,
  WsOrganizationsListSourcesRpc,
  WsOrganizationsIngestManualRpc,
  WsOrganizationsRetryCorrelationRpc,
  WsOrganizationsListObservationsRpc,
  WsOrganizationsListCorrelationJobsRpc,
  WsOrganizationsListFindingsRpc,
  WsOrganizationsListIntakeAuditRpc,
  WsOrganizationsListWorkRpc,
  WsOrganizationsListWorkIntentsRpc,
  WsOrganizationsListWorkFailuresRpc,
  WsOrganizationsGetWorkRuntimeStatusRpc,
  WsOrganizationsActivateWorkIntentRpc,
  WsOrganizationsCancelWorkRpc,
  WsOrganizationsRequestWorkDrainRpc,
  WsOrganizationsGetWorkDrainStatusRpc,
  WsOrganizationsSubscribeWorkStatusRpc,
  WsOrganizationsRequestEmergencyStopRpc,
  WsOrganizationsGetEmergencyStopStatusRpc,
  WsOrganizationsCreateStandingWorkAuthorizationRpc,
  WsOrganizationsListStandingWorkAuthorizationsRpc,
  WsOrganizationsRevokeStandingWorkAuthorizationRpc,
  WsOrganizationsReviewWorkRpc,
  WsOrganizationsDecideWorkApprovalRpc,
  WsOrganizationsArchitectListRpc,
  WsOrganizationsArchitectSendRpc,
  WsOrganizationsArchitectApplyBatchRpc,
  WsOrganizationsMemoryListRpc,
  WsOrganizationsMemoryHistoryRpc,
  WsOrganizationsMemoryCreateRpc,
  WsOrganizationsMemoryCorrectRpc,
  WsOrganizationsMemorySupersedeRpc,
  WsOrganizationsMemoryArchiveRpc,
  WsOrganizationsProposalListRpc,
  WsOrganizationsProposalDecideRpc,
  WsOrganizationsObservationModeGetRpc,
  WsOrganizationsObservationModeSetRpc,
  WsOrganizationsDirectorListRpc,
  WsOrganizationsDirectorAskRpc,
  WsAgentDashboardGetSnapshotRpc,
  WsAgentDashboardDismissFeedCardRpc,
  WsAgentDashboardClearFeedRpc,
  WsAgentDashboardReviewSuggestionRpc,
  WsAgentDashboardRunInvestigationRpc,
  WsAgentDashboardRetryRunRpc,
  WsAgentDashboardCreateGithubIssueRpc,
  WsAgentDashboardListProjectPullRequestsRpc,
  WsAgentDashboardMergeProjectPullRequestRpc,
  WsAgentDashboardApplyFindingActionRpc,
  WsAgentDashboardLinkFindingThreadRpc,
  WsAgentDashboardUpdateRepositoryPolicyRpc,
  WsAgentDashboardCollectRpc,
  WsAgentDashboardAddResearchWatchItemRpc,
  WsGuestShareCreateRpc,
  WsServerProbeRpc,
  WsServerGetConfigRpc,
  WsServerRefreshProvidersRpc,
  WsServerUpdateProviderRpc,
  WsProviderConsumeResetCreditRpc,
  WsProviderAuthStartRpc,
  WsProviderAuthCompleteRpc,
  WsChatGptReconnectProfileRpc,
  WsChatGptImportProfileRpc,
  WsChatGptHandoffSubscribeRpc,
  WsCodexAuthCallbackSubscribeRpc,
  WsProviderAuthRespondRpc,
  WsProviderAuthCancelRpc,
  WsProviderAuthLogoutRpc,
  WsProviderAuthSubscribeRpc,
  WsProviderInstallStartRpc,
  WsProviderInstallCancelRpc,
  WsProviderInstallSubscribeRpc,
  WsProviderInstallRemoveRpc,
  WsServerUpdateServerRpc,
  WsServerUpdateServerWithProgressRpc,
  WsServerCommitDesktopUpdateRpc,
  WsServerGetMaintenanceStatusRpc,
  WsServerUpdateMaintenancePolicyRpc,
  WsServerRunMaintenanceActionRpc,
  WsServerRecoverMaintenanceRpc,
  WsServerUpsertKeybindingRpc,
  WsServerRemoveKeybindingRpc,
  WsServerRunStorageCleanupRpc,
  WsServerGetStorageCleanupReportRpc,
  WsServerGetDatabaseStorageRpc,
  WsServerUpdateSettingsRpc,
  WsPeerLinksListRpc,
  WsPeerLinksLinkRpc,
  WsPeerLinksUnlinkRpc,
  WsPeerLinksAnswerRequestRpc,
  WsServerDiscoverSourceControlRpc,
  WsServerSearchAcpRegistryRpc,
  WsServerPrepareAcpRegistryAgentRpc,
  WsServerUninstallAcpRegistryManagedBinaryRpc,
  WsServerAcceptAcpRegistryUrlAuthRpc,
  WsServerListAcpRegistrySessionsRpc,
  WsServerImportAcpRegistrySessionRpc,
  WsServerDeleteAcpRegistrySessionRpc,
  WsServerListAcpRegistryProvidersRpc,
  WsServerSetAcpRegistryProviderRpc,
  WsServerDisableAcpRegistryProviderRpc,
  WsServerLogoutAcpRegistryRpc,
  WsServerGetTraceDiagnosticsRpc,
  WsServerGetProcessDiagnosticsRpc,
  WsServerGetHostResourcesRpc,
  WsServerGetProcessResourceHistoryRpc,
  WsServerGetResourceTelemetryHistoryRpc,
  WsServerRetryResourceTelemetryRpc,
  WsServerCheckOtlpEndpointRpc,
  WsServerPrepareTriageRpc,
  WsServerGetUsageSummaryRpc,
  WsServerRefreshUsageRatesRpc,
  WsServerSignalProcessRpc,
  WsScheduledTasksSubscribeRpc,
  WsScheduledTasksUpsertRpc,
  WsScheduledTasksSetEnabledRpc,
  WsScheduledTasksDeleteRpc,
  WsScheduledTasksRunNowRpc,
  WsScheduledTasksRotateWebhookTokenRpc,
  WsSecretsAnswerRequestRpc,
  WsScheduledTasksListWebhookDeliveriesRpc,
  WsScheduledTasksGetWebhookDeliveryRpc,
  WsServerReportClientActivityRpc,
  WsCloudGetRelayClientStatusRpc,
  WsCloudInstallRelayClientRpc,
  WsPullRequestsListRpc,
  WsPullRequestsListStatsRpc,
  WsPullRequestsFilterOptionsRpc,
  WsPullRequestsSummaryRpc,
  WsPullRequestsRoutingRpc,
  WsPullRequestsRoutingIdentityRpc,
  WsPullRequestsStackRpc,
  WsPullRequestsLinkedThreadsRpc,
  WsPullRequestsDetailRpc,
  WsPullRequestsPreviewRpc,
  WsPullRequestsChecksRpc,
  WsPullRequestsActivityRpc,
  WsPullRequestsReviewGuideRpc,
  WsPullRequestsGenerateReviewGuideRpc,
  WsPullRequestsThreadCommentsRpc,
  WsPullRequestsDiffFileContentsRpc,
  WsPullRequestsFilesViewedRpc,
  WsPullRequestsChangeBreakdownRpc,
  WsPullRequestsSetFilesViewedRpc,
  WsPullRequestsRunActionRpc,
  WsPullRequestsUpdateRpc,
  WsPullRequestsCommentRpc,
  WsPullRequestsUpdateCommentRpc,
  WsPullRequestsSubmitReviewRpc,
  WsPullRequestsReplyToThreadRpc,
  WsPullRequestsSetThreadResolutionRpc,
  WsPullRequestsSetReactionRpc,
  WsPullRequestsInvalidateRpc,
  WsPullRequestsReportStateRpc,
  WsPullRequestsSubscribeRefreshesRpc,
  WsPullRequestsReviewerCandidatesRpc,
  WsPullRequestsRequestReviewersRpc,
  WsPullRequestsLabelCandidatesRpc,
  WsPullRequestsSetLabelsRpc,
  WsSourceControlLookupRepositoryRpc,
  WsSourceControlCloneRepositoryRpc,
  WsSourceControlPublishRepositoryRpc,
  WsProjectCloneStartRpc,
  WsProjectCloneCancelRpc,
  WsProjectCloneRetryRpc,
  WsSubscribeProjectClonesRpc,
  WsProjectsListEntriesRpc,
  WsProjectsListIgnoredFilesRpc,
  WsProjectsReadFileRpc,
  WsProjectsSearchContentsRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsEnsureScratchRpc,
  WsProjectsCreateNewRpc,
  WsProjectsWriteFileRpc,
  WsProjectsMutateRpc,
  WsShellOpenInEditorRpc,
  WsFilesystemBrowseRpc,
  WsCodexSessionsListRpc,
  WsCodexSessionsResumeRpc,
  WsFilesystemGetMetadataRpc,
  WsAgentSessionsScanRpc,
  WsAgentSessionsImportRpc,
  WsAssetsCreateUrlRpc,
  WsAssetsPersistChatAttachmentsRpc,
  WsAttachmentsCreateUploadUrlRpc,
  WsAttachmentsDeleteRpc,
  WsMcpAppsCallToolRpc,
  WsMcpAppsToolInfoRpc,
  WsMcpAppsReadResourceRpc,
  WsMcpAppsUpdateModelContextRpc,
  WsProviderUploadFeedbackRpc,
  WsSubscribeVcsStatusRpc,
  WsSubscribeWorktreeSetupRpc,
  WsWorktreeSetupCancelRpc,
  WsVcsPullRpc,
  WsVcsRefreshStatusRpc,
  WsVcsWorktreeStorageUsageRpc,
  WsGitRunStackedActionRpc,
  WsGitResolvePullRequestRpc,
  WsGitPreparePullRequestThreadRpc,
  WsVcsListRefsRpc,
  WsVcsCreateWorktreeRpc,
  WsVcsRemoveWorktreeRpc,
  WsVcsCreateRefRpc,
  WsVcsSwitchRefRpc,
  WsVcsInitRpc,
  WsReviewGetDiffPreviewRpc,
  WsReviewGetDiffFileContentsRpc,
  WsTerminalOpenRpc,
  WsTerminalAttachRpc,
  WsTerminalObserveRpc,
  WsTerminalWriteRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalCloseRpc,
  WsSubscribeTerminalMetadataRpc,
  WsPreviewOpenRpc,
  WsPreviewNavigateRpc,
  WsPreviewRefreshRpc,
  WsPreviewResizeRpc,
  WsPreviewAdjustRpc,
  WsPreviewCloseRpc,
  WsPreviewListRpc,
  WsPreviewClearProfileRpc,
  WsPreviewReportProfilesRpc,
  WsPreviewReportStatusRpc,
  WsPreviewAttachRpc,
  WsPreviewPublishFrameRpc,
  WsPreviewInputRpc,
  WsPreviewPickElementRpc,
  WsPreviewAutomationConnectRpc,
  WsPreviewAutomationRespondRpc,
  WsPreviewAutomationFocusHostRpc,
  WsSubscribePreviewEventsRpc,
  WsPreviewStopLocalServerRpc,
  WsSubscribeDiscoveredLocalServersRpc,
  WsDeviceConfigureRpc,
  WsDeviceListRpc,
  WsDeviceTestHostRpc,
  WsDeviceEasAccountRpc,
  WsDeviceOpenRpc,
  WsDeviceCloseRpc,
  WsDeviceShutdownRpc,
  WsDeviceDetailRpc,
  WsDeviceActionRpc,
  WsSubscribeDeviceStateRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeAuthAccessRpc,
  WsSubscribeResourceTelemetryRpc,
  WsOrchestrationV2DispatchCommandRpc,
  WsOrchestrationV2GetWorkflowScriptRpc,
  WsOrchestrationV2StopWorkflowRpc,
  WsOrchestrationV2GetTurnItemRpc,
  WsOrchestrationV2GetMessageReplyChainRpc,
  WsOrchestrationV2GetTurnDiffRpc,
  WsOrchestrationV2GetFullThreadDiffRpc,
  WsOrchestrationV2SearchThreadsRpc,
  WsOrchestrationV2SearchThreadRpc,
  WsOrchestrationV2SearchThreadStreamRpc,
  WsOrchestrationV2GetArchivedShellSnapshotRpc,
  WsOrchestrationV2GetThreadFamilyRpc,
  WsOrchestrationV2GetWorktreeThreadIdsRpc,
  WsOrchestrationV2GetOlderSettledThreadsRpc,
  WsOrchestrationV2GetThreadProjectionRpc,
  WsOrchestrationV2LaunchThreadRpc,
  WsOrchestrationV2SubscribeShellRpc,
  WsOrchestrationV2SubscribeThreadRpc,
  WsOrchestrationV2SubscribeCommandOutputRpc,
).middleware(RpcScopeAuthorization);

export const ForkWsRpcGroup = RpcGroup.make(
  WsOrganizationsListRpc,
  WsOrganizationsCreateRpc,
  WsOrganizationsGetRpc,
  WsOrganizationsGetPublishedConfigRpc,
  WsOrganizationsMutateRpc,
  WsOrganizationsBindProjectRpc,
  WsOrganizationsDetachProjectRpc,
  WsOrganizationsPublishRpc,
  WsOrganizationsSetLifecycleRpc,
  WsOrganizationsListAuditRpc,
  WsOrganizationsReadProviderBudgetsRpc,
  WsOrganizationsGetProviderBudgetRpc,
  WsOrganizationsUpdateProviderBudgetRpc,
  WsOrganizationsRepositoryPreviewRpc,
  WsOrganizationsRepositoryLinkRpc,
  WsOrganizationsRepositoryLoadRpc,
  WsOrganizationsRepositorySyncRpc,
  WsOrganizationsRepositoryStatusRpc,
  WsOrganizationsRepositoryListRecordsRpc,
  WsOrganizationsRepositoryResolveConflictRpc,
  WsOrganizationsRegisterSourceRpc,
  WsOrganizationsRotateSourceSecretRpc,
  WsOrganizationsSetSourceEnabledRpc,
  WsOrganizationsListSourcesRpc,
  WsOrganizationsIngestManualRpc,
  WsOrganizationsRetryCorrelationRpc,
  WsOrganizationsListObservationsRpc,
  WsOrganizationsListCorrelationJobsRpc,
  WsOrganizationsListFindingsRpc,
  WsOrganizationsListIntakeAuditRpc,
  WsOrganizationsListWorkRpc,
  WsOrganizationsListWorkIntentsRpc,
  WsOrganizationsListWorkFailuresRpc,
  WsOrganizationsGetWorkRuntimeStatusRpc,
  WsOrganizationsActivateWorkIntentRpc,
  WsOrganizationsCancelWorkRpc,
  WsOrganizationsRequestWorkDrainRpc,
  WsOrganizationsGetWorkDrainStatusRpc,
  WsOrganizationsSubscribeWorkStatusRpc,
  WsOrganizationsRequestEmergencyStopRpc,
  WsOrganizationsGetEmergencyStopStatusRpc,
  WsOrganizationsCreateStandingWorkAuthorizationRpc,
  WsOrganizationsListStandingWorkAuthorizationsRpc,
  WsOrganizationsRevokeStandingWorkAuthorizationRpc,
  WsOrganizationsReviewWorkRpc,
  WsOrganizationsDecideWorkApprovalRpc,
  WsOrganizationsArchitectListRpc,
  WsOrganizationsArchitectSendRpc,
  WsOrganizationsArchitectApplyBatchRpc,
  WsOrganizationsMemoryListRpc,
  WsOrganizationsMemoryHistoryRpc,
  WsOrganizationsMemoryCreateRpc,
  WsOrganizationsMemoryCorrectRpc,
  WsOrganizationsMemorySupersedeRpc,
  WsOrganizationsMemoryArchiveRpc,
  WsOrganizationsProposalListRpc,
  WsOrganizationsProposalDecideRpc,
  WsOrganizationsObservationModeGetRpc,
  WsOrganizationsObservationModeSetRpc,
  WsOrganizationsDirectorListRpc,
  WsOrganizationsDirectorAskRpc,
  WsAgentDashboardGetSnapshotRpc,
  WsAgentDashboardDismissFeedCardRpc,
  WsAgentDashboardClearFeedRpc,
  WsAgentDashboardReviewSuggestionRpc,
  WsAgentDashboardRunInvestigationRpc,
  WsAgentDashboardRetryRunRpc,
  WsAgentDashboardCreateGithubIssueRpc,
  WsAgentDashboardListProjectPullRequestsRpc,
  WsAgentDashboardMergeProjectPullRequestRpc,
  WsAgentDashboardApplyFindingActionRpc,
  WsAgentDashboardLinkFindingThreadRpc,
  WsAgentDashboardUpdateRepositoryPolicyRpc,
  WsAgentDashboardCollectRpc,
  WsAgentDashboardAddResearchWatchItemRpc,
).middleware(RpcScopeAuthorization);

export const ForkExtraWsRpcGroup = RpcGroup.make(
  WsThreadExportRpc,
  WsCodexSessionsListRpc,
  WsCodexSessionsResumeRpc,
  WsPreviewAttachRpc,
  WsPreviewPublishFrameRpc,
  WsPreviewInputRpc,
  WsPreviewPickElementRpc,
).middleware(RpcScopeAuthorization);
