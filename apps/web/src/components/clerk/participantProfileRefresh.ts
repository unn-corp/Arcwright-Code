/** Refresh only visible clients, with one request at a time and no background polling. */
export function startParticipantProfileRefresh(refresh: () => Promise<void>): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  let running = false;
  let stopped = false;
  let lastAttempt = 0;
  const run = () => {
    if (
      stopped ||
      running ||
      document.visibilityState === "hidden" ||
      Date.now() - lastAttempt < 15_000
    )
      return;
    lastAttempt = Date.now();
    running = true;
    void refresh()
      .catch(() => {})
      .finally(() => {
        running = false;
      });
  };
  window.addEventListener("focus", run);
  document.addEventListener("visibilitychange", run);
  const interval = window.setInterval(run, 60_000);
  return () => {
    stopped = true;
    window.clearInterval(interval);
    window.removeEventListener("focus", run);
    document.removeEventListener("visibilitychange", run);
  };
}
