import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const captured = vi.hoisted(() => ({
  subscribe: undefined as undefined | ((listener: () => void) => () => void),
  snapshot: undefined as undefined | (() => ReadonlyArray<DesktopEnvironmentBootstrap>),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: (
    subscribe: typeof captured.subscribe,
    snapshot: NonNullable<typeof captured.snapshot>,
  ) => {
    captured.subscribe = subscribe;
    captured.snapshot = snapshot;
    return snapshot();
  },
}));
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const topology: DesktopEnvironmentBootstrap = {
  id: "wsl:test",
  label: "Test",
  runningDistro: "Test",
  httpBaseUrl: null,
  wsBaseUrl: null,
};
async function mount(bridge: object) {
  vi.stubGlobal("window", { desktopBridge: bridge });
  const { useDesktopLocalBootstraps } = await import("./useDesktopLocalBootstraps");
  useDesktopLocalBootstraps();
  cleanups.push(captured.subscribe!(vi.fn()));
}
it("shares a push subscription, keeps stable successful snapshots, and retains failed reads", async () => {
  let changed!: () => void;
  const unsubscribe = vi.fn();
  const subscribe = vi.fn((listener: () => void) => {
    changed = listener;
    return unsubscribe;
  });
  const read = vi.fn(() => [{ ...topology }]);
  await mount({
    getLocalEnvironmentBootstraps: read,
    onLocalEnvironmentBootstrapsChanged: subscribe,
  });
  cleanups.push(captured.subscribe!(vi.fn()));
  expect(subscribe).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  const first = captured.snapshot!();
  await changed();
  expect(captured.snapshot!()).toBe(first);
  read.mockImplementation(() => {
    throw new Error("IPC failed");
  });
  await changed();
  expect(captured.snapshot!()).toBe(first);
  read.mockReturnValue([]);
  await changed();
  expect(captured.snapshot!()).toEqual([]);
  cleanups.pop()!();
  expect(unsubscribe).not.toHaveBeenCalled();
  cleanups.pop()!();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
it("shares and cleans up one fallback timer for old desktop bridges", async () => {
  const read = vi.fn(() => [topology]);
  await mount({ getLocalEnvironmentBootstraps: read });
  cleanups.push(captured.subscribe!(vi.fn()));
  expect(vi.getTimerCount()).toBe(1);
  read.mockReturnValue([]);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(captured.snapshot!()).toEqual([]);
  for (const cleanup of cleanups.splice(0)) cleanup();
  expect(vi.getTimerCount()).toBe(0);
});
it("retries a failed final event without another topology notification", async () => {
  let changed!: () => void;
  const read = vi.fn(() => [topology]);
  await mount({
    getLocalEnvironmentBootstraps: read,
    onLocalEnvironmentBootstrapsChanged: (listener: () => void) => {
      changed = listener;
      return () => {};
    },
  });
  const original = captured.snapshot!();
  read.mockImplementation(() => {
    throw new Error("IPC unavailable");
  });
  await changed();
  expect(captured.snapshot!()).toBe(original);
  expect(vi.getTimerCount()).toBe(1);
  read.mockReturnValue([]);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(captured.snapshot!()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
  read.mockImplementation(() => {
    throw new Error("IPC unavailable");
  });
  await changed();
  for (const cleanup of cleanups.splice(0)) cleanup();
  expect(vi.getTimerCount()).toBe(0);
});

it("ignores a stale async bridge read after a newer topology event", async () => {
  let changed!: () => void;
  let completeOld!: (value: ReadonlyArray<DesktopEnvironmentBootstrap>) => void;
  const read = vi.fn().mockResolvedValue([topology]);
  await mount({
    readLocalEnvironmentBootstraps: read,
    onLocalEnvironmentBootstrapsChanged: (listener: () => void) => {
      changed = listener;
      return () => {};
    },
  });
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        completeOld = resolve;
      }),
  );
  const stale = changed();
  read.mockResolvedValueOnce([]);
  await changed();
  expect(captured.snapshot!()).toEqual([]);
  completeOld([topology]);
  await stale;
  expect(captured.snapshot!()).toEqual([]);
});
