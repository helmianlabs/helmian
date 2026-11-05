// Profile sync jobs: the real road behind the "Sync Profile & Guard to
// All AIs" button (S1, 2026-11-05).
//
// Before this module the button's handlers (the runner-presence route
// and its envoy-ably twin) stamped presence rows and returned a
// hardcoded list of files nobody had written. Now a button press
// enqueues a job in helmion.profile_sync_jobs (sql/070); the tenant's
// PC bridge claims it on a device-token poll — the same pull shape as
// agent-work — runs the Agent OS installer, and posts back the
// installer's per-file report (path, created-or-updated, sha256 read
// back from the disk it wrote). The page polls the job and renders
// ONLY that device report; until it lands, the job is pending and the
// page says so. No report, no checkmarks.
//
// Auth follows the house rules for /api/admin/envoy/*: any signed-in
// member of the tenant may enqueue and read their own tenant's jobs;
// only a device-token caller may claim work or post a report — the
// same line the connected claim and the activity feed draw.
//
// Wiring note: live-admin.mjs is frozen at the push size limit, so this
// route hangs off the envoy-ably hook next to the runner-presence
// delegate, with its own lazy pool (same env var, same ssl rule).
import { Pool } from 'pg';

export const PROFILE_SYNC_PATH = '/api/admin/envoy/profile-sync';
export const PROFILE_SYNC_KIND = 'profile-sync';
export const PROFILE_SYNC_JOB_STATUSES = Object.freeze(['pending', 'claimed', 'done', 'failed']);

const FILE_REPORT_LIMIT = 500;
const SHA256_HEX = /^[a-f0-9]{64}$/;

// The report is small scalars only — a path, a target name, a
// created/updated verb, a hash. Anything else is dropped here so the
// result column can never become a file-content or secret channel.
export function sanitizeProfileSyncFiles(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (out.length >= FILE_REPORT_LIMIT) break;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const path = String(entry.path ?? '').trim();
    const target = String(entry.target ?? '').trim().slice(0, 40);
    const action = entry.action === 'created' ? 'created' : entry.action === 'updated' ? 'updated' : null;
    const sha256 = String(entry.sha256 ?? '').trim().toLowerCase();
    if (!path || path.length > 1024 || !action || !SHA256_HEX.test(sha256)) continue;
    out.push({ path, target, action, sha256 });
  }
  return out;
}

function jobOut(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    kind: String(row.kind ?? PROFILE_SYNC_KIND),
    status: String(row.status),
    requestedBy: row.requested_by ?? null,
    files: sanitizeProfileSyncFiles(row.result?.files),
    error: row.error != null ? String(row.error) : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    claimedAt: row.claimed_at ? new Date(row.claimed_at).toISOString() : null,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}

function isMissingTable(error) {
  return error?.code === '42P01';
}

const unavailable = () => Object.assign(new Error('profile sync store unavailable'), { status: 503 });

// Minimal store over helmion.profile_sync_jobs, shaped like the runner
// presence store: tenant transaction via set_config, 42P01-aware.
export function createProfileSyncJobStore(pool) {
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

  return {
    // A member's button press. One row, pending, carrying nothing but
    // who asked. Returns the job the page will poll.
    async enqueue(tenantId, { requestedBy = null } = {}) {
      try {
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `insert into helmion.profile_sync_jobs(tenant_id, kind, status, requested_by)
             values (current_setting('helmion.tenant_id', true), $1, 'pending', $2)
             returning id, kind, status, requested_by, result, error, created_at, claimed_at, completed_at`,
            [PROFILE_SYNC_KIND, requestedBy != null ? String(requestedBy).slice(0, 200) : null]);
          return jobOut(r.rows[0]);
        });
      } catch (error) {
        if (isMissingTable(error)) throw unavailable();
        throw error;
      }
    },

    async get(tenantId, id) {
      const jobId = String(id ?? '').trim();
      if (!/^\d+$/.test(jobId)) return null;
      try {
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `select id, kind, status, requested_by, result, error, created_at, claimed_at, completed_at
             from helmion.profile_sync_jobs
             where tenant_id = current_setting('helmion.tenant_id', true) and id = $1`,
            [jobId]);
          return jobOut(r.rows[0] ?? null);
        });
      } catch (error) {
        if (isMissingTable(error)) throw unavailable();
        throw error;
      }
    },

    // The device's claim: oldest pending job for this tenant flips to
    // claimed in one statement, so two bridges can never take the same
    // job. Returns null when nothing waits.
    async claimNext(tenantId) {
      try {
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `update helmion.profile_sync_jobs
             set status = 'claimed', claimed_at = clock_timestamp()
             where id = (
               select id from helmion.profile_sync_jobs
               where tenant_id = current_setting('helmion.tenant_id', true) and status = 'pending'
               order by created_at asc, id asc
               limit 1
             )
             returning id, kind, status, requested_by, result, error, created_at, claimed_at, completed_at`);
          return jobOut(r.rows[0] ?? null);
        });
      } catch (error) {
        if (isMissingTable(error)) throw unavailable();
        throw error;
      }
    },

    // The device's report. Only a claimed job may be completed, and the
    // file list is sanitized on the way in — the store never trusts the
    // shape a caller claims.
    async report(tenantId, id, { status, files, error } = {}) {
      const jobId = String(id ?? '').trim();
      if (!/^\d+$/.test(jobId)) throw Object.assign(new Error('job id required'), { status: 400 });
      if (status !== 'done' && status !== 'failed') throw Object.assign(new Error('report status must be done or failed'), { status: 400 });
      const result = status === 'done' ? { files: sanitizeProfileSyncFiles(files) } : null;
      const errorText = status === 'failed' ? String(error ?? 'profile sync failed on the device').slice(0, 500) : null;
      try {
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `update helmion.profile_sync_jobs
             set status = $2, result = $3::jsonb, error = $4, completed_at = clock_timestamp()
             where tenant_id = current_setting('helmion.tenant_id', true) and id = $1 and status = 'claimed'
             returning id, kind, status, requested_by, result, error, created_at, claimed_at, completed_at`,
            [jobId, status, result ? JSON.stringify(result) : null, errorText]);
          if (!r.rows[0]) throw Object.assign(new Error('job not claimed'), { status: 409 });
          return jobOut(r.rows[0]);
        });
      } catch (error) {
        if (isMissingTable(error)) throw unavailable();
        throw error;
      }
    },
  };
}

