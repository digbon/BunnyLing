/* BunnyLing · Service Worker
 * v15 — shell + CDN con stale-while-revalidate.
 *
 * Estrategia:
 *  - Navegación (HTML): network-first, con fallback a caché.
 *  - Recursos propios (mismo origen): stale-while-revalidate.
 *  - CDN (cdnjs): stale-while-revalidate en runtime.
 *  - Resto (API externas, blob:, subidas): no se intercepta.
 *
 * v15 — bump por cambios en index.html (coloreado eliminado y procesamiento
 *  por tramos del 10 % con disparo al 70 %). La estrategia no cambia; solo
 *  se invalida la caché anterior para servir el nuevo shell.
 */
const VER = 'v15';
const SHELL = `bunnyling-shell-${VER}`;
const RUNTIME = `bunnyling-runtime-${VER}`;
const PRECACHE = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

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
        keys.filter(key => key.startsWith('bunnyling-') && key !== SHELL && key !== RUNTIME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
      .then(() => console.log('[SW] activo:', VER))
  );
});

const isCDN = url => url.hostname === 'cdnjs.cloudflare.com';
// Los audios de la narración se sirven por blob: (File System Access API),
// nunca por fetch. Aun así, evitamos cachear cualquier ruta de esa carpeta
// por si en el futuro se sirviera desde el origen.
const isNarrPath = url => url.pathname.includes('/bunnyling-narr/');

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (request.headers.has('range')) return;

  const url = new URL(request.url);
  const own = url.origin === self.location.origin;
  if (!own && !isCDN(url)) return;
  if (isNarrPath(url)) return;

  // Navegación: red primero, con respaldo a caché.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok && response.status === 200) {
          const cache = await caches.open(SHELL);
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

  // Resto: stale-while-revalidate.
  const cacheName = own ? SHELL : RUNTIME;
  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: own });
    const network = fetch(request).then(async response => {
      // Solo cacheamos respuestas completas 200 OK.
      if (response && response.ok && response.status === 200) {
        const cache = await caches.open(cacheName);
        await cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    });
    if (cached) {
      event.waitUntil(network.catch(() => {}));
      return cached;
    }
    try {
      return await network;
    } catch {
      return new Response('Recurso no disponible sin conexión', {
        status: 503, statusText: 'Offline',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  })());
});
