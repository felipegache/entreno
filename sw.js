/* Service worker: guarda la app para usarla sin conexión. Cambiar VERSION en cada actualización. */
const VERSION = 'entreno-v1.1.0';
const FILES = ['./', './index.html', './app.js', './data.js', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES))); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', (e) => { if (e.data === 'skip') self.skipWaiting(); });
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
    const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return res;
  }).catch(() => caches.match('./index.html'))));
});
