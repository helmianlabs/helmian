// Connector OAuth pending handshakes + the Scribe door OAuth client
// (mirror M1, 2026-11-09 — DESIGN §5.2/§5.3).
//
// When a person presses Connect on a Helmian-brokered OAuth connector
// inside Helmian, Helmian starts the authorization road itself: it
// registers (or reuses) an OAuth client at the provider, builds the
// authorize URL carrying a PKCE S256 challenge, and remembers the
// handshake so the callback can finish it. The pending row lives in
// helmion.connector_oauth_pending (sql/078), keyed by a HASH of the
// OAuth state — the state itself is never stored. Rows die 15 minutes
// after they start and are consumed (deleted) by the callback.
//
// FAIL-SOFT LAW: until sql/078 is applied the table is missing and
// save()/take() answer null instead of throwing — the write route
// turns that into one honest "the OAuth road is not switched on yet"
// answer and every other library write keeps working.
//
// The door client is the Scribe door's OAuth surface
// (https://connect.helmian.cloud — discovery fetched live
// 2026-11-09): DCR at /register, PKCE S256 only, authorization_code +
// refresh_token grants, public client (token_endpoint_auth_method
// "none"). The human consent at the door stays the human's step; this
// module only carries Helmian's side of the road.

import { createHash, randomBytes } from 'node:crypto';

export const CONNECTOR_OAUTH_PENDING_TTL_MS = 15 * 60 * 1000;
export const SCRIBE_DOOR_ISSUER = 'https://connect.helmian.cloud';
export const SCRIBE_DOOR_SCOPES = Object.freeze(['memory.read', 'memory.write', 'hands.read', 'hands.act']);

const base64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const newOAuthState = () => base64url(randomBytes(32));
export const hashOAuthState = (state) => createHash('sha256').update(String(state ?? ''), 'utf8').digest('hex');
export const newPkceVerifier = () => base64url(randomBytes(32));
export const pkceChallenge = (verifier) => base64url(createHash('sha256').update(String(verifier), 'utf8').digest());

const isMissingTable = (error) => error?.code === '42P01' || error?.code === '3D000'
  || /connector_oauth_pending/.test(String(error?.message ?? '')) && /does not exist/.test(String(error?.message ?? ''));

export function createConnectorOAuthPendingStore(pool) {
  const withTenant = async (tenantId, fn) => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('helmion.tenant_id', $1, true)`, [tenantId]);
      const out = await fn(client);
      await client.query('commit');
      return out;
    } catch (error) {
      try { await client.query('rollback'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  };
  const whereRow = `tenant_id = current_setting('helmion.tenant_id', true) and state_hash = $1`;
  return {
    // Returns true when the handshake was remembered, null when the
    // road is not switched on (table missing) — never throws for that.
    async save(tenantId, pending) {
      try {
        return await withTenant(tenantId, async (client) => {
          await client.query(
            `insert into helmion.connector_oauth_pending
               (tenant_id, state_hash, person_id, seat_id, entry_id, provider, client_id, code_verifier, redirect_uri, scopes, expires_at)
             values (current_setting('helmion.tenant_id', true), $1, $2, $3, $4, $5, $6, $7, $8, $9::text[], clock_timestamp() + ($10 || ' milliseconds')::interval)
             on conflict (tenant_id, state_hash) do nothing`,
            [pending.stateHash, pending.personId, pending.seatId, pending.entryId, pending.provider,
             pending.clientId, pending.codeVerifier, pending.redirectUri, pending.scopes ?? [], String(CONNECTOR_OAUTH_PENDING_TTL_MS)],
          );
          return true;
        });
      } catch (error) {
        if (isMissingTable(error)) return null;
        throw error;
      }
    },
    // Consume a handshake: returns the pending row exactly once, or
    // null when it is unknown, expired, or the road is not switched on.
    async take(tenantId, stateHash) {
      try {
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `delete from helmion.connector_oauth_pending where ${whereRow} and expires_at > clock_timestamp() returning *`,
            [stateHash],
          );
          const row = r.rows[0];
          if (!row) return null;
          return {
            personId: row.person_id, seatId: row.seat_id, entryId: row.entry_id, provider: row.provider,
            clientId: row.client_id, codeVerifier: row.code_verifier, redirectUri: row.redirect_uri,
            scopes: Array.isArray(row.scopes) ? row.scopes : [],
          };
        });
      } catch (error) {
        if (isMissingTable(error)) return null;
        throw error;
      }
    },
  };
}

// The Scribe door's OAuth client. fetchImpl is injectable for tests.
// Discovery is fetched once per instance and reused; client
// registration is per redirect URI (DCR is cheap and the door issues
// a fresh client per registration — the registration response IS the
// client record; nothing secret exists for a public PKCE client).
export function createScribeDoorOAuth({ fetchImpl = fetch, issuer = SCRIBE_DOOR_ISSUER } = {}) {
  const base = String(issuer).replace(/\/$/, '');
  let discoveryCache = null;
  async function discover() {
    if (discoveryCache) return discoveryCache;
    const res = await fetchImpl(`${base}/.well-known/oauth-authorization-server`);
    if (!res?.ok) throw Object.assign(new Error('the Scribe door did not answer its discovery document'), { status: 502 });
    discoveryCache = await res.json();
    return discoveryCache;
  }
  return {
    issuer: base,
    discover,
    async registerClient({ redirectUri, clientName = 'Helmian' }) {
      const meta = await discover();
      const endpoint = meta.registration_endpoint;
      if (!endpoint) throw Object.assign(new Error('the Scribe door offers no client registration'), { status: 502 });
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: clientName,
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          scope: SCRIBE_DOOR_SCOPES.join(' '),
        }),
      });
      if (!res?.ok) throw Object.assign(new Error('the Scribe door refused the client registration'), { status: 502 });
      const body = await res.json();
      if (!body?.client_id) throw Object.assign(new Error('the Scribe door registration carried no client_id'), { status: 502 });
      return { clientId: String(body.client_id) };
    },
    async authorizeUrl({ clientId, redirectUri, state, challenge, scopes = SCRIBE_DOOR_SCOPES }) {
      const meta = await discover();
      const url = new URL(meta.authorization_endpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('scope', [...scopes].join(' '));
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      return url.toString();
    },
    async exchangeCode({ clientId, code, codeVerifier, redirectUri }) {
      const meta = await discover();
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: codeVerifier,
      });
      const res = await fetchImpl(meta.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      const body = await res.json().catch(() => null);
      if (!res?.ok || !body?.access_token) {
        throw Object.assign(new Error(body?.error_description || body?.error || 'the Scribe door refused the code exchange'), { status: 502 });
      }
      return {
        accessToken: String(body.access_token),
        refreshToken: body.refresh_token ? String(body.refresh_token) : null,
        tokenType: body.token_type ? String(body.token_type) : 'Bearer',
        scope: body.scope ? String(body.scope) : null,
        expiresIn: Number.isFinite(Number(body.expires_in)) ? Number(body.expires_in) : null,
      };
    },
  };
}
