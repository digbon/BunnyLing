/* BunnyLing · Service Worker v29
 * - Navegación (HTML): network-first con respaldo a caché.
 * - Recursos propios (shell + core.js + app.js): stale-while-revalidate.
 * - Video precacheado (countdown.mp4): soporte offline con respuestas 206 Partial Content (Range).
 * - CDN (cdnjs: pdf.js / jszip): stale-while-revalidate en caché runtime.
 */

const VER = 'v29';
const SHELL = `bunnyling-shell-${VER}`;
const RUNTIME = `bunnyling-runtime-${VER}`;

const PRECACHE = [
  './',
  './index.html',
  './core.js',
  './app.js',
  './manifest.webmanifest',
  './bunnyling-logo.svg',
  './countdown.mp4',
  './icon-192.png',
  './icon-512.png'
];

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
          .filter(k => k.startsWith('bunnyling-') && k !== SHELL && k !== RUNTIME)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

const isCDN = url => url.hostname === 'cdnjs.cloudflare.com';
const isNarrPath = url => url.pathname.includes('/bunnyling-narr/');

async function serveRangeRequest(request) {
  try {
    return await fetch(request);
  } catch {
    const cached = await caches.match(request.url, { ignoreSearch: true });
    if (!cached) return new Response('Offline', { status: 503 });
    const buf = await cached.arrayBuffer();
    const total = buf.byteLength;
    const rangeHeader = request.headers.get('range') || '';
    const m = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
    const start = m ? Math.min(Number(m[1]), total - 1) : 0;
    const end = m && m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
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

  if (request.headers.has('range')) {
    if (own) event.respondWith(serveRangeRequest(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok && response.status === 200) {
          const cache = await caches.open(SHELL);
          cache.put(request, response.clone()).catch(() => {});
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
      network.catch(() => {});
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