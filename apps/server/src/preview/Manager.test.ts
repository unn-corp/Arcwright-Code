import { it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { type PreviewEvent, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";

import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";

import * as PreviewManager from "./Manager.ts";

const DRAIN_LIMIT = 100;

interface EventCollector {
  readonly drain: Effect.Effect<ReadonlyArray<PreviewEvent>>;
}

/** The shared live layer retains state between tests; counts need unique thread ids. */
let nextThreadId = 0;
const freshThreadId = () => ThreadId.make(`thread-${++nextThreadId}`);

/** Subscribe synchronously before publishing so the forked consumer cannot miss events. */
const collectEvents = Effect.gen(function* () {
  const manager = yield* PreviewManager.PreviewManager;
  const subscription = yield* manager.subscribeEvents;
  const collector: EventCollector = {
    drain: PubSub.takeUpTo(subscription, DRAIN_LIMIT),
  };
  return collector;
}).pipe(Effect.withSpan("preview.test.collectEvents"));

it.layer(PreviewManager.layer.pipe(Layer.provide(NodeCrypto.layer)))("PreviewManager", (it) => {
  it.effect("opens a session and emits opened with normalized URL", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;

      const snapshot = yield* manager.open({
        threadId,
        url: "localhost:5173",
      });
      expect(snapshot.tabId.startsWith("tab_")).toBe(true);
      expect(snapshot.navStatus._tag).toBe("Loading");
      if (snapshot.navStatus._tag === "Loading") {
        expect(snapshot.navStatus.url).toBe("http://localhost:5173/");
      }

      const events = yield* collector.drain;
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("opened");
      if (events[0]?.type === "opened") {
        expect(events[0].tabId).toBe(snapshot.tabId);
      }
    }),
  );

  it.effect("keeps the tab's profile across status reports", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;

      const opened = yield* manager.open({ threadId, profileId: "work" });
      expect(opened.profileId).toBe("work");

      yield* manager.reportStatus({
        threadId,
        tabId: opened.tabId,
        navStatus: {
          _tag: "Success",
          url: "http://localhost:5173/",
          title: "Dev",
        },
        canGoBack: true,
        canGoForward: false,
      });
      const listed = yield* manager.list({ threadId });
      expect(listed.sessions.find((s) => s.tabId === opened.tabId)?.profileId).toBe("work");
    }),
  );

  it.effect("reissues presentation requests without replaying them on navigation", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;
      const opened = yield* manager.open({ threadId, runtime: "server", reveal: false });
      yield* manager.requestReveal({ threadId, tabId: opened.tabId, force: true });
      const first = (yield* manager.list({ threadId })).sessions[0];
      expect(first?.reveal).toBe(true);
      expect(first?.revealRequest?.force).toBe(true);
      yield* manager.reportStatus({
        threadId,
        tabId: opened.tabId,
        serverControlled: true,
        navStatus: { _tag: "Success", url: "http://localhost:5173/", title: "Dev" },
        canGoBack: false,
        canGoForward: false,
      });
      expect((yield* manager.list({ threadId })).sessions[0]?.revealRequest).toEqual(
        first?.revealRequest,
      );
      yield* manager.requestReveal({ threadId, tabId: opened.tabId, force: false });
      const second = (yield* manager.list({ threadId })).sessions[0];
      expect(second?.revealRequest?.id).not.toBe(first?.revealRequest?.id);
      expect(second?.revealRequest?.force).toBe(false);
      const events = yield* collector.drain;
      const last = events.at(-1);
      expect(last?.type).toBe("navigated");
      if (last?.type === "navigated")
        expect(last.snapshot.revealRequest).toEqual(second?.revealRequest);
    }),
  );

  it.effect("orders list snapshots and events with one monotonic revision", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;
      const before = yield* manager.list({ threadId });

      const opened = yield* manager.open({
        threadId,
        url: "http://localhost:5173",
      });
      yield* manager.reportStatus({
        threadId,
        tabId: opened.tabId,
        navStatus: { _tag: "Success", url: "http://localhost:5173/ready", title: "Ready" },
        canGoBack: true,
        canGoForward: false,
      });

      const events = yield* collector.drain;
      const listed = yield* manager.list({ threadId });
      expect(events).toHaveLength(2);
      expect(events[0]!.serverEpoch).toBe(listed.serverEpoch);
      expect(events[1]!.serverEpoch).toBe(listed.serverEpoch);
      expect(events[0]!.revision).toBeGreaterThan(before.revision);
      expect(events[1]!.revision).toBeGreaterThan(events[0]!.revision);
      expect(listed.revision).toBe(events[1]!.revision);
      expect(listed.sessions).toHaveLength(1);
    }),
  );

  it.effect("resizes a tab and preserves its viewport across navigation reports", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const collector = yield* collectEvents;
      const opened = yield* manager.open({
        threadId,
        url: "http://localhost:5173",
      });

      const resized = yield* manager.resize({
        threadId,
        tabId: opened.tabId,
        viewport: { _tag: "freeform", width: 1024, height: 768 },
      });
      expect(resized.viewport).toEqual({
        _tag: "freeform",
        width: 1024,
        height: 768,
      });

      yield* manager.reportStatus({
        threadId,
        tabId: opened.tabId,
        navStatus: {
          _tag: "Success",
          url: "http://localhost:5173/resized",
          title: "Resized",
        },
        canGoBack: true,
        canGoForward: false,
      });
      const listed = yield* manager.list({ threadId });
      expect(listed.sessions[0]?.viewport).toEqual(resized.viewport);

      const events = yield* collector.drain;
      expect(events.map((event) => event.type)).toEqual(["opened", "resized", "navigated"]);
    }),
  );

  it.effect("gives every tab in a batch close its own monotonic revision", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      yield* manager.open({ threadId, url: "http://localhost:5173" });
      yield* manager.open({ threadId, url: "http://localhost:3000" });
      const collector = yield* collectEvents;

      yield* manager.close({ threadId });

      const events = yield* collector.drain;
      const listed = yield* manager.list({ threadId });
      expect(events).toHaveLength(2);
      expect(events.every((event) => event.type === "closed")).toBe(true);
      expect(events[1]!.revision).toBeGreaterThan(events[0]!.revision);
      expect(listed.revision).toBe(events[1]!.revision);
      expect(listed.sessions).toHaveLength(0);
    }),
  );

  it.effect("close with explicit tabId removes only that tab", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const a = yield* manager.open({
        threadId,
        url: "http://localhost:5173",
      });
      const b = yield* manager.open({
        threadId,
        url: "http://localhost:3000",
      });

      yield* manager.close({ threadId, tabId: a.tabId });

      const list = yield* manager.list({ threadId });
      expect(list.sessions.map((s) => s.tabId)).toEqual([b.tabId]);
    }),
  );

  it.effect("reports demand when a viewer attaches and again when it leaves", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const session = yield* manager.open({
        threadId,
        url: "http://localhost:5173",
      });
      const demand: Array<number> = [];
      yield* Effect.forkScoped(
        manager.frameDemand.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.threadId === threadId) demand.push(event.viewers);
            }),
          ),
        ),
      );
      yield* Effect.yieldNow;

      const frames = yield* manager.attachFrames({
        threadId,
        tabId: session.tabId,
      });
      // Taking one element opens the stream, then releases it on completion,
      // which is exactly an attach followed by a detach.
      const first = yield* Stream.runHead(frames);

      expect(first._tag).toBe("Some");
      yield* Effect.yieldNow;
      expect(demand).toEqual([1, 0]);
    }),
  );

  it.effect("drops frames when nothing is attached", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const session = yield* manager.open({
        threadId,
        url: "http://localhost:5173",
      });

      // No viewer, so this must be a no-op rather than an error or a buffer
      // that grows until someone attaches.
      yield* manager.publishFrame({
        threadId,
        tabId: session.tabId,
        seq: 1,
        data: "AAAA",
        width: 100,
        height: 80,
        pageWidth: 100,
        pageHeight: 80,
        capturedAt: "2026-01-01T00:00:00.000Z",
      });

      const snapshot = yield* manager.frameDemandSnapshot;
      expect(snapshot.filter((entry) => entry.threadId === threadId)).toEqual([]);
    }),
  );

  it.effect("counts each viewer of the same tab", () =>
    Effect.gen(function* () {
      const threadId = freshThreadId();
      const manager = yield* PreviewManager.PreviewManager;
      const session = yield* manager.open({
        threadId,
        url: "http://localhost:5173",
      });
      const first = yield* manager.attachFrames({
        threadId,
        tabId: session.tabId,
      });
      const second = yield* manager.attachFrames({
        threadId,
        tabId: session.tabId,
      });
      yield* Effect.forkScoped(Stream.runDrain(first));
      yield* Effect.forkScoped(Stream.runDrain(second));
      yield* Effect.yieldNow;

      const snapshot = yield* manager.frameDemandSnapshot;
      expect(snapshot.find((entry) => entry.threadId === threadId)?.viewers).toBe(2);
    }),
  );
});
