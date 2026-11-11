/* BunnyLing · Service Worker
 * v9 — shell (HTML/CSS/JS) + runtime (CDN) con caches separadas.
 */
const VER = 'v9';
const CSSHELL = `bunnyling-shell-${VER}`;
const CRUNTIME = `bunnyling-runtime-${VER}`;

const PRECACHE = [
  './', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'
];

self.addEventListener('install', e => e.waitUntil(
  caches.open(CSSHELL)
    .then(c => Promise.allSettled(PRECACHE.map(u => c.add(u))))
    .then(() => self.skipWaiting())
));

self.addEventListener('activate', e => e.waitUntil(
  caches.keys()
    .then(ks => Promise.all(
      ks.filter(k => k !== CSSHELL && k !== CRUNTIME).map(k => caches.delete(k))
    ))
    .then(() => clients.claim())
    .then(() => console.log('[SW] activo:', VER))
));

const isCDN = u => u.hostname === 'cdnjs.cloudflare.com';

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  const own = u.origin === location.origin;
  if (!own && !isCDN(u)) return;
  if (req.headers.has('range')) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(r => {
          if (r.ok) caches.open(CSSHELL).then(c => c.put(req, r.clone()));
          return r;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then(h => h || caches.match('./')))
    );
    return;
  }

  const cacheName = own ? CSSHELL : CRUNTIME;
  e.respondWith(
    caches.match(req, { ignoreSearch: own }).then(hit => {
      const net = fetch(req)
        .then(r => {
          if (r.ok) caches.open(cacheName).then(c => c.put(req, r.clone()));
          return r;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
