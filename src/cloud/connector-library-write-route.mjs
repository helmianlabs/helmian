// Connector library — the WRITE routes (mirror M1, 2026-11-09;
// mirror-design/DESIGN.md §5). The read route proved the gap on the
// live site: rows were inert, connect did not exist, and Manage
// landed on the generic Integrations cards. These routes are the
// missing half — connecting INSIDE Helmian:
//
//   POST /api/admin/connector-library/connect
//     Starts the entry's auth road for the CALLER (their own person):
//       authMode "none"   → the connection is recorded at once.
//       authMode "header" → returns the vault reference the person's
//                           key must be stored under (the record will
//                           hold the reference, never the key).
//       authMode "oauth"  → the entry's sign-in kind decides
//                           (connector-oauth-dcr.mjs): a FIXED
//                           registry provider with a configured
//                           client (GitHub, M3 §6.3) and a DCR entry
//                           whose server lets Helmian register
//                           itself both START the road — a pending
//                           handshake is saved (PKCE S256) and the
//                           answer carries the authorize URL (plus,
//                           on the DCR road, the approval briefing
//                           the composer renders). An OAuth entry
//                           with no live road — GitHub unconfigured,
//                           no endpoint, a server that takes no
//                           self-registered clients — keeps the
//                           consent-boundary answer: the provider's
//                           authorization endpoint and resource
//                           metadata, and nothing connected. The
//                           callback below resolves its OAuth
//                           client from the pending ROW (the fixed
//                           registry first, then the row's own DCR
//                           fields) — there is no default client.
//     Vendor-brokered entries are refused plainly: they are mirrors,
//     managed in the vendor's own garden (§1.5).
//   POST /api/admin/connector-library/connect/header
//     Lands a header/API-key credential: the value goes straight to
//     the credential service under the minted vault reference and the
//     library records the reference only. This is the ONE action that
//     ever receives a credential value; every other action refuses
//     credential-value keys by name, and the store refuses them too.
//   GET  /api/admin/connector-library/oauth/callback
//     An OAuth provider redirect lands here: the pending handshake is
//     consumed, the code is exchanged, the token pair is stored in
//     the credential service under the connection's vault references,
//     and the connection is recorded. Answers a small HTML page that
//     carries the person back to Helmian.
//   POST /api/admin/connector-library/disconnect
//     The store's disconnect with its revoke hook wired to the
//     credential service: stored credentials are revoked BEFORE the
//     record's references are cleared.
//   POST /api/admin/connector-library/posture        {seatId, entryId, posture}
//   POST /api/admin/connector-library/prompts        {seatId, entryId}          (bite M2)
//     The brokered server's published starter prompts, listed at arm
//     time for the caller (their token is resolved from the
//     credential service and rides only on that one server call).
//   POST /api/admin/connector-library/prompts/get    {seatId, entryId, name, arguments?}
//     One prompt rendered into composer draft text — a draft, never
//     a send.
//   POST /api/admin/connector-library/tool-enable    {seatId, entryId, toolEnableMap}
//     Per-tool on/off against the connection's frozen snapshot.
//   POST /api/admin/connector-library/entry-state    {seatId, entryId, state}   owner/admin
//   POST /api/admin/connector-library/entries        add a custom entry         owner/admin
//   POST /api/admin/connector-library/entries/install-report                    owner/admin
//     The ledger join's receiving end (pipeline map G2): a finished
//     MCP install pipeline on a person's machine reports the server
//     it installed (mcp-library-report.mjs), and this action records
//     the intent in the tool-connections store — kind 'mcp-stdio',
//     server_ref the installed path, state 'registered', NEVER
//     'verified' (no tools/list has reached that server from here) —
//     AND creates the library entry itself (kind 'mcp-local',
//     sql/080): the entry carries the local facts (installed path,
//     config snippet, the pipeline's baseline fingerprint) in place
//     of an endpoint. A duplicate report for the same derived entry
//     id refreshes that one entry — never a second row.
//   POST /api/admin/connector-library/entries/remove {seatId, entryId}          owner/admin
//
// CUSTOM ENTRIES PASS THE GATE (pipeline map G1,
// connector-custom-gate.mjs): an entry a person adds has no catalog
// provenance, so creating one also registers the intent in the
// tool-connections store (who, when, the URL) and runs the gate
// probe — a tools/list with NO credential — before the entry is
// offered as connectable. Every connect road for a custom entry
// re-checks the gate before any credential is stored or any
// connection lands, freezes the connection's tool snapshot from the
// gate probe's own list, and records the connection at the default
// posture 'ask' whatever the body asked for (loosening is the
// posture action's deliberate road). The gate is consulted wherever
// this handler can reach the tool-connections store — in production
// that is always (the same pool the library store reads from); a
// handler built with an injected store and no tool-connections
// store (unit-test harnesses) reports the gate as not run on create
// and leaves connects on their previous road.
//
// Gating follows the library read route: an active workspace member,
// tenant from the membership, person from the actor's subject — a
// body naming another tenant or person is refused (400). Personal
// acts (connect, disconnect, posture) act on the caller's own
// connection only. Workspace acts (entry-state, add/remove custom)
// are owner/admin. Auditors never write (skill-route precedent).
//
// THE WORKSPACE SET (SYNC S1): "the caller's own connection" is the
// workspace SET's row for the entry (connector-library.mjs) — a
// connect completed on any seat becomes the set's row, a posture /
// tool-enable write from any seat lands on it, and a disconnect
// from any seat disconnects it for every seat. The seat in a write
// body names the library the action was taken from; the store
// resolves the set's row behind it. Credential resolves/revokes
// address the vault record by the reference's own provider segment
// (providerIdForRef), because the set's credential was stored under
// the seat it was set up on.
//
// CUSTOM ENTRIES JOIN THE SET (SYNC S2a): the personal roads fetch
// the entry person-scoped, so a custom entry the caller owns
// resolves from any seat (the store projects it; another person's
// custom does not resolve at all). The GATE still keys per
// (seat, entry): ensureCustomGate runs against the entry AS READ
// ON THE ARRIVING SEAT (its view seat is the arriving seat), so a
// connect through a new seat registers and probes that seat's own
// gate row — the gate state never travels. The CREDENTIAL, by
// contrast, is minted under the seat the connection row lands on
// (credentialSeatFor): a custom entry's provenance seat, so the
// reference, the provider id, and the connection row's seat agree,
// and S1's resolves find the record on every seat.

import { randomUUID } from 'node:crypto';

import pg from 'pg';

import {
  buildConnectorTokenRef,
  createConnectorLibraryStore,
  planPromptSnapshot,
  validateVaultTokenRef,
  CONNECTOR_POSTURES,
} from './connector-library.mjs';
import { LIVE_SEATS, NATIVE_STATE_SOURCES, catalogEntryById } from './connector-catalog.mjs';
import { createMcpPromptsClient, renderPromptText } from './connector-mcp-prompts.mjs';
import { createCredentialConnectClient } from './credential-connect.mjs';
import {
  createConnectorOAuthClient,
  createConnectorOAuthPendingStore,
  hashOAuthState,
  newOAuthState,
  newPkceVerifier,
  pkceChallenge,
} from './connector-oauth-pending.mjs';
import {
  ConnectorOAuthDcrError,
  connectorOAuthKindForEntry,
  fixedProviderForEntry,
  resolvePendingOAuthClient,
  startCimdConnect,
  startDcrConnect,
} from './connector-oauth-dcr.mjs';
import { createToolConnectionsStore } from './tool-connections.mjs';
import {
  mcpLocalToolConnectionKey,
  validateInstallLibraryReport,
} from '../core/mcp-library-report.mjs';
import {
  classifyCustomGate,
  getCustomGateRow,
  probeCustomGate,
  registerCustomGateIntent,
} from './connector-custom-gate.mjs';

