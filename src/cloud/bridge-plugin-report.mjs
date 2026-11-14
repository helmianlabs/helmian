// Bridge plugin reports: the kept half of the plugins pipe (M3 G7).
//
// The bridge reports its loaded plugins on every `commands` event
// (src/agent/bridge.mjs): name, version, whether it brings commands,
// its approved and refused MCP servers by name. Until now that report
// never left the PC — its only consumers were the desktop's own
// menus — while GET /api/admin/plugins answered from the workspace
// of the process serving the request (installed-plugins.mjs), in
// production the agent host's own shelf: an honest read of the wrong
// machine. This module is the cloud half of the pipe:
//
//   POST /api/admin/envoy/bridge/plugins — the ingest. The bridge's
//   sender hop (a desktop follow-on; until it lands this route is
//   exercised by scripted posters) posts the commands payload here
//   under the device token it already holds for presence. The tenant
//   is the credential's, never a body's field. A member's POST writes
//   nothing and answers reportAccepted: false — the presence rule
//   (runner-presence.mjs): a report only means something from the
//   device it describes.
//
//   The store keeps the LATEST report per tenant (sql/089), stamped
//   at arrival. Ingest shapes each entry at the door: the bridge's
//   `root` path is dropped and never stored, and warning strings are
//   reduced to a count — a loader warning can carry a PC file path,
//   and installed-plugins.mjs's law (no roots, no file paths ride to
//   a cloud surface) binds the stored bytes too, not just the rows
//   rendered from them.
//
//   The read side is bridgeReportPluginList below: when a report
//   exists for the tenant, the plugins read (plugin-library-route's
//   delegate, live-admin's fallback) serves the REPORT's rows —
//   shaped by installedPluginRow so the menu keeps one vocabulary —
//   and the answer carries the report's age as `bridgeReport`
//   ({ reportedAt, ageMs }). No report: the read is exactly the
//   local list it has always been. The age always rides when a
//   report supplies the list, so a dead PC's shelf is never
//   presented as live; the surfaces key their stale note off it.
//
// Wiring note: live-admin.mjs is frozen at the push size limit, so
// this route hangs off the existing envoy-ably hook (envoy-ably.mjs
// delegates here), like runner-presence. Device-token auth applies
// because the path lives under /api/admin/envoy/.
import { Pool } from 'pg';
import { canonicalPluginName, installedPluginRow } from './installed-plugins.mjs';

export const BRIDGE_PLUGIN_REPORT_PATH = '/api/admin/envoy/bridge/plugins';

// Ingest caps, in the house discipline (runner-presence's activity
// detail caps): a report is a small claim, never a document.
const MAX_REPORT_PLUGINS = 64;
const MAX_SERVER_NAMES = 32;
const MAX_VERSION_CHARS = 64;
const MAX_SERVER_NAME_CHARS = 128;
const MAX_REFUSAL_REASON_CHARS = 200;

// Own lazy pool, same as runner-presence: live-admin.mjs owns the
// primary pool and cannot pass it through the frozen hook. Same env
// var, same ssl rule.
let sharedPool = null;
function getPool() {
  if (!sharedPool) {
    const connectionString = String(process.env.HELMION_DATABASE_URL ?? '').trim();
    if (!connectionString) throw Object.assign(new Error('database not configured'), { status: 503 });
    sharedPool = new Pool({ connectionString, ssl: connectionString.includes('sslmode=disable') ? false : undefined, max: 3 });
  }
  return sharedPool;
}

function isMissingTable(error) {
  return error?.code === '42P01';
}

function nameList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const value of raw) {
    if (out.length >= MAX_SERVER_NAMES) break;
    const name = String(value ?? '').trim().slice(0, MAX_SERVER_NAME_CHARS);
    if (name) out.push(name);
  }
  return out;
}

function refusalList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const value of raw) {
    if (out.length >= MAX_SERVER_NAMES) break;
    const name = String(value?.name ?? '').trim().slice(0, MAX_SERVER_NAME_CHARS);
    if (!name) continue;
    out.push(Object.freeze({
      name,
      reason: String(value?.reason ?? '').trim().slice(0, MAX_REFUSAL_REASON_CHARS),
    }));
  }
  return out;
}

/**
 * One raw bridge report entry → its stored shape, or null when the
 * entry cannot be carried. THE DROP HAPPENS HERE: the raw entry's
 * `root` (and anything else the bridge emits beyond the named
 * fields) never reaches the store — the shape is built field by
 * field, so an unlisted field does not ride. Warnings arrive as
 * strings that can name PC file paths; only their count is kept.
 */
export function shapeBridgePluginReportEntry(raw) {
  const name = canonicalPluginName(raw?.name);
  if (!name) return null;
  const version = typeof raw?.version === 'string' && raw.version.trim()
    ? raw.version.trim().slice(0, MAX_VERSION_CHARS)
    : null;
  return Object.freeze({
    name,
    ...(version ? { version } : {}),
    commands: raw?.commands === true,
    approvedMcpServers: Object.freeze(nameList(raw?.approvedMcpServers)),
    refusedMcpServers: Object.freeze(refusalList(raw?.refusedMcpServers)),
    warningCount: Array.isArray(raw?.warnings) ? raw.warnings.length : 0,
  });
}

/** The whole report body → the stored entries: shaped, deduped by name, capped. */
export function shapeBridgePluginReport(rawPlugins) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(rawPlugins) ? rawPlugins : []) {
    if (out.length >= MAX_REPORT_PLUGINS) break;
    const entry = shapeBridgePluginReportEntry(raw);
    if (!entry || seen.has(entry.name)) continue;
    seen.add(entry.name);
    out.push(entry);
  }
  return Object.freeze(out);
}

