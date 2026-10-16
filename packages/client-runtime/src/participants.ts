import { resolveUserMessagePresentation } from "./userMessage.ts";
import type {
  ClientSettings,
  ConnectedProfileAccount,
  HumanParticipant,
  ParticipantProfile,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { providerInstanceInitials } from "./state/providerInstanceDisplay.ts";

export type Participant =
  | ({ kind: "human" } & HumanParticipant)
  | {
      kind: "agent";
      id: string;
      name: string;
      model?: string | undefined;
      driver?: ProviderDriverKind | undefined;
      iconUrl?: string | undefined;
    }
  | { kind: "system"; id: string; name: string };

export const participantInitials = providerInstanceInitials;
export function agentInstanceId(thread: string, provider: string): string {
  return `agent:${thread}:${provider}`;
}
/** Model and run are deliberately absent: retries and handoffs must not repaint an agent. */
export function participantColor(id: string, override?: string): string {
  if (override && /^#[a-fA-F0-9]{6}$/.test(override)) return override;
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  // More hues than a short cycling palette, with controlled saturation/lightness.
  const hue = (hash >>> 0) % 360;
  const saturation = (52 + ((hash >>> 9) % 16)) / 100;
  const lightness = (56 + ((hash >>> 17) % 10)) / 100;
  const amplitude = saturation * Math.min(lightness, 1 - lightness);
  const channel = (offset: number) => {
    const k = (offset + hue / 30) % 12;
    const value = lightness - amplitude * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * value)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}
export function currentHuman(
  settings: Pick<ClientSettings, "participantProfiles" | "activeParticipantProfile">,
): HumanParticipant {
  return (
    settings.participantProfiles[settings.activeParticipantProfile]?.participant ?? {
      id: settings.activeParticipantProfile,
      name: "You",
      photo: null,
    }
  );
}
/** Display known authors from their live profile; never relabel a different recorded user. */
export function resolveHumanParticipant(
  author: HumanParticipant | undefined,
  settings: Pick<ClientSettings, "participantProfiles" | "activeParticipantProfile">,
): HumanParticipant {
  if (!author || author.id === "legacy-user" || author.id === "local")
    return currentHuman(settings);
  const profile = Object.values(settings.participantProfiles).find(
    (candidate) => candidate.participant.id === author.id,
  );
  // Before the first personal sign-in, bootstrap sends an uncustomized local identity.
  if (profile && !profile.initialized && author.id.startsWith("local:"))
    return currentHuman(settings);
  return profile?.participant ?? author;
}

export function seedProfile(
  existing: ParticipantProfile | undefined,
  participant: HumanParticipant,
  accounts: ReadonlyArray<ConnectedProfileAccount>,
): ParticipantProfile {
  return {
    participant: existing?.initialized ? existing.participant : participant,
    initialized: true,
    accounts,
  };
}

/** Refresh account photos without overwriting a chosen name or a legacy local photo. */
export function syncAccountProfile(
  existing: ParticipantProfile | undefined,
  participant: HumanParticipant,
  accounts: ReadonlyArray<ConnectedProfileAccount>,
): ParticipantProfile {
  const photoSource =
    existing?.photoSource ??
    (existing?.initialized && existing.participant.photo?.startsWith("data:")
      ? "custom"
      : "account");
  const next: ParticipantProfile = {
    participant: existing?.initialized
      ? {
          ...existing.participant,
          photo: photoSource === "account" ? participant.photo : existing.participant.photo,
        }
      : participant,
    initialized: true,
    accounts,
    photoSource,
  };
  return existing && JSON.stringify(existing) === JSON.stringify(next) ? existing : next;
}
export function authorContext(
  context: import("@t3tools/contracts").OrchestrationMessageContext | undefined,
  author: HumanParticipant,
): import("@t3tools/contracts").OrchestrationMessageContext {
  return { ...(context ?? { version: 1, records: [] }), author };
}

/** Old messages use their recorded run, never the composer's currently selected model. */
export function resolveMessageParticipant(
  message: {
    readonly id: string;
    readonly role: "user" | "assistant" | "system";
    readonly text: string;
    readonly runId: string | null;
    readonly senderThreadId?: string | undefined;
    readonly context?: import("@t3tools/contracts").OrchestrationMessageContext | undefined;
    readonly createdBy?: import("@t3tools/contracts").OrchestrationV2Actor | undefined;
    readonly creationSource?:
      | import("@t3tools/contracts").OrchestrationV2CreationSource
      | undefined;
    readonly scheduledTaskId?: import("@t3tools/contracts").ScheduledTaskId | undefined;
  },
  thread: string,
  runs: ReadonlyArray<import("./handoff.ts").HandoffTimelineRun>,
  providers: ReadonlyArray<import("@t3tools/contracts").ServerProvider>,
  profiles?: Pick<ClientSettings, "participantProfiles" | "activeParticipantProfile">,
): Participant {
  const attribution = resolveUserMessagePresentation({
    id: message.id,
    role: message.role,
    text: message.text,
    ...(message.createdBy ? { createdBy: message.createdBy } : {}),
    ...(message.creationSource ? { creationSource: message.creationSource } : {}),
    ...(message.scheduledTaskId ? { scheduledTaskId: message.scheduledTaskId } : {}),
  }).attribution;
  if (message.role === "assistant" || message.senderThreadId || attribution === "agent") {
    const run = runs.find((candidate) => candidate.id === message.runId);
    const recordedAgent = message.context?.agent;
    const providerId = recordedAgent?.providerInstanceId ?? run?.providerInstanceId;
    const provider = providers.find((candidate) => candidate.instanceId === providerId);
    return {
      kind: "agent",
      id: agentInstanceId(
        message.senderThreadId ?? thread,
        message.senderThreadId ? "unknown" : (providerId ?? "unknown"),
      ),
      name: message.senderThreadId ? "Agent" : (provider?.displayName ?? "Agent"),
      model: message.senderThreadId
        ? undefined
        : (recordedAgent?.model ?? run?.modelSelection.model),
      driver: message.senderThreadId ? undefined : provider?.driver,
      iconUrl: provider?.iconUrl,
    };
  }
  if (message.role === "system" || attribution === "automation" || attribution === "t3code") {
    return {
      kind: "system",
      id: "system",
      name: attribution === "automation" ? "Automation" : "Arcwright Code",
    };
  }
  return {
    kind: "human",
    ...(profiles
      ? resolveHumanParticipant(message.context?.author, profiles)
      : (message.context?.author ?? { id: "legacy-user", name: "You", photo: null })),
  };
}