export const CONNECTOR_LIBRARY_WRITE_BASE = '/api/admin/connector-library';
export const CONNECTOR_OAUTH_CALLBACK_PATH = '/api/admin/connector-library/oauth/callback';

const { Pool } = pg;
let sharedPool;
function getPool() {
  if (sharedPool) return sharedPool;
  const connectionString = String(process.env.HELMION_DATABASE_URL ?? '').trim();
  if (!connectionString) return null;
  sharedPool = new Pool({
    connectionString,
    max: 3,
    ssl: /sslmode=disable/.test(connectionString) ? false : { rejectUnauthorized: false },
  });
  return sharedPool;
}

const AUTHORITY_KEYS = Object.freeze([
  'tenantId', 'tenant_id', 'personId', 'person_id', 'subject', 'actorSubject', 'actor_subject', 'addedBy', 'added_by',
]);
const CREDENTIAL_VALUE_KEYS = Object.freeze(['accessToken', 'refreshToken', 'token', 'secret', 'password', 'apiKey', 'api_key', 'credential', 'value']);

function failure(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}
function refuseAuthoritySelectors(input) {
  if (!input || typeof input !== 'object') return;
  for (const key of AUTHORITY_KEYS) {
    if (key in input) throw failure(400, `the request may not name ${key} — the workspace and the person come from the signed-in membership`);
  }
}
function refuseCredentialValues(input, { allow = [] } = {}) {
  if (!input || typeof input !== 'object') return;
  for (const key of Object.keys(input)) {
    if (CREDENTIAL_VALUE_KEYS.includes(key) && !allow.includes(key)) {
      throw failure(400, `credential values never ride this road — "${key}" is refused; the library record holds vault references only`);
    }
  }
}

const providerIdFor = (seatId, entryId) => `connector.${seatId}.${entryId}`;

// The provider id a stored credential actually lives under (SYNC
// S1, the workspace connector SET): a connection's vault references
// are minted by buildConnectorTokenRef as
// vault://tenant/<tenant>/connector.<seat>.<entry>/… — the middle
// segment IS the provider id the credential service stored the
// record under (its rows are keyed (tenant, provider_id,
// reference)), and <seat> is the seat the connection was SET UP
// on, which is not necessarily the seat a later action arrives on.
// Resolving or revoking with the arriving seat's provider id
// would address a vault row that was never written, so wherever a
// reference is in hand, its own segment names the provider.
const providerIdForRef = (ref, seatId, entryId) => {
  const match = /^vault:\/\/tenant\/[^/]+\/([^/]+)\//.exec(String(ref ?? ''));
  return match ? match[1] : providerIdFor(seatId, entryId);
};

// The seat a connection's credentials are minted under (SYNC S2a):
// for a stocked entry it is the seat the connect arrived on — the
// seat the connection row is recorded under. For a CUSTOM entry
// the connection row lands on the entry's PROVENANCE seat (the
// store records it there, because the connection's foreign key
// names the entry's one physical row), so the references are
// minted under that seat too: S1's invariant — the set row's seat,
// its references' seat segment, and the vault provider id all name
// the one seat the connection was recorded under — then holds for
// custom entries exactly as for stocked ones, and a resolve
// presenting the connection's seat finds the vault record that
// exists. Entries from stores that carry no provenance (test
// fakes shaped before S2a) fall back to the arriving seat, which
// is their physical seat by construction.
const credentialSeatFor = (entry, seatId) => (entry?.kind === 'custom' ? (entry.provenanceSeatId ?? seatId) : seatId);

// The fixed road's connect scopes, per provider (m3-github
// DESIGN.md §1.2/§6.2): the GitHub entry asks for `repo` and
// `read:org` — the smallest classic scopes covering the repository,
// issue, and pull-request work the catalog entry promises. The DCR
// road needs no such table: its scopes come from the server's own
// published metadata at registration time — UNLESS the catalog
// entry declares its own ask (a pick whose words promise less
// than its server publishes; Atlassian's is the first), in which
// case the declared ask, narrowed to what the server offers, is
// what registration and consent request (declaredOAuthScopes
// below, ruled by the same catalog-authority law as
// effectiveAuthMode).
//
// Bite R2's family, same discipline:
//   - slack: the USER scopes the catalog entry's words promise —
//     search and read across conversations and files, nothing that
//     posts or writes (the promise is "draft replies", composed by
//     the agent, never sent under the person's name). Every scope
//     sits inside the set Slack's MCP server itself publishes
//     (live metadata read, 2026-11-10; the R2 tests pin the ask
//     against that published set).
//   - asana: EMPTY, deliberately. Asana defines no permission
//     split for MCP apps — its own guide says to use `default` or
//     omit the scope, and that including a scope parameter
//     produces an error — so the Asana factory sends no scope
//     parameter at all; the grant is the person's own Asana access.
//   - hubspot: EMPTY, deliberately. HubSpot defines no scopes on
//     an MCP connector — its consent page derives them from the
//     server's tools and the person's own permissions — so the
//     HubSpot factory sends no scope parameter either.
//   - google: NO entry in this table, deliberately. One provider
//     ('google') serves three entries whose asks DIFFER per
//     product (Gmail's pair, Calendar's three, Drive's pair — the
//     scopes Google's own Workspace MCP setup page names), so a
//     per-provider table cannot carry them. Each Google entry
//     declares its own ask as catalog data (oauthScopes), and the
//     fixed start below reads it through declaredOAuthScopes —
//     the catalog definition, never the stored row.
//   - canva / dropbox: NO entries in this table, deliberately —
//     the same law as google's, one entry per provider: each
//     entry declares its own ask as catalog data (oauthScopes —
//     the scopes its server's own protected-resource document
//     publishes for MCP), and the fixed start below reads it
//     through declaredOAuthScopes. A per-provider table would
//     only duplicate the catalog's declaration.
const FIXED_CONNECT_SCOPES = Object.freeze({
  github: Object.freeze(['repo', 'read:org']),
  slack: Object.freeze([
    'search:read.public', 'search:read.private', 'search:read.im', 'search:read.mpim',
    'search:read.files', 'search:read.users',
    'channels:history', 'groups:history', 'im:history', 'mpim:history',
    'channels:read', 'groups:read', 'im:read', 'mpim:read',
    'users:read', 'users:read.email', 'files:read',
  ]),
  asana: Object.freeze([]),
  hubspot: Object.freeze([]),
});

// The catalog definition is the authority for a seeded entry's auth
// road — never the stored row alone. Rows seeded under an older
// catalog keep its label (the read-route seed refreshes only tenants
// holding zero entries), and a live OAuth entry's rows still said
// 'none' long after the catalog's correction to 'oauth': connect
// dispatched on the stale label and recorded a "No sign-in"
// connection no consent produced (live exercise, 2026-11-09). So the
// dispatch below runs on the catalog's authMode whenever a catalog
// definition exists for the entry; the stored row's mode governs
// only entries the catalog does not define (custom entries are a
// person's own — their stored mode is their truth). A stored row
// can therefore never reroute an OAuth entry onto a direct road,
// whatever the seed says. (A migration aligns the stored rows; the
// guard stands either way.)
export function effectiveAuthMode(entry) {
  if (!entry || entry.kind === 'custom') return entry?.authMode ?? null;
  let definition = null;
  try { definition = catalogEntryById(entry.seatId, entry.id); } catch { definition = null; }
  return definition?.authMode ?? entry.authMode;
}

// The scopes a DCR connect asks for, under the same law: the
// catalog definition is the authority. Declared scopes are catalog
// data only — the store's fixed entry shape does not carry them —
// so a stored row can never supply or widen the ask; an entry the
// catalog does not define (or that declares nothing) gets null,
// and the DCR road falls back to the server's published set.
// Custom entries are a person's own: no catalog ask exists for
// them, and their stored row declares none either.
export function declaredOAuthScopes(entry) {
  if (!entry || entry.kind === 'custom') return null;
  let definition = null;
  try { definition = catalogEntryById(entry.seatId, entry.id); } catch { definition = null; }
  const declared = definition?.oauthScopes ?? null;
  return Array.isArray(declared) && declared.length ? [...declared] : null;
}

