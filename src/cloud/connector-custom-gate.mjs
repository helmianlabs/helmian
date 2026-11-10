// Custom-entry gate — the plus-button road's variant of the MCP
// install pipeline's sandbox stage (pipeline map §3, gap G1).
//
// THE HOLE THIS CLOSES. A custom connector entry used to be created
// by the write route's `entries` action straight into the library —
// name, auth mode, endpoint URL, done. Nothing probed the server,
// nothing froze a baseline, nothing recorded provenance, and arming
// dispatch's first-arm freeze then accepted whatever the server
// chose to list AFTER a person had already committed a credential
// to it. Catalog and Helmian-native entries never had this hole:
// their provenance is the operator's catalog, and their state joins
// from receipts and links that already exist.
//
// THE GATE, built only from machinery that already exists (no new
// store, no migration):
//   1. INTENT — creating a custom entry also register()s it in the
//      tool-connections store (sql/061): scope workspace, scope id
//      the seat, service id the entry. register() writes intent
//      only — who added it (the register subject), when (the row's
//      database timestamps), and the URL (server_ref) are the
//      provenance record; the library entry's own addedBy/addedAt
//      names the same person a second way.
//   2. PROBE — before the entry may connect or arm, the server is
//      probed with NO credential (probeToolConnection with
//      forceNoCredential — the sandbox stage's exact move: run it
//      uncredentialed and watch). The probe's receipt is the ONLY
//      writer of 'verified'; a failure is recorded by the same
//      machinery and clears any earlier receipt.
//   3. FREEZE — the tool list that probe returned is frozen onto the
//      connection the moment the connect lands (the write route's
//      job, through the library store's freezeSnapshot), so the
//      baseline fingerprint — per-tool inputSchemaHash — comes from
//      an uncredentialed look at the server, never from a list the
//      server produced after seeing a credential.
//   4. POSTURE — a custom entry's connection is recorded at the
//      default 'ask' whatever the connect body asks for; loosening
//      is the existing posture action's road, taken deliberately
//      after the fact.
//
// WHO CONSULTS THE GATE:
//   - the write route: at create (intent + first probe), and at
//     every connect road for a custom entry (a connect never lands
//     on an entry whose gate has not passed — the probe is re-run
//     there when the receipt is missing or failed);
//   - arming dispatch (connector-arming-dispatch.mjs): a custom
//     entry with no verified gate receipt resolves to a 'not-gated'
//     record, and a gated entry with no frozen snapshot gets NO
//     first-arm backstop freeze — the hole's second half was the
//     backstop freezing an unexamined list at arm time;
//   - the library read (connector-library-read.mjs): the row carries
//     the gate's state in its detail, and an entry whose gate has
//     not passed never reads 'connected', connected record or not.
//
// THE KEY. tool_connections.service_id is capped at 64 characters
// (sql/061) while a custom entry id can run longer (`custom-` plus a
// 60-char slug); the service id is the entry id verbatim when it
// fits, and a hashed form when it does not — deterministic, so every
// reader computes the same key from the entry alone.
//
// THE GATE IS PER (SEAT, ENTRY) — the finding SYNC S2a stands on.
// The gate row's unique key is (tenant, scope_kind, scope_id,
// service_id) in sql/061, and customGateKey puts the SEAT in
// scope_id (scope_kind is the literal 'workspace' for every custom
// gate row — the name does not make the row workspace-wide). So one
// custom entry has one gate row PER SEAT, each written only by a
// probe run for that seat: the verified state does NOT travel with
// the entry when the entry itself is projected across seats (S2a).
// A seat that has never run the gate for an entry holds no row for
// it ('missing' / not-gated); a connect through that seat registers
// and probes its own row (the write route's ensureCustomGate), and
// only then does that seat's gate read passed. Nothing in S2a
// re-keys, copies, or backfills gate rows — the projection follows
// the store's own keying, exactly as it finds it.

import { createHash } from 'node:crypto';

import { probeToolConnection } from '../agent/tool-connection-probe.mjs';

export const CUSTOM_GATE_SCOPE_KIND = 'workspace';
export const CUSTOM_GATE_KIND = 'mcp-http';
export const CUSTOM_GATE_PROBE_TIMEOUT_MS = 10_000;

