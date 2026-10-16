import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { subscribeElapsedClock } from "./elapsedClock";

let page: EventTarget & { visibilityState: string };
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("document", page);
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("shares one timer, stops while hidden, and catches up using wall time", () => {
  const first = vi.fn();
  const second = vi.fn();
  cleanups.push(subscribeElapsedClock(first), subscribeElapsedClock(second));
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(1_000);
  expect(first).toHaveBeenLastCalledWith(11_000);
  page.visibilityState = "hidden";
  page.dispatchEvent(new Event("visibilitychange"));
  const count = first.mock.calls.length;
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(60_000);
  expect(first).toHaveBeenCalledTimes(count);
  page.visibilityState = "visible";
  page.dispatchEvent(new Event("visibilitychange"));
  expect(first).toHaveBeenLastCalledWith(71_000);
  expect(second).toHaveBeenLastCalledWith(71_000);
  for (const cleanup of cleanups.splice(0)) cleanup();
  expect(vi.getTimerCount()).toBe(0);
});
it("suspends offscreen labels and releases observation on unsubscribe", () => {
  let intersect!: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void;
  const observe = vi.fn();
  const unobserve = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: typeof intersect) {
        intersect = callback;
      }
      observe = observe;
      unobserve = unobserve;
      disconnect = disconnect;
    },
  );
  const element = {} as Element;
  const update = vi.fn();
  const cleanup = subscribeElapsedClock(update, element);
  cleanups.push(cleanup);
  expect(vi.getTimerCount()).toBe(0);
  intersect([{ target: element, isIntersecting: true }]);
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(1_000);
  intersect([{ target: element, isIntersecting: false }]);
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(30_000);
  intersect([{ target: element, isIntersecting: true }]);
  expect(update).toHaveBeenLastCalledWith(41_000);
  cleanups.pop()!();
  expect(unobserve).toHaveBeenCalledWith(element);
  expect(disconnect).toHaveBeenCalledOnce();
});
it("can subscribe and unsubscribe without browser globals", () => {
  vi.stubGlobal("document", undefined);
  const update = vi.fn();
  expect(subscribeElapsedClock(update)).toBeTypeOf("function");
  subscribeElapsedClock(update)();
  expect(update).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