// The CIMD client id a connect identifies Helmian by, under the
// same law: the catalog definition is the authority. A declared
// CIMD identity is catalog data only — the store's fixed entry
// shape does not carry it — so a kind resolution ruled on the
// stored row alone cannot see it: Vercel's connect took the
// registration road its server refuses for hosted callbacks and
// the start answered 502, while the same handler fed a
// catalog-shaped entry answered the authorize hand-off (live
// walks and the stored-row proof, 2026-11-10). An entry the
// catalog does not define (or that declares nothing) gets null.
// Custom entries are a person's own: no catalog declaration
// exists for them, and their stored row declares none either.
export function declaredCimdClientId(entry) {
  if (!entry || entry.kind === 'custom') return null;
  let definition = null;
  try { definition = catalogEntryById(entry.seatId, entry.id); } catch { definition = null; }
  const declared = definition?.cimdClientId ?? null;
  return typeof declared === 'string' && declared.startsWith('https://') ? declared : null;
}

// The consent-boundary answer for OAuth entries Helmian holds no
// client registration for: the provider's resource metadata (RFC
// 9728) names its authorization server, whose metadata names the
// consent endpoint. Fetched server-side; any failure still answers
// the boundary with what the entry itself proves.
//
// The metadata lookup is DECORATIVE (2026-11-10 defect fix): the
// answer's visible content — the plain note naming the provider
// and the unplaced registration — does not depend on it (the
// panel never renders authorizationEndpoint), yet the fetches
// ran unbounded and sequential in front of that answer, so a
// stalled provider endpoint left the Connect click with no
// answer at all: no redirect, no form, no message. The whole
// lookup now shares one short budget; whatever it cannot read
// inside the budget leaves authorizationEndpoint null, exactly
// as a failed fetch did before. Exported so the road itself —
// not a copy of it — is what the timeout tests exercise.
export const CONSENT_BOUNDARY_FETCH_BUDGET_MS = 4000;

