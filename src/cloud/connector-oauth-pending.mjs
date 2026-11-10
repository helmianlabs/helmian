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
//
// Bite R2 (2026-11-10) adds the team-work family to the same
// registry — Slack, Asana, HubSpot — each an app pre-registered in
// the provider's own console (none of the three offers dynamic
// client registration; live metadata reads in the R2 report), each
// pair held as project env the same way (SLACK_OAUTH_*,
// ASANA_OAUTH_*, HUBSPOT_OAUTH_*), each absent from the registry —
// not configured, said plainly — until its pair is placed.
//
// The Google family bite (2026-11-10) adds ONE more member for
// three catalog entries: 'google', the single Google Cloud OAuth
// client covering Gmail, Google Calendar, and Google Drive
// (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET). Google's
// authorization-server metadata names no registration endpoint
// and no CIMD support (live read, 2026-11-10), so the fixed road
// is the only road; the per-product scopes ride the catalog
// entries' own declarations, never a per-provider table.
//
// The fixed-tail bite (2026-11-10) adds two more members, one
// catalog entry each: 'canva' (CANVA_OAUTH_CLIENT_ID /
// CANVA_OAUTH_CLIENT_SECRET — a Canva Developer Portal app with
// Canva MCP turned on) and 'dropbox' (DROPBOX_OAUTH_CLIENT_ID /
// DROPBOX_OAUTH_CLIENT_SECRET — a Dropbox App Console app's App
// key / App secret). Neither road lets Helmian register itself
// for MCP use (Canva: fixed Developer Portal app, CIMD only via
// a waitlist application; Dropbox: MCP dynamic registration is
// limited to a trusted set of named clients — live reads,
// 2026-11-10, in the bite report), so the fixed road is the
// road for both; each entry's scopes ride its own catalog
// declaration, never a per-provider table.

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
    // The client ID this client was built from — the write route
    // names it on the pending row (the exchange never reads it;
    // the factory's own pair rules). Exposed so the route needs no
    // provider-specific env read of its own.
    clientId,
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
    async refreshTokens({ refreshToken }) {
      return exchangeRefreshTokenForm({
        fetchImpl, tokenUrl: GITHUB_TOKEN_URL, clientId, clientSecret,
        refreshToken, providerName: 'GitHub',
      });
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

// ------------------------------------------ the team-work family
// (Bite R2). Each road's endpoints are the ones the provider's own
// metadata names (live reads, 2026-11-10): Slack's authorization
// server document points at its user-token authorize endpoint and
// its Web API token method; Asana's at its standard OAuth pair;
// HubSpot's MCP server is its own authorization server and names an
// MCP-specific authorize path and token endpoint. Exchanges are
// client_secret_post form posts, the method each server publishes.

// The standard OAuth JSON exchange, shared by the roads whose
// token endpoint answers plain OAuth JSON: refusal is a non-2xx
// status or a missing access token.
async function exchangeAuthorizationCodeForm({ fetchImpl, tokenUrl, clientId, clientSecret, code, codeVerifier, redirectUri, providerName }) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: String(code),
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
  if (codeVerifier) form.set('code_verifier', codeVerifier);
  const fetched = await fetchImpl(tokenUrl, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const body = await fetched.json().catch(() => null);
  if (!fetched?.ok || !body?.access_token) {
    throw Object.assign(new Error(body?.error_description || body?.error || `${providerName} refused the code exchange`), { status: 502 });
  }
  return {
    accessToken: String(body.access_token),
    refreshToken: body.refresh_token ? String(body.refresh_token) : null,
    tokenType: body.token_type ? String(body.token_type) : 'Bearer',
    scope: body.scope ? String(body.scope) : null,
    expiresIn: Number.isFinite(Number(body.expires_in)) ? Number(body.expires_in) : null,
  };
}

// The refresh exchange, sibling of the code exchange above
// (PLAN B5, 2026-11-10): a grant_type=refresh_token POST to the
// SAME token endpoint, with the factory's own client pair — the
// endpoints and credentials live here and nowhere else, so the
// arming dispatch's refresh leg asks this factory for a client
// instead of hardcoding a second copy of either. The return is
// the exchange bundle's exact shape. A provider ANSWER that
// refuses the grant (an OAuth error body, e.g. a revoked
// refresh token's invalid_grant) is marked refreshRefused so the
// caller can tell a dead grant from an unreachable endpoint:
// only the former may mark a connection needs-reconnect. A
// network failure throws out of fetchImpl unmarked, and an
// answer with no OAuth error and no token is unmarked too.
async function exchangeRefreshTokenForm({ fetchImpl, tokenUrl, clientId, clientSecret, refreshToken, providerName }) {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: String(refreshToken),
    client_id: clientId,
    client_secret: clientSecret,
  });
  const fetched = await fetchImpl(tokenUrl, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const body = await fetched.json().catch(() => null);
  if (!fetched?.ok || !body?.access_token) {
    throw Object.assign(
      new Error(body?.error_description || body?.error || `${providerName} refused the refresh exchange`),
      { status: 502, refreshRefused: Boolean(body?.error) },
    );
  }
  return {
    accessToken: String(body.access_token),
    refreshToken: body.refresh_token ? String(body.refresh_token) : null,
    tokenType: body.token_type ? String(body.token_type) : 'Bearer',
    scope: body.scope ? String(body.scope) : null,
    expiresIn: Number.isFinite(Number(body.expires_in)) ? Number(body.expires_in) : null,
  };
}

