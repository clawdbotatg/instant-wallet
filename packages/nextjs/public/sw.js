/* Instant Wallet service worker: precache the shell, network-first for pages, never cache /api. */
const VERSION = "iw-v2";
const SHELL = ["/", "/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", event => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // API: always the network, never cached (balances, queue state, signatures).
  if (url.pathname.startsWith("/api/")) return;
  // Pages + assets: network first, cache as fallback (offline shell).
  event.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok && (req.mode === "navigate" || url.pathname.startsWith("/_next/static/") || SHELL.includes(url.pathname))) {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(req)) || (req.mode === "navigate" ? caches.match("/") : Response.error())),
  );
});
