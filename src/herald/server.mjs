// Helmion Herald — the phone half.
//
// A dependency-free HTTP server that serves ONE mobile-first page and ONE JSON
// endpoint, so Troy can open Helmion's status on his phone over Wi-Fi without an
// app store, a build step, or anything reaching the internet.
//
// THE SECURITY POSTURE, STATED PLAINLY, BECAUSE THIS OPENS A PORT:
//
//   READ-ONLY BY CONSTRUCTION. There is no route that writes anything. Not a
//   disabled one, not a guarded one — there is no write path in this file or in
//   digest.mjs. Approving a change from a phone means authenticating a human on
//   a device, and that is a separate piece of work with its own failure modes.
//
//   A TOKEN IS REQUIRED, and it is minted per run — 32 random bytes, never
//   stored, never reused. No token, no answer: every route returns 401 before it
//   reads a single file.
//
//   IT BINDS WHERE IT IS TOLD, and defaults to LOOPBACK. Serving to the LAN is
//   an explicit --host, because the difference between 127.0.0.1 and 0.0.0.0 is
//   the difference between "my machine" and "everyone on this coffee shop's
//   Wi-Fi", and that must never be a default nobody chose.
//
//   IT SERVES NO FILES. There is no static handler and no path parameter that
//   reaches the filesystem. The only disk reads are the three ledgers digest.mjs
//   knows about, at fixed paths under the workspace.
//
// The token is compared in CONSTANT TIME. A naive === on a secret leaks its
// length and prefix to anyone patient enough to time the responses.

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';

import { buildDigest } from './digest.mjs';

export const DEFAULT_PORT = 7420;

/** 32 bytes of real entropy, hex-encoded. Minted per run and never written down. */
export function mintToken() {
  return randomBytes(32).toString('hex');
}

/** Constant-time comparison that cannot throw on a length mismatch. */
export function tokenMatches(expected, supplied) {
  const a = Buffer.from(String(expected ?? ''), 'utf8');
  const b = Buffer.from(String(supplied ?? ''), 'utf8');
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Every LAN address this machine answers on, for the URL to hand the phone. */
export function lanAddresses() {
  const found = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) found.push(entry.address);
    }
  }
  return found;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * The page. Server-rendered, no framework, no fetch on load — it works the
 * instant it arrives even on a bad signal, which is the whole point of a thing
 * you check from a sofa or a truck cab.
 */
