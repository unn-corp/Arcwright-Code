// @effect-diagnostics nodeBuiltinImport:off - Verify the pinned tab uses the shipped stylesheet.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import type { LegendListRef } from "@legendapp/list/react";
import { MessageId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
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
  it("does not pin an identity over the Android feed or subscribe to its scrolling", async () => {
    viewport.android = true;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    const readViewport = vi.fn();
    const listRef = createRef<LegendListRef | null>();
    listRef.current = { getScrollableNode: readViewport } as unknown as LegendListRef;
    try {
      await act(async () =>
        root.render(
          <PinnedTimelineParticipant
            groups={timelineParticipantGroups([message("agent", "assistant")], "thread", [], [])}
            listRef={listRef}
            refreshRef={{ current: () => {} }}
          />,
        ),
      );
      expect(container.querySelector("[data-pinned-participant]")).toBeNull();
      expect(readViewport).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });

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
    const stylesheet = NodeFS.readFileSync(
      new NodeURL.URL("../../index.css", import.meta.url),
      "utf8",
    );
    const style = document.createElement("style");
    style.textContent = stylesheet.match(/\.chat-pinned-participant-tab \{[^}]*\}/)?.[0] ?? "";
    document.head.append(style);
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
      const tab = pinned?.querySelector<HTMLElement>(".chat-pinned-participant-tab");
      expect(tab).not.toBeNull();
      const tabStyle = getComputedStyle(tab!);
      expect(tabStyle.width).toBe("fit-content");
      expect(tabStyle.borderTopLeftRadius).toBe("0px");
      expect(tabStyle.borderTopRightRadius).toBe("0px");
      expect(tabStyle.borderBottomLeftRadius).toBe("14px");
      expect(tabStyle.borderBottomRightRadius).toBe("14px");
      expect(getComputedStyle(tab!.parentElement!).backgroundColor).toBe("rgba(0, 0, 0, 0)");
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
      style.remove();
      vi.unstubAllGlobals();
    }
  });
});

it("groups legacy and recorded messages from the same current user into one identity", () => {
  const legacy = message("legacy", "user");
  if (legacy.kind !== "message") throw new Error("Expected message fixture");
  const legacyRow = {
    ...legacy,
    message: { ...legacy.message, context: { version: 1 as const, records: [] } },
  };
  const current = { id: "alice", name: "Alice Updated", photo: "https://example.com/current.png" };
  const groups = timelineParticipantGroups(
    [legacyRow, message("recorded", "user")],
    "chat",
    [],
    [],
    {
      activeParticipantProfile: "account:alice",
      participantProfiles: {
        "account:alice": { participant: current, initialized: true, accounts: [] },
      },
    },
  );
  expect(groups).toHaveLength(1);
  expect(groups[0]?.participant).toEqual({ kind: "human", ...current });
});
