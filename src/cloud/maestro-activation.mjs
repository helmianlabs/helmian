// Maestro activation (Troy's design, 2026-11-09): the one-time
// meeting. Maestro is always-on underneath — the mesh routes
// desk-style in every channel whether or not a workspace has had
// its ceremony — so this module is NOT a switch. It is the moment a
// new person meets Maestro on purpose: who he is, and the four real
// systems the click acknowledges (the Executive Guard, the
// librarian and its knowledge base, the rule base, and Maestro in
// the middle), stamped once per workspace, never asked again.
//
//   GET  /api/admin/maestro-activation
//     → { valid: true, activated, needsActivation, activatedAt }
//     The app boot reads this after the member session resolves and
//     shows the ceremony before any view when needsActivation.
//   POST /api/admin/maestro-activation
//     → { valid: true, activated: true, activatedAt, stamped }
//     Writes the stamp once (sql/077's column on helmion.tenants)
//     and posts the one-time system notice into the workspace's
//     first channel — the same notice mechanism signup's welcome
//     uses, so the moment is evidence inside the workspace itself.
//
// THE STAMP RULE, exactly:
//   - stamp present (maestro_activated_at not null) → activated.
//     sql/077 backfills every tenant that existed at apply time
//     with its own created_at, so existing workspaces read as
//     activated with no runtime write and never see the ceremony.
//   - no stamp AND the tenant was created before the feature
//     shipped (FEATURE_CUTOFF) → activated, pre-feature. The
//     backfill is the primary mechanism; this date rule is the
//     guard behind it, so even a tenant the backfill somehow
//     missed is never nagged.
//   - no stamp AND created at/after the cutoff → the ceremony.
//   - the stamp road missing (sql/077 not applied yet: the column
//     does not exist) or any read failure → activated. FAIL SOFT,
//     loud in the log: the ceremony never blocks a workspace.
//
// Scoping, exactly like the sibling library routes: member auth via
// activeTenantActor, the tenant from the actor's membership. There
// is no tenant selector on the wire and the POST body is never
// read — there is nothing a caller can name. Writes refuse the
// auditor role (403), the envoy write law: an auditor reads,
// never authors.
//
// Wiring note: live-admin.mjs is frozen at the push size limit, so
// the route hangs off the envoy-ably delegate hook with its own
// lazy pool (same env var, same ssl rule), beside
// handleSkillLibraryRoute.
import { Pool } from 'pg';
import { NOTICE_SUBJECT } from './envoy-agents.mjs';

export const ACTIVATION_PATH = '/api/admin/maestro-activation';

// The instant the feature ships. A tenant created before it is a
// pre-feature workspace and reads as activated even without a
// stamp (see the rule above). Troy's own workspaces predate this
// by weeks.
export const FEATURE_CUTOFF = new Date('2026-11-09T00:00:00.000Z');

// The notice the click leaves in the workspace's first channel.
// Plain words, the four pillars named as the real systems they
// are. Posted under the envoy notice subject, idempotency-keyed
// per tenant, so it lands exactly once.
export const ACTIVATION_NOTICE_BODY = 'Maestro is on. The Executive Guard, the librarian, and the rule base are working in this workspace, and Maestro routes every message here. Name an AI to talk to it, or name nobody and Maestro will route it. If no AI is connected yet, Maestro answers here himself and points you to the Agents tab.';

const UNDEFINED_COLUMN = '42703';

let sharedPool = null;
function getPool() {
  if (!sharedPool) {
    const connectionString = String(process.env.HELMION_DATABASE_URL ?? '').trim();
    if (!connectionString) throw Object.assign(new Error('database not configured'), { status: 503 });
    sharedPool = new Pool({ connectionString, ssl: connectionString.includes('sslmode=disable') ? false : undefined, max: 3 });
  }
  return sharedPool;
}

const iso = (value) => (value ? new Date(value).toISOString() : null);

/**
 * The stamp rule as a pure decision (see the header). Input is the
 * tenant row's shape after a read: { stamp, createdAt } — or
 * { roadMissing: true } when sql/077 has not been applied.
 */
export function decideActivation({ stamp = null, createdAt = null, roadMissing = false } = {}) {
  if (roadMissing) {
    return { activated: true, needsActivation: false, activatedAt: null, reason: 'stamp-road-missing' };
  }
  if (stamp) {
    return { activated: true, needsActivation: false, activatedAt: iso(stamp), reason: 'stamped' };
  }
  if (!createdAt || new Date(createdAt) < FEATURE_CUTOFF) {
    return { activated: true, needsActivation: false, activatedAt: null, reason: 'pre-feature' };
  }
  return { activated: false, needsActivation: true, activatedAt: null, reason: 'new-workspace' };
}

