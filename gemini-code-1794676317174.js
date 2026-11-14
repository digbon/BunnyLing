/* BunnyLing Service Worker — Offline-First App Shell & Runtime Cache */
'use strict';

// Sube la versión al cambiar el HTML/CSS/JS del shell para invalidar el caché viejo.
// v2.6.1 — Corrige ocultamiento de traducciones párrafo por párrafo en modo 'hid'
//          y asegura que el botón 🌐 muestre/oculte manualmente solo 1 párrafo a la vez.
const CACHE_VERSION = 'bunnyling-v2.6.1';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const APP_SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './bunnyling-logo.svg',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

const EXTERNAL_RUNTIME_HOSTS = new Set([
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) =>
        Promise.allSettled(
          APP_SHELL_ASSETS.map((asset) =>
            cache.add(new Request(asset, { cache: 'reload' }))
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (!url.protocol.startsWith('http')) return;

  // Nunca cachear endpoints dinámicos de API, streams con Range, HMR,
  // ni el script inyectado por el entorno de AI Studio.
  if (
    url.pathname.startsWith('/api/') ||
    request.headers.has('range') ||
    url.pathname.includes('/@vite') ||
    url.pathname.includes('/node_modules/') ||
    url.pathname.startsWith('/_aistudio-iframe')
  ) {
    return;
  }

  // 1. Navegación: Network-first con fallback a index.html cacheado
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((c) => c.put('./index.html', copy));
          }
          return response;
        })
        .catch(async () => {
          const cached =
            (await caches.match(request)) ||
            (await caches.match('./index.html')) ||
            (await caches.match('./'));
          return cached || Response.error();
        })
    );
    return;
  }

  // 2. CDN (JSZip, PDF.js) y Google Fonts: Cache-first con refresh en background
  if (EXTERNAL_RUNTIME_HOSTS.has(url.hostname)) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const networkPromise = fetch(request)
          .then((response) => {
            if (response && (response.ok || response.type === 'opaque')) {
              cache.put(request, response.clone());
            }
            return response;
          })
          .catch(() => null);
        return cached || (await networkPromise) || Response.error();
      })
    );
    return;
  }

  // 3. Estáticos mismo origen (JS, CSS, SVG, PNG): Stale-While-Revalidate
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const cached =
          (await cache.match(request)) || (await caches.match(request));
        const networkFetch = fetch(request)
          .then((response) => {
            if (response && response.ok && response.status === 200) {
              cache.put(request, response.clone());
            }
            return response;
          })
          .catch(() => null);
        return cached || (await networkFetch) || Response.error();
      })
    );
  }
});