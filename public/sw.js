// Lunch Buddy service worker: shows family push alerts and opens the app when one is tapped.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Lunch Buddy', {
    body: d.body || 'New family update',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    icon: '/icons/icon-192.png',
    data: { url: d.url || '/?tab=family' }
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) {
      if (new URL(c.url).origin === self.location.origin) {
        await c.focus();
        c.postMessage({ type: 'lb-open', url });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