/** The tool-connections service id for one custom entry (see header). */
export function customGateServiceId(entryId) {
  const id = String(entryId ?? '');
  if (id.length <= 64) return id;
  return `custom-${createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 48)}`;
}

/** The tool-connections key a custom entry's gate row lives under. */
export function customGateKey(seatId, entryId) {
  return { scopeKind: CUSTOM_GATE_SCOPE_KIND, scopeId: String(seatId ?? ''), serviceId: customGateServiceId(entryId) };
}

/**
 * Register the intent (gate step 1). The register subject is the
 * person adding the entry — provenance — and the server ref is the
 * entry's endpoint URL. No credential reference, ever: the gate row
 * names no credential because the gate must never hold one.
 */
export async function registerCustomGateIntent(toolConnections, tenantId, subject, entry) {
  return toolConnections.register(tenantId, subject, {
    ...customGateKey(entry.seatId, entry.id),
    kind: CUSTOM_GATE_KIND,
    serverRef: entry.mcpEndpointUrl,
    credentialReference: null,
    accountLabel: entry.name,
  });
}

/**
 * Run the gate probe (step 2): a real tools/list against the entry's
 * endpoint with NO credential, through the probe machinery — the
 * receipt (verified, or failed with the error kept and any earlier
 * receipt cleared) is written by the probe, never by this module.
 * `probeImpl` is injectable for tests; the default is the real probe
 * with forceNoCredential set.
 */
export async function probeCustomGate({ toolConnections, tenantId, entry, probeImpl = null, timeoutMs = CUSTOM_GATE_PROBE_TIMEOUT_MS } = {}) {
  const key = customGateKey(entry.seatId, entry.id);
  if (probeImpl) return probeImpl({ tenantId, key, entry });
  return probeToolConnection({ store: toolConnections, tenantId, key, forceNoCredential: true, timeoutMs });
}

/** The gate row for one custom entry, or null when no row exists. */
export async function getCustomGateRow(toolConnections, tenantId, seatId, entryId) {
  if (!toolConnections || typeof toolConnections.get !== 'function') return null;
  return toolConnections.get(tenantId, customGateKey(seatId, entryId));
}

/**
 * What a gate row MEANS, in one place so every surface rules it the
 * same: passed only on a verified state carrying its receipt
 * timestamp (the store's honesty rule — 'verified' is written only
 * by recordProbeReceipt, which always stamps last_verified_at).
 * `reason` extends dispatch's record vocabulary minimally:
 * 'not-gated' for never-passed, 'gate-check-failed' for a recorded
 * failure — no existing reason names either state honestly.
 */
export function classifyCustomGate(row) {
  const base = {
    lastVerifiedAt: row?.lastVerifiedAt ?? null,
    lastToolsCount: row?.lastToolsCount ?? null,
    lastError: row?.lastError ?? null,
  };
  if (!row) {
    return { ...base, state: 'missing', passed: false, reason: 'not-gated', detail: 'it has not passed its safety check, so it cannot be armed yet' };
  }
  if (row.state === 'verified' && row.lastVerifiedAt) {
    return { ...base, state: 'verified', passed: true, reason: null, detail: null };
  }
  if (row.state === 'failed') {
    return { ...base, state: 'failed', passed: false, reason: 'gate-check-failed', detail: 'its safety check failed, so it cannot be armed yet' };
  }
  if (row.state === 'revoked') {
    return { ...base, state: 'revoked', passed: false, reason: 'not-gated', detail: 'its safety check was revoked, so it cannot be armed yet' };
  }
  // 'registered' / 'probing', or a verified state with no receipt
  // timestamp (the store cannot write one — ruled unpassed anyway).
  return { ...base, state: row.state ?? 'registered', passed: false, reason: 'not-gated', detail: 'it has not passed its safety check, so it cannot be armed yet' };
}

/** The gate detail a surface carries for a custom entry's row. */
export function customGateDetail(row) {
  const gate = classifyCustomGate(row);
  return {
    state: gate.state,
    passed: gate.passed,
    lastVerifiedAt: gate.lastVerifiedAt,
    lastToolsCount: gate.lastToolsCount,
    lastError: gate.lastError,
  };
}
