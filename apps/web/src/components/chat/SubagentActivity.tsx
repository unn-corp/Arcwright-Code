import { ThreadId, type OrchestrationV2Subagent, type ServerProvider } from "@t3tools/contracts";
import { agentInstanceId, type Participant } from "@t3tools/client-runtime/participants";
import {
  isActiveSubagentStatus,
  isTerminalSubagentStatus,
  projectedSubagentsToRuntime,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { ParticipantChip } from "./ParticipantChip";
import { Button } from "../ui/button";
import { isAndroidPwa } from "../../env";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

export interface SubagentActivityMember {
  readonly id: string;
  readonly participant: Participant;
  readonly childThreadId: ThreadId | null;
  readonly status: OrchestrationV2Subagent["status"];
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

/** All retained runs matter: a child can outlive the turn which launched it. */
export function subagentActivityMembers(
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<SubagentActivityMember> {
  const byId = new Map(subagents.map((agent) => [agent.id.toString(), agent]));
  const seenThreads = new Set<string>();
  return projectedSubagentsToRuntime(subagents).flatMap((agent) => {
    const source = byId.get(agent.parentAgentId ?? agent.id);
    if (!source || (agent.childThreadId && seenThreads.has(agent.childThreadId))) return [];
    if (agent.childThreadId) seenThreads.add(agent.childThreadId);
    const provider = providers.find(
      (provider) => provider.instanceId === source.providerInstanceId,
    );
    return [
      {
        id: agent.id,
        participant: {
          kind: "agent",
          id: agentInstanceId(
            agent.childThreadId ?? `${source.threadId}:${agent.id}`,
            source.providerInstanceId,
          ),
          name: agent.title || "Agent",
          model:
            (agent.kind === "workflow_agent"
              ? agent.model
              : (source.modelSelection?.model ?? agent.model)) ?? undefined,
          driver: source.driver,
          iconUrl: provider?.iconUrl,
        },
        childThreadId: agent.childThreadId === null ? null : ThreadId.make(agent.childThreadId),
        status: agent.status,
        startedAt: agent.startedAt,
        completedAt: isTerminalSubagentStatus(agent.status)
          ? (agent.completedAt ?? agent.updatedAt)
          : null,
      } satisfies SubagentActivityMember,
    ];
  });
}

export function withSubagentMilestones(
  rows: MessagesTimelineRow[],
  members: ReadonlyArray<SubagentActivityMember>,
): MessagesTimelineRow[] {
  if (members.length === 0) return rows;
  const starts = new Set(
    rows.flatMap((row) =>
      row.kind === "event"
        ? (row.subagents ?? [row.projectedItem]).flatMap(({ item }) =>
            item.type === "subagent" ? [item.subagentId.toString()] : [],
          )
        : [],
    ),
  );
  const markers: MessagesTimelineRow[] = [];
  for (const agent of members) {
    if (agent.startedAt && !starts.has(agent.id))
      markers.push({
        kind: "subagent-milestone",
        id: `subagent-start:${agent.id}:${agent.startedAt}`,
        createdAt: agent.startedAt,
        phase: "started",
        agent,
      });
    if (agent.completedAt && isTerminalSubagentStatus(agent.status))
      markers.push({
        kind: "subagent-milestone",
        id: `subagent-finish:${agent.id}:${agent.completedAt}`,
        createdAt: agent.completedAt,
        phase: "finished",
        agent,
      });
  }
  if (markers.length === 0) return rows;
  const result = [...rows];
  // Insert into the existing order, leaving work disclosure rows and the live footer together.
  markers.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  for (const marker of markers) {
    const index = result.findIndex(
      (row) => row.createdAt !== null && row.createdAt > marker.createdAt!,
    );
    result.splice(index === -1 ? result.length : index, 0, marker);
  }
  return result;
}

export function ActiveSubagentChips({
  members,
  onOpenThread,
}: {
  members: ReadonlyArray<SubagentActivityMember>;
  onOpenThread: (id: ThreadId) => void;
}) {
  const active = members.filter((agent) => isActiveSubagentStatus(agent.status));
  if (isAndroidPwa || active.length === 0) return null;
  return (
    <div
      className="relative z-10 hidden flex-wrap items-center gap-2 px-3 py-2 sm:flex"
      aria-label="Active subagents"
      role="group"
      data-active-subagents
    >
      {active.map((agent) => {
        const contents = (
          <>
            <ParticipantChip participant={agent.participant} variant="compact" />
            <span className="shrink-0 text-xs text-muted-foreground">
              {agent.status === "pending"
                ? "Starting"
                : agent.status === "waiting"
                  ? "Waiting"
                  : "Working"}
            </span>
          </>
        );
        return agent.childThreadId ? (
          <Button
            key={agent.id}
            variant="ghost-muted"
            size="compact"
            style={{ maxWidth: "100%", minWidth: 0 }}
            onClick={() => onOpenThread(agent.childThreadId!)}
            aria-label={`Open subagent ${agent.participant.name}`}
          >
            {contents}
          </Button>
        ) : (
          <span key={agent.id} className="inline-flex min-w-0 max-w-full items-center gap-2">
            {contents}
          </span>
        );
      })}
    </div>
  );
}

export function SubagentMilestone({
  row,
  onOpenThread,
}: {
  row: Extract<MessagesTimelineRow, { kind: "subagent-milestone" }>;
  onOpenThread: (id: ThreadId) => void;
}) {
  const contents = (
    <>
      <ParticipantChip participant={row.agent.participant} variant="compact" />
      <span>
        {row.phase === "started"
          ? "Started"
          : row.agent.status === "completed"
            ? "Finished"
            : row.agent.status === "failed"
              ? "Failed"
              : row.agent.status === "cancelled"
                ? "Cancelled"
                : "Interrupted"}
      </span>
    </>
  );
  return (
    <div
      className="flex min-w-0 items-center gap-2 py-1 text-xs text-muted-foreground"
      data-subagent-milestone={row.phase}
    >
      {row.agent.childThreadId ? (
        <Button
          variant="ghost-muted"
          size="compact"
          onClick={() => onOpenThread(row.agent.childThreadId!)}
        >
          {contents}
        </Button>
      ) : (
        contents
      )}
      <time dateTime={row.createdAt}>
        {new Date(row.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
      </time>
    </div>
  );
}
