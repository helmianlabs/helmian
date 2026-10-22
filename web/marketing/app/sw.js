// /app PWA service worker. Network-first for pages and shell; never touches /api/.
const CACHE_NAME = 'helmian-app-shell-v3';
const SHELL = ['/app/', '/app/app.css', '/app/app.js', '/app/app-model.mjs', '/app/envoy.css', '/app/envoy-workspace.js', '/app/avatars.mjs', '/app/manifest.webmanifest', '/assets/helmian-logo.png', '/favicon.svg'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((n) => Promise.all(n.filter((k) => k.startsWith('helmian-app-shell-') && k !== CACHE_NAME).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', (e) => {
  const r = e.request; const u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== self.location.origin || u.pathname.startsWith('/api/')) return;
  if (!(u.pathname.startsWith('/app') || SHELL.includes(u.pathname))) return;
  e.respondWith(fetch(r).then((res) => { if (res.ok && SHELL.includes(u.pathname)) { const copy = res.clone(); caches.open(CACHE_NAME).then((c) => c.put(r, copy)); } return res; })
    .catch(() => caches.match(r).then((hit) => hit || (r.mode === 'navigate' ? caches.match('/app/') : undefined))));
});