/**
 * One stored report entry → its picker row, through the same shaper
 * the local read uses (installedPluginRow), so a report row and a
 * local row are the same vocabulary: the entry is lifted into the
 * loader's shape (server names become registration-shaped objects,
 * the commands flag becomes commandsDir) and the row builder does
 * the rest — including the `brings` line, whose counts come from
 * the same fields either way.
 */
export function bridgePluginReportRow(entry) {
  return installedPluginRow({
    name: entry?.name,
    version: entry?.version,
    commandsDir: entry?.commands === true,
    registrations: (entry?.approvedMcpServers ?? []).map((name) => ({ name })),
    refusals: entry?.refusedMcpServers ?? [],
  });
}

// Minimal store over helmion.bridge_plugin_reports (sql/089).
// 42P01-safe: when the migration has not been applied yet, latest()
// answers "no report" and report() reports unavailable, exactly
// like presence before its own migration.
export function createBridgePluginReportStore(pool) {
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
    // Keep one report: the shaped entries under the arrival stamp.
    // A newer report replaces the older whole — a report is the
    // bridge's current claim, not a history.
    async report(tenantId, rawPlugins, now = new Date()) {
      const plugins = shapeBridgePluginReport(rawPlugins);
      const reportedAt = new Date(now).toISOString();
      try {
        await withTenant(tenantId, async (client) => {
          await client.query(
            `insert into helmion.bridge_plugin_reports(tenant_id, reported_at, plugins)
             values (current_setting('helmion.tenant_id', true), $1, $2::jsonb)
             on conflict (tenant_id)
             do update set reported_at = excluded.reported_at, plugins = excluded.plugins`,
            [reportedAt, JSON.stringify(plugins)]);
        });
        return { ok: true, reportedAt, pluginCount: plugins.length };
      } catch (error) {
        if (isMissingTable(error)) throw Object.assign(new Error('bridge plugin report store unavailable'), { status: 503 });
        throw error;
      }
    },

    // The tenant's latest report with its age at the caller's now,
    // or null when the bridge has never reported (or sql/089 has
    // not landed): the read preference treats both as "no report".
    async latest(tenantId, now = new Date()) {
      try {
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `select reported_at, plugins from helmion.bridge_plugin_reports
             where tenant_id = current_setting('helmion.tenant_id', true)`);
          const row = r.rows[0];
          if (!row) return null;
          const reportedAt = new Date(row.reported_at).toISOString();
          const plugins = Array.isArray(row.plugins) ? row.plugins : [];
          return {
            plugins,
            reportedAt,
            ageMs: Math.max(0, now.getTime() - new Date(reportedAt).getTime()),
          };
        });
      } catch (error) {
        if (isMissingTable(error)) return null;
        throw error;
      }
    },
  };
}

/**
 * The read preference, shared by both plugins-read handlers: the
 * tenant's stored bridge report as a plugins list — rows shaped by
 * installedPluginRow, no unavailable entries (a load failure on the
 * bridge rides the report's own refusals/warnings, not this list),
 * and the report's age beside them. Null when no report exists:
 * the caller falls back to the local read, unchanged.
 */
export async function bridgeReportPluginList(store, tenantId, now = new Date()) {
  const report = await store.latest(tenantId, now);
  if (!report) return null;
  return Object.freeze({
    plugins: Object.freeze(report.plugins.map(bridgePluginReportRow).filter(Boolean)),
    unavailable: Object.freeze([]),
    bridgeReport: Object.freeze({ reportedAt: report.reportedAt, ageMs: report.ageMs }),
  });
}

// Route delegate. POST takes a bridge report (device-token auth via
// activeTenantActor, same as the other envoy device roads); a
// member's POST is not a report and writes nothing. Returns false
// when the request is not ours.
export async function handleBridgePluginReportRoute({
  request,
  response,
  requestUrl,
  activeTenantActor,
  send,
  TenantAuthorizationError,
  readJson,
  store: injectedStore,
} = {}) {
  if (!requestUrl || requestUrl.pathname !== BRIDGE_PLUGIN_REPORT_PATH) return false;
  const membershipError = (error) => error?.status === 403 || error instanceof TenantAuthorizationError;
  const store = injectedStore ?? createBridgePluginReportStore(getPool());
  try {
    const actor = await activeTenantActor(request);
    if (request.method !== 'POST') {
      send(response, 405, JSON.stringify({ valid: false, code: 'METHOD_NOT_ALLOWED' }));
      return true;
    }
    let body = {};
    try { body = (await readJson(request)) ?? {}; } catch {}
    if (actor.viaDeviceToken !== true) {
      // A member session cannot attest to what a bridge has loaded,
      // so its write is not a report: nothing is stored, and the
      // answer says so — the presence degrade rule, with no state
      // to stamp instead (a plugin claim is not a presence fact).
      send(response, 200, JSON.stringify({ valid: true, reportAccepted: false }));
      return true;
    }
    // The device reporting its own bridge's list — the only caller
    // whose report means anything. The tenant is the credential's;
    // any tenant named in the body is ignored, never honoured. The
    // body's other fields (the event's workspace root above all)
    // are not read at all: the entries are shaped field by field
    // in the store, and the root dies with the rest of the body.
    if (!Array.isArray(body?.plugins)) {
      throw Object.assign(new Error('plugins array required'), { status: 400 });
    }
    const result = await store.report(actor.tenantId, body.plugins);
    send(response, 200, JSON.stringify({ valid: true, ...result }));
  } catch (error) {
    const status = membershipError(error) ? 403 : (error?.status === 503 ? 503 : 400);
    send(response, status, JSON.stringify({ valid: false, code: 'BRIDGE_PLUGIN_REPORT_FAILED', detail: error?.message ?? String(error) }));
  }
  return true;
}