// The Basic-auth token exchange, sibling of the two helpers
// above (fixed-tail bite, 2026-11-10): the client pair rides the
// Authorization header as HTTP Basic (RFC 6749 §2.3.1) and never
// rides the form — the shape Canva's Connect authentication
// page recommends for its token endpoint ("Requests to the
// endpoint must be authenticated, and we recommend using the
// basic access authentication method"). One helper serves both
// grants so the code exchange and the refresh exchange can
// never drift apart in endpoint, credentials, or shape; a
// refresh refusal is marked refreshRefused exactly like the
// client_secret_post sibling's.
async function exchangeTokenFormBasic({ fetchImpl, tokenUrl, clientId, clientSecret, form, providerName, isRefresh = false }) {
  const fetched = await fetchImpl(tokenUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`,
    },
    body: form.toString(),
  });
  const body = await fetched.json().catch(() => null);
  if (!fetched?.ok || !body?.access_token) {
    throw Object.assign(
      new Error(body?.error_description || body?.error || `${providerName} refused the ${isRefresh ? 'refresh' : 'code'} exchange`),
      { status: 502, ...(isRefresh ? { refreshRefused: Boolean(body?.error) } : {}) },
    );
  }
  return {
    accessToken: String(body.access_token),
    refreshToken: body.refresh_token ? String(body.refresh_token) : null,
    tokenType: body.token_type ? String(body.token_type) : 'Bearer',
    scope: body.scope ? String(body.scope) : null,
    expiresIn: Number.isFinite(Number(body.expires_in)) ? Number(body.expires_in) : null,
  };
}

// Slack: the pre-registered app (MCP turned on; internal or
// Marketplace-published — Slack's own rule), user-token scopes.
const SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2_user/authorize';
const SLACK_TOKEN_URL = 'https://slack.com/api/oauth.v2.user.access';
const SLACK_AUTH_TEST_URL = 'https://slack.com/api/auth.test';

function createSlackOAuthClient({ fetchImpl, env }) {
  const clientId = String(env?.SLACK_OAUTH_CLIENT_ID ?? '').trim();
  const clientSecret = String(env?.SLACK_OAUTH_CLIENT_SECRET ?? '').trim();
  if (!clientId || !clientSecret) return null;
  return {
    provider: 'slack',
    displayName: 'Slack',
    clientId,
    async authorizeUrl({ redirectUri, state, challenge, scopes }) {
      // On the user-token authorize endpoint the `scope` parameter
      // names the USER scopes — the list the write route's declared
      // ask carries.
      const url = new URL(SLACK_AUTHORIZE_URL);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      if (Array.isArray(scopes) && scopes.length) url.searchParams.set('scope', scopes.join(' '));
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
      const fetched = await fetchImpl(SLACK_TOKEN_URL, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      const body = await fetched.json().catch(() => null);
      // Slack's Web API shape answers even a refusal with HTTP 200:
      // ok:false and an error name, with no token — that is a
      // refusal, never a success with an empty token.
      if (!fetched?.ok || body?.ok === false || !body?.access_token) {
        throw Object.assign(new Error(body?.error || 'Slack refused the code exchange'), { status: 502 });
      }
      return {
        accessToken: String(body.access_token),
        // Present only when the app has token rotation turned on;
        // Slack user tokens otherwise do not expire. This client
        // deliberately exposes NO refreshTokens: with rotation off
        // there is nothing to refresh, so the arming dispatch's
        // refresh leg (which keys off the factory's own shape)
        // never fires for Slack.
        refreshToken: body.refresh_token ? String(body.refresh_token) : null,
        tokenType: body.token_type ? String(body.token_type) : 'Bearer',
        scope: body.scope ? String(body.scope) : null,
        expiresIn: Number.isFinite(Number(body.expires_in)) ? Number(body.expires_in) : null,
      };
    },
    async fetchIdentity({ accessToken }) {
      // Slack's auth.test: answers who the token belongs to. Same
      // never-throw rule as GitHub's: a failed identity read leaves
      // the label to the provider name.
      try {
        const fetched = await fetchImpl(SLACK_AUTH_TEST_URL, {
          method: 'POST',
          headers: { authorization: `Bearer ${accessToken}` },
        });
        if (!fetched?.ok) return null;
        const body = await fetched.json().catch(() => null);
        return body?.ok === true && body?.user ? String(body.user) : null;
      } catch { return null; }
    },
  };
}

// Asana: the pre-registered "MCP app" from Asana's developer
// console. Asana defines no permission split for MCP apps — its own
// guide says to use the `default` scope or omit the parameter, and
// that including a scope parameter produces an error — so this road
// sends NO scope parameter at all, whatever the caller passes.
const ASANA_AUTHORIZE_URL = 'https://app.asana.com/-/oauth_authorize';
const ASANA_TOKEN_URL = 'https://app.asana.com/-/oauth_token';
const ASANA_RESOURCE = 'https://mcp.asana.com/v2';

function createAsanaOAuthClient({ fetchImpl, env }) {
  const clientId = String(env?.ASANA_OAUTH_CLIENT_ID ?? '').trim();
  const clientSecret = String(env?.ASANA_OAUTH_CLIENT_SECRET ?? '').trim();
  if (!clientId || !clientSecret) return null;
  return {
    provider: 'asana',
    displayName: 'Asana',
    clientId,
    async authorizeUrl({ redirectUri, state, challenge }) {
      const url = new URL(ASANA_AUTHORIZE_URL);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      // The resource indicator Asana's own guide requires: the MCP
      // server the token is for. Tokens minted here work ONLY
      // against that server, never Asana's standard API.
      url.searchParams.set('resource', ASANA_RESOURCE);
      url.searchParams.set('state', state);
      if (challenge) {
        url.searchParams.set('code_challenge', challenge);
        url.searchParams.set('code_challenge_method', 'S256');
      }
      return url.toString();
    },
    async exchangeCode({ code, codeVerifier, redirectUri }) {
      return exchangeAuthorizationCodeForm({
        fetchImpl, tokenUrl: ASANA_TOKEN_URL, clientId, clientSecret,
        code, codeVerifier, redirectUri, providerName: 'Asana',
      });
    },
    async refreshTokens({ refreshToken }) {
      return exchangeRefreshTokenForm({
        fetchImpl, tokenUrl: ASANA_TOKEN_URL, clientId, clientSecret,
        refreshToken, providerName: 'Asana',
      });
    },
    // No fetchIdentity: an MCP token cannot call Asana's standard
    // API (Asana's own note), so there is no honest identity read
    // on this road — the callback records the provider label.
  };
}

// HubSpot: the pre-registered "MCP connector" created in HubSpot
// itself (Development → MCP Connectors), which shows its client ID
// and secret on the connector's own details page. HubSpot defines
// no scopes on the connector — its consent page derives them from
// the server's tools and the person's own permissions — so this
// road sends no scope parameter either. PKCE is mandatory on
// HubSpot's road (its own integration guide).
const HUBSPOT_AUTHORIZE_URL = 'https://mcp.hubspot.com/oauth/authorize/user';
const HUBSPOT_TOKEN_URL = 'https://mcp.hubspot.com/oauth/v3/token';
const hubspotTokenInfoUrl = (accessToken) => `https://api.hubapi.com/oauth/v1/access-tokens/${encodeURIComponent(accessToken)}`;

function createHubSpotOAuthClient({ fetchImpl, env }) {
  const clientId = String(env?.HUBSPOT_OAUTH_CLIENT_ID ?? '').trim();
  const clientSecret = String(env?.HUBSPOT_OAUTH_CLIENT_SECRET ?? '').trim();
  if (!clientId || !clientSecret) return null;
  return {
    provider: 'hubspot',
    displayName: 'HubSpot',
    clientId,
    async authorizeUrl({ redirectUri, state, challenge }) {
      const url = new URL(HUBSPOT_AUTHORIZE_URL);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      if (challenge) {
        url.searchParams.set('code_challenge', challenge);
        url.searchParams.set('code_challenge_method', 'S256');
      }
      return url.toString();
    },
    async exchangeCode({ code, codeVerifier, redirectUri }) {
      return exchangeAuthorizationCodeForm({
        fetchImpl, tokenUrl: HUBSPOT_TOKEN_URL, clientId, clientSecret,
        code, codeVerifier, redirectUri, providerName: 'HubSpot',
      });
    },
    async refreshTokens({ refreshToken }) {
      return exchangeRefreshTokenForm({
        fetchImpl, tokenUrl: HUBSPOT_TOKEN_URL, clientId, clientSecret,
        refreshToken, providerName: 'HubSpot',
      });
    },
    async fetchIdentity({ accessToken }) {
      // HubSpot's token-info read: whose token this is. Fail-soft,
      // the registry's standing rule.
      try {
        const fetched = await fetchImpl(hubspotTokenInfoUrl(accessToken), {
          headers: { accept: 'application/json' },
        });
        if (!fetched?.ok) return null;
        const body = await fetched.json().catch(() => null);
        return body?.user ? String(body.user) : null;
      } catch { return null; }
    },
  };
}

// Google: ONE pre-registered Google Cloud OAuth client (Web
// application, "Use this client for an AI-powered agent") covering
// all three Workspace MCP servers — Gmail, Calendar, Drive. The
// endpoints are the ones Google's own authorization-server
// metadata names (live read, 2026-11-10): authorize at
// accounts.google.com, token at oauth2.googleapis.com, PKCE S256,
// grants authorization_code + refresh_token. The exchange is
// client_secret_post, the method Google's Web-application client
// runs. Two authorize parameters are this road's law, shaped here
// in the factory the way Asana's factory shapes its resource
// indicator: access_type=offline + prompt=consent — without them
// Google issues NO refresh token and the person re-signs-in about
// every hour (Google's own Workspace MCP guide). The scopes are
// NOT shaped here: each catalog entry declares its own product
// scopes and the write route passes that entry's declared ask in.
const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

function createGoogleOAuthClient({ fetchImpl, env }) {
  const clientId = String(env?.GOOGLE_OAUTH_CLIENT_ID ?? '').trim();
  const clientSecret = String(env?.GOOGLE_OAUTH_CLIENT_SECRET ?? '').trim();
  if (!clientId || !clientSecret) return null;
  return {
    provider: 'google',
    displayName: 'Google',
    clientId,
    async authorizeUrl({ redirectUri, state, challenge, scopes }) {
      const url = new URL(GOOGLE_AUTHORIZE_URL);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      if (Array.isArray(scopes) && scopes.length) url.searchParams.set('scope', scopes.join(' '));
      url.searchParams.set('state', state);
      if (challenge) {
        url.searchParams.set('code_challenge', challenge);
        url.searchParams.set('code_challenge_method', 'S256');
      }
      // The refresh-token pair (see the factory note): offline
      // access is what makes Google issue a refresh token at all,
      // and consent is what makes it re-issue one on a later
      // connect instead of silently withholding it.
      url.searchParams.set('access_type', 'offline');
      url.searchParams.set('prompt', 'consent');
      return url.toString();
    },
    async exchangeCode({ code, codeVerifier, redirectUri }) {
      return exchangeAuthorizationCodeForm({
        fetchImpl, tokenUrl: GOOGLE_TOKEN_URL, clientId, clientSecret,
        code, codeVerifier, redirectUri, providerName: 'Google',
      });
    },
    async refreshTokens({ refreshToken }) {
      return exchangeRefreshTokenForm({
        fetchImpl, tokenUrl: GOOGLE_TOKEN_URL, clientId, clientSecret,
        refreshToken, providerName: 'Google',
      });
    },
    async fetchIdentity({ accessToken }) {
      // Google's OpenID userinfo read: the person's own Google
      // account email, fetched once at callback time. It works on
      // this road because the token is a standard Google OAuth
      // token (unlike Asana's MCP-only tokens, which cannot reach
      // an identity endpoint). Fail-soft, the registry's standing
      // rule: any miss answers null and the callback records the
      // provider label instead.
      try {
        const res = await fetchImpl(GOOGLE_USERINFO_URL, {
          headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        });
        if (!res?.ok) return null;
        const body = await res.json().catch(() => null);
        return body?.email ? String(body.email) : null;
      } catch { return null; }
    },
  };
}

// Canva: the pre-registered Developer Portal app with Canva MCP
// turned on (Canva's own MCP quickstart: "create an app in the
// Developer Portal and turn on Canva MCP. You get a client ID
// and client secret straight away, and you manage your own
// redirect URLs"). The endpoints are the ones Canva's
// authorization-server metadata names for this road (live read,
// 2026-11-10: issuer https://www.canva.com, authorization
// endpoint https://www.canva.com/api/oauth/authorize, token
// endpoint https://api.canva.com/auth/v1/oauth/token, response
// type code, PKCE S256). Canva's REST API pages name a
// /rest/v1/oauth/token spelling for the REST surface; the
// metadata document the MCP server's own protected-resource
// record points at is the authority for THIS road, so auth/v1
// is the token endpoint built here. The exchange is Basic-auth
// + PKCE (Canva's Connect authentication page recommends Basic
// for the token endpoint; the PKCE verifier rides the form).
// Canva issues a refresh token with the code and a fresh one
// with each refresh — "Each refresh token can only be used
// once" (same page) — so refreshTokens() is exposed and
// refresh-on-resolve covers Canva from day one. The scopes are
// NOT shaped here: the entry declares its own ask (the MCP
// server's protected-resource set) and the write route passes
// it in.
const CANVA_AUTHORIZE_URL = 'https://www.canva.com/api/oauth/authorize';
const CANVA_TOKEN_URL = 'https://api.canva.com/auth/v1/oauth/token';

function createCanvaOAuthClient({ fetchImpl, env }) {
  const clientId = String(env?.CANVA_OAUTH_CLIENT_ID ?? '').trim();
  const clientSecret = String(env?.CANVA_OAUTH_CLIENT_SECRET ?? '').trim();
  if (!clientId || !clientSecret) return null;
  return {
    provider: 'canva',
    displayName: 'Canva',
    clientId,
    async authorizeUrl({ redirectUri, state, challenge, scopes }) {
      const url = new URL(CANVA_AUTHORIZE_URL);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      if (Array.isArray(scopes) && scopes.length) url.searchParams.set('scope', scopes.join(' '));
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
      });
      if (codeVerifier) form.set('code_verifier', codeVerifier);
      return exchangeTokenFormBasic({
        fetchImpl, tokenUrl: CANVA_TOKEN_URL, clientId, clientSecret,
        form, providerName: 'Canva',
      });
    },
    async refreshTokens({ refreshToken }) {
      const form = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: String(refreshToken),
      });
      return exchangeTokenFormBasic({
        fetchImpl, tokenUrl: CANVA_TOKEN_URL, clientId, clientSecret,
        form, providerName: 'Canva', isRefresh: true,
      });
    },
    // No fetchIdentity: the token this road mints is for
    // Canva's MCP server, and Canva publishes no identity read
    // for MCP tokens — the callback records the provider label
    // (the Asana precedent).
  };
}

