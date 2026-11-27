# Edge, DDoS and transport security

What the code does on its own, and what has to be switched on outside the
code (Cloudflare, Vercel, the Hetzner box). Written 2026-11-26 with the
Site Guard blocking change (branch `security/site-guard-blocking-1126`).
Nothing in this file has been changed on a live system; every item under
"Troy's toggles" is a manual step.

## How traffic reaches Helmian

| Surface | Path in | TLS ends at |
|---|---|---|
| `helmian.cloud` (website, `/app`, `/admin`, `/api/*`) | Cloudflare proxy, then Vercel | Cloudflare, then again at Vercel |
| Box services: `watch.`, `voice.`, `guard.`, `hands.` `<box-ip-dashed>.sslip.io` | Straight to the Hetzner box (no proxy) | Caddy on the box |
| Herald (phone status page) | Local network only | Plain http on the LAN, unless put behind a TLS proxy |

Checked from outside on 2026-11-26: `helmian.cloud` answers through
Cloudflare (`server: cloudflare`, `cf-ray`) with HSTS
`max-age=31536000; includeSubDomains`. On the box, `watch`, `voice` and
`guard` send HSTS and `nosniff`; `hands` sent neither (the hands-mcp
change below now sends them from the app).

## What the code now does

Application level (per instance, best effort):

- **Message floods** (unchanged): one sender over 90 messages in 60 s is
  stopped; flagged from 30 (`src/cloud/site-guard.mjs`).
- **HTTP rate limits** on the cloud function (`src/cloud/http-guard.mjs`,
  run first in `web/marketing/api/helmian-admin.js`): requests with a
  credential are counted per credential (default 1,200/min), anonymous
  requests per IP (300/min), and every request against a per-IP ceiling
  (6,000/min). Over the line: `429` with `Retry-After`. Defaults leave
  the app's fastest poll (4/s) and many seats behind one IP untouched.
- **Request size**: a declared body over 4 MB gets `413` before any
  route runs (routes keep their own smaller caps, 1 MB for most JSON).
- **Slow requests**: the Executive Guard, hands-mcp, the Scribe door, the
  Discord MCP server and Herald give a client 15 s to send its headers
  and 30 s to send the whole request (`408` after). Long polls and
  streamed replies are not cut off by this (checked on Node 24).
- **HTTPS only**: a request that arrived as plain http (by
  `x-forwarded-proto`) is redirected (`308`, GET/HEAD) or refused
  (`403`, everything else). Localhost is exempt.
- **Headers**: HSTS, `nosniff`, `Referrer-Policy`, `X-Frame-Options`,
  `X-Permitted-Cross-Domain-Policies` on function responses; the site
  CSP (`web/marketing/vercel.json`) gains `upgrade-insecure-requests` and
  `object-src 'none'`. hands-mcp now sends HSTS (when its public URL is
  https), `nosniff`, `X-Frame-Options: DENY` and
  `frame-ancestors 'none'` (its consent page takes a passphrase).
- **Cookies**: every session cookie was already `HttpOnly; Secure;
  SameSite`. Herald's pairing cookie had no `Secure`; it now adds it
  whenever the phone reached Herald over https.
- **Plain-http check**: `test/transport-tls.test.mjs` fails if runtime
  code gains a hard-coded `http://` or `ws://` URL to a real host. Today
  there are none; the only plain URLs are loopback and the address a
  local server prints about itself.

Switches (all default on): `HELMIAN_HTTP_GUARD=off`,
`HELMIAN_HTTP_REQUIRE_HTTPS=off`, and the numbers in
[CONFIGURATION.md](CONFIGURATION.md).

What the code cannot do: stop a volumetric DDoS. In-process counters
reset on every cold start, are per instance, and the request has already
cost a function invocation by the time they run. That has to be stopped
at the edge.

## Troy's toggles

### Cloudflare (helmian.cloud zone)

1. **SSL/TLS → Overview**: mode **Full (strict)**. (Anything less lets
   the Cloudflare-to-Vercel leg go unverified.)
2. **SSL/TLS → Edge Certificates**: **Always Use HTTPS** on; **Minimum
   TLS Version** 1.2; **TLS 1.3** on; **Automatic HTTPS Rewrites** on.
3. **Security → WAF → Rate limiting rules** (one rule is free):
   - `/api/*` and `/mcp`: 600 requests per 1 minute per IP, action
     Block for 1 minute. (Above the app's own per-credential limits, so
     real users never see it.)
   - If a second rule is available: `/api/signup` and `/admin/auth/*`,
     20 per minute per IP, action Managed Challenge.
