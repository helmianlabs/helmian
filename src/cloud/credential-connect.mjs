// Credential connect: the cloud side of the one connect road (owner's
// law, 2026-11-01 — every AI provider connects the same way: a username
// or email and a password, entered in the connect step itself).
//
// POST /api/admin/envoy/credential/connect { provider, username, password }
//   1. stores the pair in the credential service (Hetzner box, beside the
//      Executive Guard) as a kind 'password' credential under the
//      per-tenant reference vault://tenant/<tenant>/<provider>/password;
//   2. writes the provider_connections row the surfaces read
//      (auth_mode 'password_session', credential reference only — the row
//      never carries secret material, per the sql/031 contract).
// The box executor resolves the password once per session establishment
// (Guard-gated under the F4 rules) and answers off the stored session;
// this route never resolves anything and never returns secret material.
//
// API keys (Troy, 2026-11-04 — "we need API slots", for backups and for
// tool services): POST { provider, apiKey } stores a kind 'api_key'
// credential under vault://tenant/<tenant>/<provider>/api-key and, when
// the provider has no connection row yet, records it (auth_mode
// 'api_key'). A key is a BACKUP credential: when a row already exists
// (a password sign-in, an OAuth connection) the key lands in the vault
// only and the row is left untouched — a backup never replaces the
// primary connection record. GET on this same path returns the caller's
// connection rows (references and lifecycle only, never secrets) so any
// client — web or desktop — renders card state from the same read.
//
// Who may write: the owner/admin PERSON, on either client. A signed-in
// session is one road; the other is the desktop link token, which is
// minted only when that person creates a link code in their signed-in
// session and types it into their own desktop app — the token is bound
// to their subject at exchange (org-invites.desktopIdentity), and the
// owner/admin role gate below is fed by their real membership role.
// Unattended processes hold no such token: the box worker holds
// sessions, it does not enter credentials, and nothing here lets it.
//
// Wiring note: live-admin.mjs is frozen at the push size limit, so this
// route hangs off the existing envoy-ably hook (envoy-ably.mjs delegates
// here), same as runner-presence.mjs. Env: the credential service base
// URL and service token are read from HELMION_CREDENTIAL_SERVICE_URL /
// HELMION_CREDENTIAL_SERVICE_TOKEN; with either unset the route answers
// 503 and stores nothing.
import { Pool } from 'pg';
import { requireActiveTenantMembership, withTenantTransaction } from '../core/tenant-context.mjs';
import { createCredentialServiceClient } from './credential-service-client.mjs';
import { composeRegistryCredential, providerRegistryRow } from './provider-registry.mjs';

export const CREDENTIAL_CONNECT_PATH = '/api/admin/envoy/credential/connect';

// The providers the create-agent dialog offers; a connect for anything
// else is a client bug, refused before any storage is touched. heygen
// and higgsfield are API-key-only tool services (Troy, 2026-11-04):
// they have no password road, their slot is the apiKey shape below.
// The provider-catalog seats (provider-registry.mjs) join the same
// gate from their registry rows: API-key kind, stored under the row's
// vault slot name, never a password road.
const CONNECT_PROVIDERS = new Set(['claude', 'openai', 'grok', 'gemini', 'mistral', 'runway', 'ollama', 'heygen', 'higgsfield', 'groq', 'nvidia', 'cloudflare', 'openrouter']);
const MAX_USERNAME_CHARS = 256;
const MAX_PASSWORD_CHARS = 1024;
const MAX_API_KEY_CHARS = 1024;
// A multi-field row's composed bundle (cloudflare: account_id +
// api_token as one JSON record) is two values in one stored string.
const MAX_BUNDLE_CHARS = 2048;

// Own lazy pool: live-admin.mjs owns the primary pool and cannot pass it
// through the frozen hook. Same env var, same ssl rule (runner-presence
// precedent).
let sharedPool = null;
function getPool() {
  if (!sharedPool) {
    const connectionString = String(process.env.HELMION_DATABASE_URL ?? '').trim();
    if (!connectionString) throw Object.assign(new Error('database not configured'), { status: 503 });
    sharedPool = new Pool({ connectionString, ssl: connectionString.includes('sslmode=disable') ? false : undefined, max: 3 });
  }
  return sharedPool;
}

