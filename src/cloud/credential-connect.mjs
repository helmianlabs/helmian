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
// Wiring note: live-admin.mjs is frozen at the push size limit, so this
// route hangs off the existing envoy-ably hook (envoy-ably.mjs delegates
// here), same as runner-presence.mjs. Env: the credential service base
// URL and service token are read from HELMION_CREDENTIAL_SERVICE_URL /
// HELMION_CREDENTIAL_SERVICE_TOKEN; with either unset the route answers
// 503 and stores nothing.
import { Pool } from 'pg';
import { requireActiveTenantMembership, withTenantTransaction } from '../core/tenant-context.mjs';
import { createCredentialServiceClient } from './credential-service-client.mjs';

export const CREDENTIAL_CONNECT_PATH = '/api/admin/envoy/credential/connect';

// The providers the create-agent dialog offers; a connect for anything
// else is a client bug, refused before any storage is touched.
const CONNECT_PROVIDERS = new Set(['claude', 'openai', 'grok', 'gemini', 'mistral', 'runway', 'ollama']);
const MAX_USERNAME_CHARS = 256;
const MAX_PASSWORD_CHARS = 1024;

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
    if (request.method !== 'POST') {
      send(response, 405, JSON.stringify({ valid: false, code: 'METHOD_NOT_ALLOWED' }));
      return true;
    }
    const actor = await activeTenantActor(request);
    // Passwords are entered by a signed-in person, never by a device:
    // the box worker holds sessions, it does not create password records.
    if (actor?.viaDeviceToken === true) throw Object.assign(new Error('credential connect requires a signed-in owner or admin'), { status: 403 });
    if (!['owner', 'admin'].includes(String(actor?.role ?? '').toLowerCase())) {
      throw Object.assign(new Error('credential connect requires owner or admin membership'), { status: 403 });
    }
    let body = {};
    try { body = (await readJson(request)) ?? {}; } catch { body = {}; }
    // The body is exactly the two fields and the provider. Anything else
    // — above all a tenant id — is refused: the tenant comes from the
    // verified actor, so a connect can only ever write its own tenant.
    if (Object.keys(body).some((key) => !['provider', 'username', 'password'].includes(key))) {
      throw Object.assign(new Error('credential connect body contains a forbidden field'), { status: 400 });
    }
    const provider = String(body.provider ?? '').toLowerCase();
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!CONNECT_PROVIDERS.has(provider)) throw Object.assign(new Error('unknown provider'), { status: 400 });
    if (!username || username.length > MAX_USERNAME_CHARS) throw Object.assign(new Error('username is required'), { status: 400 });
    if (!password || password.length > MAX_PASSWORD_CHARS) throw Object.assign(new Error('password is required'), { status: 400 });

    const client = injectedClient ?? createCredentialConnectClient();
    if (!client) throw Object.assign(new Error('credential service not configured'), { status: 503, code: 'CREDENTIAL_SERVICE_NOT_CONFIGURED' });

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
