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
//       authMode "oauth"  → helmian-scribe starts the Scribe door
//                           OAuth road from inside Helmian (DCR +
//                           PKCE S256 + a remembered pending row);
//                           every other OAuth entry answers with its
//                           consent boundary — the provider's
//                           authorization endpoint and resource
//                           metadata — because Helmian holds no OAuth
//                           client registration for it yet; landing
//                           those callbacks is M3's leg.
//     Vendor-brokered entries are refused plainly: they are mirrors,
//     managed in the vendor's own garden (§1.5).
//   POST /api/admin/connector-library/connect/header
//     Lands a header/API-key credential: the value goes straight to
//     the credential service under the minted vault reference and the
//     library records the reference only. This is the ONE action that
//     ever receives a credential value; every other action refuses
//     credential-value keys by name, and the store refuses them too.
//   GET  /api/admin/connector-library/oauth/callback
//     The Scribe door redirect lands here: the pending handshake is
//     consumed, the code is exchanged, the token pair is stored in
//     the credential service under the connection's vault references,
//     and the connection is recorded. Answers a small HTML page that
//     carries the person back to the Manage surface.
//   POST /api/admin/connector-library/disconnect
//     The store's disconnect with its revoke hook wired to the
//     credential service: stored credentials are revoked BEFORE the
//     record's references are cleared.
//   POST /api/admin/connector-library/posture        {seatId, entryId, posture}
//   POST /api/admin/connector-library/entry-state    {seatId, entryId, state}   owner/admin
//   POST /api/admin/connector-library/entries        add a custom entry         owner/admin
//   POST /api/admin/connector-library/entries/remove {seatId, entryId}          owner/admin
//
// Gating follows the library read route: an active workspace member,
// tenant from the membership, person from the actor's subject — a
// body naming another tenant or person is refused (400). Personal
// acts (connect, disconnect, posture) act on the caller's own
// connection only. Workspace acts (entry-state, add/remove custom)
// are owner/admin. Auditors never write (skill-route precedent).

import pg from 'pg';

import {
  buildConnectorTokenRef,
  createConnectorLibraryStore,
  validateVaultTokenRef,
  CONNECTOR_POSTURES,
} from './connector-library.mjs';
import { LIVE_SEATS, catalogEntryById } from './connector-catalog.mjs';
import { createCredentialConnectClient } from './credential-connect.mjs';
import {
  createConnectorOAuthPendingStore,
  createScribeDoorOAuth,
  hashOAuthState,
  newOAuthState,
  newPkceVerifier,
  pkceChallenge,
  SCRIBE_DOOR_ISSUER,
  SCRIBE_DOOR_SCOPES,
} from './connector-oauth-pending.mjs';

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
const isScribeEntry = (entry) => entry.id === 'helmian-scribe'
  || String(entry.mcpEndpointUrl ?? '').startsWith(SCRIBE_DOOR_ISSUER);

// The catalog definition is the authority for a seeded entry's auth
// road — never the stored row alone. Rows seeded under an older
// catalog keep its label (the read-route seed refreshes only tenants
// holding zero entries), and helmian-scribe's live rows still said
// 'none' long after the catalog's correction to 'oauth': connect
// dispatched on the stale label and recorded a "No sign-in"
// connection no consent produced (live exercise, 2026-11-09). So the
// dispatch below runs on the catalog's authMode whenever a catalog
// definition exists for the entry; the stored row's mode governs
// only entries the catalog does not define (custom entries are a
// person's own — their stored mode is their truth). A stored row
// can therefore never reroute an OAuth entry onto a direct road,
// whatever the seed says. (sql/079 aligns the stored rows; the
// guard stands either way.)
export function effectiveAuthMode(entry) {
  if (!entry || entry.kind === 'custom') return entry?.authMode ?? null;
  let definition = null;
  try { definition = catalogEntryById(entry.seatId, entry.id); } catch { definition = null; }
  return definition?.authMode ?? entry.authMode;
}