4. **Security → Bots**: **Bot Fight Mode** on. Check after turning it on
   that the Discord/Slack bridges and the desktop runner still reach
   `/api/*` (they are not browsers); if they are challenged, add a WAF
   skip rule for requests that carry an `Authorization` header.
5. **During an attack only**: **Security → Settings → Under Attack
   Mode**. It challenges every browser and will block non-browser
   clients (bridges, runners), so turn it off when the attack ends.
6. **HSTS** (SSL/TLS → Edge Certificates → HSTS), only after step 1-2 are
   settled and every subdomain of helmian.cloud serves https: max-age 12
   months, include subdomains on, preload **off for now** (see below).

### Vercel (the marketing / app project)

1. **Firewall → Bot Protection** and **AI Bots** managed rulesets: on
   (free on all plans).
2. **Firewall → Rate limiting**: Hobby allows one rule. Because traffic
   comes through Cloudflare, Vercel sees Cloudflare's addresses, so an
   IP rule here would lump visitors together. Leave the rate rule to
   Cloudflare and use Vercel's slot only if the Cloudflare proxy is ever
   turned off.
3. **Attack Mode** (Firewall → menu → Enable Attack Mode): for a
   targeted attack only, 1/6/24 hours. Like Cloudflare's, it can block
   non-browser clients.
4. Preview deployments currently fail with "Account is blocked" (seen on
   PR #193 and #194). That is an account setting, not code.

### Hetzner box (Caddy and the host)

1. **Hetzner Cloud Firewall**: inbound 22, 80, 443 only (the README
   already asks for this); 22 limited to known addresses if possible.
2. **Caddy**: send the same headers on every site block, `hands`
   included. A snippet to add (not applied):

   ```caddyfile
   (secure_headers) {
   	header {
   		Strict-Transport-Security "max-age=31536000; includeSubDomains"
   		X-Content-Type-Options "nosniff"
   		X-Frame-Options "DENY"
   		Referrer-Policy "no-referrer"
   		-Server
   	}
   }
   # in each site block:  import secure_headers
   ```

   and server timeouts in the global block:

   ```caddyfile
   {
   	servers {
   		timeouts {
   			read_header 15s
   			idle 2m
   		}
   	}
   }
   ```

   Caddy already redirects http to https and renews certificates on its
   own.
3. **Request rate at the box**: the box has no proxy in front of it.
   Either put the box names behind Cloudflare (needs a real domain, see
   next item) or add a rate limit at Caddy (the `caddy-ratelimit`
   plugin) or the host firewall (`nftables` / `ufw limit` on 443).

### Move the box off sslip.io

Every box service is reached through `*.sslip.io`, a free third-party
DNS service that answers with the address written in the name. If that
service is down or hijacked, every box name can resolve to someone
else's server, and the only thing that would catch it is the
certificate check. Moving to names under `helmian.cloud` (the Hetzner
`.env.example` already names `voice.helmian.cloud` and
`relay.helmian.cloud`) puts DNS under Helmian's own account and allows
the box to sit behind Cloudflare. Steps: add A records for the box
names, add them to Caddy, update the four places the sslip names appear
(`web/marketing/vercel.json` CSP, `web/marketing/app/app.js`,
`web/shared/voice-dictation.mjs`, the spoke and guard defaults), then
retire the sslip names. This needs a deploy and DNS changes, so it is
not part of this change.

### Rotate the voice token

The text-to-speech bearer token is written into browser JavaScript
(`SERVED_TTS_TOKEN` in `web/marketing/app/app.js` and
`web/shared/voice-dictation.mjs`), so anyone can read it from the page.
Rotate it on the box and serve voice through a Helmian API route that
holds the token server-side. This needs a deploy, so it is listed here,
not done here.

### HSTS preload

Preloading puts `helmian.cloud` into the browsers' built-in https-only
list, so even a first visit can never be downgraded. It is hard to undo
(removal takes months), and it applies to every subdomain. Before
submitting:

1. Every subdomain of `helmian.cloud`, including any not yet created,
   must serve valid https.
2. Change the header to `max-age=63072000; includeSubDomains; preload`
   (both in `web/marketing/vercel.json` and in Cloudflare's HSTS
   setting).
3. Submit at https://hstspreload.org and check its report.

This repo does not add `preload` for Troy to decide on.

## What to check after toggling

- `curl -sI https://helmian.cloud | grep -i strict-transport`
- `curl -sI http://helmian.cloud` returns a redirect to https.
- `curl -sI https://hands.<box>.sslip.io/healthz` shows HSTS and nosniff
  (after the hands-mcp container is rebuilt with this change).
- The Discord and Slack bridges and a desktop runner still post and poll.
