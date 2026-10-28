// xdai.io's old Burner Wallet registered a Workbox service worker at this path, which keeps serving the old app from
// its cache. Browsers re-fetch this file on navigation, find this one, and it removes itself and the old caches, then
// reloads open tabs onto the live site (PLAN-xdai.md). Our own worker is /sw.js.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) await caches.delete(k);
      await self.registration.unregister();
      for (const c of await self.clients.matchAll({ type: "window" })) c.navigate(c.url);
    })(),
  );
});
