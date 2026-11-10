// Connector OAuth pending handshakes + the provider OAuth client
// registry (mirror M1, 2026-11-09 — DESIGN §5.2/§5.3; registry:
// m3-github/DESIGN.md §6).
//
// When a person presses Connect on a Helmian-brokered OAuth connector
// inside Helmian, Helmian starts the authorization road itself: it
// builds the authorize URL carrying a PKCE S256 challenge, and
// remembers the handshake so the callback can finish it. The pending
// row lives in helmion.connector_oauth_pending (sql/078), keyed by a
// HASH of the OAuth state — the state itself is never stored. Rows die
// 15 minutes after they start and are consumed (deleted) by the
// callback.
//
// FAIL-SOFT LAW: until sql/078 is applied the table is missing and
// save()/take() answer null instead of throwing — the write route
// turns that into one honest "the OAuth road is not switched on yet"
// answer and every other library write keeps working.
//
// DCR ROWS (sql/081): a handshake started on the self-registering
// road (connector-oauth-dcr.mjs) also carries the token endpoint
// and — only when the authorization server issued one — the client
// secret, so the callback can finish the exchange from the row
// alone. Those columns ride the insert ONLY on rows that carry
// them: a fixed-provider row's insert stays byte-identical to the
// sql/078 shape and keeps working before sql/081 lands, and a DCR
// row saved before sql/081 fails soft the same way (the missing
// column answers null, never a throw).
//
// THE REGISTRY: there is no default OAuth client. The callback
// resolves its client from the pending row's `provider` through
// createConnectorOAuthClient(); a provider with no registered client
// fails the callback honestly. GitHub is the registry's first member:
// one fixed OAuth App — no discovery fetch, no dynamic registration —
// whose client ID and secret live in the environment
// (GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET). With either
// unset, GitHub is absent from the registry: not configured, said
// plainly. The human consent at the provider stays the human's step;
// this module only carries Helmian's side of the road.

import { createHash, randomBytes } from 'node:crypto';

export const CONNECTOR_OAUTH_PENDING_TTL_MS = 15 * 60 * 1000;

const base64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const newOAuthState = () => base64url(randomBytes(32));
export const hashOAuthState = (state) => createHash('sha256').update(String(state ?? ''), 'utf8').digest('hex');
export const newPkceVerifier = () => base64url(randomBytes(32));
export const pkceChallenge = (verifier) => base64url(createHash('sha256').update(String(verifier), 'utf8').digest());

const isMissingTable = (error) => error?.code === '42P01' || error?.code === '3D000'
  || /connector_oauth_pending/.test(String(error?.message ?? '')) && /does not exist/.test(String(error?.message ?? ''));

// sql/081's columns, absent until that migration lands.
const isMissingDcrColumn = (error) => error?.code === '42703'
  && /(client_secret|token_endpoint|token_endpoint_auth_method)/.test(String(error?.message ?? ''));

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
      // The DCR fields (sql/081) join the insert only when the
      // handshake carries them — see the header note.
      const carriesDcr = pending.tokenEndpoint != null || pending.clientSecret != null || pending.tokenEndpointAuthMethod != null;
      const insertSql = carriesDcr
        ? `insert into helmion.connector_oauth_pending
             (tenant_id, state_hash, person_id, seat_id, entry_id, provider, client_id, code_verifier, redirect_uri, scopes, client_secret, token_endpoint, token_endpoint_auth_method, expires_at)
           values (current_setting('helmion.tenant_id', true), $1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $11, $12, $13, clock_timestamp() + ($10 || ' milliseconds')::interval)
           on conflict (tenant_id, state_hash) do nothing`
        : `insert into helmion.connector_oauth_pending
             (tenant_id, state_hash, person_id, seat_id, entry_id, provider, client_id, code_verifier, redirect_uri, scopes, expires_at)
           values (current_setting('helmion.tenant_id', true), $1, $2, $3, $4, $5, $6, $7, $8, $9::text[], clock_timestamp() + ($10 || ' milliseconds')::interval)
           on conflict (tenant_id, state_hash) do nothing`;
      const params = [pending.stateHash, pending.personId, pending.seatId, pending.entryId, pending.provider,
        pending.clientId, pending.codeVerifier, pending.redirectUri, pending.scopes ?? [], String(CONNECTOR_OAUTH_PENDING_TTL_MS)];
      if (carriesDcr) params.push(pending.clientSecret ?? null, pending.tokenEndpoint ?? null, pending.tokenEndpointAuthMethod ?? null);
      try {
        return await withTenant(tenantId, async (client) => {
          await client.query(insertSql, params);
          return true;
        });
      } catch (error) {
        if (isMissingTable(error)) return null;
        if (carriesDcr && isMissingDcrColumn(error)) return null;
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
            // sql/081's DCR fields: null on fixed-provider rows and
            // on rows read before the migration lands (the delete's
            // returning * simply has no such keys then).
            clientSecret: row.client_secret ?? null,
            tokenEndpoint: row.token_endpoint ?? null,
            tokenEndpointAuthMethod: row.token_endpoint_auth_method ?? null,
          };
        });
      } catch (error) {
        if (isMissingTable(error)) return null;
        throw error;
      }
    },
  };
}

