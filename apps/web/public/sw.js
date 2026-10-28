/* global self, caches */

/* Replace the legacy /sw.js cache-owning worker, clear its caches and reload clients onto the network. The SPA HTML fallback previously prevented worker updates. Preserve the separate /service-worker.js notification registration until every legacy client is reclaimed. */

self.addEventListener("install", () => {
  void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.registration.unregister();
      const windows = await self.clients.matchAll({ type: "window" });
      for (const client of windows) {
        // Re-navigate so the freed window loads from the network.
        client.navigate(client.url);
      }
    })(),
  );
});
