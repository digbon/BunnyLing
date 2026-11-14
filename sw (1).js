/* BunnyLing · Service Worker v30
 * - Navegación: red primero, con respaldo a caché.
 * - Recursos propios y CDN: stale-while-revalidate.
 * - APIs externas, blob: y peticiones con Range: no se interceptan.
 */
const VER = 'v30';
const SHELL = `bunnyling-shell-${VER}`;
const RUNTIME = `bunnyling-runtime-${VER}`;
const PRECACHE = ['./', './index.html', './manifest.webmanifest', './bunnyling-logo.svg', './icon-192.png', './icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL)
      .then(cache => Promise.allSettled(PRECACHE.map(url => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith('bunnyling-') && k !== SHELL && k !== RUNTIME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

const isCDN = url => url.hostname === 'cdnjs.cloudflare.com';
const cacheable = res => res && res.ok && res.status === 200;

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;

  const url = new URL(req.url);
  const own = url.origin === self.location.origin;
  if (!own && !isCDN(url)) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (cacheable(res)) {
          const copy = res.clone();
          event.waitUntil(caches.open(SHELL).then(c => c.put(req, copy)).catch(() => {}));
        }
        return res;
      } catch {
        return (await caches.match(req, { ignoreSearch: true }))
          || (await caches.match('./index.html'))
          || (await caches.match('./'))
          || new Response('Sin conexión', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: own });
    const network = fetch(req).then(res => {
      if (cacheable(res)) {
        const copy = res.clone();
        event.waitUntil(caches.open(own ? SHELL : RUNTIME).then(c => c.put(req, copy)).catch(() => {}));
      }
      return res;
    });
    if (cached) { event.waitUntil(network.catch(() => {})); return cached; }
    try {
      return await network;
    } catch {
      return new Response('Recurso no disponible sin conexión', {
        status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  })());
});
