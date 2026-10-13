// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import type { LegendListRef } from "@legendapp/list/react";
import { MessageId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  PinnedTimelineParticipant,
  pinnedParticipant,
  timelineParticipantGroups,
} from "./TimelineParticipants";

function message(
  id: string,
  role: "user" | "assistant",
  author = "alice",
  provider = "codex",
): MessagesTimelineRow {
  return {
    kind: "message",
    id,
    createdAt: "2026-10-13T12:00:00Z",
    durationStart: "2026-10-13T12:00:00Z",
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
    message: {
      id: MessageId.make(id),
      role,
      text: id,
      runId: null,
      createdAt: "2026-10-13T12:00:00Z",
      updatedAt: "2026-10-13T12:00:00Z",
      streaming: false,
      context: {
        version: 1,
        records: [],
        ...(role === "user"
          ? { author: { id: author, name: author, photo: null } }
          : {
              agent: {
                threadId: ThreadId.make("thread"),
                providerInstanceId: ProviderInstanceId.make(provider),
                model: "gpt-6.1-sol",
              },
            }),
      },
    },
  };
}

describe("timeline participant grouping", () => {
  it("groups by identity, including distinct humans and agent instances", () => {
    const rows = [
      message("a", "user"),
      message("b", "user"),
      message("c", "user", "bob"),
      message("d", "assistant"),
      message("e", "assistant"),
      message("f", "assistant", "alice", "claude"),
      message("g", "user"),
    ];
    const groups = timelineParticipantGroups(rows, "thread", [], []);
    expect(groups.map((group) => [group.start, group.end, group.participant.id])).toEqual([
      [0, 2, "alice"],
      [2, 3, "bob"],
      [3, 5, "agent:thread:codex"],
      [5, 6, "agent:thread:claude"],
      [6, 7, "alice"],
    ]);
    expect(timelineParticipantGroups([], "thread", [], [])).toEqual([]);
  });

  it("pins a long group, pushes it out at the next sender, and clears beyond the final message", () => {
    const groups = timelineParticipantGroups(
      [message("a", "assistant"), message("b", "assistant"), message("c", "user")],
      "thread",
      [],
      [],
    );
    const positions = [0, 800, 1400];
    const at = (scroll: number) =>
      pinnedParticipant(
        groups,
        (index) => (positions[index] === undefined ? undefined : positions[index]! - scroll),
        2000 - scroll,
        48,
      );
    expect(at(0)).toBeNull();
    expect(at(1000)).toEqual({ group: groups[0], offset: 0 });
    expect(at(1370)).toEqual({ group: groups[0], offset: -18 });
    expect(at(1400)).toBeNull();
    expect(at(1500)).toEqual({ group: groups[1], offset: 0 });
    expect(at(2000)).toBeNull();
    expect(pinnedParticipant(groups, () => undefined, 2000, 48)).toBeNull();
  });

  it("retains the chip when its first row is recycled and cleans it up on thread changes", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const rows = [message("a", "assistant"), message("b", "assistant"), message("c", "user")];
    const groups = timelineParticipantGroups(rows, "thread", [], []);
    const container = document.createElement("div");
    const viewport = document.createElement("div");
    const mountedRow = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let scroll = 1000;
    const positions = [0, 800, 1400];
    vi.spyOn(mountedRow, "getBoundingClientRect").mockImplementation(
      () => ({ top: 800 - scroll }) as DOMRect,
    );
    const listRef = createRef<LegendListRef | null>();
    const refreshRef = { current: () => {} };
    listRef.current = {
      getScrollableNode: () => viewport,
      getState: () => ({
        data: rows,
        start: 1,
        elementAtIndex: (index: number) => (index === 1 ? mountedRow : null),
        positionAtIndex: (index: number) => positions[index],
        sizeAtIndex: () => 600,
      }),
    } as unknown as LegendListRef;
    try {
      await act(async () =>
        root.render(
          <PinnedTimelineParticipant groups={groups} listRef={listRef} refreshRef={refreshRef} />,
        ),
      );
      await act(async () => refreshRef.current());
      const pinned = container.querySelector('[data-pinned-participant="agent:thread:codex"]');
      expect(pinned).not.toBeNull();
      expect(pinned?.hasAttribute("inert")).toBe(true);
      expect(pinned?.getAttribute("aria-hidden")).toBe("true");
      scroll = 1370;
      await act(async () => refreshRef.current());
      expect(container.querySelector(".chat-content-lane")?.getAttribute("style")).toContain(
        "-18px",
      );
      scroll = 1500;
      await act(async () => refreshRef.current());
      expect(container.querySelector('[data-pinned-participant="alice"]')).not.toBeNull();
      await act(async () =>
        root.render(
          <PinnedTimelineParticipant groups={[]} listRef={listRef} refreshRef={refreshRef} />,
        ),
      );
      await act(async () => refreshRef.current());
      expect(container.querySelector("[data-pinned-participant]")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });
});
