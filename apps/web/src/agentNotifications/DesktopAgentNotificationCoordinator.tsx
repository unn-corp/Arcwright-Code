import type { AgentNotificationEvent, AgentNotificationKind } from "@t3tools/contracts";
import { projectThreadAwarenessV2, type AgentAwarenessPhase } from "@t3tools/shared/agentAwareness";
import { useEffect, useRef } from "react";

import { useProjects, useThreadShells } from "../state/entities";
import { getClientSettings } from "../hooks/useSettings";
import type { AppRouter } from "../router";
import { buildThreadRouteParams, resolveAgentNotificationThreadRef } from "../threadRoutes";
import { playAgentNotificationSound } from "./sound";

type ThreadSnapshot = {
  readonly phase: AgentAwarenessPhase | null;
  readonly hasActionableProposedPlan: boolean;
  readonly updatedAt: string;
};

function eventKindForTransition(
  previous: ThreadSnapshot,
  next: ThreadSnapshot,
): AgentNotificationKind | null {
  if (!previous.hasActionableProposedPlan && next.hasActionableProposedPlan) {
    return "plan_ready";
  }
  if (
    (next.phase === "waiting_for_approval" || next.phase === "waiting_for_input") &&
    next.phase !== previous.phase
  ) {
    return "input_required";
  }
  if (next.phase === "failed" && next.phase !== previous.phase) {
    return "agent_failed";
  }
  if (next.phase === "completed" && next.phase !== previous.phase) {
    return "agent_completed";
  }
  return null;
}

/* Notify only on live desktop transitions. Prime the first snapshot without replaying historical work after a renderer restart; remote delivery belongs to the server outbox. */
export function DesktopAgentNotificationCoordinator({ router }: { readonly router: AppRouter }) {
  const projects = useProjects();
  const threads = useThreadShells();
  const snapshots = useRef(new Map<string, ThreadSnapshot>());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes the desktop notification bridge to router navigation for the app lifetime
  useEffect(() => {
    const subscribe = window.desktopBridge?.onAgentNotificationNavigate;
    if (typeof subscribe !== "function") return;
    return subscribe((deepLink) => {
      const threadRef = resolveAgentNotificationThreadRef(deepLink);
      if (threadRef) {
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        });
      }
    });
  }, [router]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- emits native desktop notifications for live thread transitions while priming the initial snapshot without replay
  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.showAgentNotification !== "function") {
      return;
    }

    const projectsByKey = new Map(
      projects.map((project) => [`${project.environmentId}:${project.id}`, project]),
    );
    const nextSnapshots = new Map<string, ThreadSnapshot>();

    for (const thread of threads) {
      const project = projectsByKey.get(`${thread.environmentId}:${thread.projectId}`);
      if (!project) continue;

      const awareness = projectThreadAwarenessV2({
        environmentId: thread.environmentId,
        project,
        thread: thread.source,
      });
      const key = `${thread.environmentId}:${thread.id}`;
      const next = {
        phase: awareness?.phase ?? null,
        hasActionableProposedPlan: thread.hasActionableProposedPlan,
        updatedAt: thread.updatedAt,
      } satisfies ThreadSnapshot;
      nextSnapshots.set(key, next);

      const previous = snapshots.current.get(key);
      if (!previous || !awareness) continue;
      const kind = eventKindForTransition(previous, next);
      if (!kind) continue;

      const event: AgentNotificationEvent = {
        eventId:
          `desktop:${thread.environmentId}:${thread.id}:${kind}:${next.updatedAt}` as AgentNotificationEvent["eventId"],
        environmentId: thread.environmentId,
        threadId: thread.id,
        kind,
        occurredAt: next.updatedAt,
        deepLink: awareness.deepLink as AgentNotificationEvent["deepLink"],
        projectTitle: awareness.projectTitle,
        threadTitle: awareness.threadTitle,
        ...(kind === "input_required"
          ? { inputKind: awareness.phase === "waiting_for_approval" ? "approval" : "input" }
          : {}),
        ...(kind === "plan_ready" ? { planUpdatedAt: next.updatedAt } : {}),
      };
      void bridge
        .showAgentNotification(event)
        .then((outcome) => {
          const preferences = getClientSettings().agentNotifications;
          if (outcome === "attempted" && preferences.playSound) {
            playAgentNotificationSound(kind, preferences.sounds);
          }
        })
        .catch(() => {});
    }

    snapshots.current = nextSnapshots;
  }, [projects, threads]);

  return null;
}
