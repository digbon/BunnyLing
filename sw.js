/* BunnyLing · Service Worker
 * v22 — shell + CDN con stale-while-revalidate.
 *
 * Estrategia:
 *  - Navegación (HTML): network-first, con fallback a caché.
 *  - Recursos propios (mismo origen): stale-while-revalidate.
 *  - CDN (cdnjs): stale-while-revalidate en runtime.
 *  - Resto (API externas, blob:, subidas): no se intercepta.
 *
 * v22 — bump tras rediseñar la función 🤔 de sección confusa:
 *  - Se elimina el estado "desmarcar" del botón (ya no se puede
 *    desmarcar una sección guardada directamente desde el botón).
 *  - La sección se persiste por archivo en IndexedDB (clave
 *    confuse_<fileId>), sobrevive a cerrar y reabrir la app.
 *  - Al pulsar el botón con sección guardada se abre un diálogo
 *    de confirmación (<dialog id="cdlg">) con Revelar / Marcar de
 *    nuevo / Cancelar.
 *  - Durante el revelado, si el usuario pausa, los subtítulos
 *    permanecen visibles CONFUSE_PAUSE_GRACE ms (8 s) antes de
 *    ocultarse y terminar el revelado.
 *  - El revelado ya no se activa al marcar el fin: ahora hay que
 *    pulsar 💡 y confirmar en el diálogo.
 * La estrategia de caché no cambia; solo se invalida la versión
 * anterior para servir el nuevo shell.
 */

const VER = 'v22';
const SHELL = `bunnyling-shell-${VER}`;
const RUNTIME = `bunnyling-runtime-${VER}`;

const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL)
      .then(cache => Promise.allSettled(
        PRECACHE.map(url => cache.add(url))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key =>
            key.startsWith('bunnyling-') &&
            key !== SHELL &&
            key !== RUNTIME
          )
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
      .then(() => console.log('[SW] activo:', VER))
  );
});

const isCDN = url =>
  url.hostname === 'cdnjs.cloudflare.com';

// Los audios de la narración se sirven por blob: (File System Access API),
// nunca por fetch. Aun así, evitamos cachear cualquier ruta de esa carpeta
// por si en el futuro se sirviera desde el origen.
const isNarrPath = url =>
  url.pathname.includes('/bunnyling-narr/');

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

          event.waitUntil(
            cache.put(request, response.clone()).catch(() => {})
          );
        }

        return response;

      } catch {
        return (
          await caches.match(request, { ignoreSearch: true })
        ) ||
        (await caches.match('./index.html')) ||
        (await caches.match('./'));
      }
    })());

    return;
  }

  // Resto: stale-while-revalidate.
  const cacheName = own ? SHELL : RUNTIME;

  event.respondWith((async () => {
    const cached = await caches.match(request, {
      ignoreSearch: own
    });

    const network = fetch(request).then(async response => {
      // Solo cacheamos respuestas completas 200 OK.
      if (response && response.ok && response.status === 200) {
        const cache = await caches.open(cacheName);

        await cache.put(
          request,
          response.clone()
        ).catch(() => {});
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
      return new Response(
        'Recurso no disponible sin conexión',
        {
          status: 503,
          statusText: 'Offline',
          headers: {
            'Content-Type': 'text/plain; charset=utf-8'
          }
        }
      );
    }
  })());
});
