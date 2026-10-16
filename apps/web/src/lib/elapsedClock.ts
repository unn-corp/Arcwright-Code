/** One wall-clock timer for visible elapsed labels; no accumulated tick counts. */
interface ClockListener {
  update: (nowMs: number) => void;
  element?: Element;
  visible: boolean;
}
const listeners = new Set<ClockListener>();
let timer: ReturnType<typeof setInterval> | undefined;
let observer: IntersectionObserver | undefined;

function reconcileClock() {
  const visible = typeof document !== "undefined" && document.visibilityState !== "hidden";
  if (visible) {
    const now = Date.now();
    for (const listener of listeners) {
      if (listener.visible) listener.update(now);
    }
  }
  const running = visible && [...listeners].some((listener) => listener.visible);
  if (running && timer === undefined) timer = setInterval(reconcileClock, 1_000);
  if (!running && timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}

export function subscribeElapsedClock(update: (nowMs: number) => void, element?: Element) {
  if (typeof document === "undefined") return () => {};
  if (listeners.size === 0) {
    document.addEventListener("visibilitychange", reconcileClock);
    if (typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          for (const listener of listeners) {
            if (listener.element === entry.target) listener.visible = entry.isIntersecting;
          }
        }
        reconcileClock();
      });
    }
  }
  const listener: ClockListener = {
    update,
    ...(element ? { element } : {}),
    visible: !element || !observer,
  };
  listeners.add(listener);
  if (element) observer?.observe(element);
  reconcileClock();
  return () => {
    listeners.delete(listener);
    if (element && ![...listeners].some((other) => other.element === element))
      observer?.unobserve(element);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = undefined;
      document.removeEventListener("visibilitychange", reconcileClock);
    }
    reconcileClock();
  };
}
