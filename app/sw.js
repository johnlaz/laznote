// LazNote service worker
// VERSION must match APP_VER in app.js and the stamp in index.html. Bump all three together.
// Every app on johnlaz.github.io shares one origin and one cache store, so this worker
// only ever touches caches that start with "laznote-".
const VERSION = '4.7.0'; // 2026-10-08
const CACHE_PREFIX = 'laznote-';
const CACHE_NAME = CACHE_PREFIX + 'v' + VERSION;

const PRECACHE = [
  './',
  './index.html',
  './app.js',
  './import.js',
  './styles.css',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
  // splash.mp4 is left out on purpose (large, played with range requests)
];

// Third-party files the app loads. Cached after the first online use so they survive offline.
const RUNTIME_HOSTS = ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

function store(request, response) {
  // Only whole, successful responses. Opaque (no-cors CDN) responses are allowed; 206 range replies are not.
  if (response && (response.status === 200 || response.type === 'opaque')) {
    const copy = response.clone();
    caches.open(CACHE_NAME).then(cache => cache.put(request, copy)).catch(() => {});
  }
  return response;
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || request.headers.has('range')) return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // Third-party: only the allow-listed hosts are cached. Groq and everything else go straight to the network.
  if (!sameOrigin) {
    if (!RUNTIME_HOSTS.includes(url.hostname)) return;
    event.respondWith(
      caches.match(request).then(cached => {
        const fresh = fetch(request).then(r => store(request, r)).catch(() => cached);
        return cached || fresh;
      })
    );
    return;
  }

  // Page loads: network first so a new release shows up, cached copy when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(r => store(request, r))
        .catch(() =>
          caches.match(request, { ignoreSearch: true })
            .then(c => c || caches.match('./index.html'))
        )
    );
    return;
  }

  // Code, styles and manifest: network first, cache when offline.
  // Images and media: cache first.
  const isImage = /\.(png|jpe?g|svg|gif|webp|ico|woff2?)$/i.test(url.pathname);
  if (isImage) {
    event.respondWith(
      caches.match(request).then(cached => cached || fetch(request).then(r => store(request, r)))
    );
    return;
  }
  if (/\.(mp4|webm)$/i.test(url.pathname)) return;

  event.respondWith(
    fetch(request)
      .then(r => store(request, r))
      .catch(() => caches.match(request))
  );
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