export function renderPage(digest, token) {
  const s = digest.summary;
  const tone = s.state === 'needs-you' ? '#e06c60' : s.state === 'unknown' ? '#c8a35a' : '#4cc38a';

  const refusals = digest.advisory.items.filter((d) => !d.allowed);

  const advisoryRows = refusals.length === 0
    ? '<p class="muted">No refused changes.</p>'
    : refusals.map((d) => `
      <div class="card stop">
        <div class="when">${escapeHtml(d.at ?? '')}</div>
        <div class="title">${escapeHtml(d.summary)}</div>
        <div class="why">${escapeHtml(d.why)}</div>
        ${d.blocks.length ? `<div class="tag">BLOCK: ${escapeHtml(d.blocks.join(' · '))}</div>` : ''}
        ${d.concerns.length ? `<div class="tag">CONCERN: ${escapeHtml(d.concerns.join(' · '))}</div>` : ''}
        ${d.missing.length ? `<div class="tag">no answer from: ${escapeHtml(d.missing.join(', '))}</div>` : ''}
      </div>`).join('');

  const blockRows = digest.blocks.items.length === 0
    ? '<p class="muted">Nothing blocked.</p>'
    : digest.blocks.items.slice(0, 12).map((b) => `
      <div class="card warn">
        <div class="when">${escapeHtml(b.at ?? '')} · ${escapeHtml(b.layer)}</div>
        <div class="mono">${escapeHtml(b.text)}</div>
        <div class="tag">matched: ${escapeHtml(b.matched)}</div>
      </div>`).join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>Helmion Herald</title>
<style>
:root{--bg:#0d1419;--panel:#101a22;--stroke:#263845;--ink:#f2fbff;--faint:#92a8b8}
*{box-sizing:border-box}
body{margin:0;padding:16px;background:var(--bg);color:var(--ink);
  font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif;
  padding-bottom:env(safe-area-inset-bottom)}
h1{font-size:16px;margin:0 0 2px}
h2{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--faint);margin:22px 0 8px}
.muted{color:var(--faint);font-size:13px}
.head{border-left:5px solid ${tone};background:var(--panel);border-radius:0 12px 12px 0;padding:14px 16px}
.state{font-size:11px;font-weight:800;letter-spacing:.09em;color:${tone}}
.headline{font-size:19px;font-weight:700;margin:4px 0 6px}
.card{background:var(--panel);border:1px solid var(--stroke);border-left-width:4px;
  border-radius:0 10px 10px 0;padding:11px 13px;margin-bottom:9px}
.card.stop{border-left-color:#e06c60}
.card.warn{border-left-color:#c8a35a}
.when{font-size:11px;color:var(--faint)}
.title{font-weight:650;margin:3px 0}
.why{font-size:13px;color:#c6d6e2}
.tag{font-size:11.5px;color:var(--faint);margin-top:5px;word-break:break-word}
.mono{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:12.5px;
  white-space:pre-wrap;word-break:break-word;margin:3px 0}
footer{margin-top:26px;border-top:1px solid var(--stroke);padding-top:12px}
a.refresh{display:block;text-align:center;margin-top:18px;padding:12px;border:1px solid var(--stroke);
  border-radius:10px;color:var(--ink);text-decoration:none;font-weight:600}
</style></head><body>

<h1>Helmion Herald</h1>
<p class="muted">${escapeHtml(digest.workspace)}</p>

<div class="head">
  <div class="state">${escapeHtml(s.state.toUpperCase())}</div>
  <div class="headline">${escapeHtml(s.headline)}</div>
  <div class="why">${escapeHtml(s.detail)}</div>
</div>

<h2>Write lease</h2>
<div class="card ${digest.lease.state === 'active' ? '' : 'warn'}">
  <div class="title">${escapeHtml(digest.lease.state)}</div>
  <div class="why">${digest.lease.computed
    ? escapeHtml(`${digest.lease.holder ?? '—'} · expires ${digest.lease.expiresAt ?? 'unknown'}`)
    : escapeHtml(`could not read: ${digest.lease.reason}`)}</div>
</div>

<h2>Refused changes</h2>
${advisoryRows}

<h2>Blocked commands</h2>
${blockRows}

<a class="refresh" href="/?token=${encodeURIComponent(token)}">Refresh</a>

<footer class="muted">
  Read-only. This page cannot approve, run or change anything — it only reports what
  Helmion already wrote to disk. Generated ${escapeHtml(digest.generatedAt)}.
</footer>
</body></html>`;
}

/**
 * Starts the Herald.
 *
 * @param {{workspace: string, host?: string, port?: number, token?: string}} options
 *   host defaults to LOOPBACK. Serving to the LAN is an explicit choice.
 */
export async function startHerald({
  workspace,
  host = '127.0.0.1',
  port = DEFAULT_PORT,
  token = mintToken(),
} = {}) {
  if (!workspace) throw new Error('Herald needs a workspace to report on');

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    // Authenticate BEFORE reading anything. A 401 must not depend on what is on
    // disk, or the response time itself leaks whether a workspace exists.
    const supplied = url.searchParams.get('token') ?? request.headers['x-helmion-token'];
    if (!tokenMatches(token, supplied)) {
      response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Helmion Herald: a valid token is required.\n');
      return;
    }

    // No route reads a path from the request. There is no static handler.
    if (request.method !== 'GET') {
      response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Helmion Herald is read-only.\n');
      return;
    }

    try {
      const digest = await buildDigest(workspace);
      if (url.pathname === '/api/digest') {
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(JSON.stringify(digest, null, 2));
        return;
      }

      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // It renders its own markup and loads nothing. Say so.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
        'referrer-policy': 'no-referrer',
      });
      response.end(renderPage(digest, token));
    } catch (error) {
      // A failure here must not read as a calm page.
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`Helmion Herald could not build a digest: ${error.message}\n`);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const actual = server.address();
  const urls = (host === '0.0.0.0' ? lanAddresses() : [host])
    .map((address) => `http://${address}:${actual.port}/?token=${token}`);

  return {
    token,
    host,
    port: actual.port,
    urls,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
