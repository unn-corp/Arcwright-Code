import { afterEach, expect, it, vi } from "vite-plus/test";
import { startParticipantProfileRefresh } from "./participantProfileRefresh";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("refreshes visible clients at most once a minute, coalesces focus, and stops on unmount", async () => {
  vi.useFakeTimers();
  const page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const shell = Object.assign(new EventTarget(), { setInterval, clearInterval });
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", shell);
  let finish!: () => void;
  const refresh = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const stop = startParticipantProfileRefresh(refresh);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(refresh).toHaveBeenCalledOnce();
  shell.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(refresh).toHaveBeenCalledOnce();
  finish();
  await Promise.resolve();
  await Promise.resolve();
  page.visibilityState = "hidden";
  await vi.advanceTimersByTimeAsync(60_000);
  expect(refresh).toHaveBeenCalledOnce();
  page.visibilityState = "visible";
  page.dispatchEvent(new Event("visibilitychange"));
  expect(refresh).toHaveBeenCalledTimes(2);
  finish();
  stop();
  await vi.advanceTimersByTimeAsync(60_000);
  shell.dispatchEvent(new Event("focus"));
  expect(refresh).toHaveBeenCalledTimes(2);
});
