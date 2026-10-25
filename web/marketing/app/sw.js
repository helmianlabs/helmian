// /app PWA service worker. Network-first for pages and shell; never touches /api/.
const CACHE_NAME = 'helmian-app-shell-v4';
const SHELL = ['/app/', '/app/app.css', '/app/app.js', '/app/app-model.mjs', '/app/envoy.css', '/app/envoy-workspace.js', '/app/avatars.mjs', '/app/manifest.webmanifest', '/assets/helmian-logo.png', '/favicon.svg'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((n) => Promise.all(n.filter((k) => k.startsWith('helmian-app-shell-') && k !== CACHE_NAME).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', (e) => {
  const r = e.request; const u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== self.location.origin || u.pathname.startsWith('/api/')) return;
  if (!(u.pathname.startsWith('/app') || SHELL.includes(u.pathname))) return;
  // cache: 'no-cache' is load-bearing (2026-10-25, the invisible Maestro
  // seat): a plain fetch(r) here is satisfied by any HTTP-cache entry the
  // browser still counts as fresh — including an entry stored under an
  // older, longer Cache-Control than the server sends today. That is how
  // a warm profile kept running a pre-deploy shell for hours after the
  // server-side headers were fixed and the CDN purged: the stored entry's
  // own lifetime, not the server's current answer, decided. 'no-cache'
  // forces revalidation with the origin before any stored shell response
  // is used, so a deploy reaches warm profiles on their next load.
  e.respondWith(fetch(r, { cache: 'no-cache' }).then((res) => { if (res.ok && SHELL.includes(u.pathname)) { const copy = res.clone(); caches.open(CACHE_NAME).then((c) => c.put(r, copy)); } return res; })
    .catch(() => caches.match(r).then((hit) => hit || (r.mode === 'navigate' ? caches.match('/app/') : undefined))));
});
