// Recovery alerts as notifications (web/lib/alerts.ts). Nothing else: no caching, no offline.
self.addEventListener("push", e => {
  let d = {};
  try {
    d = e.data.json();
  } catch {}
  e.waitUntil(self.registration.showNotification(d.title || "Instant Wallet", { body: d.body || "", data: { url: d.url || "/" }, requireInteraction: true }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data?.url || "/"));
});
