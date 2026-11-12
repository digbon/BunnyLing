/* BunnyLing · Service Worker
 * v15 — shell + CDN con stale-while-revalidate.
 *
 * Navegación: red primero, caché como respaldo.
 * Recursos del mismo origen y cdnjs: stale-while-revalidate.
 * API externas, blob:, cargas y peticiones Range: no se interceptan.
 */
const VERSION = 'v15';
const SHELL_CACHE = `bunnyling-shell-${VERSION}`;
const RUNTIME_CACHE = `bunnyling-runtime-${VERSION}`;
const CACHE_PREFIX = 'bunnyling-';
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

const isCDN = url => url.hostname === 'cdnjs.cloudflare.com';
const isNarrationPath = url => url.pathname.includes('/bunnyling-narr/');
const offlineResponse = message => new Response(message, {
  status: 503,
  statusText: 'Offline',
  headers: { 'Content-Type': 'text/plain; charset=utf-8' }
});

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => Promise.allSettled(PRECACHE.map(path => cache.add(path))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key.startsWith(CACHE_PREFIX) &&
            key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
      .then(() => console.log('[SW] activo:', VERSION))
  );
});

async function cacheResponse(cacheName, request, response, own, url) {
  const isCompleteResponse = response?.ok && response.status === 200;
  // cdnjs suele responder como opaque a los scripts clásicos sin CORS.
  const isAllowedOpaqueCDN = !own && isCDN(url) && response?.type === 'opaque';
  if (!isCompleteResponse && !isAllowedOpaqueCDN) return;

  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone());
  } catch {
    // La app debe seguir funcionando aunque la caché esté llena o bloqueada.
  }
}

async function offlinePage(request) {
  const scope = self.registration.scope;
  return (await caches.match(request, { ignoreSearch: true })) ||
    (await caches.match(new URL('./index.html', scope))) ||
    (await caches.match(new URL('./', scope))) ||
    offlineResponse('La aplicación no está disponible sin conexión.');
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.headers.has('range')) return;

  const url = new URL(request.url);
  const own = url.origin === self.location.origin;
  if ((!own && !isCDN(url)) || isNarrationPath(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok && response.status === 200) {
          await cacheResponse(SHELL_CACHE, request, response, true, url);
        }
        return response;
      } catch {
        return offlinePage(request);
      }
    })());
    return;
  }

  const cacheName = own ? SHELL_CACHE : RUNTIME_CACHE;
  event.respondWith((async () => {
    let cached = null;
    try {
      cached = await caches.match(request, { ignoreSearch: own });
    } catch {
      // Si la caché falla, todavía intentamos la red.
    }

    const network = fetch(request).then(async response => {
      await cacheResponse(cacheName, request, response, own, url);
      return response;
    });

    if (cached) {
      event.waitUntil(network.catch(() => {}));
      return cached;
    }

    try {
      return await network;
    } catch {
      return offlineResponse('Recurso no disponible sin conexión');
    }
  })());
});
