import { useEffect, useState, type RefObject } from "react";
import { subscribeElapsedClock } from "../lib/elapsedClock";

/** Use in small elapsed components, never in a list or chat root. */
export function useElapsedNow(active: boolean, element?: RefObject<Element | null>) {
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes a mounted elapsed-time element to the shared visibility-aware clock
  useEffect(() => {
    if (active) return subscribeElapsedClock(setNow, element?.current ?? undefined);
  }, [active, element]);
  return now;
}
