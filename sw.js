// One-time cleanup. The landing page used to register a service worker here.
// Browsers that still have it will pick up this file, which removes the old worker
// and its two old caches, then unregisters itself. Nothing registers it any more.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k === 'laznote-v1' || k === 'laznote-runtime-v1').map(k => caches.delete(k))
      ))
      .then(() => self.registration.unregister())
  );
});
