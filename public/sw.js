const CACHE_NAME = 'taskboards-v1';
const ASSETS = ['/', './index.html', './style.css', './app.js', './manifest.json', './config.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // NEVER intercept cross-origin requests (Google APIs, fonts, etc.)
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  // Only cache GET requests for local assets
  if (e.request.method !== 'GET') return;

  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
