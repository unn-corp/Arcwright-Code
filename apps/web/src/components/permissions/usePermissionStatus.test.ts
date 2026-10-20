import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { usePermissionStatus } from "./usePermissionStatus";

const effects = vi.hoisted(() => [] as Array<() => (() => void) | undefined>);
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useState: reactHookHarness.useState,
    useEffect: (effect: () => (() => void) | undefined) => effects.push(effect),
    useEffectEvent: <T>(callback: T) => callback,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
const check = vi.fn<() => Promise<{ screen: boolean; accessibility: boolean }>>();
let cleanup: (() => void) | undefined;
let page: EventTarget & { visibilityState: string };
const render = () => {
  hooks.beginRender();
  return usePermissionStatus(check, { screen: false, accessibility: false });
};
beforeEach(() => {
  hooks.reset();
  effects.length = 0;
  vi.useFakeTimers();
  page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { setInterval, clearInterval }));
  check.mockReset().mockResolvedValue({ screen: false, accessibility: false });
});
afterEach(() => {
  cleanup?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const start = async () => {
  render();
  cleanup = effects[0]!();
  // Settle the full check/catch/finally chain before treating the read as idle.
  await vi.advanceTimersByTimeAsync(0);
};

it("unlocks Continue only for required grants and relocks on revocation", async () => {
  await start();
  expect(render().isReady(["screen"])).toBe(false);
  check.mockResolvedValue({ screen: true, accessibility: false });
  await vi.advanceTimersByTimeAsync(1500);
  expect(render().isReady(["screen"])).toBe(true);
  expect(render().isReady(["screen", "accessibility"])).toBe(false);
  check.mockResolvedValue({ screen: true, accessibility: true });
  await vi.advanceTimersByTimeAsync(1500);
  expect(render().isReady(["screen", "accessibility"])).toBe(true);
  check.mockResolvedValue({ screen: false, accessibility: true });
  window.dispatchEvent(new Event("focus"));
  await Promise.resolve();
  expect(render().isReady(["screen"])).toBe(false);
});

it("does not overlap checks and discards completion after closing", async () => {
  let resolve!: (status: { screen: boolean; accessibility: boolean }) => void;
  const promise = new Promise<{ screen: boolean; accessibility: boolean }>((done) => {
    resolve = done;
  });
  const pending = { promise, resolve };
  check.mockReturnValue(pending.promise);
  await start();
  await vi.advanceTimersByTimeAsync(4500);
  window.dispatchEvent(new Event("focus"));
  expect(check).toHaveBeenCalledTimes(1);
  cleanup?.();
  pending.resolve({ screen: true, accessibility: true });
  await pending.promise;
  expect(render().isReady(["screen"])).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("pauses in the background and blocks stale grants after a check failure", async () => {
  check.mockResolvedValue({ screen: true, accessibility: true });
  await start();
  expect(render().isReady(["screen"])).toBe(true);
  page.visibilityState = "hidden";
  await vi.advanceTimersByTimeAsync(3000);
  expect(check).toHaveBeenCalledTimes(1);
  check.mockRejectedValue(new Error("IPC unavailable"));
  page.visibilityState = "visible";
  page.dispatchEvent(new Event("visibilitychange"));
  await Promise.resolve();
  expect(render().isReady(["screen"])).toBe(false);
  check.mockResolvedValue({ screen: true, accessibility: true });
  await vi.advanceTimersByTimeAsync(1500);
  expect(render().isReady(["screen"])).toBe(true);
});

it("backs off stable visible checks but refreshes immediately on focus and visibility return", async () => {
  check.mockResolvedValue({ screen: true, accessibility: true });
  await start();
  await vi.advanceTimersByTimeAsync(1_500);
  expect(check).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2_999);
  expect(check).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(check).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(5_999);
  expect(check).toHaveBeenCalledTimes(3);
  check.mockResolvedValue({ screen: false, accessibility: true });
  window.dispatchEvent(new Event("focus"));
  await Promise.resolve();
  expect(check).toHaveBeenCalledTimes(4);
  expect(render().isReady(["screen"])).toBe(false);
  page.visibilityState = "hidden";
  page.dispatchEvent(new Event("visibilitychange"));
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(60_000);
  page.visibilityState = "visible";
  page.dispatchEvent(new Event("visibilitychange"));
  await Promise.resolve();
  expect(check).toHaveBeenCalledTimes(5);
});

it("queues one fresh check after focus during an in-flight read and ignores its stale grant", async () => {
  let resolve!: (status: { screen: boolean; accessibility: boolean }) => void;
  check.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await start();
  window.dispatchEvent(new Event("focus"));
  window.dispatchEvent(new Event("focus"));
  expect(check).toHaveBeenCalledTimes(1);
  resolve({ screen: true, accessibility: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(check).toHaveBeenCalledTimes(2);
  expect(render().isReady(["screen"])).toBe(false);
  cleanup?.();
  await vi.advanceTimersByTimeAsync(60_000);
  window.dispatchEvent(new Event("focus"));
  expect(check).toHaveBeenCalledTimes(2);
});
it("rejects hidden in-flight grants and relocks until the return check completes", async () => {
  check.mockResolvedValue({ screen: true, accessibility: true });
  await start();
  expect(render().isReady(["screen"])).toBe(true);
  let resolve!: (value: { screen: boolean; accessibility: boolean }) => void;
  check.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  window.dispatchEvent(new Event("focus"));
  expect(render().isReady(["screen"])).toBe(false);
  page.visibilityState = "hidden";
  page.dispatchEvent(new Event("visibilitychange"));
  resolve({ screen: true, accessibility: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(render().isReady(["screen"])).toBe(false);
  page.visibilityState = "visible";
  page.dispatchEvent(new Event("visibilitychange"));
  expect(render().isReady(["screen"])).toBe(false);
  resolve({ screen: false, accessibility: true });
  await Promise.resolve();
  expect(render().status.screen).toBe(false);
  expect(render().isReady(["screen"])).toBe(false);
});
