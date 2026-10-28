import { useEffect, useEffectEvent } from "react";

/** Fallback for status APIs without a complete push path. */
export function useVisiblePolling(refresh: () => void, enabled: boolean, intervalMs: number) {
  const refreshLatest = useEffectEvent(refresh);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the visible polling timer and focus/visibility listeners for this mounted surface
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const resume = () => {
      clearInterval(timer);
      timer = undefined;
      if (document.visibilityState === "hidden") return;
      refreshLatest();
      timer = setInterval(refreshLatest, intervalMs);
    };
    resume();
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [enabled, intervalMs]);
}
