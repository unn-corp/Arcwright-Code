import { useEffect, useState, type RefObject } from "react";
import { subscribeElapsedClock } from "../lib/elapsedClock";

/** Use in small elapsed components, never in a list or chat root. */
export function useElapsedNow(active: boolean, element?: RefObject<Element | null>) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (active) return subscribeElapsedClock(setNow, element?.current ?? undefined);
  }, [active, element]);
  return now;
}
