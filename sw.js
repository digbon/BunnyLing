/* BunnyLing · Service Worker
 * v29 — Shell + CDN con stale-while-revalidate y soporte Range offline.
 *
 * Estrategia:
 *  - Navegación (HTML): network-first, con respaldo a caché offline.
 *  - Recursos propios (mismo origen): stale-while-revalidate en SHELL.
 *  - Video local precacheado (countdown.mp4 con cabecera Range): red primero y
 *    respaldo 206 Partial Content desde caché cuando no hay conexión.
 *  - CDN (cdnjs: pdf.js y jszip): stale-while-revalidate en RUNTIME.
 *  - Resto (APIs externas de IA/diccionario/voz, blob:, /bunnyling-narr/): no se intercepta.
 */

const VER = 'v29';
const SHELL = `bunnyling-shell-${VER}`;
const RUNTIME = `bunnyling-runtime-${VER}`;

const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './bunnyling-logo.svg',
  './countdown.mp4',
  './icon-192.png',
  './icon-512.png'
];

const safeWait = (event, promise) => {
  try { event.waitUntil(promise.catch(() => {})); } catch {}
};

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
        keys
          .filter(key => key.startsWith('bunnyling-') && key !== SHELL && key !== RUNTIME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
      .then(() => console.log('[SW] activo:', VER))
  );
});

const isCDN = url => url.hostname === 'cdnjs.cloudflare.com';
const isNarrPath = url => url.pathname.includes('/bunnyling-narr/');

async function handleRangeRequest(request) {
  try {
    return await fetch(request);
  } catch {
    const cached = await caches.match(request.url, { ignoreSearch: true });
    if (!cached) {
      return new Response('Recurso multimedia no disponible sin conexión', {
        status: 503,
        statusText: 'Offline'
      });
    }
    const buf = await cached.arrayBuffer();
    const total = buf.byteLength;
    if (!total) return cached;

    const rangeHeader = request.headers.get('range') || '';
    const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
    const start = match ? Math.min(Number(match[1]), total - 1) : 0;
    const end = match && match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
    const chunk = buf.slice(start, end + 1);

    return new Response(chunk, {
      status: 206,
      statusText: 'Partial Content',
      headers: {
        'Content-Type': cached.headers.get('Content-Type') || 'video/mp4',
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(chunk.byteLength)
      }
    });
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const own = url.origin === self.location.origin;

  if (!own && !isCDN(url)) return;
  if (isNarrPath(url)) return;

  // Peticiones de video/audio con Range (p. ej. countdown.mp4)
  if (request.headers.has('range')) {
    if (own) event.respondWith(handleRangeRequest(request));
    return;
  }

  // Navegación HTML: red primero, con respaldo a caché
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response && response.ok && response.status === 200) {
          const clone = response.clone();
          safeWait(event, caches.open(SHELL).then(cache => cache.put(request, clone)));
        }
        return response;
      } catch {
        return (
          (await caches.match(request, { ignoreSearch: true })) ||
          (await caches.match('./index.html')) ||
          (await caches.match('./'))
        );
      }
    })());
    return;
  }

  // Recursos estáticos propios y librerías CDN: stale-while-revalidate
  const cacheName = own ? SHELL : RUNTIME;

  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: own });

    const network = fetch(request).then(async response => {
      if (response && response.ok && response.status === 200) {
        const cache = await caches.open(cacheName);
        await cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    });

    if (cached) {
      safeWait(event, network);
      return cached;
    }

    try {
      return await network;
    } catch {
      return new Response('Recurso no disponible sin conexión', {
        status: 503,
        statusText: 'Offline',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  })());
});
