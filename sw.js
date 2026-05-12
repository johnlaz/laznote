// LazNote Service Worker v2
// Strategy: Network-first for HTML, Cache-first for assets, Network-only for videos

const CACHE_NAME = 'laznote-v1';
const RUNTIME_CACHE = 'laznote-runtime-v1';

// Critical assets to pre-cache on install
const PRECACHE_URLS = [
  '/laznote/',
  '/laznote/index.html',
  '/laznote/manifest.json'
];

// ─── Install ────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Try to cache critical assets, but don't fail if some are missing
      return Promise.allSettled(
        PRECACHE_URLS.map(url =>
          cache.add(url).catch(err =>
            console.warn(`[SW] Precache skipped: ${url}`)
          )
        )
      );
    }).then(() => {
      self.skipWaiting();
    })
  );
});

// ─── Activate ───────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME && key !== RUNTIME_CACHE)
          .map(key => {
            console.log(`[SW] Deleting old cache: ${key}`);
            return caches.delete(key);
          })
      )
    ).then(() => {
      self.clients.claim();
    })
  );
});

// ─── Fetch ───────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GET requests
  if (request.method !== 'GET') return;
  
  // Skip chrome extensions
  if (!url.protocol.startsWith('http')) return;
  
  // Skip external domains (APIs, CDNs)
  if (url.origin !== self.location.origin) {
    return event.respondWith(
      fetch(request).catch(() => new Response('', { status: 503 }))
    );
  }

  // ── HTML navigation: Network-first
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(RUNTIME_CACHE).then(cache => cache.put(request, clone));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          // Fallback: show offline message
          return new Response(
            `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LazNote Offline</title></head><body style="font-family:sans-serif;padding:2rem;background:#0b0d0a;color:#f3f5ec"><h1>LazNote is offline</h1><p>You can still use cached pages. Check your connection and try again.</p></body></html>`,
            { headers: { 'Content-Type': 'text/html' } }
          );
        })
    );
    return;
  }

  // ── Videos: Network-only (range requests, too large)
  if (url.pathname.match(/\.(mp4|webm|ogv|mov)$/i)) {
    event.respondWith(
      fetch(request).catch(() => new Response('', { status: 503 }))
    );
    return;
  }

  // ── Static assets: Cache-first with network update
  if (shouldCache(request)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(request);
        
        // Return cached immediately
        if (cached) {
          // Update cache in background
          fetch(request)
            .then(response => {
              if (response.ok) cache.put(request, response.clone());
            })
            .catch(() => {});
          return cached;
        }

        // No cache: fetch from network
        try {
          const response = await fetch(request);
          if (response.ok) {
            cache.put(request, response.clone());
          }
          return response;
        } catch (error) {
          return new Response('', { status: 503 });
        }
      })
    );
    return;
  }

  // ── Default: Network-first
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(RUNTIME_CACHE).then(cache => cache.put(request, clone));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        return cached || new Response('', { status: 503 });
      })
  );
});

// ─── Helper ─────────────────────────────────────────────────────────────────
function shouldCache(request) {
  const { destination, url } = request;
  return (
    destination === 'style' ||
    destination === 'script' ||
    destination === 'image' ||
    destination === 'font' ||
    url.includes('.woff') ||
    url.includes('.woff2') ||
    url.includes('.png') ||
    url.includes('.jpg') ||
    url.includes('.jpeg') ||
    url.includes('.svg') ||
    url.includes('.gif')
  );
}

// ─── Message: Force update ───────────────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data.type === 'CLEAR_CACHE') {
    caches.keys().then(keys =>
      Promise.all(keys.map(key => caches.delete(key)))
    );
  }
});
