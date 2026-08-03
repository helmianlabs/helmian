const CACHE_NAME = 'helmian-pwa-shell-v14';
const SHELL = Object.freeze([
  '/herald/',
  '/herald/index.html',
  '/herald/styles.css',
  '/herald/shell.js',
  '/herald/shell-state.js',
  '/herald/account-runtime.js',
  '/herald/runtime.js',
  '/herald/icons.svg',
  '/herald/manifest.webmanifest',
  '/assets/helmian-logo.png',
]);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(
    names.filter((name) => (name.startsWith('helmian-herald-shell-') || name.startsWith('helmian-pwa-shell-')) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)),
  )));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate' && url.pathname.startsWith('/herald')) {
    event.respondWith(fetch(request).catch(() => caches.match('/herald/index.html')));
    return;
  }

  if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
  }
});
