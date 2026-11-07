// Runner provider presence: presence-only rows for the Settings UI.
// The cloud never holds provider credentials (migration 019 contract); this
// module carries a connected true/false plus a timestamp, nothing secret.
//
// The boolean is a device claim only: the PC bridge sets it when it finds
// a provider signed in or keyed on the PC it runs on. A profile sync must
// never set it — sync writes profile files, it does not connect anything —
// so the sync branch below stamps the row's timestamp through markSynced
// and leaves the boolean exactly as it found it. No surface may render
// this feed as "Connected"; connection truth lives in the provider
// connections store (sql/031), the same store the Agents page reads.
//
// Honest-connection fix (2026-11-01): the route now honors a report only
// from a device-token caller. A signed-in member's POST used to write
// connected = true on nothing but a click; it degrades to markSynced —
// the member's write can move a timestamp, never the boolean, in either
// direction. The row also carries last_answered_at (sql/066), written
// only by markAnswered from the reply-posting path when a runner posts
// an agent reply: the one event that proves the road works. Surfaces
// read that stamp as "Answered"; a provider without it has never
// answered and does not read as connected.
//
// Wiring note: live-admin.mjs is frozen at the push size limit, so this
// route hangs off the existing envoy-ably hook (envoy-ably.mjs delegates
// here). Device-token auth applies because the path lives under
// /api/admin/envoy/.
//
// Profile sync (S1, 2026-11-05): the sync branch below used to return a
// hardcoded list of files it claimed to have written — it wrote none.
// It now also enqueues a real profile-sync job (profile-sync.mjs,
// sql/070) for the tenant's device; the PC bridge claims it, runs the
// Agent OS installer, and reports the files it actually wrote. This
// route's answer carries the job and an EMPTY syncedFiles: the only
// file list a surface may render is the device's report, read back
// through the profile-sync route.
import { Pool } from 'pg';
import { PROVIDER_KEY_ENV } from '../runner/vault.mjs';
import { connectionProvider } from './tenant-agent-state.mjs';
import { createProfileSyncJobStore } from './profile-sync.mjs';

export const RUNNER_PRESENCE_PATH = '/api/admin/envoy/runner/presence';

// Live activity (demo-night bite A, 2026-11-04): the room must show what
// a seat is DOING, not a bare "answering…" for five minutes. The worker
// posts one event per real milestone of a job over this same route —
// { provider, channelId, stage, detail, at } with stage one of
// ACTIVITY_STAGES — and the desk reads the unexpired events back on the
// GET payload it already polls (a new `activity` field; every existing
// presence field keeps its meaning). REAL events only: an event exists
// because the worker emitted it at the milestone, never because a timer
// or a message's age suggests one. Same honesty rules as presence: only
// a device-token caller may post (a member's activity write degrades to
// the sync stamp, exactly like its connected claim), and no event may
// create or move a presence row. Events live in helmion.runner_activity
// (sql/067) under a short TTL: when a worker dies mid-job its last event
// expires and the seat stops claiming work — nothing has to clean up
// after it. Until sql/067 is applied, reads answer [] and writes report
// unavailable, exactly like presence before its own migration.
export const ACTIVITY_STAGES = Object.freeze(['started', 'working', 'file-placed', 'published', 'done', 'failed']);
export const ACTIVITY_TTL_MS = 5 * 60_000;
const ACTIVITY_STAGE_SET = new Set(ACTIVITY_STAGES);
const ACTIVITY_LIST_LIMIT = 100;
const ACTIVITY_CLOCK_SKEW_MS = 60_000;

// The presence vocabulary is the vault key set (report() enforces the
// same set); connection aliases ('chatgpt', 'openai_codex') resolve
// through tenant-agent-state's connectionProvider, the same resolver
// the presence leg uses. The worker reports the qwen seat as 'ollama'
// (its presence name), so the desk matches activity to a seat by the
// same names it already maps presence by.
function normalizeActivityProvider(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return null;
  if (PROVIDERS.has(value)) return value;
  const resolved = connectionProvider(value);
  return resolved && PROVIDERS.has(resolved) ? resolved : null;
}

// Detail is a small bag of scalars the worker measured (counts, a
// transport name, a message id). Anything else — nested objects, long
// strings, extra keys — is dropped here so the feed can never become a
// second message body or a secret's hiding place.
function sanitizeActivityDetail(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Object.keys(out).length >= 16) break;
    const k = String(key).slice(0, 40);
    if (!k) continue;
    if (typeof value === 'string') out[k] = value.slice(0, 200);
    else if (typeof value === 'number' && Number.isFinite(value)) out[k] = value;
    else if (typeof value === 'boolean') out[k] = value;
  }
  return out;
}

