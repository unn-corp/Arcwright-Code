let sequence = 0;
let configuration: string | null = null;
const listeners = new Set<() => void>();

/** Freshness metadata is shared by automatic registration and explicit notification selection.
 * It never grants permission to replace a saved choice by itself. */
export function notificationRegistration(configurationId: string) {
  return { configurationId, sequence: ++sequence };
}
export function confirmNotificationConfiguration(id: string) {
  configuration = id;
  for (const listener of listeners) listener();
}
export function clearNotificationConfiguration(id: string) {
  if (configuration !== id) return;
  configuration = null;
  for (const listener of listeners) listener();
}
export const notificationConfiguration = {
  getSnapshot: () => configuration,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
