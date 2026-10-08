import {
  LOCAL_TEAM_METHODS,
  LOCAL_TEAM_MEMBERS_METHOD,
  LOCAL_TEAM_ACCEPT_METHOD,
} from "./teamProjects.ts";
import { LOCAL_TEAM_FILES_METHOD } from "./teamFiles.ts";
import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput } from "./git.ts";
import { ForkMaintenanceActionInput } from "./maintenance.ts";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { WS_METHODS } from "./rpc.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [LOCAL_TEAM_METHODS.control]: AuthAccessWriteScope,
  [LOCAL_TEAM_FILES_METHOD]: AuthAccessWriteScope,
  [LOCAL_TEAM_MEMBERS_METHOD]: AuthAccessWriteScope,
  [LOCAL_TEAM_ACCEPT_METHOD]: AuthAccessWriteScope,
  [LOCAL_TEAM_METHODS.discuss]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverUpdateMaintenancePolicy]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverRunMaintenanceAction]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverRecoverMaintenance]: AuthAccessWriteScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);
const decodeMaintenanceAction = Schema.decodeUnknownSync(ForkMaintenanceActionInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (
    method === LOCAL_TEAM_METHODS.control &&
    typeof input === "object" &&
    input !== null &&
    "action" in input &&
    (input.action === "intent" || input.action === "publish" || input.action === "stop-publication")
  )
    return [AuthOrchestrationOperateScope];
  if (method === WS_METHODS.serverRunMaintenanceAction && input !== undefined) {
    const { action } = decodeMaintenanceAction(input);
    if (action === "confirm-bootstrap" || action === "acknowledge-automation-review")
      return [AuthOrchestrationOperateScope, AuthAccessWriteScope];
  }
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
