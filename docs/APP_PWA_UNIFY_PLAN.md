# /app as the single installable Helmian PWA

## Done in this draft PR (safe, no env/secret change)
- `/app/manifest.webmanifest` + `/app/sw.js` (network-first, never caches `/api/`), registered from app.js. /app is now installable.
- `/app/pair` -> `/herald/pair` and `/app/remote` -> `/herald/` redirects (query string preserved by Vercel), so new links can use /app URLs today.

## Clerk mismatch (needs Troy)
- /app and /admin sign in through the admin server's OIDC on Clerk **witty-sawfly-97**.
- Herald (`/herald`, `/api/remote/*`, `/api/herald*`) reads `CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` from Vercel env, which point at **crucial-wildcat-22**.
- Fix: set those two Vercel env vars to witty-sawfly-97 keys and add helmian.cloud to `HELMION_HERALD_CLERK_AUTHORIZED_PARTIES`. That is a secret change, so **not done**. Side effect: Herald accounts made on crucial-wildcat-22 must sign in again (users are per instance); existing desktop enrollments keyed to old Clerk user ids need re-pairing.

## Next steps (after the Clerk switch)
1. DONE (draft PR): pairing page is a real page at /app/pair (app/pair.html, reusing /herald/app.js + pairing-link.js). /herald/pair and /herald/pair.html redirect to /app/pair; ?channel= links on /herald route to /app/pair; new desktop sessions get /app/pair phone URLs.
2. Add a "Devices" view in /app (Remote Control enroll: `/api/remote/v1/enrollment`, desktops list).
3. Make `/herald/*` redirect to `/app/*`; have herald/sw.js unregister itself and delete `helmian-pwa-shell-*` caches.
4. Update scripts/verify.mjs and test/herald-runtime.test.mjs manifest-scope asserts.