// Shape one raw activity report into the stored event. `at` is the
// worker's own stamp, clamped to the server's now when it is missing,
// unparseable, or ahead of the clock beyond a small skew — a worker
// cannot fake freshness, and expiry always derives from the clamped
// stamp plus the TTL.
export function normalizeActivityEvent(raw, fallbackProvider, now = new Date()) {
  const bad = (message) => Object.assign(new Error(message), { status: 400 });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('activity event required');
  const provider = normalizeActivityProvider(raw.provider ?? fallbackProvider);
  if (!provider) throw bad('unknown provider');
  const channelId = String(raw.channelId ?? '').trim();
  if (!channelId || channelId.length > 128) throw bad('channelId required');
  const stage = String(raw.stage ?? '').trim().toLowerCase();
  if (!ACTIVITY_STAGE_SET.has(stage)) throw bad('unknown activity stage');
  const nowMs = now.getTime();
  let atMs = raw.at != null ? new Date(raw.at).getTime() : NaN;
  if (!Number.isFinite(atMs) || atMs > nowMs + ACTIVITY_CLOCK_SKEW_MS) atMs = nowMs;
  return {
    provider,
    channelId,
    stage,
    detail: sanitizeActivityDetail(raw.detail),
    at: new Date(atMs).toISOString(),
    expiresAt: new Date(atMs + ACTIVITY_TTL_MS).toISOString(),
  };
}

// Own lazy pool: live-admin.mjs owns the primary pool and cannot pass it
// through the frozen hook. Same env var, same ssl rule.
let sharedPool = null;
function getPool() {
  if (!sharedPool) {
    const connectionString = String(process.env.HELMION_DATABASE_URL ?? '').trim();
    if (!connectionString) throw Object.assign(new Error('database not configured'), { status: 503 });
    sharedPool = new Pool({ connectionString, ssl: connectionString.includes('sslmode=disable') ? false : undefined, max: 3 });
  }
  return sharedPool;
}

const PROVIDERS = new Set(Object.keys(PROVIDER_KEY_ENV));

function isMissingTable(error) {
  return error?.code === '42P01';
}