// Dropbox: the pre-registered App Console app — Scoped access,
// Full Dropbox, the MCP permissions enabled on its Permissions
// tab (Dropbox's own Help Center setup for this server). The
// env pair is the app's App key / App secret. The endpoints are
// the ones Dropbox's authorization-server metadata names (live
// read, 2026-11-10: issuer https://www.dropbox.com — the
// issuer the MCP server's protected-resource document names —
// authorization endpoint https://www.dropbox.com/oauth2/
// authorize, token endpoint https://api.dropboxapi.com/oauth2/
// token, grants authorization_code + refresh_token, PKCE
// S256). The exchange is client_secret_post, one of the
// methods that metadata publishes. One authorize parameter is
// this road's law, shaped here in the factory the way Google's
// factory shapes its offline pair: token_access_type=offline —
// without it Dropbox issues NO refresh token and the person
// re-signs-in when the short-lived access token expires. The
// scopes are NOT shaped here: the entry declares its own ask
// (the MCP server's protected-resource set) and the write
// route passes it in.
const DROPBOX_AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const DROPBOX_ACCOUNT_URL = 'https://api.dropboxapi.com/2/users/get_current_account';

function createDropboxOAuthClient({ fetchImpl, env }) {
  const clientId = String(env?.DROPBOX_OAUTH_CLIENT_ID ?? '').trim();
  const clientSecret = String(env?.DROPBOX_OAUTH_CLIENT_SECRET ?? '').trim();
  if (!clientId || !clientSecret) return null;
  return {
    provider: 'dropbox',
    displayName: 'Dropbox',
    clientId,
    async authorizeUrl({ redirectUri, state, challenge, scopes }) {
      const url = new URL(DROPBOX_AUTHORIZE_URL);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      if (Array.isArray(scopes) && scopes.length) url.searchParams.set('scope', scopes.join(' '));
      url.searchParams.set('state', state);
      if (challenge) {
        url.searchParams.set('code_challenge', challenge);
        url.searchParams.set('code_challenge_method', 'S256');
      }
      // The refresh-token parameter (see the factory note):
      // offline access is what makes Dropbox issue a refresh
      // token at all on this road.
      url.searchParams.set('token_access_type', 'offline');
      return url.toString();
    },
    async exchangeCode({ code, codeVerifier, redirectUri }) {
      return exchangeAuthorizationCodeForm({
        fetchImpl, tokenUrl: DROPBOX_TOKEN_URL, clientId, clientSecret,
        code, codeVerifier, redirectUri, providerName: 'Dropbox',
      });
    },
    async refreshTokens({ refreshToken }) {
      return exchangeRefreshTokenForm({
        fetchImpl, tokenUrl: DROPBOX_TOKEN_URL, clientId, clientSecret,
        refreshToken, providerName: 'Dropbox',
      });
    },
    async fetchIdentity({ accessToken }) {
      // Dropbox's current-account read (the account_info.read
      // scope the entry declares): whose token this is — the
      // account's email when Dropbox returns one. Fail-soft,
      // the registry's standing rule.
      try {
        const res = await fetchImpl(DROPBOX_ACCOUNT_URL, {
          method: 'POST',
          headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
          body: 'null',
        });
        if (!res?.ok) return null;
        const body = await res.json().catch(() => null);
        const identity = body?.email ?? body?.name?.display_name ?? body?.account_id;
        return identity ? String(identity) : null;
      } catch { return null; }
    },
  };
}

const CONNECTOR_OAUTH_PROVIDERS = Object.freeze({
  github: createGithubOAuthClient,
  slack: createSlackOAuthClient,
  asana: createAsanaOAuthClient,
  hubspot: createHubSpotOAuthClient,
  google: createGoogleOAuthClient,
  canva: createCanvaOAuthClient,
  dropbox: createDropboxOAuthClient,
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
