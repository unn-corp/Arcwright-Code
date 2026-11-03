import { useLayoutEffect } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";
import type { LegendListRef } from "@legendapp/list/react";
import { useTimelineFollow } from "./useTimelineFollow";
import type { TimelineNavigation, TimelineViewport } from "./timelineViewport";

vi.mock("../ChatView.logic", () => ({
  releaseChatTimelineAnchor: () => null,
  shouldReleaseTimelineAnchorForToolActivity: () => false,
}));
vi.mock("./MessagesTimeline.logic", () => ({
  resolveTimelineIsAtEnd: (state: {
    contentLength: number;
    scroll: number;
    scrollLength: number;
  }) => state.scroll >= state.contentLength - state.scrollLength,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("timeline follow", () => {
  it("keeps a scroll-to-end request following when a delayed upward scroll arrives", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      (cb: FrameRequestCallback) => (frames.push(cb), frames.length),
    );
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    const scrollToEnd = vi.fn(async () => {});
    const node = { scrollTop: 200, scrollHeight: 1000, clientHeight: 400 };
    const list = {
      getState: () => ({
        contentLength: 1000,
        scroll: 200,
        scrollLength: 400,
        data: [{}],
        positionAtIndex: () => 900,
        sizeAtIndex: () => 100,
      }),
      getScrollableNode: () => node,
      scrollToEnd,
      scrollToItem: vi.fn(async () => {}),
      scrollToOffset: vi.fn(async () => {}),
    } as unknown as LegendListRef;
    let listener: ((navigation: TimelineNavigation) => void) | undefined;
    let holds = 0;
    const viewport = {
      scrollNode: node,
      subscribe: (fn: typeof listener) => {
        listener = fn;
        return () => {};
      },
      navigate: ({ releasesFollow }: { releasesFollow: boolean }) =>
        listener?.({ source: "command", releasesFollow }),
      holdProgrammaticScroll: () => {
        holds++;
        return () => {
          holds--;
        };
      },
      followReleased: () => {},
      onFollowReleased: () => () => {},
    } as unknown as TimelineViewport;
    let follow!: ReturnType<typeof useTimelineFollow>;
    function Harness() {
      const current = useTimelineFollow({
        legendListRef: { current: list },
        composerTimelineInset: 0,
        routeThreadKey: "a",
        activeThreadKey: "a",
        isServerThread: false,
        serverProjection: null,
        threadStatus: "live",
        activeActivityRun: null,
        activeRunningTurnId: null,
        timelineEntries: [],
        timelineAnchorMessageId: null,
        setTimelineAnchor: () => {},
      });
      useLayoutEffect(() => {
        follow = current;
      }, [current]);
      return null;
    }
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<Harness />);
    });
    await act(async () => {
      follow.attachTimelineViewport(viewport);
      listener?.({ source: "wheel", direction: "up" });
      follow.onIsAtEndChangeStable(false);
    });
    await act(async () => {
      follow.scrollToEnd(true);
      if (holds === 0) listener?.({ source: "scroll" });
      frames.shift()?.(0);
      await Promise.resolve();
    });
    expect(scrollToEnd).toHaveBeenCalledOnce();
    expect(follow.timelineLiveFollowEnabled).toBe(true);
    await act(async () => {
      listener?.({ source: "wheel", direction: "up" });
    });
    expect(follow.timelineLiveFollowEnabled).toBe(false);
    await act(async () => renderer.unmount());
    vi.unstubAllGlobals();
  });
});