export function credentialReferenceFor(tenantId, providerId) {
  return `vault://tenant/${tenantId}/${providerId}/password`;
}

export function credentialApiKeyReferenceFor(tenantId, providerId) {
  return `vault://tenant/${tenantId}/${providerId}/api-key`;
}

export function createCredentialConnectClient(env = process.env) {
  const baseUrl = String(env.HELMION_CREDENTIAL_SERVICE_URL ?? '').trim();
  const serviceToken = String(env.HELMION_CREDENTIAL_SERVICE_TOKEN ?? '').trim();
  if (!baseUrl || !serviceToken) return null;
  return createCredentialServiceClient({ baseUrl, serviceToken });
}

const SELECT = 'provider_id, auth_mode, credential_reference, lifecycle, adapter, updated_at';

// The connections-row half of a connect: same insert shape and conflict
// target as provider-connection-repository.save(), with the
// password_session auth mode sql/063 widened the table for. Runs inside
// the caller's tenant transaction with membership re-verified.
export function createProviderConnectionWriter(pool) {
  return Object.freeze({
    async recordPasswordSession(context, { providerId, credentialReference } = {}) {
      return withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const result = await client.query(
          `insert into helmion.provider_connections (tenant_id, provider_id, auth_mode, credential_reference, lifecycle, adapter, updated_by_subject) values ($1,$2,'password_session',$3,'pending','credential_service',$4) on conflict (tenant_id,provider_id) do update set auth_mode=excluded.auth_mode, credential_reference=excluded.credential_reference, lifecycle='pending', adapter=excluded.adapter, updated_by_subject=excluded.updated_by_subject, updated_at=clock_timestamp() returning ${SELECT}`,
          [context.tenantId, providerId, credentialReference, context.actorSubject],
        );
        if (result.rowCount !== 1) throw new Error('provider connection was not durable');
        const item = result.rows[0];
        return {
          connection: {
            providerId: item.provider_id,
            authMode: item.auth_mode,
            credentialReference: item.credential_reference,
            lifecycle: item.lifecycle,
            adapter: item.adapter,
            updatedAt: item.updated_at,
          },
        };
      });
    },

    // The API-key half: the key itself lands in the vault (kind
    // 'api_key'); the row is recorded ONLY when the provider has no
    // connection row yet. A backup key never replaces the primary
    // connection record — when a row exists it is read back unchanged
    // and returned with recorded: false.
    async recordApiKey(context, { providerId, credentialReference } = {}) {
      return withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const shape = (item, recorded) => ({
          recorded,
          connection: {
            providerId: item.provider_id,
            authMode: item.auth_mode,
            credentialReference: item.credential_reference,
            lifecycle: item.lifecycle,
            adapter: item.adapter,
            updatedAt: item.updated_at,
          },
        });
        const inserted = await client.query(
          `insert into helmion.provider_connections (tenant_id, provider_id, auth_mode, credential_reference, lifecycle, adapter, updated_by_subject) values ($1,$2,'api_key',$3,'pending','credential_service',$4) on conflict (tenant_id,provider_id) do nothing returning ${SELECT}`,
          [context.tenantId, providerId, credentialReference, context.actorSubject],
        );
        if (inserted.rowCount === 1) return shape(inserted.rows[0], true);
        const existing = await client.query(
          `select ${SELECT} from helmion.provider_connections where tenant_id=$1 and provider_id=$2`,
          [context.tenantId, providerId],
        );
        if (existing.rowCount !== 1) throw new Error('provider connection was not durable');
        return shape(existing.rows[0], false);
      });
    },

    // The card-state read behind GET on the connect path: the caller's
    // own tenant rows, references and lifecycle only — never secrets.
    async listConnections(context) {
      return withTenantTransaction(pool, context, async (client) => {
        await requireActiveTenantMembership(client, context);
        const result = await client.query(
          `select ${SELECT} from helmion.provider_connections where tenant_id=$1 order by provider_id`,
          [context.tenantId],
        );
        return {
          connections: result.rows.map((item) => ({
            providerId: item.provider_id,
            authMode: item.auth_mode,
            credentialReference: item.credential_reference,
            lifecycle: item.lifecycle,
            adapter: item.adapter,
            updatedAt: item.updated_at,
          })),
        };
      });
    },
  });
}

