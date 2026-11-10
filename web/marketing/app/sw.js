// /app PWA service worker. Network-first for pages and the unstamped
// shell; cache-first for content-stamped asset URLs (?v=…, see
// scripts/shell-stamp.mjs); never touches /api/.
const CACHE_NAME = 'helmian-app-shell-v5';
const SHELL = ['/app/', '/app/app.css?v=532eef9e5fbe752f', '/app/app.js?v=532eef9e5fbe752f', '/app/app-model.mjs?v=532eef9e5fbe752f', '/app/envoy.css?v=532eef9e5fbe752f', '/app/envoy-workspace.js?v=532eef9e5fbe752f', '/app/avatars.mjs?v=532eef9e5fbe752f', '/app/manifest.webmanifest', '/assets/helmian-logo.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((n) => Promise.all(n.filter((k) => k.startsWith('helmian-app-shell-') && k !== CACHE_NAME).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', (e) => {
  const r = e.request; const u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== self.location.origin || u.pathname.startsWith('/api/')) return;
  if (!(u.pathname.startsWith('/app') || SHELL.includes(u.pathname))) return;
  // A content-stamped URL (?v=…) is a content address: the same URL can
  // never name different bytes, so cache-first cannot serve a stale
  // shell — freshness flows through the document, which is never
  // stamped, still revalidates below, and names the current stamps.
  // Stamped assets therefore skip the round trip entirely: the worker
  // cache answers, and a miss fetches under the URL's own immutable
  // Cache-Control and is stored under its exact stamped URL.
  if (u.searchParams.has('v')) {
    e.respondWith(caches.match(r).then((hit) => hit || fetch(r).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE_NAME).then((c) => c.put(r, copy)); }
      return res;
    })));
    return;
  }
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
