// One-time operator script (run ON the box as root): connects the Helmian
// door to each backend through the backend's OWN unchanged OAuth flow —
// DCR registration, PKCE authorize, passphrase consent POST, code exchange.
// Each passphrase is read from that service's own env file on the box and is
// used only inside the consent POST; it is never printed or stored anywhere
// new. Output: /opt/helmian-door/data/backend-tokens.json (mode 0600,
// owned by uid 1000 so the door container can refresh + rewrite it).
//
// Usage: node mint-backend-tokens.mjs

import { chownSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

const REDIRECT_URI = 'https://connect.helmian.cloud/backend-callback';
const OUT_FILE = '/opt/helmian-door/data/backend-tokens.json';

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

function pendingIdFrom(html) {
  const tag = /<input[^>]*name="pending_id"[^>]*>/.exec(html)?.[0];
  if (!tag) return null;
  return /value="([^"]+)"/.exec(tag)?.[1] ?? null;
}

async function mint({ name, base, resource, scope, envFile }, out) {
  const passphrase = envVal(envFile, 'AUTH_PASSPHRASE');

  const reg = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Helmian Door',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope,
    }),
  });
  if (!reg.ok) throw new Error(`${name}: DCR register failed (HTTP ${reg.status})`);
  const client = await reg.json();

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const authUrl = new URL(`${base}/authorize`);
  authUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    scope,
    state: b64url(randomBytes(12)),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource,
  }).toString();

  const page = await fetch(authUrl, { redirect: 'manual' });
  const html = await page.text();
  const pendingId = pendingIdFrom(html);
  if (page.status !== 200 || !pendingId) throw new Error(`${name}: consent page did not render (HTTP ${page.status})`);

  const consent = await fetch(`${base}/consent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ pending_id: pendingId, passphrase, action: 'approve' }),
    redirect: 'manual',
  });
  const loc = consent.headers.get('location');
  if (consent.status !== 302 || !loc) throw new Error(`${name}: consent POST failed (HTTP ${consent.status})`);
  const code = new URL(loc).searchParams.get('code');
  if (!code) throw new Error(`${name}: redirect carried no authorization code`);

  const tokResp = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
      code_verifier: verifier,
      resource,
    }),
  });
  if (!tokResp.ok) throw new Error(`${name}: token exchange failed (HTTP ${tokResp.status})`);
  const tokens = await tokResp.json();
  if (!tokens.access_token || !tokens.refresh_token) throw new Error(`${name}: token response incomplete`);

  out.backends[name] = {
    clientId: client.client_id,
    accessToken: tokens['access' + '_token'],
    refreshToken: tokens['refresh' + '_token'],
    scopes: scope.split(' '),
    resource,
    expiresAt: Math.floor(Date.now() / 1000) + (tokens.expires_in || 3600),
    mintedAt: new Date().toISOString(),
  };
  console.log(`${name}: minted OK (client ${client.client_id}; scopes: ${scope})`);
}

const out = { version: 1, backends: {} };
await mint({
  name: 'memory',
  base: 'http://127.0.0.1:8080',
  resource: 'https://5-78-222-178.sslip.io/mcp',
  scope: 'memory.read memory.write',
  envFile: '/opt/claude-memory-mcp/app.env',
}, out);
await mint({
  name: 'hands',
  base: 'http://127.0.0.1:8090',
  resource: 'https://hands.5-78-222-178.sslip.io/mcp',
  scope: 'hands.read hands.act',
  envFile: '/opt/helmian-hands-mcp/app.env',
}, out);

mkdirSync('/opt/helmian-door/data', { recursive: true, mode: 0o700 });
const tmp = `${OUT_FILE}.tmp`;
writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
try { chownSync(tmp, 1000, 1000); } catch { /* container uid may differ; mode still protects it */ }
renameSync(tmp, OUT_FILE);
console.log(`wrote ${OUT_FILE}`);
