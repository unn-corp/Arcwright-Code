import { useEffect, useEffectEvent, useState } from "react";

export function usePermissionStatus<Id extends string>(
  check: (signal?: AbortSignal) => Promise<Record<Id, boolean>>,
  initialStatus: Record<Id, boolean>,
  enabled = true,
) {
  const [status, setStatus] = useState(initialStatus);
  const [fresh, setFresh] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checkLatest = useEffectEvent(check);
  useEffect(() => {
    if (!enabled) return;
    const isVisible = () => document.visibilityState !== "hidden";
    const controller = new AbortController();
    let disposed = false;
    let checking = false;
    let pending = false;
    let previous: Record<Id, boolean> | undefined;
    let delay = 1_500;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelTimer = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    const schedule = () => {
      cancelTimer();
      if (!disposed && isVisible()) {
        timer = setTimeout(() => void refresh(), delay);
      }
    };
    const refresh = async () => {
      cancelTimer();
      if (disposed || document.visibilityState === "hidden") return;
      if (checking) {
        pending = true;
        return;
      }
      checking = true;
      try {
        const next = await checkLatest(controller.signal);
        if (!disposed && !pending && isVisible()) {
          const stable =
            previous !== undefined &&
            Object.keys(next).length === Object.keys(previous).length &&
            (Object.keys(next) as Id[]).every((id) => previous?.[id] === next[id]);
          delay = stable ? Math.min(delay * 2, 15_000) : 1_500;
          previous = next;
          setStatus((current) => (stable ? current : next));
          setError(null);
          setFresh(true);
        }
      } catch {
        delay = 1_500;
        previous = undefined;
        if (!disposed) setError("Could not check permissions. We'll try again automatically.");
      } finally {
        checking = false;
        if (!disposed && pending) {
          pending = false;
          void refresh();
        } else {
          schedule();
        }
      }
    };
    const refreshImmediately = () => {
      delay = 1_500;
      previous = undefined;
      setFresh(false);
      if (checking) pending = true;
      void refresh();
    };
    void refresh();
    window.addEventListener("focus", refreshImmediately);
    document.addEventListener("visibilitychange", refreshImmediately);
    return () => {
      disposed = true;
      controller.abort();
      cancelTimer();
      window.removeEventListener("focus", refreshImmediately);
      document.removeEventListener("visibilitychange", refreshImmediately);
    };
  }, [enabled]);
  return {
    status,
    error,
    isReady: (required: readonly Id[]) =>
      enabled &&
      fresh &&
      document.visibilityState !== "hidden" &&
      error === null &&
      required.every((id) => status[id]),
  };
}
