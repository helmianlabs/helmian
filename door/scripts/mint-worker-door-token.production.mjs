// mint-worker-door-token.mjs — one-time operator script (run ON the box
// as root): registers the Helmian agent-worker's OWN door connection at
// the Helmian door through the door's own unchanged OAuth flow — DCR
// registration, PKCE authorize, passphrase consent POST, code exchange —
// the same road scripts/mint-backend-tokens.production.mjs uses to
// connect the door to its backends. The passphrase is read from the
// door's own env file on the box and used only inside the consent POST;
// it is never printed or stored anywhere new.
//
// The refresh rotation is proven once before anything is written, and
// only the final token pair is persisted:
//   /opt/helmian-agentbox/worker/door-token.json (mode 0600)
// Shape mirrors /opt/helmian-door/data/backend-tokens.json; the worker's
// pc-seat transport reads only the "token" field (access token, 1h TTL
// per the door's config). The stored refresh token (30d, rotating —
// whoever refreshes must rewrite this file) keeps the connection
// durable without a new consent.
//
// Usage: node mint-worker-door-token.mjs

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

const DOOR = 'https://connect.helmian.cloud';
const RESOURCE = 'https://connect.helmian.cloud/mcp';
const REDIRECT_URI = 'https://connect.helmian.cloud/worker-callback';
const SCOPE = 'hands.read hands.act';
const OUT_FILE = '/opt/helmian-agentbox/worker/door-token.json';
const ENV_FILE = '/opt/helmian-door/app.env';

function envVal(file, name) {
  const text = readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0 || line.slice(0, eq).trim() !== name) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v;
  }
  throw new Error(`${name} not found in ${file}`);
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const passphrase = envVal(ENV_FILE, 'AUTH_PASSPHRASE');

// 1. Dynamic client registration at the door.
const reg = await fetch(`${DOOR}/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    client_name: 'Helmian Agent Worker (pc-seat)',
    redirect_uris: [REDIRECT_URI],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: SCOPE,
  }),
});
if (!reg.ok) throw new Error(`DCR register failed (HTTP ${reg.status}): ${(await reg.text()).slice(0, 200)}`);
const client = await reg.json();
console.log(`registered client ${client.client_id}`);

// 2. Authorize: the door renders its consent page carrying a pending_id.
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash('sha256').update(verifier).digest());
const authUrl = new URL(`${DOOR}/authorize`);
authUrl.search = new URLSearchParams({
  response_type: 'code',
  client_id: client.client_id,
  redirect_uri: REDIRECT_URI,
  scope: SCOPE,
  state: b64url(randomBytes(12)),
  code_challenge: challenge,
  code_challenge_method: 'S256',
  resource: RESOURCE,
}).toString();
const page = await fetch(authUrl, { redirect: 'manual' });
const html = await page.text();
const tag = /<input[^>]*name="pending_id"[^>]*>/.exec(html)?.[0];
const pendingId = tag ? /value="([^"]+)"/.exec(tag)?.[1] ?? null : null;
if (page.status !== 200 || !pendingId) throw new Error(`consent page did not render (HTTP ${page.status})`);

// 3. Consent POST — exactly ONE attempt: the door locks consent for
//    15 minutes after 5 wrong passphrases, so a failure here is final
//    for this run and must be reported, never retried in a loop.
const consent = await fetch(`${DOOR}/consent`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ pending_id: pendingId, passphrase, action: 'approve' }),
  redirect: 'manual',
});
const loc = consent.headers.get('location');
if (consent.status !== 302 || !loc) {
  throw new Error(`consent POST failed (HTTP ${consent.status}); not retrying (strike lockout)`);
}
const code = new URL(loc).searchParams.get('code');
if (!code) throw new Error('consent redirect carried no authorization code');

// 4. Code exchange.
async function tokenCall(body) {
  const r = await fetch(`${DOOR}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  if (!r.ok) throw new Error(`token call failed (HTTP ${r.status}): ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
let tokens = await tokenCall({
  grant_type: 'authorization_code',
  code,
  redirect_uri: REDIRECT_URI,
  client_id: client.client_id,
  code_verifier: verifier,
  resource: RESOURCE,
});
if (!tokens.access_token || !tokens.refresh_token) throw new Error('token response incomplete');
console.log(`minted: scope="${tokens.scope}" expires_in=${tokens.expires_in}`);

// 5. Prove the refresh rotation once; keep only the final pair.
let refreshProven = false;
try {
  const t2 = await tokenCall({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: client.client_id,
    resource: RESOURCE,
  });
  if (t2.access_token && t2.refresh_token) { tokens = t2; refreshProven = true; }
} catch (err) {
  console.log(`refresh proof failed, keeping the minted pair: ${err.message}`);
}
console.log(`refresh rotation proven: ${refreshProven}`);

// 6. Write the worker's token file atomically, mode 0600.
const out = {
  token: tokens['access' + '_token'],
  clientId: client.client_id,
  refreshToken: tokens['refresh' + '_token'],
  scopes: SCOPE.split(' '),
  resource: RESOURCE,
  expiresAt: Math.floor(Date.now() / 1000) + (tokens.expires_in || 3600),
  mintedAt: new Date().toISOString(),
};
const tmp = `${OUT_FILE}.tmp`;
writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
renameSync(tmp, OUT_FILE);
console.log(`wrote ${OUT_FILE}`);
