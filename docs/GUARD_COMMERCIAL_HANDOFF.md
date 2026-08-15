# Guard commercial handoff

The marketing site now has one-time checkout handoffs for `helmian_individual` and `helmian_guard`. Checkout resolves each Stripe product's server-side `default_price`; no Stripe secret or client secret is returned to the browser. `helmian_bundle` is recognized only when `STRIPE_PRODUCT_HELMIAN_BUNDLE` is configured, so an absent bundle product remains unavailable.

Required server configuration before enabling payment:

- `STRIPE_SECRET_KEY` (server-only)
- `STRIPE_PRODUCT_HELMIAN_INDIVIDUAL` and `STRIPE_PRODUCT_HELMIAN_GUARD` (real Stripe product IDs)
- optional `STRIPE_PRODUCT_HELMIAN_BUNDLE` (only if a real bundle product exists)
- `STRIPE_WEBHOOK_SECRET` and a durable entitlement store for idempotent `checkout.session.completed` events
- a server-side customer/session resolver and private artifact resolver for download redirects
- `HELMION_SITE_ORIGIN` or a trusted forwarded host for checkout return URLs

The webhook and download routes fail closed without these dependencies. Download responses are never public artifact listings: an authenticated customer must hold the product entitlement, then the server returns a no-store redirect to a private artifact URL.

Guard browser packages remain staging-only. Chromium and Firefox output must pass review, be signed (Chrome Web Store / Mozilla AMO as applicable), and be served only from an approved private artifact channel. No store submission, Stripe account mutation, entitlement write, signing, or deployment was performed by this source change.
