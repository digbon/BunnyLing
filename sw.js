/* BunnyLing · Service Worker
 * v13 — caché de shell y recursos externos con actualización segura.
 */
const VER = 'v13';
const CSSHELL = `bunnyling-shell-${VER}`;
const CRUNTIME = `bunnyling-runtime-${VER}`;
const PRECACHE = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CSSHELL)
      .then(cache => Promise.allSettled(PRECACHE.map(url => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key.startsWith('bunnyling-') && key !== CSSHELL && key !== CRUNTIME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
      .then(() => console.log('[SW] activo:', VER))
  );
});

const isCDN = url => url.hostname === 'cdnjs.cloudflare.com';

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('range')) return;

  const url = new URL(request.url);
  const own = url.origin === self.location.origin;
  if (!own && !isCDN(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CSSHELL);
          event.waitUntil(cache.put(request, response.clone()).catch(() => {}));
        }
        return response;
      } catch {
        return (await caches.match(request, { ignoreSearch: true })) ||
          (await caches.match('./index.html')) ||
          (await caches.match('./'));
      }
    })());
    return;
  }

  const cacheName = own ? CSSHELL : CRUNTIME;
  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: own });
    const network = fetch(request).then(async response => {
      if (response && response.ok) {
        const cache = await caches.open(cacheName);
        await cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    });
    if (cached) {
      event.waitUntil(network.catch(() => {}));
      return cached;
    }
    try { return await network; }
    catch {
      return new Response('Recurso no disponible sin conexión', {
        status: 503, statusText: 'Offline',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  })());
});