// The credential service's own refusal mapping (credential-service.mjs
// refusalFor), mirrored so a refused store surfaces with the same weight
// it had at the service: Guard refusals are 403, a vanished credential
// 404, an unreachable service 502.
function storeRefusalStatus(result) {
  const status = String(result?.status ?? '');
  if (status.startsWith('guard_')) return 403;
  if (status === 'credential_not_available') return 404;
  if (status === 'tenant_vault_shredded') return 410;
  if (status === 'credential_service_unreachable' || status === 'credential_service_bad_response') return 502;
  return 400;
}

// Route delegate. POST only; returns false when the request is not ours.
export async function handleCredentialConnectRoute({
  request,
  response,
  requestUrl,
  activeTenantActor,
  send,
  TenantAuthorizationError,
  readJson,
  client: injectedClient,
  connectionWriter: injectedWriter,
} = {}) {
  if (!requestUrl || requestUrl.pathname !== CREDENTIAL_CONNECT_PATH) return false;
  const membershipError = (error) => error?.status === 403 || error instanceof TenantAuthorizationError;
  try {
    const actor = await activeTenantActor(request);
    const actorContext = { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: actor.sessionId, requestId: actor.requestId };
    if (request.method === 'GET') {
      // Card-state read for any client: the caller's own tenant rows.
      // Membership is enforced by activeTenantActor + the writer; no
      // role gate beyond it (the web's connections read serves members
      // the same way), and no secret material exists in a row to leak.
      const writer = injectedWriter ?? createProviderConnectionWriter(getPool());
      const { connections } = await writer.listConnections(actorContext);
      send(response, 200, JSON.stringify({ valid: true, connections, secretMaterial: 'not_returned' }));
      return true;
    }
    if (request.method !== 'POST') {
      send(response, 405, JSON.stringify({ valid: false, code: 'METHOD_NOT_ALLOWED' }));
      return true;
    }
    // Writes are the owner/admin person's connect step, on either
    // client: a signed-in session, or the desktop app through the
    // desktop link token that person minted while signed in (the token
    // is bound to their subject at exchange; the role below is their
    // real membership role). No other device token reaches this route —
    // the actor derivation only accepts desktop link tokens here.
    if (!['owner', 'admin'].includes(String(actor?.role ?? '').toLowerCase())) {
      throw Object.assign(new Error('credential connect requires owner or admin membership'), { status: 403 });
    }
    let body = {};
    try { body = (await readJson(request)) ?? {}; } catch { body = {}; }
    // The body is exactly one credential shape and the provider.
    // Anything else — above all a tenant id — is refused: the tenant
    // comes from the verified actor, so a connect can only ever write
    // its own tenant. A multi-field registry row (cloudflare) sends
    // its named intake fields in `fields` instead of a bare apiKey;
    // the fields compose into the row's one stored record below.
    if (Object.keys(body).some((key) => !['provider', 'username', 'password', 'apiKey', 'fields'].includes(key))) {
      throw Object.assign(new Error('credential connect body contains a forbidden field'), { status: 400 });
    }
    const provider = String(body.provider ?? '').toLowerCase();
    if (!CONNECT_PROVIDERS.has(provider)) throw Object.assign(new Error('unknown provider'), { status: 400 });
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const rawApiKey = typeof body.apiKey === 'string' ? body.apiKey : '';
    const registryRow = providerRegistryRow(provider);
    let apiKey = rawApiKey;
    if (registryRow && registryRow.auth.fields.length > 1) {
      // Store-time composition (DESIGN.md §4): the row's named fields
      // become the one bundle record the runner reads. A bare apiKey
      // is refused for a multi-field row — half a credential stored
      // as the whole record would read as connected and never work.
      const fields = body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields) ? body.fields : null;
      if (rawApiKey || !fields || Object.keys(fields).some((key) => !registryRow.auth.fields.includes(key))) {
        throw Object.assign(new Error('send the provider fields for this provider, not a single key'), { status: 400 });
      }
      const values = {};
      for (const f of registryRow.auth.fields) values[f] = typeof fields[f] === 'string' ? fields[f].trim() : '';
      apiKey = composeRegistryCredential(registryRow, values) ?? '';
      if (!apiKey) throw Object.assign(new Error('every provider field is required'), { status: 400 });
    } else if (body.fields !== undefined) {
      throw Object.assign(new Error('provider fields are only for multi-field providers'), { status: 400 });
    }
    const hasApiKey = apiKey.length > 0;
    const hasPair = username.length > 0 || password.length > 0;
    if (hasApiKey && hasPair) {
      throw Object.assign(new Error('send either an API key or a username and password, not both'), { status: 400 });
    }

    const client = injectedClient ?? createCredentialConnectClient();
    if (!client) throw Object.assign(new Error('credential service not configured'), { status: 503, code: 'CREDENTIAL_SERVICE_NOT_CONFIGURED' });

    if (hasApiKey) {
      const maxChars = registryRow && registryRow.auth.fields.length > 1 ? MAX_BUNDLE_CHARS : MAX_API_KEY_CHARS;
      if (apiKey.length > maxChars) throw Object.assign(new Error('api key is too long'), { status: 400 });
      const credentialReference = credentialApiKeyReferenceFor(actor.tenantId, provider);
      const stored = await client.storeCredential({
        tenantId: actor.tenantId,
        actorSubject: actor.subject,
        actorRole: actor.role,
        sessionId: actor.sessionId,
        requestId: actor.requestId,
        providerId: provider,
        credentialReference,
        credentialKind: 'api_key',
        apiKey,
      });
      if (!stored?.accepted) {
        send(response, storeRefusalStatus(stored), JSON.stringify({
          valid: false,
          code: 'CREDENTIAL_STORE_REFUSED',
          serviceStatus: String(stored?.status ?? 'credential_store_failed'),
          secretMaterial: 'not_returned',
        }));
        return true;
      }
      const writer = injectedWriter ?? createProviderConnectionWriter(getPool());
      const { connection, recorded } = await writer.recordApiKey(actorContext, { providerId: provider, credentialReference });
      send(response, 200, JSON.stringify({ valid: true, stored: true, connection, connectionRecorded: recorded, secretMaterial: 'not_returned' }));
      return true;
    }

    if (!username || username.length > MAX_USERNAME_CHARS) throw Object.assign(new Error('username is required'), { status: 400 });
    if (!password || password.length > MAX_PASSWORD_CHARS) throw Object.assign(new Error('password is required'), { status: 400 });

    const credentialReference = credentialReferenceFor(actor.tenantId, provider);
    const stored = await client.storeCredential({
      tenantId: actor.tenantId,
      actorSubject: actor.subject,
      actorRole: actor.role,
      sessionId: actor.sessionId,
      requestId: actor.requestId,
      providerId: provider,
      credentialReference,
      credentialKind: 'password',
      username,
      password,
    });
    if (!stored?.accepted) {
      // Nothing is written on a refused store: no half-connected rows.
      send(response, storeRefusalStatus(stored), JSON.stringify({
        valid: false,
        code: 'CREDENTIAL_STORE_REFUSED',
        serviceStatus: String(stored?.status ?? 'credential_store_failed'),
        secretMaterial: 'not_returned',
      }));
      return true;
    }

    const writer = injectedWriter ?? createProviderConnectionWriter(getPool());
    const { connection } = await writer.recordPasswordSession(
      { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: actor.sessionId, requestId: actor.requestId },
      { providerId: provider, credentialReference },
    );
    send(response, 200, JSON.stringify({ valid: true, stored: true, connection, secretMaterial: 'not_returned' }));
  } catch (error) {
    const status = membershipError(error) ? 403 : (error?.status ?? 400);
    send(response, status, JSON.stringify({
      valid: false,
      code: error?.code ?? 'CREDENTIAL_CONNECT_FAILED',
      detail: error?.message ?? String(error),
      secretMaterial: 'not_returned',
    }));
  }
  return true;
}