// The consent-boundary answer for OAuth entries Helmian holds no
// client registration for: the provider's resource metadata (RFC
// 9728) names its authorization server, whose metadata names the
// consent endpoint. Fetched server-side; any failure still answers
// the boundary with what the entry itself proves.
async function consentBoundary(entry, fetchImpl) {
  const endpoint = String(entry.mcpEndpointUrl ?? '');
  let resourceMetadataUrl = null;
  let authorizationEndpoint = null;
  try {
    const u = new URL(endpoint);
    resourceMetadataUrl = `${u.origin}/.well-known/oauth-protected-resource${u.pathname.replace(/\/$/, '')}`;
  } catch { /* the entry's endpoint was validated at creation; defensive only */ }
  if (resourceMetadataUrl && fetchImpl) {
    try {
      const res = await fetchImpl(resourceMetadataUrl);
      if (res?.ok) {
        const meta = await res.json();
        const servers = Array.isArray(meta?.authorization_servers) ? meta.authorization_servers : [];
        for (const server of servers) {
          try {
            const asRes = await fetchImpl(`${String(server).replace(/\/$/, '')}/.well-known/oauth-authorization-server`);
            if (asRes?.ok) { authorizationEndpoint = (await asRes.json())?.authorization_endpoint ?? null; if (authorizationEndpoint) break; }
          } catch { /* try the next server */ }
        }
      }
    } catch { /* the boundary answer stands without the live fetch */ }
  }
  return {
    status: 'consent-boundary',
    seatId: entry.seatId,
    entryId: entry.id,
    provider: entry.id === 'github' || entry.id === 'helmian-github' ? 'github' : 'oauth',
    mcpEndpointUrl: endpoint || null,
    resourceMetadataUrl,
    authorizationEndpoint,
    note: 'Helmian holds no OAuth client registration for this connector yet, so the sign-in cannot be completed inside Helmian. The consent endpoint and the remaining callback leg are M3\u2019s work; nothing was connected.',
  };
}

