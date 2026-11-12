// The self-registering sign-in road for remote MCP servers
// (connector OAuth, DCR leg — 2026-11-09; the Perplexity pipeline
// map's finishing order named this road: "the OAuth road (DCR +
// PKCE + approval briefing in the composer)"; m3-github/DESIGN.md §6
// built the fixed-provider registry first because GitHub's OAuth
// Apps need pre-registration).
//
// Modern remote MCP servers run the other shape (MCP authorization
// spec, on RFC 9728 + RFC 8414 + RFC 7591 + PKCE): the server
// publishes its authorization server's metadata, the client
// REGISTERS ITSELF at connect time — no pre-registered app, no
// stored client secret of Helmian's own — and runs authorization
// code + PKCE S256 under the freshly issued client id. Where the
// server issues no secret (it advertises token auth method "none"),
// the PKCE verifier is the handshake's proof; where it issues one,
// the secret is born inside the pending handshake, lives ONLY on
// the server-side pending row (sql/081), and dies with it.
//
// The CIMD leg (below, 2026-11-10) is the same road with the
// registration step replaced by a published identity: a server
// that gates DCR to approved redirect URIs (Vercel is the first)
// accepts a client whose client_id is the HTTPS URL of its own
// metadata document instead.
//
// This module is the road, provider-neutral on purpose: nothing
// here names a service. The first live-shaped check (2026-11-10)
// read the metadata of the catalog's registry-notion entry
// (https://mcp.notion.com/mcp): registration endpoint present,
// token auth methods include "none", PKCE S256, scopes ["default"].
// A server that publishes no registration endpoint gets the honest
// named answer — it needs a different sign-in road (a fixed
// registry member, like GitHub) — never a forced DCR shape.
//
// FAILURES ARE NAMED: every network or metadata failure throws a
// ConnectorOAuthDcrError with a stable `code`, so the connect
// surface can say the true thing instead of a generic error.

import {
  createConnectorOAuthClient,
  hashOAuthState,
  newOAuthState,
  newPkceVerifier,
  pkceChallenge,
} from './connector-oauth-pending.mjs';

export const CONNECTOR_OAUTH_DCR_KIND = 'dcr';
export const CONNECTOR_OAUTH_CIMD_KIND = 'cimd';
export const CONNECTOR_OAUTH_CALLBACK_URL = 'https://helmian.cloud/api/admin/connector-library/oauth/callback';
const DEFAULT_CLIENT_NAME = 'Helmian';

// ------------------------------------------------------------- CIMD
// Client ID Metadata Documents (draft-ietf-oauth-client-id-
// metadata-document; the MCP authorization spec's preferred client
// identification): instead of registering, the client publishes a
// small JSON document on its own domain and uses that document's
// HTTPS URL as its client_id. The authorization server fetches the
// document at authorize time and reads the client's name, redirect
// URIs, grants, and token auth method out of it. The document's own
// client_id field MUST equal the URL it is served from; its token
// endpoint auth method must carry no shared secret (a public
// document cannot keep one), so this road is 'none' + PKCE, exactly
// like the public-client DCR shape.
//
// Helmian's document is served as a static file on helmian.cloud —
// the same production road that serves the site's other public
// documents (llms.txt, robots.txt): web/marketing/oauth/
// client-metadata.json in the marketing site Vercel hosts. The URL
// below is the ONE canonical client_id; the catalog entry carries
// it as data (cimdClientId), this module's builder produces the
// document's exact content, and the tests pin all three together so
// they can never drift apart silently.
export const HELMIAN_CLIENT_METADATA_URL = 'https://helmian.cloud/oauth/client-metadata.json';
export const HELMIAN_CLIENT_METADATA_PATH = '/oauth/client-metadata.json';

