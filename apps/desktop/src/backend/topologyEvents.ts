// Coalesce state transitions after their Effect/registry mutations finish.
const listeners = new Set<() => void>();
let queued = false;
export function notifyLocalEnvironmentTopologyChanged() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    for (const listener of listeners) listener();
  });
}
export function subscribeLocalEnvironmentTopology(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
