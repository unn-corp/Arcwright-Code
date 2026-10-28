import { act } from "react";
import { createRoot } from "react-dom/client";
import { EnvironmentId, ThreadId, RunId } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it, vi } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import { useUiStateStore } from "../../uiStateStore";
import {
  CollapsedThreadStatusIndicators,
  summarizeCollapsedThreadStatuses,
} from "./CollapsedThreadStatusIndicators";

const visitedAt = "2026-10-13T12:00:00.000Z";
const completedAt = "2026-10-13T12:05:00.000Z";
function completed(id: string, environment = "host") {
  return makeThreadFixture({
    id: ThreadId.make(id),
    environmentId: EnvironmentId.make(environment),
    lastVisitedAt: visitedAt,
    runtime: null,
    latestRun: {
      runId: RunId.make(`run-${id}`),
      status: "completed",
      assistantMessageId: null,
      requestedAt: visitedAt,
      startedAt: visitedAt,
      completedAt,
    },
  });
}
function failed(id: string) {
  const thread = completed(id);
  return {
    ...thread,
    runtime: {
      status: "failed" as const,
      activeRunId: null,
      providerInstanceId: thread.providerInstanceId,
      providerName: "Codex",
      lastError: "Failed",
      updatedAt: completedAt,
    },
  };
}

describe("collapsed thread statuses", () => {
  it("counts each hidden chat once, with input taking priority over failure and completion", () => {
    expect(
      summarizeCollapsedThreadStatuses(
        [
          { ...failed("question"), hasPendingUserInput: true, hasPendingApprovals: true },
          makeThreadFixture({ id: ThreadId.make("approval"), hasPendingApprovals: true }),
          makeThreadFixture({ id: ThreadId.make("guest-request"), pendingGuestMessageCount: 1 }),
          failed("failed"),
          {
            ...failed("limited"),
            runtime: { ...failed("limited").runtime, lastErrorClass: "usage_limit" as const },
          },
          completed("done"),
          { ...completed("read"), lastVisitedAt: completedAt },
          makeThreadFixture({ id: ThreadId.make("idle"), runtime: null }),
        ],
        {},
      ),
    ).toEqual({ input: 3, failed: 2, done: 1 });
  });

  it("keeps historical failures out of Snoozed and Settled summaries", () => {
    expect(
      summarizeCollapsedThreadStatuses([failed("old-failure"), completed("new-result")], {}, false),
    ).toEqual({ input: 0, failed: 0, done: 1 });
    expect(summarizeCollapsedThreadStatuses([failed("active-failure")], {}, true).failed).toBe(1);
  });

  it("clears done counts after a server-side visit and honors mark-unread on another device", () => {
    const thread = completed("done");
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    expect(summarizeCollapsedThreadStatuses([thread], { [key]: completedAt }).done).toBe(1);
    expect(
      summarizeCollapsedThreadStatuses([{ ...thread, lastVisitedAt: completedAt }], {}).done,
    ).toBe(0);
  });

  it("keeps legacy local read watermarks scoped to the connection", () => {
    const a = { ...completed("same-chat", "host-a"), lastVisitedAt: undefined };
    const b = { ...completed("same-chat", "host-b"), lastVisitedAt: undefined };
    const key = scopedThreadKey(scopeThreadRef(a.environmentId, a.id));
    const otherKey = scopedThreadKey(scopeThreadRef(b.environmentId, b.id));
    expect(
      summarizeCollapsedThreadStatuses([a, b], { [key]: completedAt, [otherKey]: visitedAt }),
    ).toEqual({
      input: 0,
      failed: 0,
      done: 1,
    });
  });

  it("shows accessible icons and a multiplier only when a status has several chats", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <CollapsedThreadStatusIndicators
            threads={[
              makeThreadFixture({ hasPendingUserInput: true }),
              failed("one"),
              failed("two"),
              completed("done"),
            ]}
          />,
        ),
      );
      expect(container.querySelector('[aria-label="Need input: 1 chat"]')?.textContent).toBe("");
      expect(
        container.querySelector('[aria-label="Failed or limited: 2 chats"]')?.textContent,
      ).toBe("×2");
      expect(container.querySelector('[aria-label="Done, unread: 1 chat"]')).not.toBeNull();
      await act(async () => root.render(<CollapsedThreadStatusIndicators threads={[]} />));
      expect(container.querySelector("[data-collapsed-thread-statuses]")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });

  it("updates a collapsed legacy group's done icon when its local read watermark changes", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const original = useUiStateStore.getState().threadLastVisitedAtById;
    const thread = { ...completed("legacy"), lastVisitedAt: undefined };
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      useUiStateStore.setState({ threadLastVisitedAtById: { [key]: visitedAt } });
      await act(async () => root.render(<CollapsedThreadStatusIndicators threads={[thread]} />));
      expect(container.querySelector('[aria-label="Done, unread: 1 chat"]')).not.toBeNull();
      await act(async () =>
        useUiStateStore.setState({ threadLastVisitedAtById: { [key]: completedAt } }),
      );
      expect(container.querySelector("[data-collapsed-thread-statuses]")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      useUiStateStore.setState({ threadLastVisitedAtById: original });
      vi.unstubAllGlobals();
    }
  });
});
