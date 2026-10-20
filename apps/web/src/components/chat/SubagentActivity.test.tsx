import { act } from "react";
import { createRoot } from "react-dom/client";
import * as DateTime from "effect/DateTime";
import {
  NodeId,
  ThreadId,
  ProviderInstanceId,
  ProviderDriverKind,
  RunId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
const viewport = vi.hoisted(() => ({ android: false }));
vi.mock("../../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../env")>()),
  get isAndroidPwa() {
    return viewport.android;
  },
}));
afterEach(() => {
  viewport.android = false;
});
import {
  ActiveSubagentChips,
  SubagentMilestone,
  subagentActivityMembers,
  withSubagentMilestones,
} from "./SubagentActivity";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

const start = DateTime.makeUnsafe("2026-10-13T12:00:00Z");
const end = DateTime.makeUnsafe("2026-10-13T12:02:00Z");
function agent(
  id: string,
  status: OrchestrationV2Subagent["status"],
  extra: Partial<OrchestrationV2Subagent> = {},
): OrchestrationV2Subagent {
  return {
    id: NodeId.make(id),
    threadId: ThreadId.make("parent"),
    parentNodeId: NodeId.make("parent-node"),
    runId: RunId.make(`run-${id}`),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codexAppServer"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerThreadId: null,
    nativeTaskRef: null,
    childThreadId: ThreadId.make(`child-${id}`),
    prompt: `Task ${id}`,
    title: id,
    model: "gpt-6.1-sol",
    status,
    result: null,
    startedAt: start,
    completedAt: status === "completed" ? end : null,
    updatedAt: end,
    ...extra,
  };
}

describe("subagent activity", () => {
  it("keeps Android agent activity in the feed instead of covering the composer", async () => {
    viewport.android = true;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    const members = subagentActivityMembers([agent("review", "running")], []);
    const marker = withSubagentMilestones([], members)[0];
    try {
      await act(async () =>
        root.render(
          <>
            <ActiveSubagentChips members={members} onOpenThread={vi.fn()} />
            {marker?.kind === "subagent-milestone" ? (
              <SubagentMilestone row={marker} onOpenThread={vi.fn()} />
            ) : null}
          </>,
        ),
      );
      expect(container.querySelector("[data-active-subagents]")).toBeNull();
      expect(container.querySelector('[data-subagent-milestone="started"]')).not.toBeNull();
      expect(container.textContent).toContain("review");
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("keeps active workers from every run visible and removes each one when it finishes", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const open = vi.fn();
    const records = [
      agent("review", "running"),
      agent("build", "waiting"),
      agent("queued", "pending"),
      agent("done", "completed"),
      agent("idle", "idle"),
    ];
    try {
      await act(async () =>
        root.render(
          <ActiveSubagentChips
            members={subagentActivityMembers(records, [])}
            onOpenThread={open}
          />,
        ),
      );
      expect(container.querySelectorAll("[data-participant-id]")).toHaveLength(3);
      expect(container.textContent).toContain("Working");
      expect(container.textContent).toContain("Waiting");
      expect(container.textContent).toContain("Starting");
      expect(container.textContent).not.toContain("done");
      expect(container.textContent).not.toContain("idle");
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Open subagent review"]')!.click(),
      );
      expect(open).toHaveBeenCalledWith(ThreadId.make("child-review"));
      expect(
        getComputedStyle(
          container.querySelector<HTMLButtonElement>('[aria-label="Open subagent review"]')!,
        ).maxWidth,
      ).toBe("100%");

      const id = container
        .querySelector("[data-participant-id]")
        ?.getAttribute("data-participant-id");
      await act(async () =>
        root.render(
          <ActiveSubagentChips
            members={subagentActivityMembers([agent("review", "running")], [])}
            onOpenThread={open}
          />,
        ),
      );
      expect(
        container.querySelector("[data-participant-id]")?.getAttribute("data-participant-id"),
      ).toBe(id);
      await act(async () =>
        root.render(
          <ActiveSubagentChips
            members={subagentActivityMembers([agent("review", "completed")], [])}
            onOpenThread={open}
          />,
        ),
      );
      expect(container.querySelector("[data-active-subagents]")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });

  it("places start and terminal milestones at their recorded times, including failed workers", () => {
    const members = subagentActivityMembers(
      [agent("review", "completed"), agent("failed", "failed")],
      [],
    );
    const rows: MessagesTimelineRow[] = [
      { kind: "working", id: "working", createdAt: "2026-10-13T12:01:00Z" },
    ];
    const result = withSubagentMilestones(rows, members);
    expect(result.map((row) => row.id)).toEqual([
      "subagent-start:review:2026-10-13T12:00:00.000Z",
      "subagent-start:failed:2026-10-13T12:00:00.000Z",
      "working",
      "subagent-finish:review:2026-10-13T12:02:00.000Z",
      "subagent-finish:failed:2026-10-13T12:02:00.000Z",
    ]);
    expect(rows).toHaveLength(1);
    expect(withSubagentMilestones(rows, [])).toBe(rows);
    expect(
      withSubagentMilestones([], subagentActivityMembers([agent("review", "running")], [])),
    ).toHaveLength(1);
  });

  it("expands workflow workers with their own models, colors and child chat links", () => {
    const coordinator = agent("workflow", "running", {
      workflow: {
        phases: [],
        agents: [
          {
            index: 0,
            label: "Worker",
            state: "running",
            model: "claude-sonnet-4-6",
            childThreadId: ThreadId.make("member-thread"),
            startedAt: DateTime.toEpochMillis(start),
          },
        ],
      },
    });
    const members = subagentActivityMembers([coordinator], []);
    expect(members).toHaveLength(2);
    expect(members[1]?.participant).toMatchObject({
      id: "agent:member-thread:codex",
      model: "claude-sonnet-4-6",
      name: "Worker",
    });
    expect(members[1]?.childThreadId).toBe("member-thread");
  });

  it("keeps a finished worker's chip and result marker after it leaves the composer", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const row = withSubagentMilestones(
      [],
      subagentActivityMembers([agent("review", "completed")], []),
    ).find((row) => row.kind === "subagent-milestone" && row.phase === "finished");
    expect(row?.kind).toBe("subagent-milestone");
    try {
      if (row?.kind === "subagent-milestone")
        await act(async () => root.render(<SubagentMilestone row={row} onOpenThread={vi.fn()} />));
      expect(container.textContent).toContain("Finished");
      expect(
        container.querySelector('[data-participant-id="agent:child-review:codex"]'),
      ).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });
});