// ----------------------------------------------------------------
// The provider registry (§6.2). A client is
// { provider, displayName, registerClient?, authorizeUrl,
//   exchangeCode, fetchIdentity? }
// — registerClient exists only for providers whose road registers a
// client per handshake; GitHub's does not. fetchImpl and env are
// injectable for tests.
//
// TWO KINDS live under this registry now: the FIXED kind below
// (a provider whose OAuth app Helmian pre-registered — GitHub) and
// the DCR kind in connector-oauth-dcr.mjs (a provider resolved by
// discovery from the entry's own endpoint, registering a fresh
// client per handshake). The fixed factory's contract is unchanged:
// it answers for fixed providers only, and a pending row carrying
// DCR fields is the DCR module's to resolve
// (resolvePendingOAuthClient there).

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';

// GitHub: one fixed OAuth App. No registration step, no discovery
// fetch — the endpoints are GitHub's documented ones and the client
// ID/secret come from the environment. The exchange posts the client
// secret server-side (GitHub's OAuth App exchange requires it,
// unlike a public-client flow) plus the PKCE verifier the pending
// machinery already minted; the design does not depend on the
// verifier being accepted — the state hash and the secret carry the
// handshake either way.
function createGithubOAuthClient({ fetchImpl, env }) {
  const clientId = String(env?.GITHUB_OAUTH_CLIENT_ID ?? '').trim();
  const clientSecret = String(env?.GITHUB_OAUTH_CLIENT_SECRET ?? '').trim();
  if (!clientId || !clientSecret) return null;
  return {
    provider: 'github',
    displayName: 'GitHub',
    async authorizeUrl({ redirectUri, state, challenge, scopes = [] }) {
      const url = new URL(GITHUB_AUTHORIZE_URL);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      if (scopes.length) url.searchParams.set('scope', [...scopes].join(' '));
      url.searchParams.set('state', state);
      if (challenge) {
        url.searchParams.set('code_challenge', challenge);
        url.searchParams.set('code_challenge_method', 'S256');
      }
      return url.toString();
    },
    async exchangeCode({ code, codeVerifier, redirectUri }) {
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      });
      if (codeVerifier) form.set('code_verifier', codeVerifier);
      const res = await fetchImpl(GITHUB_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: form.toString(),
      });
      const body = await res.json().catch(() => null);
      if (!res?.ok || !body?.access_token) {
        throw Object.assign(new Error(body?.error_description || body?.error || 'GitHub refused the code exchange'), { status: 502 });
      }
      return {
        accessToken: String(body.access_token),
        refreshToken: body.refresh_token ? String(body.refresh_token) : null,
        tokenType: body.token_type ? String(body.token_type) : 'Bearer',
        scope: body.scope ? String(body.scope) : null,
        expiresIn: Number.isFinite(Number(body.expires_in)) ? Number(body.expires_in) : null,
      };
    },
    // The person's GitHub login, fetched once at callback time so
    // the recorded accountIdentity is a fact, not a label. Fail-soft:
    // any miss answers null and the callback records the provider
    // label instead.
    async fetchIdentity({ accessToken }) {
      try {
        const res = await fetchImpl(GITHUB_USER_URL, {
          headers: { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json' },
        });
        if (!res?.ok) return null;
        const body = await res.json().catch(() => null);
        return body?.login ? String(body.login) : null;
      } catch { return null; }
    },
  };
}

const CONNECTOR_OAUTH_PROVIDERS = Object.freeze({
  github: createGithubOAuthClient,
});

// Resolve the OAuth client for a provider — always the pending
// row's provider, never a default. Returns null when the provider
// is unknown, or registered but not configured (GitHub with its
// environment pair unset).
export function createConnectorOAuthClient(provider, { fetchImpl = fetch, env = process.env } = {}) {
  const factory = CONNECTOR_OAUTH_PROVIDERS[String(provider ?? '').trim().toLowerCase()];
  if (!factory) return null;
  return factory({ fetchImpl, env });
}
