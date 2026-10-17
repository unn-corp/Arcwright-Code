/** Fork-owned migrations; deployed IDs remain immutable. */
import Migration0036 from "./Migrations/036_DiscordBridge.ts";
import Migration0037 from "./Migrations/037_BackfillProjectionThreadsLatestTurn.ts";
import Migration0039 from "./Migrations/039_CanonicalizeLegacyReviewRuntimeMode.ts";
import Migration0047 from "./Migrations/047_ProjectionProjectGitHubAccount.ts";
import Migration0058 from "./Migrations/058_ProjectionThreadActivitiesKindIndex.ts";
import Migration0059 from "./Migrations/059_Organizations.ts";
import Migration0060 from "./Migrations/060_OrganizationWorkflows.ts";
import Migration0061 from "./Migrations/061_OrganizationIntake.ts";
import Migration0062 from "./Migrations/062_OrganizationWork.ts";
import Migration0063 from "./Migrations/063_OrganizationFindingEvidence.ts";
import Migration0064 from "./Migrations/064_OrganizationArchitectTranscript.ts";
import Migration0065 from "./Migrations/065_OrganizationArchitectTranscriptCompatibility.ts";
import Migration0066 from "./Migrations/066_OrganizationMemory.ts";
import Migration0067 from "./Migrations/067_OrganizationCorrelationRecovery.ts";
import Migration0068 from "./Migrations/068_OrganizationProposals.ts";
import Migration0069 from "./Migrations/069_OrganizationDirectorTranscript.ts";
import Migration0070 from "./Migrations/070_OrganizationResourcePermits.ts";
import Migration0071 from "./Migrations/071_OrganizationWorkScopes.ts";
import Migration0072 from "./Migrations/072_OrganizationWorkArtifacts.ts";
import Migration0073 from "./Migrations/073_OrganizationWorkQAReceipts.ts";
import Migration0074 from "./Migrations/074_OrganizationWorkApprovalReceipts.ts";
import Migration0075 from "./Migrations/075_OrganizationWorkIntegrationReceipts.ts";
import Migration0076 from "./Migrations/076_OrganizationGitCandidateIntents.ts";
import Migration0077 from "./Migrations/077_OrganizationScopePreparation.ts";
import Migration0078 from "./Migrations/078_OrganizationReservedScopeUnits.ts";
import Migration0079 from "./Migrations/079_OrganizationGitIntegrationIntents.ts";
import Migration0080 from "./Migrations/080_OrganizationScopeReservationCompatibility.ts";
import Migration0081 from "./Migrations/081_OrganizationProviderBudgets.ts";
import Migration0082 from "./Migrations/082_OrganizationWorkIntents.ts";
import Migration0083 from "./Migrations/083_OrganizationProviderBudgetAudit.ts";
import Migration0084 from "./Migrations/084_OrganizationScopeLaunchRequested.ts";
import Migration0085 from "./Migrations/085_OrganizationRepositories.ts";
import Migration0086 from "./Migrations/086_OrganizationScopeRecoveryReceipts.ts";
import Migration0087 from "./Migrations/087_OrganizationWorkIntentActivations.ts";
import Migration0088 from "./Migrations/088_OrganizationLiveWorkFailures.ts";
import Migration0089 from "./Migrations/089_OrganizationLiveWorkDrains.ts";
import Migration0090 from "./Migrations/090_OrganizationEmergencyStops.ts";
import Migration0091 from "./Migrations/091_OrganizationStandingWorkAuthorizations.ts";
import Migration0092 from "./Migrations/092_OrganizationEmergencyProcessRecovery.ts";
import Migration0093 from "./Migrations/093_OrganizationProviderLaunchMarkers.ts";
import Migration0099 from "./Migrations/099_MessageReplyIndex.ts";
import Migration0100 from "./Migrations/100_ProviderThreadRecoveryIndex.ts";
import Migration0101 from "./Migrations/101_LosslessStorage.ts";
import Migration0102 from "./Migrations/102_AutomaticStorageMigration.ts";
import Migration0103 from "./Migrations/103_StartupSchemaFingerprint.ts";
import Migration0107 from "./Migrations/107_CompactHistoryBlocks.ts";
import Migration0109 from "./Migrations/109_ThreadSearchIndex.ts";

export const forkMigrationEntries = [
  [36, "DiscordBridge", Migration0036],
  [37, "BackfillProjectionThreadsLatestTurn", Migration0037],
  [39, "CanonicalizeLegacyReviewRuntimeMode", Migration0039],
  [47, "ProjectionProjectGitHubAccount", Migration0047],
  [58, "ProjectionThreadActivitiesKindIndex", Migration0058],
  [59, "Organizations", Migration0059],
  [60, "OrganizationWorkflows", Migration0060],
  [61, "OrganizationIntake", Migration0061],
  [62, "OrganizationWork", Migration0062],
  [63, "OrganizationFindingEvidence", Migration0063],
  [64, "OrganizationArchitectTranscript", Migration0064],
  [65, "OrganizationArchitectTranscriptCompatibility", Migration0065],
  [66, "OrganizationMemory", Migration0066],
  [67, "OrganizationCorrelationRecovery", Migration0067],
  [68, "OrganizationProposals", Migration0068],
  [69, "OrganizationDirectorTranscript", Migration0069],
  [70, "OrganizationResourcePermits", Migration0070],
  [71, "OrganizationWorkScopes", Migration0071],
  [72, "OrganizationWorkArtifacts", Migration0072],
  [73, "OrganizationWorkQAReceipts", Migration0073],
  [74, "OrganizationWorkApprovalReceipts", Migration0074],
  [75, "OrganizationWorkIntegrationReceipts", Migration0075],
  [76, "OrganizationGitCandidateIntents", Migration0076],
  [77, "OrganizationScopePreparation", Migration0077],
  [78, "OrganizationReservedScopeUnits", Migration0078],
  [79, "OrganizationGitIntegrationIntents", Migration0079],
  [80, "OrganizationScopeReservationCompatibility", Migration0080],
  [81, "OrganizationProviderBudgets", Migration0081],
  [82, "OrganizationWorkIntents", Migration0082],
  [83, "OrganizationProviderBudgetAudit", Migration0083],
  [84, "OrganizationScopeLaunchRequested", Migration0084],
  [85, "OrganizationRepositories", Migration0085],
  [86, "OrganizationScopeRecoveryReceipts", Migration0086],
  [87, "OrganizationWorkIntentActivations", Migration0087],
  [88, "OrganizationLiveWorkFailures", Migration0088],
  [89, "OrganizationLiveWorkDrains", Migration0089],
  [90, "OrganizationEmergencyStops", Migration0090],
  [91, "OrganizationStandingWorkAuthorizations", Migration0091],
  [92, "OrganizationEmergencyProcessRecovery", Migration0092],
  [93, "OrganizationProviderLaunchMarkers", Migration0093],
  [99, "MessageReplyIndex", Migration0099],
  [100, "ProviderThreadRecoveryIndex", Migration0100],
  [101, "LosslessStorage", Migration0101],
  [102, "AutomaticStorageMigration", Migration0102],
  [103, "StartupSchemaFingerprint", Migration0103],
  [107, "CompactHistoryBlocks", Migration0107],
  [109, "ThreadSearchIndex", Migration0109],
] as const;
