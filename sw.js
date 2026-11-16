
/* BunnyLing Service Worker — Offline-First App Shell & Runtime Cache */
'use strict';

// Sube la versión al cambiar el HTML/CSS/JS del shell para invalidar el caché viejo.
// v3.6.0 — Segmentos confusos resaltan según el cabezal de reproducción; narración TXT divide el texto sin perder palabras y alinea subtítulos al texto original.
// Antes: v3.5.0 — Unificado el botón de traducción en un solo control «Traducir todo» / «Ocultar traducción» que traduce o carga el segmento actual (10 %) y alterna visibilidad.
// Antes: v3.3.0 — Historial de lectura compartido durante narración; audio y subtítulos generados se guardan también en IndexedDB y reaparecen en Biblioteca.
// Antes: v3.2.0 — Deepgram pasa por Netlify Function del mismo origen; elimina CORS y relés públicos.
// Antes: v3.1.0 — Narración: audio + subtítulos (.mp3/.srt) se guardan acumulativos en la carpeta de Ajustes; ⏪/⏩ de la barra de
// narración saltan los segundos configurados (no de párrafo en párrafo); modelos de Gemini y Deepgram y voces
// de Deepgram se piden siempre a los servidores (sin catálogo escrito en el HTML).
// Antes: v3.0.0 — Narración por segmentos del 10 % con subtítulos Deepgram (modo subtítulos paralelo al modo texto);
// botón 🌐 disponible mientras se narra.
// Antes: v2.9.0 — Muestra cuántas veces faltan para cambiar una palabra de estado (lista de palabras y ventana de la palabra).
// Antes: v2.8.0 — Eliminada la cuenta regresiva (audio y visual); campo de tiempo HH:MM:SS con «:» fijos;
// el botón Diccionario solo aparece para palabras sueltas.
// Antes: v2.7.0 — La lupa muestra cuántas coincidencias encontró.
// Antes: v2.6.5 — Diccionario: formato real de la API (senses/translations), principal + otros significados;
// más espacio entre renglones para el contador del historial.
// Antes: v2.6.4 — Contador pendiente inicia en +0 en todos los modos; sin subtítulos: botón «última marca» que solo
// lleva al minuto; ✂️ actúa al soltar (evita tocar +x1 por el cambio de layout).
// Antes: v2.6.3 — ✂️ sin subtítulos: marca por tiempo (final, luego inicio por barra o campo manual).
// Antes: v2.6.2 — 🤔 por toque con corte exacto, reubicado junto al % leído.

const CACHE_VERSION = 'bunnyling-v3.6.0';
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
    url.pathname.startsWith('/.netlify/functions/') ||
    request.headers.has('range') ||
    url.pathname.includes('/@vite') ||
    url.pathname.includes('/node_modules/') ||
    url.pathname.startsWith('/_aistudio-iframe')
  ) {
    return;
  }

  // 1. Navegación: Network-first con fallback a index.html cacheado.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) =>
              cache.put('./index.html', copy)
            );
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

  // 2. CDN (JSZip, PDF.js) y Google Fonts:
  // Cache-first con actualización en segundo plano.
  if (EXTERNAL_RUNTIME_HOSTS.has(url.hostname)) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const cached = await cache.match(request);

        const networkPromise = fetch(request)
          .then((response) => {
            if (
              response &&
              (response.ok || response.type === 'opaque')
            ) {
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

  // 3. Estáticos del mismo origen (JS, CSS, SVG, PNG):
  // Stale-While-Revalidate.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const cached =
          (await cache.match(request)) ||
          (await caches.match(request));

        const networkFetch = fetch(request)
          .then((response) => {
            if (
              response &&
              response.ok &&
              response.status === 200
            ) {
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
