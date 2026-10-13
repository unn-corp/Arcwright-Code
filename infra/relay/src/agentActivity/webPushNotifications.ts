import type { RelayAgentActivityState, RelayWebPushPreferences } from "@t3tools/contracts/relay";
import type { WebPushNotificationKind, WebPushStateVersion } from "./webPushDeliveryJobs.ts";

export function wantsNotification(
  preferences: RelayWebPushPreferences,
  kind: WebPushNotificationKind,
): boolean {
  if (!preferences.enabled) return false;
  switch (kind) {
    case "plan_ready":
      return preferences.notifyOnPlanReady;
    case "input_required":
      return preferences.notifyOnInput;
    case "agent_completed":
      return preferences.notifyOnCompletion;
    case "agent_failed":
      return preferences.notifyOnFailure;
    default:
      return false;
  }
}

export function notificationKind(
  previous: { readonly phase: string; readonly hasActionableProposedPlan: boolean },
  next: RelayAgentActivityState,
): WebPushNotificationKind | null {
  if (!previous.hasActionableProposedPlan && next.hasActionableProposedPlan) return "plan_ready";
  if (
    (next.phase === "waiting_for_approval" || next.phase === "waiting_for_input") &&
    previous.phase !== next.phase
  ) {
    return "input_required";
  }
  if (next.phase === "completed" && previous.phase !== "completed") return "agent_completed";
  if (next.phase === "failed" && previous.phase !== "failed") return "agent_failed";
  return null;
}

export function notificationCopy(input: {
  readonly state: RelayAgentActivityState;
  readonly kind: WebPushNotificationKind;
  readonly names: boolean;
}) {
  if (!input.names) {
    return { title: "Arcwright Code", body: "Agent activity needs your attention." };
  }
  switch (input.kind) {
    case "plan_ready":
      return { title: input.state.threadTitle, body: `Plan ready · ${input.state.projectTitle}` };
    case "input_required":
      return {
        title: input.state.threadTitle,
        body: `${input.state.headline} · ${input.state.projectTitle}`,
      };
    case "agent_completed":
      return {
        title: input.state.threadTitle,
        body: `Agent completed · ${input.state.projectTitle}`,
      };
    default:
      return { title: input.state.threadTitle, body: `Agent failed · ${input.state.projectTitle}` };
  }
}

export function stateVersion(
  state: Pick<RelayAgentActivityState, "updatedAt" | "phase" | "hasActionableProposedPlan">,
): typeof WebPushStateVersion.Type {
  return {
    updatedAt: state.updatedAt,
    phase: state.phase,
    hasActionableProposedPlan: state.hasActionableProposedPlan ?? false,
  };
}

export function kindFitsState(
  kind: WebPushNotificationKind,
  state: Pick<typeof WebPushStateVersion.Type, "phase" | "hasActionableProposedPlan">,
): boolean {
  switch (kind) {
    case "plan_ready":
      return state.hasActionableProposedPlan;
    case "input_required":
      return state.phase === "waiting_for_input" || state.phase === "waiting_for_approval";
    case "agent_completed":
      return state.phase === "completed";
    case "agent_failed":
      return state.phase === "failed";
  }
}
