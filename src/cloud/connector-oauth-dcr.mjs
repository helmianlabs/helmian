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
export const CONNECTOR_OAUTH_CALLBACK_URL = 'https://helmian.cloud/api/admin/connector-library/oauth/callback';
const DEFAULT_CLIENT_NAME = 'Helmian';

export class ConnectorOAuthDcrError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConnectorOAuthDcrError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new ConnectorOAuthDcrError(code, message); };

const trimSlash = (value) => String(value ?? '').replace(/\/+$/, '');

// JSON-or-named-failure fetch: a non-JSON or non-2xx answer from a
// metadata/registration/token endpoint is a fact about the road,
// reported by endpoint role, never parsed hopefully.
async function fetchJson(fetchImpl, url, { role, ...opts } = {}) {
  let res;
  try {
    res = await fetchImpl(url, opts);
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
      const body = await fetchJson(fetchImpl, docUrl, { role: 'resource metadata document' });
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
      const body = await fetchJson(fetchImpl, docUrl, { role: 'authorization server metadata document' });
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
  };
}

// --------------------------------------------------------- registration
// Register Helmian as a client of the authorization server
// (RFC 7591). Prefers a public client (token auth method "none" —
// PKCE carries the proof, nothing secret exists to leak); falls
// back to a server-issued secret only when the server offers no
// public-client method, and the issued secret then lives on the
// pending row only. No registration endpoint → the honest named
// answer: this service needs a different sign-in road.
export async function registerDcrClient(metadata, { redirectUri, fetchImpl = fetch, clientName = DEFAULT_CLIENT_NAME } = {}) {
  if (!metadata?.registrationEndpoint) {
    fail('dcr-unsupported',
      'this service does not let Helmian register itself — it needs a different sign-in road (a pre-registered app), so nothing was connected');
  }
  const offered = metadata.tokenAuthMethods;
  const authMethod = offered.includes('none') ? 'none'
    : offered.includes('client_secret_post') ? 'client_secret_post'
    : offered.includes('client_secret_basic') ? 'client_secret_basic'
    : (offered[0] ?? 'none');
  const scopes = metadata.resourceScopes.length ? metadata.resourceScopes : metadata.scopesSupported;
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
export function createDcrOAuthClient({ resourceUrl, fetchImpl = fetch, clientName = DEFAULT_CLIENT_NAME } = {}) {
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
      return registerDcrClient(metadata, { redirectUri, fetchImpl, clientName });
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

export function buildApprovalBriefing({ metadata, registration, entry }) {
  const scopes = (registration?.scopes?.length ? registration.scopes : metadata.resourceScopes).map((name) => ({
    name, words: plainScopeWords(name),
  }));
  return {
    kind: CONNECTOR_OAUTH_DCR_KIND,
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
}) {
  if (!pendingStore) fail('pending-store-unavailable', 'the OAuth road is not switched on yet, so the sign-in cannot be started');
  const resourceUrl = entry?.mcpEndpointUrl ?? entry?.endpoint ?? null;
  if (!resourceUrl) fail('invalid-resource', 'this connector carries no server endpoint to sign in to');
  const metadata = await discoverAuthorizationServer(resourceUrl, { fetchImpl });
  const registration = await registerDcrClient(metadata, { redirectUri, fetchImpl, clientName });
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

// The provider key a DCR entry's pending rows carry: the entry's
// own service key ('registry-notion' → 'notion'; a bare id stands
// as itself). Display and reporting key on it; the road never does.
export function dcrProviderKeyForEntry(entry) {
  const id = String(entry?.id ?? '');
  return id.startsWith('registry-') ? id.slice('registry-'.length) : id;
}

// Which sign-in kind an entry's OAuth road is: a fixed-map provider
// (today: GitHub — decided the way the write route's consent
// boundary already decides it) or the discovery-driven DCR kind for
// any other OAuth entry carrying a server endpoint. Null when the
// entry is not an OAuth entry at all.
export function connectorOAuthKindForEntry(entry, { env = process.env } = {}) {
  if (!entry || entry.authMode !== 'oauth') return null;
  if (entry.id === 'github' || entry.id === 'helmian-github') {
    return { kind: 'fixed', provider: 'github', configured: Boolean(createConnectorOAuthClient('github', { fetchImpl: async () => { throw new Error('no fetch at kind resolution'); }, env })) };
  }
  const resourceUrl = entry.mcpEndpointUrl ?? entry.endpoint ?? null;
  if (!resourceUrl) return null;
  return { kind: CONNECTOR_OAUTH_DCR_KIND, provider: dcrProviderKeyForEntry(entry), resourceUrl };
}
