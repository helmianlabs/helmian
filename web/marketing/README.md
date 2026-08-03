# Helmian marketing site

This is the dedicated public marketing surface. It is intentionally separate
from the private `helmion-hub` build-sharing prototype and from the desktop app.

## Verify locally

```powershell
npm run check
```

Serve this directory with any static HTTP server for browser review. There is no
framework, install step, database, analytics, form handler, or runtime secret.

## Add approved videos

Edit `site-config.js`. Each key maps to one card in `index.html`:

- `desktop-overview`
- `guard-review`
- `project-flow`

Set `src` to an approved HTTPS URL or a file under `/media/`. Add `poster` and
`caption` if available. An empty `src` keeps the honest placeholder visible.

## Add approved links

Edit the `links` object in `site-config.js`:

- `product-material` is the product notes/download destination.
- `contact` is the approved email or contact page.

Empty values keep the controls disabled rather than publishing a guessed route.

## Deploy

The site is configured for a static Vercel deployment. Run the local check first,
then deploy this directory to its dedicated Vercel project.