// The metadata document Helmian publishes about itself as an OAuth
// client. Field set grounded in the CIMD draft (the RFC 7591 client
// metadata registry, profiled): client_id (== the serving URL),
// client_name, redirect_uris (the production callback the OAuth
// road already uses, HTTPS as Vercel's CIMD note requires),
// grant_types + response_types matching the road, the public-client
// auth method, and the declared scope ask as catalog data the
// caller passes in (Vercel: 'openid' only). No logo_uri: Vercel
// requires a PNG/JPEG under 100 KB for one, and Helmian publishes
// none that meets that bar today — the field is optional, so it is
// omitted rather than pointed at an unverified asset.
export function buildClientMetadataDocument({
  clientId = HELMIAN_CLIENT_METADATA_URL,
  redirectUri = CONNECTOR_OAUTH_CALLBACK_URL,
  clientName = DEFAULT_CLIENT_NAME,
  scopes = [],
} = {}) {
  return {
    client_id: clientId,
    client_name: clientName,
    client_uri: 'https://helmian.cloud',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...(scopes.length ? { scope: scopes.join(' ') } : {}),
  };
}

// The CIMD client id a catalog entry declares, or null when the
// entry does not run the CIMD road. Catalog data, like oauthScopes:
// the entry definition carries it, never the stored row.
export function cimdClientIdForEntry(entry) {
  const value = entry?.cimdClientId;
  return typeof value === 'string' && value.startsWith('https://') ? value : null;
}

export class ConnectorOAuthDcrError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConnectorOAuthDcrError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new ConnectorOAuthDcrError(code, message); };

const trimSlash = (value) => String(value ?? '').replace(/\/+$/, '');

// Every fetch on the connect-start roads is bounded
// (2026-11-10 defect fix): this road answers a person's Connect
// click, and an unbounded fetch to a stalled provider endpoint
// left the click with no answer at all — no redirect, no form,
// no message. The codebase's other outbound fetches all carry
// AbortSignal.timeout (the GitHub file read's 10s, spoke
// setup's 8s, the OIDC gateway's own constant); the OAuth
// connect-start fetches were the ones with none. A timeout
// surfaces as the named 'network-failure' below, in Helmian's
// time, not the provider's.
export const DCR_FETCH_TIMEOUT_MS = 8000;

// Discovery chains up to four metadata fetches (two resource
// documents, then two authorization-server forms), so a
// per-fetch bound alone still lets a stalled provider hold a
// Connect click for half a minute. Discovery therefore shares
// one deadline across its fetches: healthy providers answer
// each document in well under a second, and the whole lookup
// gives up — with the named failure — inside this budget.
export const DCR_DISCOVERY_BUDGET_MS = 12000;

// JSON-or-named-failure fetch: a non-JSON or non-2xx answer from a
// metadata/registration/token endpoint is a fact about the road,
// reported by endpoint role, never parsed hopefully.
async function fetchJson(fetchImpl, url, { role, ...opts } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { ...opts, signal: opts.signal ?? AbortSignal.timeout(DCR_FETCH_TIMEOUT_MS) });
  } catch (error) {
    fail('network-failure', `the ${role} could not be reached (${error?.message ?? 'network error'})`);
  }
  const body = await res.json().catch(() => null);
  if (!res?.ok) {
    const named = body?.error_description || body?.error || `HTTP ${res?.status ?? '?'}`;
    fail('endpoint-refused', `the ${role} refused the request (${named})`);
  }
  if (!body || typeof body !== 'object') fail('endpoint-refused', `the ${role} answered without a JSON body`);
  return body;
}

// RFC 8414 metadata URL for an issuer: the well-known segment goes
// BEFORE the issuer's path (issuer https://host/mcp →
// https://host/.well-known/oauth-authorization-server/mcp). Some
// servers also answer the naive suffix form (the whole metadata
// document served off the resource host, the shape the write
// route's consent boundary already reads); discovery tries the
// canonical form first, then the suffix form, and validates the
// issuer inside the document either way.
function asMetadataUrls(issuer) {
  const u = new URL(issuer);
  const canonical = `${u.origin}/.well-known/oauth-authorization-server${u.pathname.replace(/\/+$/, '')}`;
  const suffix = `${trimSlash(issuer)}/.well-known/oauth-authorization-server`;
  return canonical === suffix ? [canonical] : [canonical, suffix];
}