export function createMaestroActivationStore(pool) {
  async function withTenant(tenantId, fn) {
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
  }

  return {
    /**
     * The tenant's stamp state. A missing column (sql/077 not yet
     * applied) is reported as roadMissing, never thrown — the
     * caller decides fail-soft. Any other database error throws.
     */
    async readState(tenantId) {
      try {
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            'select maestro_activated_at as stamp, created_at from helmion.tenants where tenant_id=$1',
            [tenantId],
          );
          if (r.rowCount !== 1) return { stamp: null, createdAt: null };
          return { stamp: r.rows[0].stamp ?? null, createdAt: r.rows[0].created_at ?? null };
        });
      } catch (error) {
        if (error?.code === UNDEFINED_COLUMN) return { roadMissing: true };
        throw error;
      }
    },

    /**
     * Write the stamp once. The UPDATE only lands on a null stamp;
     * a replay reads the standing stamp back instead of moving it.
     * Then, best-effort and in its own transaction, the one-time
     * notice lands in the workspace's first channel ('team'
     * preferred — the starter channel signup seeds). A notice
     * failure is logged, never fatal: the stamp is the record.
     */
    async activate(tenantId) {
      let stamped;
      try {
        stamped = await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `update helmion.tenants set maestro_activated_at = clock_timestamp()
              where tenant_id=$1 and maestro_activated_at is null
              returning maestro_activated_at as stamp`,
            [tenantId],
          );
          if (r.rowCount === 1) return { stamped: true, activatedAt: r.rows[0].stamp };
          const back = await client.query(
            'select maestro_activated_at as stamp from helmion.tenants where tenant_id=$1',
            [tenantId],
          );
          return { stamped: back.rowCount === 1 && back.rows[0].stamp != null, activatedAt: back.rows?.[0]?.stamp ?? null };
        });
      } catch (error) {
        if (error?.code === UNDEFINED_COLUMN) return { stamped: false, roadMissing: true, activatedAt: null };
        throw error;
      }
      try {
        await withTenant(tenantId, async (client) => {
          const ch = await client.query(
            `select id from helmion.envoy_channels where tenant_id=$1
              order by (slug='team') desc, id asc limit 1`,
            [tenantId],
          );
          if (ch.rowCount !== 1) return;
          await client.query(
            `insert into helmion.envoy_messages(tenant_id, channel_id, author_subject, author_kind, body, idempotency_key)
             values ($1,$2,$3,'system',$4,$5)
             on conflict (tenant_id, channel_id, author_subject, idempotency_key) do nothing`,
            [tenantId, ch.rows[0].id, NOTICE_SUBJECT, ACTIVATION_NOTICE_BODY, `maestro-activation:${tenantId}`],
          );
        });
      } catch (error) {
        console.error('[maestro-activation] notice post failed:', error.message);
      }
      return { stamped: stamped.stamped, activatedAt: stamped.activatedAt };
    },
  };
}

// Route delegate. Returns false when the request is not ours.
// `store` is injectable for tests; production builds it from the
// lazy pool. Neither verb ever blocks a workspace on a stamp-road
// failure: reads and writes degrade to "activated" with the
// failure loud in the log and flagged in the body.
export async function handleMaestroActivationRoute({
  request,
  response,
  requestUrl,
  activeTenantActor,
  send,
  TenantAuthorizationError,
  store = null,
} = {}) {
  if (requestUrl?.pathname !== ACTIVATION_PATH) return false;

  const reply = (status, body) => send(response, status, JSON.stringify(body));
  if (!['GET', 'POST'].includes(request.method)) { reply(405, { valid: false, code: 'METHOD_NOT_ALLOWED' }); return true; }

  let activationStore;
  try {
    activationStore = store ?? createMaestroActivationStore(getPool());
  } catch { reply(200, { valid: true, activated: true, needsActivation: false, activatedAt: null, reason: 'degraded', degraded: true }); return true; }

  let actor;
  try {
    actor = await activeTenantActor(request);
  } catch (error) {
    const status = error instanceof TenantAuthorizationError || error?.status === 403 ? 403 : 503;
    reply(status, { valid: false, code: status === 403 ? 'ACTIVATION_MEMBERSHIP_REQUIRED' : 'ACTIVATION_UNAVAILABLE' });
    return true;
  }

  if (request.method === 'GET') {
    try {
      const state = await activationStore.readState(actor.tenantId);
      reply(200, { valid: true, ...decideActivation(state) });
    } catch (error) {
      console.error('[maestro-activation] read failed, treating as activated:', error.message);
      reply(200, { valid: true, activated: true, needsActivation: false, activatedAt: null, reason: 'degraded', degraded: true });
    }
    return true;
  }

  // POST — the click. An auditor reads, never authors (the envoy
  // write law), so an auditor's click is refused; the workspace's
  // owner or an admin performs the activation.
  if (String(actor.role ?? '').toLowerCase() === 'auditor') {
    reply(403, { valid: false, code: 'ACTIVATION_ROLE_FORBIDDEN' });
    return true;
  }
  try {
    const out = await activationStore.activate(actor.tenantId);
    if (out.roadMissing) {
      reply(200, { valid: true, activated: true, needsActivation: false, activatedAt: null, stamped: false, reason: 'stamp-road-missing' });
      return true;
    }
    reply(200, { valid: true, activated: true, needsActivation: false, activatedAt: iso(out.activatedAt), stamped: out.stamped === true });
  } catch (error) {
    console.error('[maestro-activation] write failed, letting the workspace in:', error.message);
    reply(200, { valid: true, activated: true, needsActivation: false, activatedAt: null, stamped: false, reason: 'degraded', degraded: true });
  }
  return true;
}
