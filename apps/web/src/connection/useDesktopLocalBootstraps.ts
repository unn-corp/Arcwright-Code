import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import { readDesktopSecondaryBootstrapsResult } from "./desktopLocal";

const listeners = new Set<() => void>();
let snapshot: ReadonlyArray<DesktopEnvironmentBootstrap> = [];
let cleanup: (() => void) | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
function refresh() {
  clearTimeout(retry);
  retry = undefined;
  const result = readDesktopSecondaryBootstrapsResult();
  if (result._tag === "Failure") {
    if (listeners.size > 0 && window.desktopBridge?.onLocalEnvironmentBootstrapsChanged) {
      retry = setTimeout(refresh, 2_000);
    }
    return;
  }
  const next = result.bootstraps;
  if (next === snapshot) return;
  snapshot = next;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    const onChange = window.desktopBridge?.onLocalEnvironmentBootstrapsChanged;
    if (onChange) {
      cleanup = onChange(refresh);
    } else if (window.desktopBridge) {
      // Older bridges have no producer notification. Share one fallback timer.
      const timer = setInterval(refresh, 2_000);
      cleanup = () => clearInterval(timer);
    }
    // Subscribe first so a change racing the initial read cannot be missed.
    refresh();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearTimeout(retry);
      retry = undefined;
      cleanup?.();
      cleanup = undefined;
    }
  };
}
/** Stable shared snapshots; failed bridge reads retain the latest successful topology. */
export function useDesktopLocalBootstraps() {
  return useSyncExternalStore(subscribe, () => snapshot);
}