// ------------------------------------------------------------ discovery
// Read the two well-known documents for a resource (an MCP server
// URL) and validate them against each other and against the ask:
//   - the protected-resource document must name THIS resource;
//   - the authorization-server document's issuer must be exactly
//     the server the resource document named;
//   - the server must offer authorization-code + PKCE S256.
// Returns the working metadata set. Registration may still be
// absent — that is registerDcrClient's named refusal, not a
// discovery failure: a server can be discoverable and still need a
// pre-registered client.
export async function discoverAuthorizationServer(resourceUrl, { fetchImpl = fetch } = {}) {
  const resource = trimSlash(resourceUrl);
  let resourceUrlParsed;
  try { resourceUrlParsed = new URL(resource); } catch { fail('invalid-resource', 'the connector endpoint is not a URL'); }
  if (resourceUrlParsed.protocol !== 'https:' && resourceUrlParsed.hostname !== 'localhost' && resourceUrlParsed.hostname !== '127.0.0.1') {
    fail('invalid-resource', 'the connector endpoint is not an HTTPS URL');
  }
  const origin = resourceUrlParsed.origin;
  const path = resourceUrlParsed.pathname.replace(/\/+$/, '');
  // One deadline for the whole discovery (see
  // DCR_DISCOVERY_BUDGET_MS above): each fetch's signal is the
  // time left, so a stalled first document leaves nothing for
  // the retries and the lookup fails inside the budget.
  const deadline = Date.now() + DCR_DISCOVERY_BUDGET_MS;
  const discoverySignal = () => AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  // The path-suffixed document first (RFC 9728 §3.1), then the
  // origin-wide one; servers publish either or both.
  const resourceDocs = [];
  for (const candidate of [`${origin}/.well-known/oauth-protected-resource${path}`, `${origin}/.well-known/oauth-protected-resource`]) {
    if (!resourceDocs.includes(candidate)) resourceDocs.push(candidate);
  }
  let resourceMeta = null;
  let lastMiss = null;
  for (const docUrl of resourceDocs) {
    try {
      const body = await fetchJson(fetchImpl, docUrl, { role: 'resource metadata document', signal: discoverySignal() });
      if (trimSlash(body.resource) === resource) { resourceMeta = body; break; }
      lastMiss = new ConnectorOAuthDcrError('resource-mismatch',
        `the resource metadata at ${docUrl} names ${body.resource ?? 'a different resource'}, not this connector`);
    } catch (error) { lastMiss = error; }
  }
  if (!resourceMeta) throw lastMiss ?? new ConnectorOAuthDcrError('discovery-failed', 'no resource metadata document could be read');
  const servers = Array.isArray(resourceMeta.authorization_servers) ? resourceMeta.authorization_servers : [];
  if (!servers.length) fail('discovery-failed', 'the resource metadata names no authorization server');
  const issuer = trimSlash(servers[0]);
  let asMeta = null;
  let lastAsMiss = null;
  for (const docUrl of asMetadataUrls(issuer)) {
    try {
      const body = await fetchJson(fetchImpl, docUrl, { role: 'authorization server metadata document', signal: discoverySignal() });
      if (trimSlash(body.issuer) !== issuer) {
        lastAsMiss = new ConnectorOAuthDcrError('issuer-mismatch',
          `the authorization server metadata names issuer ${body.issuer ?? '(none)'}, not the ${issuer} the resource named — refused`);
        continue;
      }
      asMeta = body; break;
    } catch (error) { lastAsMiss = error; }
  }
  if (!asMeta) throw lastAsMiss ?? new ConnectorOAuthDcrError('discovery-failed', 'no authorization server metadata document could be read');
  if (!asMeta.authorization_endpoint || !asMeta.token_endpoint) {
    fail('metadata-incomplete', 'the authorization server metadata names no authorization or token endpoint');
  }
  const challengeMethods = Array.isArray(asMeta.code_challenge_methods_supported) ? asMeta.code_challenge_methods_supported : [];
  if (!challengeMethods.includes('S256')) {
    fail('pkce-unsupported', 'the authorization server does not offer PKCE S256, so Helmian will not run its sign-in road');
  }
  return {
    resource,
    resourceName: typeof resourceMeta.resource_name === 'string' ? resourceMeta.resource_name : null,
    resourceScopes: Array.isArray(resourceMeta.scopes_supported) ? resourceMeta.scopes_supported.map(String) : [],
    issuer,
    authorizationEndpoint: String(asMeta.authorization_endpoint),
    tokenEndpoint: String(asMeta.token_endpoint),
    registrationEndpoint: asMeta.registration_endpoint ? String(asMeta.registration_endpoint) : null,
    revocationEndpoint: asMeta.revocation_endpoint ? String(asMeta.revocation_endpoint) : null,
    scopesSupported: Array.isArray(asMeta.scopes_supported) ? asMeta.scopes_supported.map(String) : [],
    tokenAuthMethods: Array.isArray(asMeta.token_endpoint_auth_methods_supported)
      ? asMeta.token_endpoint_auth_methods_supported.map(String) : [],
    // The CIMD advertisement (RFC 8414 extension, CIMD draft §6):
    // true only when the server says so in those words; anything
    // else means the CIMD road is not offered here.
    clientIdMetadataDocumentSupported: asMeta.client_id_metadata_document_supported === true,
  };
}

