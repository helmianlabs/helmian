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

// The device report is the one legitimately large body on the admin
// host: FILE_REPORT_LIMIT entries, each carrying a path of up to 1024
// chars, a target, a verb and a sha256 — a full report serializes to
// roughly 600 KB. The host's shared body reader (live-admin.mjs
// readJsonObject) caps bodies at 16 KB by default, a size chosen for
// action-policy payloads; it takes the cap as its second argument, so
// this route asks for a report-sized one. 1 MiB covers the largest
// report the sanitizer can emit, with headroom, and stays bounded.
const REPORT_BODY_MAX_BYTES = 1024 * 1024;

// A pending job waits on a machine outside Helmian's control picking it up —
// the same shape as a pending connector OAuth handshake, so it gets the same
// window: CONNECTOR_OAUTH_PENDING_TTL_MS (src/cloud/connector-oauth-pending.mjs)
// is 15 minutes, and envoy-mesh link codes use the same 15 minutes. Past the
// window the job is failed with the plain reason (PROFILE_SYNC_EXPIRED_MESSAGE)
// instead of sitting pending forever behind a spinner no surface can see.
export const PROFILE_SYNC_PENDING_TTL_MS = 15 * 60 * 1000;
// The press-time answer when the workspace has no desktop linked: nothing
// can ever claim the job, so no job is queued — the press says so instead.
export const PROFILE_SYNC_NO_DESKTOP_CODE = 'PROFILE_SYNC_NO_DESKTOP';
export const PROFILE_SYNC_NO_DESKTOP_MESSAGE = 'No computer is connected yet, so the sync cannot run. Open Helmian on your PC, then press Sync again.';
export const PROFILE_SYNC_EXPIRED_MESSAGE = 'No computer picked up the sync within 15 minutes, so it was cancelled. Open Helmian on your PC and press Sync again.';

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
    // True only for a job the pending-expiry sweep below closed; the
    // surfaces render an expired job's reason whole instead of as a
    // failure on the PC.
    expired: row.result?.expired === true,
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

  // Fail pending jobs older than PROFILE_SYNC_PENDING_TTL_MS in place.
  // Runs inside the caller's transaction ahead of reads and claims, so a
  // stale job is never handed out as claimable and every surface reads
  // the settled truth. Claimed jobs are not swept: a claim means a PC
  // took the work, and its report (or its own failure) closes the job.
  const expireStalePending = async (client) => {
    await client.query(
      `update helmion.profile_sync_jobs
       set status = 'failed', error = $1, result = $2::jsonb, completed_at = clock_timestamp()
       where tenant_id = current_setting('helmion.tenant_id', true)
         and status = 'pending'
         and created_at <= clock_timestamp() - ($3 || ' milliseconds')::interval`,
      [PROFILE_SYNC_EXPIRED_MESSAGE, JSON.stringify({ expired: true }), String(PROFILE_SYNC_PENDING_TTL_MS)]);
  };

  return {
    // True when the tenant has a desktop link a PC bridge can claim work
    // with — the same runner truth tenant-agent-state.mjs counts
    // (helmion.desktop_links rows holding a token, not revoked). A sync
    // press with no link can never be claimed, so the press answers with
    // that fact instead of queueing a job nothing will ever run. A
    // missing desktop_links table reads as no link.
    async desktopLinked(tenantId) {
      try {
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `select count(*)::int as n from helmion.desktop_links
             where tenant_id = $1 and token_hash is not null and revoked_at is null`,
            [tenantId]);
          return (r.rows[0]?.n ?? 0) > 0;
        });
      } catch (error) {
        if (isMissingTable(error)) return false;
        throw error;
      }
    },

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
          await expireStalePending(client);
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

    // The tenant's newest job, whatever its state — the one read both web
    // surfaces render the sync's state from, so a job queued away from
    // this page (or left pending by an earlier visit) stays visible
    // instead of vanishing when the page that queued it goes away.
    async latest(tenantId) {
      try {
        return await withTenant(tenantId, async (client) => {
          await expireStalePending(client);
          const r = await client.query(
            `select id, kind, status, requested_by, result, error, created_at, claimed_at, completed_at
             from helmion.profile_sync_jobs
             where tenant_id = current_setting('helmion.tenant_id', true)
             order by created_at desc, id desc
             limit 1`);
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
          await expireStalePending(client);
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
// POST enqueues (or answers 409 PROFILE_SYNC_NO_DESKTOP when no desktop
// is linked), GET ?job=<id> reads one job back, GET with no job reads
// the tenant's newest job — the state both web surfaces render. Device
// token: GET ?work=1 claims the oldest pending job, POST { jobId,
// status, files } reports it. Returns false when the request is not
// ours.
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
      try {
        body = (await readJson(request, REPORT_BODY_MAX_BYTES)) ?? {};
      } catch (error) {
        // An unreadable body is an error, never an enqueue. The old
        // empty catch re-read an oversized device report as a button
        // press: the 16 KB host cap rejected every estate-scale report
        // (jobs 8, 11, 14 on 2026-11-06), the route minted a phantom
        // job and answered 202, and the claimed job sat in 'claimed'
        // forever while the bridge logged a successful report.
        send(response, error?.status ?? 400, JSON.stringify({ valid: false, code: 'PROFILE_SYNC_BODY_INVALID', detail: error?.message ?? String(error) }));
        return true;
      }
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
      // The press. With no desktop linked to this workspace, nothing can
      // ever claim the job — say so now instead of queueing a job that
      // spins forever. The probe is optional on the store so injected
      // doubles without it keep their behaviour.
      if (typeof store.desktopLinked === 'function' && !(await store.desktopLinked(actor.tenantId))) {
        send(response, 409, JSON.stringify({ valid: false, code: PROFILE_SYNC_NO_DESKTOP_CODE, detail: PROFILE_SYNC_NO_DESKTOP_MESSAGE }));
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
      if (requestUrl.searchParams.get('job') != null) {
        const job = await store.get(actor.tenantId, requestUrl.searchParams.get('job'));
        if (!job) {
          send(response, 404, JSON.stringify({ valid: false, code: 'PROFILE_SYNC_JOB_NOT_FOUND' }));
          return true;
        }
        send(response, 200, JSON.stringify({ valid: true, ok: true, job }));
        return true;
      }
      // No job named: the tenant's newest job (or none yet) — the state
      // read both sync surfaces render from on page load.
      const job = await store.latest(actor.tenantId);
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