// Minimal store over helmion.runner_provider_presence. 42P01-safe: when the
// migration has not been applied yet, reads return [] and writes report
// unavailable instead of throwing.
export function createRunnerPresenceStore(pool) {
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

  // One presence upsert, with the standing repair for databases whose
  // provider-name check predates a provider rename: widen it and retry.
  const upsert = async (client, sql, params) => {
    try {
      await client.query(sql, params);
    } catch (err) {
      if (err?.code !== '23514') throw err;
      await client.query(`alter table helmion.runner_provider_presence drop constraint if exists runner_provider_presence_provider_name_check`);
      await client.query(`alter table helmion.runner_provider_presence add constraint runner_provider_presence_provider_name_check check (provider_name in ('gemini', 'claude', 'openai', 'grok', 'xai', 'mistral', 'runway', 'ollama', 'groq', 'nvidia', 'cloudflare', 'openrouter', 'muse'))`);
      await client.query(sql, params);
    }
  };

  // sql/066 adds last_answered_at; until that migration lands the column
  // does not exist and every stamp reads as "never answered". Probe once
  // per store, outside any transaction (a failed query would poison one),
  // and let list/markAnswered shape themselves to what the schema has.
  let answeredColumnPromise = null;
  const hasAnsweredColumn = () => {
    if (!answeredColumnPromise) {
      answeredColumnPromise = (async () => {
        if (typeof pool?.query !== 'function') return true; // test fakes model the migrated schema
        try {
          await pool.query('select last_answered_at from helmion.runner_provider_presence limit 0');
          return true;
        } catch (error) {
          if (error?.code === '42703' || error?.code === '42P01') return false;
          throw error;
        }
      })();
    }
    return answeredColumnPromise;
  };

  return {
    async list(tenantId) {
      try {
        const answered = await hasAnsweredColumn();
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            answered
              ? 'select provider_name, connected, updated_at, last_answered_at from helmion.runner_provider_presence where tenant_id = current_setting(\'helmion.tenant_id\', true)'
              : 'select provider_name, connected, updated_at from helmion.runner_provider_presence where tenant_id = current_setting(\'helmion.tenant_id\', true)'
          );
          return r.rows.map((row) => ({
            provider: String(row.provider_name),
            connected: row.connected === true,
            updatedAt: row.updated_at,
            lastAnsweredAt: row.last_answered_at ?? null,
          }));
        });
      } catch (error) {
        if (isMissingTable(error)) return [];
        throw error;
      }
    },

    // Upsert presence for one provider. Called by the bridge (device token).
    async report(tenantId, provider, connected) {
      const p = String(provider || '').toLowerCase();
      if (!PROVIDERS.has(p)) throw Object.assign(new Error('unknown provider'), { status: 400 });
      try {
        await withTenant(tenantId, async (client) => {
          await upsert(client, `insert into helmion.runner_provider_presence(tenant_id, provider_name, connected, updated_at)
             values (current_setting('helmion.tenant_id', true), $1, $2, clock_timestamp())
             on conflict (tenant_id, provider_name)
             do update set connected = excluded.connected, updated_at = clock_timestamp()`, [p, connected === true]);
        });
        return { ok: true, provider: p, connected: connected === true };
      } catch (error) {
        if (isMissingTable(error)) throw Object.assign(new Error('presence store unavailable'), { status: 503 });
        throw error;
      }
    },

    // Stamp a profile sync's time for one provider WITHOUT making or
    // erasing a connection claim: a fresh row starts at connected = false,
    // and an existing row keeps whatever the bridge last reported — only
    // its updated_at moves. Surfaces read that row as "Synced", never as
    // "Connected".
    async markSynced(tenantId, provider) {
      const p = String(provider || '').toLowerCase();
      if (!PROVIDERS.has(p)) throw Object.assign(new Error('unknown provider'), { status: 400 });
      try {
        await withTenant(tenantId, async (client) => {
          await upsert(client, `insert into helmion.runner_provider_presence(tenant_id, provider_name, connected, updated_at)
             values (current_setting('helmion.tenant_id', true), $1, false, clock_timestamp())
             on conflict (tenant_id, provider_name)
             do update set updated_at = clock_timestamp()`, [p]);
        });
        return { ok: true, provider: p, synced: true };
      } catch (error) {
        if (isMissingTable(error)) throw Object.assign(new Error('presence store unavailable'), { status: 503 });
        throw error;
      }
    },

    // Stamp the moment an agent reply was actually posted for this
    // provider (called from envoy-mesh's postAsAgent). UPDATE-only: an
    // answer never creates a presence row — a tenant with no device
    // report (the hand-wired case) must not gain one, because a row's
    // mere existence is one of the tenant agent state's readiness
    // signals. The boolean is untouched: answering does not by itself
    // rewrite the device's connection claim either.
    async markAnswered(tenantId, provider) {
      const p = String(provider || '').toLowerCase();
      if (!PROVIDERS.has(p)) throw Object.assign(new Error('unknown provider'), { status: 400 });
      try {
        if (!(await hasAnsweredColumn())) return { ok: true, provider: p, answered: false, unavailable: true };
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `update helmion.runner_provider_presence set last_answered_at = clock_timestamp()
             where tenant_id = current_setting('helmion.tenant_id', true) and provider_name = $1`, [p]);
          return { ok: true, provider: p, answered: (r.rowCount ?? 0) > 0 };
        });
      } catch (error) {
        if (isMissingTable(error)) throw Object.assign(new Error('presence store unavailable'), { status: 503 });
        throw error;
      }
    },

    // Store one live-activity event (sql/067). The write first prunes
    // this tenant's expired rows, so the table stays the size of the
    // TTL window without a sweeper. An event never touches the presence
    // rows: activity is what a seat is doing, presence is what a device
    // claims — different facts, different tables.
    async reportActivity(tenantId, rawActivity, fallbackProvider) {
      const event = normalizeActivityEvent(rawActivity, fallbackProvider, new Date());
      try {
        await withTenant(tenantId, async (client) => {
          await client.query(
            `delete from helmion.runner_activity
             where tenant_id = current_setting('helmion.tenant_id', true) and expires_at <= $1`,
            [new Date().toISOString()]);
          await client.query(
            `insert into helmion.runner_activity(tenant_id, provider_name, channel_id, stage, detail, at, expires_at)
             values (current_setting('helmion.tenant_id', true), $1, $2, $3, $4::jsonb, $5, $6)`,
            [event.provider, event.channelId, event.stage, JSON.stringify(event.detail), event.at, event.expiresAt]);
        });
        return { ok: true, activity: event };
      } catch (error) {
        if (isMissingTable(error)) throw Object.assign(new Error('activity store unavailable'), { status: 503 });
        throw error;
      }
    },

    // The desk's activity feed: this tenant's unexpired events, newest
    // first. Expiry is judged at read time against the caller's now, so
    // a stale event never rides the payload even before a write prunes
    // it. 42P01-safe like list(): before sql/067 the feed is empty and
    // presence answers exactly as it always has.
    async listActivity(tenantId, now = new Date()) {
      try {
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `select provider_name, channel_id, stage, detail, at, expires_at from helmion.runner_activity
             where tenant_id = current_setting('helmion.tenant_id', true) and expires_at > $1
             order by at desc limit ${ACTIVITY_LIST_LIMIT}`,
            [now.toISOString()]);
          return r.rows.map((row) => ({
            provider: String(row.provider_name),
            channelId: String(row.channel_id),
            stage: String(row.stage),
            detail: row.detail && typeof row.detail === 'object' ? row.detail : {},
            at: new Date(row.at).toISOString(),
            expiresAt: new Date(row.expires_at).toISOString(),
          }));
        });
      } catch (error) {
        if (isMissingTable(error)) return [];
        throw error;
      }
    },
  };
}