// The scopes a registration asks for. The default is the server's
// own published set (the resource document's scopes, else the
// authorization server's) — the shape this road has always run.
// A catalog entry may DECLARE the scopes it asks for instead (a
// pick whose own words promise less than the server publishes —
// Atlassian's entry is the first: its server offers 40 scopes,
// delete and manage included, against a promise of search-and-work
// on three products; R1 live read, 2026-11-10). A declaration is
// narrowed to what the server actually offers; if the server
// offers none of the declared names, the declaration stands as-is
// and the registration endpoint itself rules on it — Helmian never
// silently widens a declared ask back to the server's full set.
export function dcrScopesForRegistration(metadata, declaredScopes = null) {
  const offered = metadata.resourceScopes.length ? metadata.resourceScopes : metadata.scopesSupported;
  if (!Array.isArray(declaredScopes) || !declaredScopes.length) return offered;
  const narrowed = declaredScopes.filter((scope) => offered.includes(scope));
  return narrowed.length ? narrowed : [...declaredScopes];
}

// --------------------------------------------------------- registration
// Register Helmian as a client of the authorization server
// (RFC 7591). Prefers a public client (token auth method "none" —
// PKCE carries the proof, nothing secret exists to leak); falls
// back to a server-issued secret only when the server offers no
// public-client method, and the issued secret then lives on the
// pending row only. No registration endpoint → the honest named
// answer: this service needs a different sign-in road.
export async function registerDcrClient(metadata, { redirectUri, fetchImpl = fetch, clientName = DEFAULT_CLIENT_NAME, scopes: declaredScopes = null } = {}) {
  if (!metadata?.registrationEndpoint) {
    fail('dcr-unsupported',
      'this service does not let Helmian register itself — it needs a different sign-in road (a pre-registered app), so nothing was connected');
  }
  const offered = metadata.tokenAuthMethods;
  const authMethod = offered.includes('none') ? 'none'
    : offered.includes('client_secret_post') ? 'client_secret_post'
    : offered.includes('client_secret_basic') ? 'client_secret_basic'
    : (offered[0] ?? 'none');
  const scopes = dcrScopesForRegistration(metadata, declaredScopes);
  const body = await fetchJson(fetchImpl, metadata.registrationEndpoint, {
    role: 'client registration endpoint',
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: authMethod,
      ...(scopes.length ? { scope: scopes.join(' ') } : {}),
    }),
  });
  if (!body.client_id) fail('endpoint-refused', 'the client registration endpoint answered without a client_id');
  return {
    clientId: String(body.client_id),
    clientSecret: body.client_secret ? String(body.client_secret) : null,
    tokenEndpointAuthMethod: typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : authMethod,
    scopes,
  };
}