// Own lazy pool: live-admin.mjs owns the primary pool and cannot pass
// it through the frozen hook. Same env var, same ssl rule as
// runner-presence.
let sharedPool = null;
function getPool() {
  if (!sharedPool) {
    const connectionString = String(process.env.HELMION_DATABASE_URL ?? '').trim();
    if (!connectionString) throw Object.assign(new Error('database not configured'), { status: 503 });
    sharedPool = new Pool({ connectionString, ssl: connectionString.includes('sslmode=disable') ? false : undefined, max: 3 });
  }
  return sharedPool;
}

// Route delegate, same contract as handleRunnerPresenceRoute. Member:
// POST enqueues, GET ?job=<id> reads it back. Device token: GET
// ?work=1 claims the oldest pending job, POST { jobId, status, files }
// reports it. Returns false when the request is not ours.
export async function handleProfileSyncRoute({
  request,
  response,
  requestUrl,
  activeTenantActor,
  send,
  TenantAuthorizationError,
  readJson,
  store: injectedStore,
} = {}) {
  if (!requestUrl || requestUrl.pathname !== PROFILE_SYNC_PATH) return false;
  const membershipError = (error) => error?.status === 403 || error instanceof TenantAuthorizationError;
  const store = injectedStore ?? createProfileSyncJobStore(getPool());
  try {
    const actor = await activeTenantActor(request);
    if (request.method === 'POST') {
      let body = {};
      try { body = (await readJson(request)) ?? {}; } catch {}
      if (body.jobId != null || body.status != null) {
        // A device report. A member session cannot attest to files on
        // a PC it is not running on — same line as the connected claim.
        if (actor.viaDeviceToken !== true) {
          send(response, 403, JSON.stringify({ valid: false, code: 'PROFILE_SYNC_DEVICE_REQUIRED' }));
          return true;
        }
        const job = await store.report(actor.tenantId, body.jobId, { status: body.status, files: body.files, error: body.error });
        send(response, 200, JSON.stringify({ valid: true, ok: true, job }));
        return true;
      }
      const job = await store.enqueue(actor.tenantId, { requestedBy: actor.subject ?? null });
      send(response, 202, JSON.stringify({ valid: true, ok: true, job }));
      return true;
    }
    if (request.method === 'GET') {
      if (requestUrl.searchParams.get('work') != null) {
        if (actor.viaDeviceToken !== true) {
          send(response, 403, JSON.stringify({ valid: false, code: 'PROFILE_SYNC_DEVICE_REQUIRED' }));
          return true;
        }
        const job = await store.claimNext(actor.tenantId);
        send(response, 200, JSON.stringify({ valid: true, ok: true, job }));
        return true;
      }
      const job = await store.get(actor.tenantId, requestUrl.searchParams.get('job'));
      if (!job) {
        send(response, 404, JSON.stringify({ valid: false, code: 'PROFILE_SYNC_JOB_NOT_FOUND' }));
        return true;
      }
      send(response, 200, JSON.stringify({ valid: true, ok: true, job }));
      return true;
    }
    send(response, 405, JSON.stringify({ valid: false, code: 'METHOD_NOT_ALLOWED' }));
  } catch (error) {
    const status = membershipError(error) ? 403 : (error?.status ?? 400);
    send(response, status, JSON.stringify({ valid: false, code: 'PROFILE_SYNC_FAILED', detail: error?.message ?? String(error) }));
  }
  return true;
}