// Route delegate. GET lists presence (member auth); POST reports presence
// (device-token auth via activeTenantActor, same as other envoy paths).
// Returns false when the request is not ours.
export async function handleRunnerPresenceRoute({
  request,
  response,
  requestUrl,
  activeTenantActor,
  send,
  TenantAuthorizationError,
  readJson,
  store: injectedStore,
  profileSyncJobs: injectedJobs,
} = {}) {
  if (!requestUrl || requestUrl.pathname !== RUNNER_PRESENCE_PATH) return false;
  const membershipError = (error) => error?.status === 403 || error instanceof TenantAuthorizationError;
  const store = injectedStore ?? createRunnerPresenceStore(getPool());
  try {
    const actor = await activeTenantActor(request);
    if (request.method === 'GET') {
      const presence = await store.list(actor.tenantId);
      // The activity feed rides the read the desk already polls. Every
      // existing field keeps its meaning; `activity` is additive, and
      // it is [] until sql/067 lands.
      const activity = typeof store.listActivity === 'function' ? await store.listActivity(actor.tenantId) : [];
      send(response, 200, JSON.stringify({ valid: true, presence, activity }));
    } else if (request.method === 'POST') {
      let body = {};
      try { body = (await readJson(request)) ?? {}; } catch {}
      if (body.syncProfile === true) {
        // A sync distributes the profile; it connects nothing. Stamp each
        // provider's presence row with the sync time (markSynced) so the
        // surfaces can say "Synced" — the connected boolean is the
        // bridge's claim to make, and this branch never touches it.
        const syncedProviders = ['claude', 'openai', 'grok', 'gemini', 'mistral', 'runway', 'ollama'];
        for (const prov of syncedProviders) {
          await store.markSynced(actor.tenantId, prov).catch(() => {});
        }
        // And enqueue the real work: a profile-sync job the tenant's PC
        // bridge claims and answers with the files it actually wrote
        // (profile-sync.mjs). No file list is returned here — the only
        // list a surface may render is that device report. If the job
        // store is unavailable (sql/070 not applied) the request fails
        // honestly instead of falling back to the old fiction.
        const jobs = injectedJobs ?? createProfileSyncJobStore(getPool());
        const job = await jobs.enqueue(actor.tenantId, { requestedBy: actor.subject ?? null });
        send(response, 202, JSON.stringify({
          valid: true,
          ok: true,
          syncedProviders,
          syncedFiles: [],
          syncJob: { id: job.id, status: job.status },
          syncedAt: new Date().toISOString(),
        }));
        return true;
      }
      if (body.activity != null) {
        // A live-activity report: its own write, never a presence
        // report — an event must not create or move a connected claim.
        // The provider may ride at the top level (the presence body's
        // shape) or inside the event itself.
        if (actor.viaDeviceToken === true) {
          // The worker emitting a job's real milestones — the only
          // caller whose activity means anything, same rule as the
          // connected claim.
          const result = await store.reportActivity(actor.tenantId, body.activity, body.provider);
          send(response, 200, JSON.stringify({ valid: true, ...result }));
          return true;
        }
        // A member browser session cannot attest to a seat's work
        // either, so its activity write degrades to the same
        // timestamp-only sync stamp as its connected claim, and the
        // event is dropped.
        const result = await store.markSynced(actor.tenantId, body.provider ?? body.activity?.provider);
        send(response, 200, JSON.stringify({ valid: true, ...result, activityAccepted: false }));
        return true;
      }
      if (actor.viaDeviceToken === true) {
        // The runner/worker reporting the seats it actually holds — the
        // only caller whose connected claim means anything.
        const result = await store.report(actor.tenantId, body.provider, body.connected);
        send(response, 200, JSON.stringify({ valid: true, ...result }));
        return true;
      }
      // A member browser session cannot verify a connection, so its
      // write degrades to a timestamp-only sync stamp: it records that
      // the user looked, and it can neither set nor clear the boolean
      // the device reported. (Honest-connection fix, 2026-11-01.)
      const result = await store.markSynced(actor.tenantId, body.provider);
      send(response, 200, JSON.stringify({ valid: true, ...result }));
    } else {
      send(response, 405, JSON.stringify({ valid: false, code: 'METHOD_NOT_ALLOWED' }));
    }
  } catch (error) {
    const status = membershipError(error) ? 403 : (error?.status === 503 ? 503 : 400);
    send(response, status, JSON.stringify({ valid: false, code: 'RUNNER_PRESENCE_FAILED', detail: error?.message ?? String(error) }));
  }
  return true;
}
