// Stage 1 ingestion for live turns (provenance verification, Scribe 1154):
// when a turn arrives carrying source URLs, the bridge fetches each source
// AT INGESTION, fingerprints what it actually retrieved (sha256 of the
// bytes), stamps the retrieval time, and builds the Milestone 1
// ProvenanceRecord the pre-response hooks evaluate. A fetched page carries
// no cryptographic signature the bridge can verify, so the record is
// honestly marked signatureStatus 'not-checked' — which derives the
// Unverified Provenance flag, exactly as the specification requires for
// unattributed or unsigned sources. Nothing here upgrades a source's
// standing; it records what was seen, when, and its fingerprint.
//
// TENANT GATE. Provenance verification is turned on per tenant, in code,
// starting with Troy's own workspace. A bridge paired to any other tenant
// gets null from buildTurnProvenance — byte-for-byte today's behaviour.
// Widening the list is a deliberate edit to PROVENANCE_TENANT_IDS, never a
// configuration accident.
//
// Failure posture: a source that cannot be fetched still becomes a record
// (no hash — itself a flag reason) so the claim is annotated, not silently
// dropped. A failure to build provenance at all is returned as a warning
// the bridge surfaces as a status event; it never kills the turn, and it
// is never silent.

import { createHash } from 'node:crypto';

import { createProvenanceRecord } from '../core/provenance-verification.mjs';
import { loadSyncedProvenanceProfile } from '../core/provenance-profile-store.mjs';

export const PROVENANCE_TENANT_IDS = Object.freeze([
  '0d7ca4d3-a2f4-458a-936b-d8a002a569e0', // Troy's workspace — the first tenant turned on (2026-11-20).
]);

export function provenanceEnabledForTenant(tenantId) {
  return typeof tenantId === 'string' && PROVENANCE_TENANT_IDS.includes(tenantId);
}

const MAX_SOURCES = 3;
const FETCH_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 256 * 1024;

/** http/https URLs in a turn's text, in order, deduped, capped. */
export function extractSourceUrls(text) {
  const found = String(text ?? '').match(/https?:\/\/[^\s<>"')\]]+/gi) ?? [];
  const cleaned = found.map((u) => u.replace(/[.,;:]+$/, ''));
  return [...new Set(cleaned)].slice(0, MAX_SOURCES);
}

// SSRF guard: ingestion fetches URLs a turn names, from the bridge's own
// network position. A pasted link must never turn the bridge into a probe
// of the machine's own network, so loopback, private, link-local, and
// reserved hosts are refused before any fetch, and the host a redirect
// lands on is checked again before the body is read. (DNS rebinding — a
// public name resolving to a private address — is NOT closed by this
// check; it is named as a residual gap in the bite's audit record.)
export function isPublicHttpUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224) return false;
    return true;
  }
  if (host.includes(':')) {
    // IPv6 literals: only globally routable space passes (2xxx), which
    // excludes loopback (::1), link-local (fe80::/10), and ULA (fc00::/7).
    return /^[23]/.test(host);
  }
  return true;
}

async function fetchSource(url, fetchImpl) {
  if (!isPublicHttpUrl(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' });
    if (!res || res.ok === false) return null;
    if (typeof res.url === 'string' && res.url && !isPublicHttpUrl(res.url)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.subarray(0, MAX_BODY_BYTES);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the loop's provenanceVerification option for one turn, or null when
 * provenance is not on for this tenant or the turn carries no sources.
 *
 * @returns {Promise<null | { claims: object[], profile: object|null,
 *            profileWarning: string|null }>}
 */
export async function buildTurnProvenance({
  text,
  tenantId,
  workspaceRoot = null,
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  if (!provenanceEnabledForTenant(tenantId)) return null;
  const urls = extractSourceUrls(text);
  if (!urls.length || typeof fetchImpl !== 'function') return null;

  const claims = [];
  for (const [i, url] of urls.entries()) {
    const bytes = await fetchSource(url, fetchImpl);
    let host = url;
    try { host = new URL(url).hostname; } catch { /* the record keeps the raw URL */ }
    const record = createProvenanceRecord({
      recordId: `turn-source-${i + 1}`,
      sourceUrl: url,
      ...(bytes ? { sourceHash: createHash('sha256').update(bytes).digest('hex') } : {}),
      signatureStatus: 'not-checked',
      attributionStatus: 'publisher-only',
      publisher: host,
    }, { now });
    claims.push({ claimId: `source-${i + 1}`, provenanceRecord: record, contestationVector: null });
  }

  // The tenant's synced weighting profile, when one has landed in this
  // workspace (Milestone 4). A corrupt synced file is a warning, not a
  // silent default and not a dead turn.
  let profile = null;
  let profileWarning = null;
  if (workspaceRoot) {
    try {
      const loaded = await loadSyncedProvenanceProfile(workspaceRoot);
      profile = loaded.profile;
    } catch (err) {
      profileWarning = `the synced weighting profile could not be read (${err?.message ?? String(err)}); this turn runs on the default profile`;
    }
  }

  return { claims, profile, profileWarning };
}
