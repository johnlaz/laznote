// LazNote Landing Page — Service Worker
// Strategy: Cache-first for assets, Network-first for HTML

const CACHE_NAME = 'laznote-landing-v1';
const OFFLINE_URL = '/laznote/offline.html';

// Assets to pre-cache on install
const PRECACHE_ASSETS = [
  '/laznote/',
  '/laznote/index.html',
  '/laznote/offline.html',
  '/laznote/manifest.json',
  '/laznote/icons/icon-192.png',
  '/laznote/icons/icon-512.png',
];

// ─── Install ────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Use individual adds so one missing asset doesn't fail the whole install
      return Promise.allSettled(
        PRECACHE_ASSETS.map(url =>
          cache.add(url).catch(err =>
            console.warn(`[SW] Pre-cache skipped: ${url}`, err)
          )
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ─── Activate ───────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => {
            console.log(`[SW] Deleting old cache: ${key}`);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ─── Fetch ───────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GET requests
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Skip chrome-extension and non-http(s) schemes
  if (!url.protocol.startsWith('http')) return;

  // ── HTML navigation: Network-first, fall back to cache, then offline page
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          // Cache a fresh copy on success
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          // Last resort: offline fallback page
          return caches.match(OFFLINE_URL) || new Response(
            '<h1 style="font-family:sans-serif;padding:2rem">LazNote is offline</h1>',
            { headers: { 'Content-Type': 'text/html' } }
          );
        })
    );
    return;
  }

  // ── Videos: Network-only (too large to cache, range requests)
  if (url.pathname.match(/\.(mp4|webm|ogv)$/i)) {
    event.respondWith(fetch(request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // ── Static assets: Cache-first, update cache in background (stale-while-revalidate)
  event.respondWith(
    caches.open(CACHE_NAME).then(async cache => {
      const cached = await cache.match(request);
      const networkFetch = fetch(request).then(response => {
        if (response.ok) cache.put(request, response.clone());
        return response;
      }).catch(() => null);

      // Return cached immediately; let network update run in background
      return cached || networkFetch || new Response('', { status: 503 });
    })
  );
});

// ─── Message: force update ───────────────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