const callbackPage = (title, line) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta http-equiv="refresh" content="2;url=/app/#integrations"></head><body style="font-family:system-ui,sans-serif;background:#0B1120;color:#F8FAFC;display:grid;place-items:center;min-height:100vh;margin:0"><main style="text-align:center;max-width:34rem;padding:2rem"><h1 style="font-size:1.25rem">${title}</h1><p style="color:#94A3B8">${line}</p><p><a href="/app/#integrations" style="color:#38BDF8">Back to Helmian</a></p></main></body></html>`;

export function createConnectorLibraryWriteHandler({
  store: injectedStore,
  pendingStore: injectedPending,
  credentialClient: injectedCredentials,
  doorOAuth: injectedDoor,
  fetchImpl = globalThis.fetch,
} = {}) {
  const resolveStore = () => injectedStore ?? (getPool() ? createConnectorLibraryStore(getPool()) : null);
  const resolvePending = () => injectedPending ?? (getPool() ? createConnectorOAuthPendingStore(getPool()) : null);
  const resolveCredentials = () => injectedCredentials !== undefined ? injectedCredentials : createCredentialConnectClient();
  const resolveDoor = () => injectedDoor ?? createScribeDoorOAuth({ fetchImpl });

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

      // ------------------------------------------------------ callback
      if (isCallback) {
        const fail = (line) => { send(response, 200, callbackPage('That sign-in did not land', line), 'text/html; charset=utf-8'); return true; };
        const code = requestUrl.searchParams.get('code');
        const state = requestUrl.searchParams.get('state');
        const doorError = requestUrl.searchParams.get('error');
        if (doorError) return fail('The Scribe door answered with an error, so nothing was connected. Start the connect again from the Manage surface.');
        if (!code || !state) return fail('The Scribe door sent back no code, so nothing was connected. Start the connect again from the Manage surface.');
        const pendingStore = resolvePending();
        const pending = pendingStore ? await pendingStore.take(tenantId, hashOAuthState(state)) : null;
        if (!pending) return fail('This sign-in link has expired or was never started here. Start the connect again from the Manage surface.');
        if (pending.personId !== personId) return fail('This sign-in was started by a different person in the workspace, so it cannot land on your account.');
        const credentials = resolveCredentials();
        if (!credentials) return fail('Helmian\u2019s credential storage is not switched on, so the sign-in could not be kept. Nothing was connected.');
        const store = resolveStore();
        if (!store) return fail('The connector library is not switched on yet. Nothing was connected.');
        const tokens = await resolveDoor().exchangeCode({
          clientId: pending.clientId, code, codeVerifier: pending.codeVerifier, redirectUri: pending.redirectUri,
        });
        const providerId = providerIdFor(pending.seatId, pending.entryId);
        const accessTokenRef = buildConnectorTokenRef({ tenantId, seatId: pending.seatId, entryId: pending.entryId, personId, tokenKind: 'access' });
        const refreshTokenRef = tokens.refreshToken
          ? buildConnectorTokenRef({ tenantId, seatId: pending.seatId, entryId: pending.entryId, personId, tokenKind: 'refresh' })
          : null;
        // The pair is stored as one oauth_bundle per reference (the
        // vault's bundle record holds both tokens) so resolving
        // either reference yields the bundle the turn road needs.
        const bundle = {
          tenantId, providerId, credentialKind: 'oauth_bundle',
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
        const connection = await store.createConnection(tenantId, personId, {
          personId, seatId: pending.seatId, entryId: pending.entryId,
          accountIdentity: 'Scribe account', accessTokenRef, refreshTokenRef, grantedScopes,
        });
        void connection;
        send(response, 200, callbackPage('Scribe is connected', 'Scribe is now connected inside Helmian for this seat. Taking you back to the Manage surface.'), 'text/html; charset=utf-8');
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

      if (action === 'connect') {
        refuseCredentialValues(body);
        const entry = await store.getEntry(tenantId, seatId, entryId);
        if (!entry) throw failure(404, 'connector entry not found in this seat\u2019s library');
        if (entry.state !== 'available') throw failure(409, 'this connector is turned off by the workspace owner');
        if (entry.brokerMode !== 'helmian') {
          sendJson(400, {
            error: 'this connector is a mirror of the seat\u2019s own account — Helmian does not hold its sign-in. It is managed in the vendor\u2019s own product; connecting it there does not connect it here.',
            code: 'VENDOR_MANAGED',
          });
          return true;
        }
        const authMode = effectiveAuthMode(entry);
        if (authMode === 'none') {
          const connection = await store.createConnection(tenantId, personId, {
            ...key, accountIdentity: 'No sign-in', grantedScopes: [], ...(body.posture ? { posture: String(body.posture) } : {}),
          });
          sendJson(201, { status: 'connected', connection });
          return true;
        }
        if (authMode === 'header') {
          const accessTokenRef = buildConnectorTokenRef({ tenantId, seatId, entryId, personId, tokenKind: 'access' });
          sendJson(200, {
            status: 'needs-credential',
            seatId, entryId,
            providerId: providerIdFor(seatId, entryId),
            accessTokenRef,
            completeAction: 'connect/header',
            note: 'Store the key through the connect/header action — it goes straight into the credential service under this reference, and the library record keeps the reference only.',
          });
          return true;
        }
        // authMode oauth
        if (isScribeEntry(entry)) {
          const credentials = resolveCredentials();
          if (!credentials) { sendJson(503, { error: 'Helmian\u2019s credential storage is not switched on, so this sign-in cannot be kept yet', code: 'CREDENTIAL_SERVICE_NOT_CONFIGURED' }); return true; }
          const pendingStore = resolvePending();
          if (!pendingStore) { sendJson(503, { error: 'the OAuth road is not switched on yet (no database configured)', code: 'OAUTH_ROAD_NOT_READY' }); return true; }
          const redirectUri = `${String(requestUrl.origin ?? '')}${CONNECTOR_OAUTH_CALLBACK_PATH}`;
          const door = resolveDoor();
          const { clientId } = await door.registerClient({ redirectUri, clientName: 'Helmian' });
          const state = newOAuthState();
          const verifier = newPkceVerifier();
          const saved = await pendingStore.save(tenantId, {
            stateHash: hashOAuthState(state), personId, seatId, entryId,
            provider: 'scribe', clientId, codeVerifier: verifier, redirectUri, scopes: [...SCRIBE_DOOR_SCOPES],
          });
          if (!saved) { sendJson(503, { error: 'the OAuth road is not switched on yet (the pending-handshake table is missing — migration 078)', code: 'OAUTH_ROAD_NOT_READY' }); return true; }
          const authorizeUrl = await door.authorizeUrl({ clientId, redirectUri, state, challenge: pkceChallenge(verifier) });
          sendJson(200, { status: 'consent', provider: 'scribe', authorizeUrl, note: 'The Scribe door asks the person, in person — approve it there and the connection lands back here.' });
          return true;
        }
        sendJson(200, await consentBoundary(entry, fetchImpl));
        return true;
      }

      if (action === 'connect/header') {
        refuseCredentialValues(body, { allow: ['apiKey'] });
        const apiKey = typeof body.apiKey === 'string' ? body.apiKey : '';
        if (!apiKey) throw failure(400, 'the key itself is required on this one action — it is stored in the credential service and never written to the library record');
        const entry = await store.getEntry(tenantId, seatId, entryId);
        if (!entry) throw failure(404, 'connector entry not found in this seat\u2019s library');
        if (entry.brokerMode !== 'helmian') throw failure(400, 'this entry is vendor-brokered — Helmian holds no credential for it');
        if (effectiveAuthMode(entry) !== 'header') throw failure(400, 'this entry does not take a header key — use its own connect road');
        const credentials = resolveCredentials();
        if (!credentials) { sendJson(503, { error: 'Helmian\u2019s credential storage is not switched on, so the key cannot be kept yet', code: 'CREDENTIAL_SERVICE_NOT_CONFIGURED' }); return true; }
        const accessTokenRef = buildConnectorTokenRef({ tenantId, seatId, entryId, personId, tokenKind: 'access' });
        const stored = await credentials.storeCredential({
          tenantId, providerId: providerIdFor(seatId, entryId), credentialReference: accessTokenRef,
          credentialKind: 'api_key', apiKey,
        });
        if (!stored?.accepted) { sendJson(502, { error: 'the credential service would not keep the key, so nothing was connected', code: 'CREDENTIAL_STORE_REFUSED' }); return true; }
        const connection = await store.createConnection(tenantId, personId, {
          ...key,
          accountIdentity: typeof body.accountLabel === 'string' && body.accountLabel.trim() ? body.accountLabel.trim().slice(0, 512) : 'API key',
          accessTokenRef, grantedScopes: [], ...(body.posture ? { posture: String(body.posture) } : {}),
        });
        sendJson(201, { status: 'connected', connection });
        return true;
      }

      if (action === 'connect/complete') {
        // Land a connection from a vault reference the caller stored
        // through another Helmian road — references only, verified
        // twice: the reference must be exactly the one this surface
        // mints for the caller, and the credential must resolve.
        refuseCredentialValues(body);
        const completeEntry = await store.getEntry(tenantId, seatId, entryId);
        if (!completeEntry) throw failure(404, 'connector entry not found in this seat\u2019s library');
        if (effectiveAuthMode(completeEntry) === 'oauth') {
          throw failure(400, 'this connector signs in with OAuth — its connection lands only through its sign-in callback, never from a stored reference');
        }
        const accessTokenRef = String(body.accessTokenRef ?? '');
        const expected = buildConnectorTokenRef({ tenantId, seatId, entryId, personId, tokenKind: 'access' });
        if (accessTokenRef !== expected) {
          validateVaultTokenRef(accessTokenRef, tenantId, 'accessTokenRef');
          throw failure(400, 'accessTokenRef is not the reference this surface mints for you on this connector');
        }
        const credentials = resolveCredentials();
        if (!credentials) { sendJson(503, { error: 'Helmian\u2019s credential storage is not switched on, so the stored credential cannot be checked', code: 'CREDENTIAL_SERVICE_NOT_CONFIGURED' }); return true; }
        const resolved = await credentials.resolveVaultCredential({ tenantId, providerId: providerIdFor(seatId, entryId), credentialReference: accessTokenRef, reasonClass: 'provider_call' });
        if (!resolved?.accepted) { sendJson(400, { error: 'no credential is stored under that reference yet — store it first, then complete the connect', code: 'CREDENTIAL_NOT_STORED' }); return true; }
        const connection = await store.createConnection(tenantId, personId, {
          ...key,
          accountIdentity: typeof body.accountLabel === 'string' && body.accountLabel.trim() ? body.accountLabel.trim().slice(0, 512) : 'Stored key',
          accessTokenRef, grantedScopes: [], ...(body.posture ? { posture: String(body.posture) } : {}),
        });
        sendJson(201, { status: 'connected', connection });
        return true;
      }

      if (action === 'disconnect') {
        refuseCredentialValues(body);
        const credentials = resolveCredentials();
        const revoke = credentials
          ? async (ref) => {
            const out = await credentials.revokeVaultCredential({ tenantId, credentialReference: ref });
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
        sendJson(201, { status: 'created', entry });
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