export async function consentBoundary(entry, fetchImpl) {
  const endpoint = String(entry.mcpEndpointUrl ?? '');
  let resourceMetadataUrl = null;
  let authorizationEndpoint = null;
  try {
    const u = new URL(endpoint);
    resourceMetadataUrl = `${u.origin}/.well-known/oauth-protected-resource${u.pathname.replace(/\/$/, '')}`;
  } catch { /* the entry's endpoint was validated at creation; defensive only */ }
  if (resourceMetadataUrl && fetchImpl) {
    const deadline = Date.now() + CONSENT_BOUNDARY_FETCH_BUDGET_MS;
    const boundedFetch = (url) => fetchImpl(url, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
    try {
      const res = await boundedFetch(resourceMetadataUrl);
      if (res?.ok) {
        const meta = await res.json();
        const servers = Array.isArray(meta?.authorization_servers) ? meta.authorization_servers : [];
        for (const server of servers) {
          if (Date.now() >= deadline) break;
          try {
            const asRes = await boundedFetch(`${String(server).replace(/\/$/, '')}/.well-known/oauth-authorization-server`);
            if (asRes?.ok) { authorizationEndpoint = (await asRes.json())?.authorization_endpoint ?? null; if (authorizationEndpoint) break; }
          } catch { /* try the next server */ }
        }
      }
    } catch { /* the boundary answer stands without the live fetch */ }
  }
  let displayName = null;
  try { displayName = catalogEntryById(entry.seatId, entry.id)?.name ?? null; } catch { displayName = null; }
  if (!displayName) {
    const p = fixedProviderForEntry(entry);
    displayName = p ? p.charAt(0).toUpperCase() + p.slice(1) : 'This connector';
  }
  return {
    status: 'consent-boundary',
    seatId: entry.seatId,
    entryId: entry.id,
    provider: fixedProviderForEntry(entry) ?? 'oauth',
    mcpEndpointUrl: endpoint || null,
    resourceMetadataUrl,
    authorizationEndpoint,
    note: `Helmian's app registration in ${displayName}'s own console has not been placed yet, so ${displayName} cannot be connected inside Helmian yet. Nothing was connected.`,
  };
}

const callbackPage = (title, line) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta http-equiv="refresh" content="2;url=/app/#integrations"></head><body style="font-family:system-ui,sans-serif;background:#0B1120;color:#F8FAFC;display:grid;place-items:center;min-height:100vh;margin:0"><main style="text-align:center;max-width:34rem;padding:2rem"><h1 style="font-size:1.25rem">${title}</h1><p style="color:#94A3B8">${line}</p><p><a href="/app/#integrations" style="color:#38BDF8">Back to Helmian</a></p></main></body></html>`;

export function createConnectorLibraryWriteHandler({
  store: injectedStore,
  pendingStore: injectedPending,
  credentialClient: injectedCredentials,
  oauthClientFor: injectedOAuthClientFor,
  promptsClient: injectedPrompts,
  toolConnections: injectedToolConnections,
  gateProbe: injectedGateProbe,
  fetchImpl = globalThis.fetch,
} = {}) {
  const resolveStore = () => injectedStore ?? (getPool() ? createConnectorLibraryStore(getPool()) : null);
  const resolvePending = () => injectedPending ?? (getPool() ? createConnectorOAuthPendingStore(getPool()) : null);
  // The custom-entry gate's store. Production (no injected library
  // store) reaches it through the same pool the library reads from;
  // a handler built around an injected store reaches it only when
  // one is injected — a unit-test harness never wakes a real pool
  // by accident (see the header note).
  const resolveToolConnections = () => {
    if (injectedToolConnections !== undefined) return injectedToolConnections;
    if (injectedStore !== undefined) return null;
    return getPool() ? createToolConnectionsStore(getPool()) : null;
  };
  // One gate probe: the injected fake in tests, the real
  // null-credential probe in production. Null when no gate store is
  // reachable — the gate cannot run, and callers say so.
  const runGateProbe = async ({ tenantId, entry }) => {
    const tc = resolveToolConnections();
    if (!tc) return null;
    if (injectedGateProbe) return injectedGateProbe({ tenantId, entry, toolConnections: tc });
    return probeCustomGate({ toolConnections: tc, tenantId, entry });
  };
  const resolveCredentials = () => injectedCredentials !== undefined ? injectedCredentials : createCredentialConnectClient();
  // OAuth clients come from the provider registry — there is no
  // default client (m3-github/DESIGN.md §6.2). Null means the
  // provider is unknown or not configured. The connect start
  // resolves its fixed-road client here, by provider; the callback
  // resolves from the pending row itself (below).
  const resolveOAuthClient = (provider) => injectedOAuthClientFor
    ? injectedOAuthClientFor(provider)
    : createConnectorOAuthClient(provider, { fetchImpl });
  // The CALLBACK's client, resolved from the pending row after the
  // row is taken: the fixed registry answers first — a GitHub row
  // resolves to exactly the client resolveOAuthClient builds — and
  // a row carrying DCR fields (the token endpoint, and any secret
  // the server issued, from sql/081) resolves to the exchange
  // client built from the row alone; no discovery runs at callback
  // time. The injected seam, when a harness provides one, still
  // rules by the row's provider.
  const resolveCallbackOAuthClient = (pending) => injectedOAuthClientFor
    ? injectedOAuthClientFor(pending?.provider)
    : resolvePendingOAuthClient(pending, { fetchImpl });
  const resolvePrompts = () => injectedPrompts ?? createMcpPromptsClient({ fetchImpl });

  return async function connectorLibraryWrite({ request, response, requestUrl, activeTenantActor, send, TenantAuthorizationError, readJson }) {
    const path = requestUrl?.pathname ?? '';
    const isCallback = request?.method === 'GET' && path === CONNECTOR_OAUTH_CALLBACK_PATH;
    const isWrite = request?.method === 'POST' && path.startsWith(`${CONNECTOR_LIBRARY_WRITE_BASE}/`) && path !== CONNECTOR_OAUTH_CALLBACK_PATH;
    if (!isCallback && !isWrite) return false;

    const sendJson = (status, payload) => send(response, status, JSON.stringify({ valid: status < 400, ...payload }));
    const membershipError = (error) => error?.status === 403 || error instanceof TenantAuthorizationError;
    try {
      const actor = await activeTenantActor(request);
      const tenantId = String(actor?.tenantId ?? '');
      const personId = String(actor?.subject ?? '');
      const role = String(actor?.role ?? '').toLowerCase();
      if (!tenantId || !personId) throw failure(403, 'workspace membership is required');
      if (role === 'auditor') throw failure(403, 'auditors read the connector library; they do not change it');
      // The credential vault's actor contract (credential-vault.mjs
      // requireActor): every store / resolve / revoke must carry the
      // full actor context as top-level fields — tenantId plus these
      // four — or the service refuses the call outright
      // (actor_context_required). The credential-connect route has
      // always sent them; this route's calls did not, so every OAuth
      // callback store was refused at the keeping step and no library
      // connection could ever land (the Notion failure, 2026-11-10).
      // sessionId / requestId ride the verified actor when the
      // session layer minted them (live-admin does); the randomUUID
      // fallback is the audit-event-repository convention for actor
      // shapes that carry none.
      const actorContext = {
        actorSubject: personId,
        actorRole: role,
        sessionId: actor?.sessionId ?? randomUUID(),
        requestId: actor?.requestId ?? randomUUID(),
      };

      // ------------------------------------------------------ callback
      if (isCallback) {
        const fail = (line) => { send(response, 200, callbackPage('That sign-in did not land', line), 'text/html; charset=utf-8'); return true; };
        const code = requestUrl.searchParams.get('code');
        const state = requestUrl.searchParams.get('state');
        const providerError = requestUrl.searchParams.get('error');
        if (providerError) return fail('The sign-in answered with an error, so nothing was connected. Start the connect again from Helmian.');
        if (!code || !state) return fail('The sign-in sent back no code, so nothing was connected. Start the connect again from Helmian.');
        const pendingStore = resolvePending();
        const pending = pendingStore ? await pendingStore.take(tenantId, hashOAuthState(state)) : null;
        if (!pending) return fail('This sign-in link has expired or was never started here. Start the connect again from Helmian.');
        if (pending.personId !== personId) return fail('This sign-in was started by a different person in the workspace, so it cannot land on your account.');
        // The client is resolved from the pending row itself —
        // never a default: the fixed registry for a fixed-provider
        // row, the row's own DCR fields for a self-registered one.
        // A row no client answers for gets the same honest answer
        // as an expired link: Helmian cannot finish what it holds
        // no client for.
        const oauthClient = resolveCallbackOAuthClient(pending);
        if (!oauthClient) return fail('This sign-in link has expired or was never started here. Start the connect again from Helmian.');
        const providerName = oauthClient.displayName || pending.provider;
        const credentials = resolveCredentials();
        if (!credentials) return fail('Helmian\u2019s credential storage is not switched on, so the sign-in could not be kept. Nothing was connected.');
        const store = resolveStore();
        if (!store) return fail('The connector library is not switched on yet. Nothing was connected.');
        let tokens;
        try {
          tokens = await oauthClient.exchangeCode({
            clientId: pending.clientId, code, codeVerifier: pending.codeVerifier, redirectUri: pending.redirectUri,
          });
        } catch {
          return fail(`The ${providerName} sign-in answered with an error, so nothing was connected. Start the connect again from Helmian.`);
        }
        const providerId = providerIdFor(pending.seatId, pending.entryId);
        const accessTokenRef = buildConnectorTokenRef({ tenantId, seatId: pending.seatId, entryId: pending.entryId, personId, tokenKind: 'access' });
        const refreshTokenRef = tokens.refreshToken
          ? buildConnectorTokenRef({ tenantId, seatId: pending.seatId, entryId: pending.entryId, personId, tokenKind: 'refresh' })
          : null;
        // The pair is stored as one oauth_bundle per reference (the
        // vault's bundle record holds both tokens) so resolving
        // either reference yields the bundle the turn road needs.
        const bundle = {
          tenantId, ...actorContext, providerId, credentialKind: 'oauth_bundle',
          accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
          tokenType: tokens.tokenType, scope: tokens.scope, expiresIn: tokens.expiresIn,
        };
        const storedAccess = await credentials.storeCredential({ ...bundle, credentialReference: accessTokenRef });
        if (!storedAccess?.accepted) return fail('The credential service would not keep the sign-in, so nothing was connected.');
        if (refreshTokenRef) {
          const storedRefresh = await credentials.storeCredential({ ...bundle, credentialReference: refreshTokenRef });
          if (!storedRefresh?.accepted) return fail('The credential service would not keep the sign-in, so nothing was connected.');
        }
        const grantedScopes = (tokens.scope ? tokens.scope.split(/\s+/) : pending.scopes).filter(Boolean);
        // The recorded identity is the person's own account at the
        // provider when the client can fetch it (GitHub: the login,
        // one GET /user at callback time) — fail-soft to the
        // provider's label when it cannot.
        let accountIdentity = `${providerName} account`;
        if (tokens.accessToken && typeof oauthClient.fetchIdentity === 'function') {
          try {
            const login = await oauthClient.fetchIdentity({ accessToken: tokens.accessToken });
            if (login) accountIdentity = String(login);
          } catch { /* the provider label stands */ }
        }
        const connection = await store.createConnection(tenantId, personId, {
          personId, seatId: pending.seatId, entryId: pending.entryId,
          accountIdentity, accessTokenRef, refreshTokenRef, grantedScopes,
        });
        void connection;
        // A custom entry's baseline freeze rides its gate (G1): the
        // snapshot frozen here is a fresh gate probe's list — an
        // uncredentialed look at the server, taken now — never a
        // list produced with the token that just landed. Best
        // effort by design: if the freeze cannot be taken, the
        // connection stands but arming dispatch refuses a custom
        // entry with no frozen snapshot rather than backstop-
        // freezing one at arm time.
        try {
          const landedEntry = await store.getEntry(tenantId, pending.seatId, pending.entryId, { personId });
          if (landedEntry?.kind === 'custom' && resolveToolConnections()) {
            const probe = await runGateProbe({ tenantId, entry: landedEntry });
            if (probe?.state === 'verified' && Array.isArray(probe.tools)) {
              await store.freezeSnapshot(tenantId, { personId, seatId: pending.seatId, entryId: pending.entryId }, probe.tools, personId);
            }
          }
        } catch { /* the dispatch guard carries the unfrozen case honestly */ }
        send(response, 200, callbackPage(`${providerName} is connected`, `${providerName} is now connected inside Helmian for this seat. Taking you back to Helmian.`), 'text/html; charset=utf-8');
        return true;
      }

      // -------------------------------------------------------- writes
      const body = (await readJson(request)) ?? {};
      refuseAuthoritySelectors(body);
      const action = path.slice(CONNECTOR_LIBRARY_WRITE_BASE.length + 1);
      const store = resolveStore();
      if (!store) { sendJson(503, { error: 'the connector library is not switched on yet (no database configured)' }); return true; }
      const seatId = String(body.seatId ?? '');
      const entryId = String(body.entryId ?? '');
      const key = { personId, seatId, entryId };
      const ownerAct = () => { if (!['owner', 'admin'].includes(role)) throw failure(403, 'this is a workspace-level change — it takes the workspace owner or an admin'); };

      // The caller's brokered-pipe token for the prompts actions
      // (mirror-design §4, bite M2): the entry must be Helmian-
      // brokered and the caller connected to it; the token is
      // resolved from the credential service under the connection's
      // own vault reference, held in memory for the one call, and
      // never returned, stored, or logged. Entries whose state joins
      // from elsewhere (helmian-github: channel repo links) hold no
      // token in the library at all — the honest answer for them is
      // PROMPTS_NOT_HELD, not a faked list.
      const brokeredToken = async (entry) => {
        if (entry.brokerMode !== 'helmian') {
          throw failure(400, 'this connector is a mirror of the seat\u2019s own account — Helmian does not hold its sign-in, so it cannot list starters for it', { code: 'VENDOR_MANAGED' });
        }
        if (entry.state !== 'available') throw failure(409, 'this connector is turned off by the workspace owner');
        const connection = await store.getConnection(tenantId, key);
        if (!connection || connection.state === 'disconnected') {
          if (NATIVE_STATE_SOURCES[entryId]) {
            throw failure(409, 'Helmian does not hold a sign-in token for this connector, so its starter prompts cannot be listed here yet', { code: 'PROMPTS_NOT_HELD' });
          }
          throw failure(409, 'connect this connector first — its starters are listed for the person connected to it', { code: 'NOT_CONNECTED' });
        }
        if (connection.state !== 'connected') {
          throw failure(409, 'this connector needs reconnecting before its starters can be listed', { code: 'NOT_CONNECTED' });
        }
        if (effectiveAuthMode(entry) === 'none') return { connection, accessToken: null };
        if (!connection.accessTokenRef) {
          throw failure(409, 'Helmian does not hold a sign-in token for this connector, so its starter prompts cannot be listed here yet', { code: 'PROMPTS_NOT_HELD' });
        }
        const credentials = resolveCredentials();
        if (!credentials) throw failure(503, 'Helmian\u2019s credential storage is not switched on, so the sign-in cannot be read', { code: 'CREDENTIAL_SERVICE_NOT_CONFIGURED' });
        const resolved = await credentials.resolveVaultCredential({
          // The set's row may have been set up on another seat:
          // the credential lives under the reference's own
          // provider segment (providerIdForRef), not this seat's.
          tenantId, ...actorContext, providerId: providerIdForRef(connection.accessTokenRef, seatId, entryId), credentialReference: connection.accessTokenRef, reasonClass: 'provider_call',
        });
        if (!resolved?.accepted) throw failure(502, 'the stored sign-in could not be read, so the starters could not be listed', { code: 'CREDENTIAL_NOT_RESOLVABLE' });
        const cred = resolved.credential;
        const accessToken = cred && typeof cred === 'object'
          ? (typeof cred.accessToken === 'string' && cred.accessToken ? cred.accessToken : (typeof cred.apiKey === 'string' && cred.apiKey ? cred.apiKey : null))
          : (typeof cred === 'string' && cred ? cred : null);
        if (!accessToken) throw failure(502, 'the stored sign-in could not be read, so the starters could not be listed', { code: 'CREDENTIAL_NOT_RESOLVABLE' });
        return { connection, accessToken };
      };

      // ------------------------------------------- the custom gate
      // The helpers every custom-entry road below shares (G1; see
      // the file header). ensureCustomGate rules one entry's gate:
      // { enforced:false } when no gate store is reachable (the
      // handler cannot consult the gate — production always can);
      // otherwise the intent is registered if it is missing (an
      // entry created before the gate existed heals here, at the
      // commitment point, instead of bricking), a missing or failed
      // receipt is re-probed once — the connect click is the
      // approval stage, and a server that was down at create time
      // gets its fresh chance here — and the probe's own tool list
      // rides back for the freeze.
      const ensureCustomGate = async (entry) => {
        const tc = resolveToolConnections();
        if (!tc) return { enforced: false, passed: true, gate: null, tools: null };
        let row = await getCustomGateRow(tc, tenantId, entry.seatId, entry.id);
        if (!row) {
          await registerCustomGateIntent(tc, tenantId, personId, entry);
          row = null;
        }
        let gate = classifyCustomGate(row);
        let tools = null;
        if (!gate.passed) {
          const result = await runGateProbe({ tenantId, entry });
          if (result?.state === 'verified' && Array.isArray(result.tools)) tools = result.tools;
          gate = classifyCustomGate(result?.row ?? null);
          if (!gate.passed && gate.state !== 'failed' && gate.state !== 'revoked') {
            // The probe could not write or return its receipt row
            // (a test fake, a store hiccup): rule from its answer.
            gate = result?.state === 'verified'
              ? { ...gate, state: 'verified', passed: true }
              : { ...gate, state: 'failed', passed: false, reason: 'gate-check-failed', detail: 'its safety check failed, so it cannot be connected yet', lastError: result?.error ?? gate.lastError };
          }
        }
        return { enforced: true, passed: gate.passed, gate, tools };
      };
      const refuseUngated = (ensured) => {
        sendJson(409, {
          error: ensured.gate?.state === 'failed'
            ? 'this custom connector has not passed its safety check — the check failed, so nothing was connected. Fix the server, or remove the entry and add it again.'
            : 'this custom connector has not passed its safety check yet, so nothing was connected.',
          code: 'CUSTOM_GATE_NOT_PASSED',
          gate: ensured.gate ? { state: ensured.gate.state, lastError: ensured.gate.lastError ?? null } : null,
        });
        return true;
      };
      // Freeze the baseline onto a connection that just landed for
      // a custom entry: the tool list is the gate probe's own —
      // passed in from the ensure step, or re-probed fresh here —
      // never a list taken with the person's credential. A freeze
      // that cannot be taken is reported, not hidden: the
      // connection stands, and dispatch refuses the arm honestly.
      const freezeGateBaseline = async (entry, tools) => {
        try {
          let list = Array.isArray(tools) ? tools : null;
          if (!list) {
            const result = await runGateProbe({ tenantId, entry });
            if (result?.state === 'verified' && Array.isArray(result.tools)) list = result.tools;
          }
          if (!list) return { frozen: false };
          const snapshot = await store.freezeSnapshot(tenantId, key, list, personId);
          return { frozen: true, snapshot };
        } catch { return { frozen: false }; }
      };
      // Gate step 4: a custom entry's connection is recorded at the
      // default 'ask' — a connect body naming a looser posture is
      // honoured for catalog/native entries only.
      const postureSpread = (entry) => (entry.kind === 'custom' ? {} : (body.posture ? { posture: String(body.posture) } : {}));

      if (action === 'connect') {
        refuseCredentialValues(body);
        const entry = await store.getEntry(tenantId, seatId, entryId, { personId });
        if (!entry) throw failure(404, 'connector entry not found in this seat\u2019s library');
        if (entry.state !== 'available') throw failure(409, 'this connector is turned off by the workspace owner');
        if (entry.brokerMode !== 'helmian') {
          sendJson(400, {
            error: 'this connector is a mirror of the seat\u2019s own account — Helmian does not hold its sign-in. It is managed in the vendor\u2019s own product; connecting it there does not connect it here.',
            code: 'VENDOR_MANAGED',
          });
          return true;
        }
        if (entry.kind === 'mcp-local') {
          // A local install is not connected from here: it lives on
          // a person's machine, the install pipeline's report is its
          // record, and it can only run on that machine. Recording a
          // "No sign-in" connection for it would dress a machine's
          // install up as a cloud connection — refused plainly.
          sendJson(400, {
            error: 'this connector is a local install on a person\u2019s own machine — there is nothing to connect from here. The install pipeline\u2019s report is its record, and it can only run on that machine.',
            code: 'MCP_LOCAL_NOT_CONNECTABLE',
          });
          return true;
        }
        const authMode = effectiveAuthMode(entry);
        // The seat this connect's credentials are minted under
        // (credentialSeatFor): the arriving seat for a stocked
        // entry; a custom entry's provenance seat, where its
        // connection row will land.
        const credentialSeatId = credentialSeatFor(entry, seatId);
        // The custom gate stands before every auth road: no
        // credential is asked for, stored, or landed on an entry
        // whose null-credential check has not passed.
        let gateEnsured = null;
        if (entry.kind === 'custom') {
          gateEnsured = await ensureCustomGate(entry);
          if (gateEnsured.enforced && !gateEnsured.passed) return refuseUngated(gateEnsured);
        }
        if (authMode === 'none') {
          const connection = await store.createConnection(tenantId, personId, {
            ...key, accountIdentity: 'No sign-in', grantedScopes: [], ...postureSpread(entry),
          });
          if (gateEnsured?.enforced) {
            const frozen = await freezeGateBaseline(entry, gateEnsured.tools);
            sendJson(201, { status: 'connected', connection, gate: { state: 'verified', frozen: frozen.frozen } });
            return true;
          }
          sendJson(201, { status: 'connected', connection });
          return true;
        }
        if (authMode === 'header') {
          const accessTokenRef = buildConnectorTokenRef({ tenantId, seatId: credentialSeatId, entryId, personId, tokenKind: 'access' });
          sendJson(200, {
            status: 'needs-credential',
            seatId, entryId,
            providerId: providerIdFor(credentialSeatId, entryId),
            accessTokenRef,
            completeAction: 'connect/header',
            note: 'Store the key through the connect/header action — it goes straight into the credential service under this reference, and the library record keeps the reference only.',
          });
          return true;
        }
        // authMode oauth — the sign-in roads. The entry's kind
        // (connector-oauth-dcr.mjs) is ruled on the
        // catalog-resolved entry — the `oauthEntry` local: the
        // catalog's auth mode and declared OAuth identity (its
        // scopes ask and its CIMD client id) laid over the stored
        // row, never the stored row alone. The declared identity
        // is catalog data the row's fixed shape cannot carry, so
        // a resolution ruled on the row alone sends a CIMD entry
        // down the registration road (the Vercel 502,
        // 2026-11-10). The starts receive the same resolved
        // entry — startCimdConnect reads the client id off it.
        // The kind decides:
        //   fixed — a registry provider (GitHub) with a configured
        //     client starts the real road (M3 §6.3): state + PKCE
        //     minted here, the handshake saved, the authorize URL
        //     answered. No configured client → the consent boundary
        //     below, word for word.
        //   dcr — the server lets Helmian register itself:
        //     startDcrConnect runs discovery → registration → the
        //     pending save, and the answer carries the authorize
        //     URL plus the approval briefing the composer renders.
        //     A server that takes no self-registered clients
        //     (dcr-unsupported) falls through to the consent
        //     boundary; every other named failure answers with its
        //     own code and its plain message.
        //   cimd — the entry declares a client metadata document:
        //     startCimdConnect runs discovery → the authorize URL
        //     built directly on the document URL as client_id, no
        //     registration call at all. A server that does not
        //     advertise CIMD (cimd-unsupported) falls through to
        //     the consent boundary the same way.
        // Anything else (no endpoint, not an OAuth entry at all)
        // keeps the consent-boundary answer.
        const connectScopes = declaredOAuthScopes(entry);
        const cimdClientId = declaredCimdClientId(entry);
        const oauthEntry = {
          ...entry, authMode,
          ...(cimdClientId ? { cimdClientId } : {}),
          ...(connectScopes ? { oauthScopes: connectScopes } : {}),
        };
        const oauthKind = connectorOAuthKindForEntry(oauthEntry);
        const callbackUrl = `https://helmian.cloud${CONNECTOR_OAUTH_CALLBACK_PATH}`;
        if (oauthKind?.kind === 'dcr' || oauthKind?.kind === 'cimd') {
          let started = null;
          try {
            const startConnect = oauthKind.kind === 'cimd' ? startCimdConnect : startDcrConnect;
            started = await startConnect({
              pendingStore: resolvePending(), tenantId, personId, seatId: credentialSeatId, entry: oauthEntry,
              provider: oauthKind.provider, redirectUri: callbackUrl, fetchImpl,
              scopes: connectScopes,
            });
          } catch (error) {
            if (!(error instanceof ConnectorOAuthDcrError)) throw error;
            if (error.code !== 'dcr-unsupported' && error.code !== 'cimd-unsupported') {
              throw failure(error.code === 'pending-store-unavailable' ? 503 : 502, error.message, { code: error.code });
            }
          }
          if (started) {
            sendJson(200, {
              status: 'authorize', seatId, entryId, provider: oauthKind.provider,
              authorizeUrl: started.authorizeUrl, briefing: started.briefing,
            });
            return true;
          }
        }
        if (oauthKind?.kind === 'fixed') {
          const client = resolveOAuthClient(oauthKind.provider);
          if (client) {
            const pendingStore = resolvePending();
            const state = newOAuthState();
            const codeVerifier = newPkceVerifier();
            // The ask: the entry's own catalog-declared scopes when
            // it declares any (the Google family — one provider,
            // three different per-product asks), else the
            // per-provider table above. No fixed entry before the
            // Google family declared catalog scopes, so every
            // existing road's ask is unchanged.
            const scopes = connectScopes ?? FIXED_CONNECT_SCOPES[oauthKind.provider] ?? [];
            const saved = pendingStore ? await pendingStore.save(tenantId, {
              stateHash: hashOAuthState(state),
              personId, seatId: credentialSeatId, entryId,
              provider: oauthKind.provider,
              // The row names the client the handshake runs under:
              // for the fixed road that is the registry client's own
              // env-held app id — the same value the client was
              // built from (the exchange posts the factory's own
              // pair; the callback never reads this field for a
              // fixed row).
              clientId: String(client.clientId ?? '').trim(),
              codeVerifier, redirectUri: callbackUrl, scopes,
            }) : null;
            if (!saved) {
              sendJson(503, { error: 'the OAuth road is not switched on yet, so the sign-in cannot be started', code: 'pending-store-unavailable' });
              return true;
            }
            const authorizeUrl = await client.authorizeUrl({
              redirectUri: callbackUrl, state, challenge: pkceChallenge(codeVerifier), scopes,
            });
            sendJson(200, { status: 'authorize', seatId, entryId, provider: oauthKind.provider, authorizeUrl });
            return true;
          }
        }
        sendJson(200, await consentBoundary(entry, fetchImpl));
        return true;
      }

      if (action === 'connect/header') {
        refuseCredentialValues(body, { allow: ['apiKey'] });
        const apiKey = typeof body.apiKey === 'string' ? body.apiKey : '';
        if (!apiKey) throw failure(400, 'the key itself is required on this one action — it is stored in the credential service and never written to the library record');
        const entry = await store.getEntry(tenantId, seatId, entryId, { personId });
        if (!entry) throw failure(404, 'connector entry not found in this seat\u2019s library');
        if (entry.brokerMode !== 'helmian') throw failure(400, 'this entry is vendor-brokered — Helmian holds no credential for it');
        if (entry.kind === 'mcp-local') throw failure(400, 'this entry is a local install on a person\u2019s own machine — Helmian holds no credential for it; the install pipeline\u2019s report is its record', { code: 'MCP_LOCAL_NOT_CONNECTABLE' });
        if (effectiveAuthMode(entry) !== 'header') throw failure(400, 'this entry does not take a header key — use its own connect road');
        // The custom gate stands before the key is stored: a key is
        // never committed to a server the null-credential check has
        // not examined.
        let gateEnsured = null;
        if (entry.kind === 'custom') {
          gateEnsured = await ensureCustomGate(entry);
          if (gateEnsured.enforced && !gateEnsured.passed) return refuseUngated(gateEnsured);
        }
        const credentials = resolveCredentials();
        if (!credentials) { sendJson(503, { error: 'Helmian\u2019s credential storage is not switched on, so the key cannot be kept yet', code: 'CREDENTIAL_SERVICE_NOT_CONFIGURED' }); return true; }
        const credentialSeatId = credentialSeatFor(entry, seatId);
        const accessTokenRef = buildConnectorTokenRef({ tenantId, seatId: credentialSeatId, entryId, personId, tokenKind: 'access' });
        const stored = await credentials.storeCredential({
          tenantId, ...actorContext, providerId: providerIdFor(credentialSeatId, entryId), credentialReference: accessTokenRef,
          credentialKind: 'api_key', apiKey,
        });
        if (!stored?.accepted) { sendJson(502, { error: 'the credential service would not keep the key, so nothing was connected', code: 'CREDENTIAL_STORE_REFUSED' }); return true; }
        const connection = await store.createConnection(tenantId, personId, {
          ...key,
          accountIdentity: typeof body.accountLabel === 'string' && body.accountLabel.trim() ? body.accountLabel.trim().slice(0, 512) : 'API key',
          accessTokenRef, grantedScopes: [], ...postureSpread(entry),
        });
        if (gateEnsured?.enforced) {
          const frozen = await freezeGateBaseline(entry, gateEnsured.tools);
          sendJson(201, { status: 'connected', connection, gate: { state: 'verified', frozen: frozen.frozen } });
          return true;
        }
        sendJson(201, { status: 'connected', connection });
        return true;
      }

      if (action === 'connect/complete') {
        // Land a connection from a vault reference the caller stored
        // through another Helmian road — references only, verified
        // twice: the reference must be exactly the one this surface
        // mints for the caller, and the credential must resolve.
        refuseCredentialValues(body);
        const completeEntry = await store.getEntry(tenantId, seatId, entryId, { personId });
        if (!completeEntry) throw failure(404, 'connector entry not found in this seat\u2019s library');
        if (completeEntry.kind === 'mcp-local') throw failure(400, 'this entry is a local install on a person\u2019s own machine — Helmian holds no credential for it; the install pipeline\u2019s report is its record', { code: 'MCP_LOCAL_NOT_CONNECTABLE' });
        if (effectiveAuthMode(completeEntry) === 'oauth') {
          throw failure(400, 'this connector signs in with OAuth — its connection lands only through its sign-in callback, never from a stored reference');
        }
        // The custom gate stands before the stored credential is
        // resolved or the connection lands (same law as the other
        // connect roads).
        let gateEnsured = null;
        if (completeEntry.kind === 'custom') {
          gateEnsured = await ensureCustomGate(completeEntry);
          if (gateEnsured.enforced && !gateEnsured.passed) return refuseUngated(gateEnsured);
        }
        const accessTokenRef = String(body.accessTokenRef ?? '');
        const credentialSeatId = credentialSeatFor(completeEntry, seatId);
        const expected = buildConnectorTokenRef({ tenantId, seatId: credentialSeatId, entryId, personId, tokenKind: 'access' });
        if (accessTokenRef !== expected) {
          validateVaultTokenRef(accessTokenRef, tenantId, 'accessTokenRef');
          throw failure(400, 'accessTokenRef is not the reference this surface mints for you on this connector');
        }
        const credentials = resolveCredentials();
        if (!credentials) { sendJson(503, { error: 'Helmian\u2019s credential storage is not switched on, so the stored credential cannot be checked', code: 'CREDENTIAL_SERVICE_NOT_CONFIGURED' }); return true; }
        const resolved = await credentials.resolveVaultCredential({ tenantId, ...actorContext, providerId: providerIdFor(credentialSeatId, entryId), credentialReference: accessTokenRef, reasonClass: 'provider_call' });
        if (!resolved?.accepted) { sendJson(400, { error: 'no credential is stored under that reference yet — store it first, then complete the connect', code: 'CREDENTIAL_NOT_STORED' }); return true; }
        const connection = await store.createConnection(tenantId, personId, {
          ...key,
          accountIdentity: typeof body.accountLabel === 'string' && body.accountLabel.trim() ? body.accountLabel.trim().slice(0, 512) : 'Stored key',
          accessTokenRef, grantedScopes: [], ...postureSpread(completeEntry),
        });
        if (gateEnsured?.enforced) {
          const frozen = await freezeGateBaseline(completeEntry, gateEnsured.tools);
          sendJson(201, { status: 'connected', connection, gate: { state: 'verified', frozen: frozen.frozen } });
          return true;
        }
        sendJson(201, { status: 'connected', connection });
        return true;
      }

      if (action === 'disconnect') {
        refuseCredentialValues(body);
        const credentials = resolveCredentials();
        const revoke = credentials
          ? async (ref) => {
            // A disconnect from any seat revokes the SET row's
            // credentials: each reference names its own provider
            // segment — the seat the connection was set up on —
            // which is where the vault record actually lives.
            const out = await credentials.revokeVaultCredential({ tenantId, ...actorContext, providerId: providerIdForRef(ref, seatId, entryId), credentialReference: ref });
            if (out && out.accepted === false) throw failure(502, 'the credential service would not revoke a stored credential, so the disconnect was not recorded');
          }
          : undefined;
        const result = await store.disconnectConnection(tenantId, key, personId, { revoke });
        sendJson(200, { status: 'disconnected', connection: result.connection, revokedRefs: result.revokedRefs, custodyRevoked: Boolean(credentials) });
        return true;
      }

      if (action === 'posture') {
        refuseCredentialValues(body);
        const posture = String(body.posture ?? '');
        if (!CONNECTOR_POSTURES.includes(posture)) throw failure(400, `posture must be one of ${CONNECTOR_POSTURES.join(', ')}`);
        const connection = await store.setPosture(tenantId, key, posture, personId);
        sendJson(200, { status: 'posture-set', connection });
        return true;
      }

      if (action === 'prompts' || action === 'prompts/get') {
        // The MCP-prompts mechanism (mirror-design §4, bite M2): a
        // brokered server's published starter prompts, listed at arm
        // time for the person connected to it, and — on the /get
        // half — one prompt rendered into composer draft text. The
        // token rides only on the call to the server itself.
        refuseCredentialValues(body);
        const entry = await store.getEntry(tenantId, seatId, entryId, { personId });
        if (!entry) throw failure(404, 'connector entry not found in this seat\u2019s library');
        const { accessToken } = await brokeredToken(entry);
        const client = resolvePrompts();
        if (action === 'prompts') {
          const listed = await client.listPrompts({ endpoint: entry.mcpEndpointUrl, accessToken });
          if (!listed.supported) {
            sendJson(200, { status: 'ok', supported: false, prompts: [], note: 'This connector\u2019s server publishes no starter prompts.' });
            return true;
          }
          const plan = planPromptSnapshot(listed.prompts);
          sendJson(200, { status: 'ok', supported: true, prompts: plan.prompts, snapshotHash: plan.snapshotHash });
          return true;
        }
        const name = String(body.name ?? '').trim();
        if (!name) throw failure(400, 'the prompt name is required');
        const rawArgs = body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments) ? body.arguments : {};
        const args = {};
        for (const [k, v] of Object.entries(rawArgs)) {
          if (typeof v !== 'string') throw failure(400, 'prompt arguments are text — they seed a draft, nothing more');
          args[k] = v.slice(0, 2000);
        }
        const rendered = await client.getPrompt({ endpoint: entry.mcpEndpointUrl, accessToken, name, args });
        sendJson(200, { status: 'ok', name, text: renderPromptText(rendered) });
        return true;
      }

      if (action === 'tool-enable') {
        // Per-tool on/off against the connection's frozen snapshot
        // (mirror-design §3.1 Tool access, bite M2): the store
        // refuses any tool the snapshot does not name, so a stale
        // face can never invent one. Posture stays the 'posture'
        // action's business; this is only the tool map.
        refuseCredentialValues(body);
        const map = body.toolEnableMap;
        if (!map || typeof map !== 'object' || Array.isArray(map)) throw failure(400, 'toolEnableMap must be an object keyed by tool name');
        const connection = await store.setToolEnableMap(tenantId, key, map, personId);
        sendJson(200, { status: 'tool-map-set', connection });
        return true;
      }

      if (action === 'entry-state') {
        refuseCredentialValues(body);
        ownerAct();
        const state = String(body.state ?? '');
        if (!['available', 'disabled-by-owner'].includes(state)) throw failure(400, 'state must be "available" or "disabled-by-owner"');
        const entry = await store.setEntryState(tenantId, seatId, entryId, state, personId);
        sendJson(200, { status: 'entry-state-set', entry });
        return true;
      }

      if (action === 'entries') {
        refuseCredentialValues(body);
        ownerAct();
        if (!LIVE_SEATS.includes(seatId)) throw failure(400, 'seatId is not a seat that holds a connector library');
        const name = String(body.name ?? '').trim();
        if (!name) throw failure(400, 'a custom connector needs a name');
        const authMode = String(body.authMode ?? '');
        if (!['none', 'header', 'oauth'].includes(authMode)) throw failure(400, 'authMode must be one of none, header, oauth');
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'connector';
        const entry = await store.createEntry(tenantId, personId, {
          seatId,
          id: `custom-${slug}`,
          kind: 'custom',
          brokerMode: 'helmian',
          name,
          oneLiner: String(body.oneLiner ?? '').trim().slice(0, 512) || name,
          vendorName: 'Custom',
          mcpEndpointUrl: String(body.mcpEndpointUrl ?? ''),
          authMode,
          category: typeof body.category === 'string' ? body.category.slice(0, 128) : null,
          addedBy: personId,
        });
        // THE GATE (G1): the entry is registered as intent in the
        // tool-connections store — who added it, when, and the URL
        // are the provenance record — and probed with NO credential
        // before it is ever offered as connectable. The entry is
        // created either way: a failed check leaves it standing but
        // unconnectable and unarmable, with the failure recorded on
        // its gate row and named in this answer. A gate that cannot
        // run at all says so ('not-run' / 'error') rather than
        // dressing the entry up as checked.
        let gate = { state: 'not-run' };
        const tc = resolveToolConnections();
        if (tc) {
          try {
            await registerCustomGateIntent(tc, tenantId, personId, entry);
            const result = await runGateProbe({ tenantId, entry });
            gate = {
              state: result?.state ?? 'failed',
              ...(Number.isInteger(result?.toolsCount) ? { toolsCount: result.toolsCount } : {}),
              ...(result?.error ? { error: String(result.error) } : {}),
            };
          } catch (error) {
            gate = { state: 'error', error: String(error?.message ?? error) };
          }
        }
        sendJson(201, { status: 'created', entry, gate });
        return true;
      }

      if (action === 'entries/install-report') {
        // THE LEDGER JOIN, direction 1 (pipeline map G2): a finished
        // install pipeline on a person's machine reports the server
        // it installed, and the report lands HERE in two records:
        //
        //   1. THE LIBRARY ENTRY (sql/080): kind 'mcp-local',
        //      brokerMode 'helmian', carrying the local facts —
        //      installed path, config snippet, and the pipeline's
        //      baseline fingerprint — in place of an endpoint (a
        //      stdio server on a person's machine has none, and a
        //      fabricated URL would be a false record). The entry id
        //      is DERIVED from the server name by the report's own
        //      validation, never named by the reporter: a duplicate
        //      report for the same install refreshes that one entry
        //      through the store's create road (a re-install's new
        //      baseline lands; no second row ever appears), and an
        //      existing entry of a DIFFERENT kind under the derived
        //      id is a conflict, refused — the report is never
        //      recorded against another connector's row.
        //   2. THE INTENT REGISTRATION, through the same
        //      tool-connections receipt path the custom-entry gate
        //      used — register() writes intent; the row's subject
        //      and timestamps are the provenance, its server_ref the
        //      installed path. No probe receipt is written:
        //      recordProbeReceipt demands a tools/list the cloud
        //      has never run against this server, so the
        //      registration stands at 'registered', never
        //      'verified', until a road exists that can list a
        //      local server's tools (the runner on that machine is
        //      the only thing that can).
        //
        // Order matters: the tool-connections presence check comes
        // first (a report that cannot be recorded at all answers
        // 503 before anything is written), then the entry, then the
        // registration — a failure mid-way leaves at most an entry a
        // re-report refreshes, never a registration claiming an
        // install the library does not hold.
        refuseCredentialValues(body);
        ownerAct();
        if (!LIVE_SEATS.includes(seatId)) throw failure(400, 'seatId is not a seat that holds a connector library');
        const installReport = validateInstallLibraryReport(body.installReport);
        const tc = resolveToolConnections();
        if (!tc) {
          sendJson(503, {
            error: 'the install report could not be recorded — the tool-connections store is not reachable from this handler, so nothing was written',
            code: 'INSTALL_REPORT_NOT_RECORDED',
          });
          return true;
        }
        const priorEntry = await store.getEntry(tenantId, seatId, installReport.entryId);
        if (priorEntry && priorEntry.kind !== 'mcp-local') {
          throw failure(409, 'an entry with this install\u2019s derived id already exists and is not a local install — the report was not recorded against it');
        }
        const libraryEntry = await store.createEntry(tenantId, personId, {
          seatId,
          id: installReport.entryId,
          kind: 'mcp-local',
          brokerMode: 'helmian',
          name: installReport.name,
          oneLiner: 'Local MCP server on a person\u2019s machine, installed by the Helmian install pipeline',
          vendorName: 'Helmian',
          trustLabel: 'verified',
          authMode: 'none',
          category: 'local',
          installedPath: installReport.installedPath,
          configSnippet: installReport.configSnippet,
          baselineFingerprint: installReport.baseline?.fingerprint ?? null,
          addedBy: personId,
        });
        const row = await tc.register(tenantId, personId, {
          ...mcpLocalToolConnectionKey(seatId, installReport.serverName),
          kind: 'mcp-stdio',
          serverRef: installReport.installedPath,
          credentialReference: null,
          accountLabel: installReport.name,
        });
        sendJson(201, {
          status: 'install-recorded',
          entryId: installReport.entryId,
          entryCreated: !priorEntry,
          toolConnection: row,
          libraryEntry,
          baseline: {
            fingerprint: installReport.baseline?.fingerprint ?? null,
            recordedInLibrary: true,
            home: 'the entry\u2019s baseline_fingerprint in helmion.connector_entries (sql/080), seeded from this report — the same fingerprint the install ledger keeps on the machine, so the drift story compares one hash in both tellings',
            note: 'the receipt side still stands at intent: no probe receipt is written — no tools/list has reached this server from the cloud, so the registration is registered, never verified',
          },
        });
        return true;
      }

      if (action === 'entries/remove') {
        refuseCredentialValues(body);
        ownerAct();
        const entry = await store.getEntry(tenantId, seatId, entryId);
        if (!entry) throw failure(404, 'connector entry not found in this seat\u2019s library');
        if (entry.kind !== 'custom') throw failure(400, 'only custom entries are removed from here — catalog and Helmian entries are turned off with entry-state instead');
        const removed = await store.removeEntry(tenantId, seatId, entryId, personId);
        sendJson(200, { status: 'removed', entry: removed });
        return true;
      }

      sendJson(404, { error: 'unknown connector library write action' });
      return true;
    } catch (error) {
      if (membershipError(error)) { sendJson(403, { error: 'workspace membership is required' }); return true; }
      const status = error?.status ?? 500;
      sendJson(status, { error: error?.message || 'connector library write failed', ...(error?.code ? { code: error.code } : {}) });
      return true;
    }
  };
}

let sharedHandler;
export async function handleConnectorLibraryWriteRoute(args) {
  sharedHandler ??= createConnectorLibraryWriteHandler();
  return sharedHandler(args);
}
