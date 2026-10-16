import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const effects = vi.hoisted(() => [] as Array<() => (() => void) | undefined>);
vi.mock("react", () => ({
  useEffect: (effect: () => (() => void) | undefined) => effects.push(effect),
  useEffectEvent: <T>(callback: T) => callback,
}));
import { useVisiblePolling } from "./useVisiblePolling";
let page: EventTarget & { visibilityState: string };
let cleanup: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  effects.length = 0;
  page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => {
  cleanup?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("retains status polling while visible, refreshes on return, and releases timers and listeners", () => {
  const refresh = vi.fn();
  useVisiblePolling(refresh, true, 5_000);
  cleanup = effects[0]!();
  expect(refresh).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(5_000);
  expect(refresh).toHaveBeenCalledTimes(2);
  page.visibilityState = "hidden";
  page.dispatchEvent(new Event("visibilitychange"));
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(30_000);
  expect(refresh).toHaveBeenCalledTimes(2);
  page.visibilityState = "visible";
  page.dispatchEvent(new Event("visibilitychange"));
  expect(refresh).toHaveBeenCalledTimes(3);
  window.dispatchEvent(new Event("focus"));
  expect(refresh).toHaveBeenCalledTimes(4);
  expect(vi.getTimerCount()).toBe(1);
  cleanup?.();
  cleanup = undefined;
  window.dispatchEvent(new Event("focus"));
  vi.advanceTimersByTime(5_000);
  expect(refresh).toHaveBeenCalledTimes(4);
  expect(vi.getTimerCount()).toBe(0);
});
