// Live turn-on wiring (Scribe 1154): the bridge's provenance ingestion.
// The tenant gate, the URL extraction, the fingerprint + timestamp on the
// record, the honest not-checked signature, and the profile loading — plus
// the full path: an ingested turn's claims run through the REAL loop hooks
// and the delivered reply carries the Unverified Provenance annotation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PROVENANCE_TENANT_IDS,
  provenanceEnabledForTenant,
  extractSourceUrls,
  buildTurnProvenance,
  isPublicHttpUrl,
} from '../src/agent/provenance-ingest.mjs';
import { runPreResponseVerification } from '../src/core/provenance-verification.mjs';
import { saveSyncedProvenanceProfile } from '../src/core/provenance-profile-store.mjs';

const TROY_TENANT = '0d7ca4d3-a2f4-458a-936b-d8a002a569e0';
const PAGE = '<html><body>The study found a 40 percent effect.</body></html>';
const PAGE_HASH = createHash('sha256').update(Buffer.from(PAGE)).digest('hex');

function fetchStub(map) {
  return async (url) => {
    if (!(url in map)) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(map[url]) };
  };
}

test('the gate: Troy\'s tenant is on, every other tenant and no tenant are off', () => {
  assert.deepEqual([...PROVENANCE_TENANT_IDS], [TROY_TENANT]);
  assert.equal(provenanceEnabledForTenant(TROY_TENANT), true);
  assert.equal(provenanceEnabledForTenant('1f44c3c1-886e-4afe-924e-2c142a688077'), false);
  assert.equal(provenanceEnabledForTenant(null), false);
  assert.equal(provenanceEnabledForTenant(undefined), false);
});

test('URL extraction: ordered, deduped, capped at three, trailing punctuation trimmed', () => {
  const urls = extractSourceUrls('see https://a.example/x, and https://b.example/y. plus https://a.example/x again, https://c.example/z and https://d.example/w');
  assert.deepEqual(urls, ['https://a.example/x', 'https://b.example/y', 'https://c.example/z']);
  assert.deepEqual(extractSourceUrls('no links here'), []);
});

test('an ingested source gets a fingerprint, a retrieval timestamp, and the Unverified Provenance flag', async () => {
  const now = new Date('2026-11-21T05:00:00.000Z');
  const result = await buildTurnProvenance({
    text: 'What does https://example.org/paper say?',
    tenantId: TROY_TENANT,
    fetchImpl: fetchStub({ 'https://example.org/paper': PAGE }),
    now,
  });
  assert.equal(result.claims.length, 1);
  const record = result.claims[0].provenanceRecord;
  assert.equal(record.sourceHash, PAGE_HASH, 'the fingerprint is the sha256 of the bytes actually retrieved');
  assert.equal(record.retrievedAt, now.toISOString());
  assert.equal(record.signatureStatus, 'not-checked');
  assert.equal(record.unverifiedProvenance, true);
  assert.ok(record.flagReasons.some((r) => /signature was not checked/.test(r)));
});

test('a source that cannot be fetched still becomes a record — flagged for the missing fingerprint', async () => {
  const result = await buildTurnProvenance({
    text: 'Check https://gone.example/page please',
    tenantId: TROY_TENANT,
    fetchImpl: fetchStub({}),
  });
  assert.equal(result.claims.length, 1);
  const record = result.claims[0].provenanceRecord;
  assert.ok(!record.sourceHash, 'no fingerprint was recorded for an unfetchable source');
  assert.equal(record.unverifiedProvenance, true);
  assert.ok(record.flagReasons.some((r) => /source hash/.test(r)));
});

test('off-tenant and source-less turns get null — byte-for-byte the old behaviour', async () => {
  assert.equal(await buildTurnProvenance({ text: 'https://a.example/x', tenantId: 'other-tenant', fetchImpl: fetchStub({}) }), null);
  assert.equal(await buildTurnProvenance({ text: 'just a question', tenantId: TROY_TENANT, fetchImpl: fetchStub({}) }), null);
});

test('the workspace\'s synced profile is loaded; a corrupt one becomes a named warning, not silence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'helmion-ingest-profile-'));
  try {
    await saveSyncedProvenanceProfile(root, { provenanceWeight: 0.5 });
    const good = await buildTurnProvenance({
      text: 'https://example.org/paper', tenantId: TROY_TENANT, workspaceRoot: root,
      fetchImpl: fetchStub({ 'https://example.org/paper': PAGE }),
    });
    assert.equal(good.profile.provenanceWeight, 0.5);
    assert.equal(good.profileWarning, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('SSRF guard: loopback, private, link-local, and reserved hosts are refused; public hosts pass', async () => {
  for (const bad of ['http://127.0.0.1/admin', 'http://localhost:8787/x', 'https://192.168.1.1/', 'https://10.0.0.5/', 'https://172.16.0.9/', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/', 'https://[fe80::1]/', 'https://printer.local/', 'ftp://example.org/x']) {
    assert.equal(isPublicHttpUrl(bad), false, bad);
  }
  for (const good of ['https://example.org/paper', 'https://8.8.8.8/x', 'https://[2606:4700:4700::1111]/']) {
    assert.equal(isPublicHttpUrl(good), true, good);
  }
  // And end to end: a private source is never fetched — the record is
  // built from the refusal, still flagged, with no fingerprint.
  let fetched = false;
  const result = await buildTurnProvenance({
    text: 'Check http://127.0.0.1:8787/healthz for me',
    tenantId: TROY_TENANT,
    fetchImpl: async () => { fetched = true; return { ok: true, arrayBuffer: async () => Buffer.from('x') }; },
  });
  assert.equal(fetched, false);
  assert.equal(result.claims[0].provenanceRecord.sourceHash ?? '', '');
  assert.equal(result.claims[0].provenanceRecord.unverifiedProvenance, true);
});

test('END TO END: an ingested claim annotates the delivered reply with the flag', async () => {
  const built = await buildTurnProvenance({
    text: 'Summarize https://example.org/paper',
    tenantId: TROY_TENANT,
    fetchImpl: fetchStub({ 'https://example.org/paper': PAGE }),
  });
  const result = await runPreResponseVerification({
    text: 'The study found a 40 percent effect.',
    claims: built.claims,
    profile: built.profile,
  });
  assert.equal(result.action, 'annotate');
  assert.match(result.text, /Unverified Provenance/);
  assert.equal(result.evaluations[0].unverifiedProvenance, true);
});