// ------------------------------------------------------ authorize + token
export function buildDcrAuthorizationUrl(metadata, { clientId, redirectUri, state, challenge, scopes = [] }) {
  const url = new URL(metadata.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  if (scopes.length) url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // RFC 8707 resource indicator: the MCP authorization spec asks
  // the client to name the resource the token is for.
  url.searchParams.set('resource', metadata.resource);
  return url.toString();
}

// The token exchange, shaped exactly like the fixed registry's
// (same return bundle the callback stores). The client secret —
// when the server issued one — is presented the way the
// registration recorded: in the form (client_secret_post) or as
// HTTP Basic (client_secret_basic); with method "none" nothing
// secret exists and the PKCE verifier is the only proof sent.
export async function exchangeDcrCode({ tokenEndpoint, clientId, clientSecret = null, tokenEndpointAuthMethod = 'none', code, codeVerifier, redirectUri, fetchImpl = fetch }) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: String(code),
    redirect_uri: redirectUri,
    client_id: clientId,
  });
  if (codeVerifier) form.set('code_verifier', codeVerifier);
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (clientSecret && tokenEndpointAuthMethod === 'client_secret_post') form.set('client_secret', clientSecret);
  if (clientSecret && tokenEndpointAuthMethod === 'client_secret_basic') {
    headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`;
  }
  const body = await fetchJson(fetchImpl, tokenEndpoint, { role: 'token endpoint', method: 'POST', headers, body: form.toString() });
  if (!body.access_token) fail('endpoint-refused', 'the token endpoint answered without an access_token');
  return {
    accessToken: String(body.access_token),
    refreshToken: body.refresh_token ? String(body.refresh_token) : null,
    tokenType: body.token_type ? String(body.token_type) : 'Bearer',
    scope: body.scope ? String(body.scope) : null,
    expiresIn: Number.isFinite(Number(body.expires_in)) ? Number(body.expires_in) : null,
  };
}

// ------------------------------------------------------------ the client
// A DCR client in the registry's shape (connector-oauth-pending.mjs
// header): registerClient exists because this road registers a
// client per handshake. The client is bound to one resource; its
// discovery runs once and is remembered for the handshake's life.
export function createDcrOAuthClient({ resourceUrl, fetchImpl = fetch, clientName = DEFAULT_CLIENT_NAME, scopes = null } = {}) {
  let discovered = null;
  const discover = async () => {
    if (!discovered) discovered = await discoverAuthorizationServer(resourceUrl, { fetchImpl });
    return discovered;
  };
  return {
    provider: CONNECTOR_OAUTH_DCR_KIND,
    kind: CONNECTOR_OAUTH_DCR_KIND,
    displayName: null, // set from the resource document at discovery; the start helper names it
    discover,
    async registerClient({ redirectUri }) {
      const metadata = await discover();
      return registerDcrClient(metadata, { redirectUri, fetchImpl, clientName, scopes });
    },
    async authorizeUrl({ redirectUri, state, challenge, scopes = [], registration }) {
      const metadata = await discover();
      return buildDcrAuthorizationUrl(metadata, {
        clientId: registration.clientId, redirectUri, state, challenge,
        scopes: scopes.length ? scopes : registration.scopes,
      });
    },
    async exchangeCode({ code, codeVerifier, redirectUri, registration }) {
      const metadata = await discover();
      return exchangeDcrCode({
        tokenEndpoint: metadata.tokenEndpoint,
        clientId: registration.clientId, clientSecret: registration.clientSecret,
        tokenEndpointAuthMethod: registration.tokenEndpointAuthMethod,
        code, codeVerifier, redirectUri, fetchImpl,
      });
    },
  };
}

// The callback-side client for a DCR handshake: built from the
// pending row alone (the token endpoint and any issued secret were
// stored on the row at start; sql/081). No discovery runs at
// callback time — the row is the handshake's memory.
export function createDcrExchangeClient({ pending, fetchImpl = fetch } = {}) {
  if (!pending?.tokenEndpoint || !pending?.clientId) return null;
  return {
    provider: pending.provider,
    kind: CONNECTOR_OAUTH_DCR_KIND,
    displayName: pending.provider ? `${pending.provider.charAt(0).toUpperCase()}${pending.provider.slice(1)}` : 'The connector',
    async exchangeCode({ code, codeVerifier, redirectUri }) {
      return exchangeDcrCode({
        tokenEndpoint: pending.tokenEndpoint,
        clientId: pending.clientId,
        clientSecret: pending.clientSecret ?? null,
        tokenEndpointAuthMethod: pending.tokenEndpointAuthMethod ?? (pending.clientSecret ? 'client_secret_post' : 'none'),
        code, codeVerifier, redirectUri, fetchImpl,
      });
    },
  };
}

// Resolve the OAuth client for a PENDING ROW — the callback's
// question. The fixed registry answers first, byte-identical to
// today (a GitHub row resolves to the GitHub client or to null when
// unconfigured); a row carrying DCR fields resolves to the DCR
// exchange client; anything else is no client, honestly.
export function resolvePendingOAuthClient(pending, { fetchImpl = fetch, env = process.env } = {}) {
  if (!pending) return null;
  const fixed = createConnectorOAuthClient(pending.provider, { fetchImpl, env });
  if (fixed) return fixed;
  return createDcrExchangeClient({ pending, fetchImpl });
}

// ------------------------------------------------------------- the briefing
// The approval briefing's data: what the consent step needs to say,
// in plain words, what this connection will be able to do. Built at
// connect start from the server's own published facts (its resource
// name and the scopes it asks for) — the composer words ride the
// connect-start wiring; this is the plumbing they render from.
const SCOPE_WORDS = Object.freeze({
  default: 'the standard access this service grants its connected apps, chosen on its own consent page',
  offline_access: 'stay signed in between sessions (a refresh token)',
  mcp: 'use this service\u2019s tools through Helmian',
});
export function plainScopeWords(scope) {
  return SCOPE_WORDS[scope] ?? `the "${scope}" permission this service asks for`;
}

export function buildApprovalBriefing({ metadata, registration, entry, kind = CONNECTOR_OAUTH_DCR_KIND }) {
  const scopes = (registration?.scopes?.length ? registration.scopes : metadata.resourceScopes).map((name) => ({
    name, words: plainScopeWords(name),
  }));
  return {
    kind,
    entryId: entry?.id ?? null,
    seatId: entry?.seatId ?? null,
    serviceName: metadata.resourceName ?? entry?.name ?? 'This service',
    resource: metadata.resource,
    authorizationHost: new URL(metadata.authorizationEndpoint).host,
    scopes,
    summary: scopes.length
      ? `Signing in lets this seat use ${metadata.resourceName ?? entry?.name ?? 'this service'} through Helmian: ${scopes.map((s) => s.words).join('; ')}.`
      : `Signing in lets this seat use ${metadata.resourceName ?? entry?.name ?? 'this service'} through Helmian.`,
  };
}

// ------------------------------------------------------------ connect start
// Run the start of a DCR connect end to end: discovery →
// registration → state + PKCE → the pending row (which carries the
// scopes for the briefing and, when the server issued one, the
// client secret and token endpoint for the callback) → the
// authorize URL the person's browser is sent to. The pending
// store's fail-soft null (its table not switched on) is the named
// 'pending-store-unavailable' refusal — the same condition the
// write route already words for the fixed road.
export async function startDcrConnect({
  pendingStore, tenantId, personId, seatId, entry, provider,
  redirectUri = CONNECTOR_OAUTH_CALLBACK_URL, fetchImpl = fetch, clientName = DEFAULT_CLIENT_NAME,
  scopes = null,
}) {
  if (!pendingStore) fail('pending-store-unavailable', 'the OAuth road is not switched on yet, so the sign-in cannot be started');
  const resourceUrl = entry?.mcpEndpointUrl ?? entry?.endpoint ?? null;
  if (!resourceUrl) fail('invalid-resource', 'this connector carries no server endpoint to sign in to');
  const metadata = await discoverAuthorizationServer(resourceUrl, { fetchImpl });
  // The scopes asked for: the caller's explicit set wins, then the
  // entry's own declared ask (catalog data — a pick that promises
  // less than its server publishes), else the server's set.
  const declaredScopes = scopes ?? entry?.oauthScopes ?? null;
  const registration = await registerDcrClient(metadata, { redirectUri, fetchImpl, clientName, scopes: declaredScopes });
  const state = newOAuthState();
  const codeVerifier = newPkceVerifier();
  const authorizeUrl = buildDcrAuthorizationUrl(metadata, {
    clientId: registration.clientId, redirectUri, state,
    challenge: pkceChallenge(codeVerifier), scopes: registration.scopes,
  });
  const saved = await pendingStore.save(tenantId, {
    stateHash: hashOAuthState(state),
    personId, seatId, entryId: entry.id,
    provider: provider ?? entry.id,
    clientId: registration.clientId,
    codeVerifier, redirectUri,
    scopes: registration.scopes,
    clientSecret: registration.clientSecret,
    tokenEndpoint: metadata.tokenEndpoint,
    tokenEndpointAuthMethod: registration.tokenEndpointAuthMethod,
  });
  if (!saved) fail('pending-store-unavailable', 'the OAuth road is not switched on yet, so the sign-in cannot be started');
  return {
    authorizeUrl,
    briefing: buildApprovalBriefing({ metadata, registration, entry }),
    metadata,
    registration: { clientId: registration.clientId, tokenEndpointAuthMethod: registration.tokenEndpointAuthMethod, scopes: registration.scopes },
  };
}

// --------------------------------------------------- connect start (CIMD)
// Run the start of a CIMD connect end to end: discovery → the
// server must advertise CIMD (client_id_metadata_document_
// supported) → NO registration call at all: the client_id IS
// Helmian's published metadata document URL, which the server
// fetches and validates itself at authorize time → state + PKCE →
// the pending row (carrying the token endpoint and the 'none' auth
// method, so the callback's exchange client resolves from the row
// alone, exactly like a DCR row — the exchange posts the URL as
// client_id with the PKCE verifier as its only proof) → the
// authorize URL the person's browser is sent to.
export async function startCimdConnect({
  pendingStore, tenantId, personId, seatId, entry, provider,
  redirectUri = CONNECTOR_OAUTH_CALLBACK_URL, fetchImpl = fetch, clientName = DEFAULT_CLIENT_NAME,
  scopes = null,
}) {
  if (!pendingStore) fail('pending-store-unavailable', 'the OAuth road is not switched on yet, so the sign-in cannot be started');
  const resourceUrl = entry?.mcpEndpointUrl ?? entry?.endpoint ?? null;
  if (!resourceUrl) fail('invalid-resource', 'this connector carries no server endpoint to sign in to');
  const clientId = cimdClientIdForEntry(entry);
  if (!clientId) fail('invalid-resource', 'this connector declares no client metadata document to identify Helmian by');
  const metadata = await discoverAuthorizationServer(resourceUrl, { fetchImpl });
  if (!metadata.clientIdMetadataDocumentSupported) {
    fail('cimd-unsupported',
      'this service does not accept a client metadata document — it needs a different sign-in road, so nothing was connected');
  }
  const declaredScopes = scopes ?? entry?.oauthScopes ?? null;
  const registration = {
    clientId,
    clientSecret: null,
    tokenEndpointAuthMethod: 'none',
    scopes: dcrScopesForRegistration(metadata, declaredScopes),
  };
  const state = newOAuthState();
  const codeVerifier = newPkceVerifier();
  const authorizeUrl = buildDcrAuthorizationUrl(metadata, {
    clientId, redirectUri, state,
    challenge: pkceChallenge(codeVerifier), scopes: registration.scopes,
  });
  const saved = await pendingStore.save(tenantId, {
    stateHash: hashOAuthState(state),
    personId, seatId, entryId: entry.id,
    provider: provider ?? entry.id,
    clientId,
    codeVerifier, redirectUri,
    scopes: registration.scopes,
    clientSecret: null,
    tokenEndpoint: metadata.tokenEndpoint,
    tokenEndpointAuthMethod: 'none',
  });
  if (!saved) fail('pending-store-unavailable', 'the OAuth road is not switched on yet, so the sign-in cannot be started');
  return {
    authorizeUrl,
    briefing: buildApprovalBriefing({ metadata, registration, entry, kind: CONNECTOR_OAUTH_CIMD_KIND }),
    metadata,
    registration: { clientId, tokenEndpointAuthMethod: 'none', scopes: registration.scopes },
  };
}

// The provider key a DCR entry's pending rows carry: the entry's
// own service key — its catalog prefix is Helmian's filing system,
// not the service's name ('registry-notion' → 'notion'; the
// brokered 'helmian-vercel' → 'vercel'; a bare id stands as
// itself). Display and reporting key on it; the road never does.
export function dcrProviderKeyForEntry(entry) {
  const id = String(entry?.id ?? '');
  if (id.startsWith('registry-')) return id.slice('registry-'.length);
  if (id.startsWith('helmian-')) return id.slice('helmian-'.length);
  return id;
}

// The entries whose OAuth road is a fixed-map provider: an app
// pre-registered in the provider's own console, never a dynamic
// registration. Entry id → registry provider key. GitHub was the
// first member (its mirror id and its brokered id both name it);
// Bite R2 adds the team-work family's brokered entries — Slack,
// Asana, HubSpot — whose servers publish NO registration endpoint
// (live metadata reads, 2026-11-10), so the DCR road cannot serve
// them by construction. The Google family bite (2026-11-10) adds
// the three Workspace entries — Gmail, Google Calendar, Google
// Drive — all under the ONE provider 'google': Google publishes
// one OAuth client covering all three servers, and its
// authorization-server metadata names no registration endpoint
// and no CIMD support (live read, 2026-11-10), so neither the DCR
// nor the CIMD road can serve them either. The fixed-tail bite
// (2026-11-10) adds the last two fixed registrations: Canva —
// whose developer-endpoint road runs on a fixed Developer
// Portal app and offers CIMD only through a waitlist
// application, so neither the DCR nor the CIMD road can serve
// it today — and Dropbox, whose own Help Center limits MCP
// dynamic registration to a trusted set of named clients
// Helmian is not in, so the DCR road cannot serve it either
// (Dropbox's general authorization-server metadata does publish
// a registration endpoint; the MCP server's own documentation
// is what gates it to the trusted set). An entry not named
// here with an OAuth road and a server endpoint takes the
// discovery-driven DCR kind.
const FIXED_PROVIDER_BY_ENTRY_ID = Object.freeze({
  github: 'github',
  'helmian-github': 'github',
  'helmian-slack': 'slack',
  'helmian-asana': 'asana',
  'helmian-hubspot': 'hubspot',
  'helmian-gmail': 'google',
  'helmian-google-calendar': 'google',
  'helmian-google-drive': 'google',
  'helmian-canva': 'canva',
  'helmian-dropbox': 'dropbox',
});

// The fixed provider a catalog entry's OAuth road runs under, or
// null when the entry is not a fixed-provider entry.
export function fixedProviderForEntry(entry) {
  return FIXED_PROVIDER_BY_ENTRY_ID[String(entry?.id ?? '')] ?? null;
}

// Which sign-in kind an entry's OAuth road is: CIMD when the entry
// declares a client metadata document (the identification outranks
// registration — the MCP spec's own priority order: a declared
// client identity, then CIMD, then DCR), a fixed-map provider
// (decided the way the write route's consent boundary already
// decides it), or the discovery-driven DCR kind for any other OAuth
// entry carrying a server endpoint. Null when the entry is not an
// OAuth entry at all.
export function connectorOAuthKindForEntry(entry, { env = process.env } = {}) {
  if (!entry || entry.authMode !== 'oauth') return null;
  const resourceUrl = entry.mcpEndpointUrl ?? entry.endpoint ?? null;
  const cimdClientId = cimdClientIdForEntry(entry);
  if (cimdClientId && resourceUrl) {
    return { kind: CONNECTOR_OAUTH_CIMD_KIND, provider: dcrProviderKeyForEntry(entry), resourceUrl, clientId: cimdClientId };
  }
  const fixedProvider = fixedProviderForEntry(entry);
  if (fixedProvider) {
    return { kind: 'fixed', provider: fixedProvider, configured: Boolean(createConnectorOAuthClient(fixedProvider, { fetchImpl: async () => { throw new Error('no fetch at kind resolution'); }, env })) };
  }
  if (!resourceUrl) return null;
  return { kind: CONNECTOR_OAUTH_DCR_KIND, provider: dcrProviderKeyForEntry(entry), resourceUrl };
}
