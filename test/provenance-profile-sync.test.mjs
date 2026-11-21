// Milestone 4 of the provenance verification build (Scribe 1154): Profile
// Sync Integration for the weighting profile. What syncs is the profile;
// the policy is derived, and a payload whose policy disagrees with its own
// profile is refused whole. The store's apply path is exercised on a real
// filesystem, and a synced stricter profile is proven to change a real
// guardrail decision on the Milestone 1 hook path.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  PROVENANCE_PROFILE_RELATIVE_PATH,
  WEIGHTING_SLIDERS,
  sliderKeys,
  createProvenanceSyncPayload,
  validateProvenanceSyncPayload,
  renderProvenanceProfileFile,
  parseProvenanceProfileFile,
  applyProvenanceSyncPayload,
  ProvenanceProfileSyncError,
} from '../src/core/provenance-profile-sync.mjs';
import {
  loadSyncedProvenanceProfile,
  saveSyncedProvenanceProfile,
  provenanceProfilePath,
} from '../src/core/provenance-profile-store.mjs';
import {
  DEFAULT_WEIGHTING_PROFILE,
  createProvenanceRecord,
  createContestationVector,
  runPreResponseVerification,
} from '../src/core/provenance-verification.mjs';
import { buildProvenancePolicy, evaluateProvenancePolicy } from '../src/core/provenance-policy.mjs';

const NOW = new Date('2026-11-20T19:00:00.000Z');
const STRICTER = { highContestationConsensusMax: 0.85, highContestationDissentRigorMin: 0.4 };

function workspace() {
  return mkdtempSync(join(tmpdir(), 'helmion-prov-profile-'));
}

/* ── Config exposure ─────────────────────────────────────────────────────── */

test('the config sliders are exactly the profile fields, in the specification language', () => {
  assert.deepEqual([...sliderKeys()].sort(), Object.keys(DEFAULT_WEIGHTING_PROFILE).sort());
  const labels = Object.fromEntries(WEIGHTING_SLIDERS.map((s) => [s.key, s.label]));
  assert.equal(labels.financialIndependenceWeight, 'Financial Independence Weight');
  assert.equal(labels.institutionalConsensusWeight, 'Institutional Consensus Weight');
  assert.ok(WEIGHTING_SLIDERS.every((s) => s.min === 0 && s.max === 1 && s.step > 0));
});

/* ── Payload ─────────────────────────────────────────────────────────────── */

test('a payload carries the RESOLVED profile and the policy it builds', () => {
  const payload = createProvenanceSyncPayload(STRICTER, { now: NOW, source: 'workspace-settings' });
  assert.equal(payload.profile.highContestationConsensusMax, 0.85);
  assert.equal(payload.profile.provenanceWeight, DEFAULT_WEIGHTING_PROFILE.provenanceWeight, 'defaults are filled in, not left to the receiver');
  assert.deepEqual(payload.policy, buildProvenancePolicy(payload.profile));
  assert.equal(payload.updatedAt, NOW.toISOString());
  assert.equal(validateProvenanceSyncPayload(payload).valid, true);
});

test('the rendered file is deterministic and round-trips byte-for-byte', () => {
  const payload = createProvenanceSyncPayload(STRICTER, { now: NOW });
  const a = renderProvenanceProfileFile(payload);
  const b = renderProvenanceProfileFile(createProvenanceSyncPayload(STRICTER, { now: NOW }));
  assert.equal(a, b);
  assert.deepEqual(parseProvenanceProfileFile(a), payload);
});

test('a payload whose policy was edited after the fact is REFUSED as tampered', () => {
  const payload = createProvenanceSyncPayload(null, { now: NOW });
  payload.policy.rules[0] = { ...payload.policy.rules[0], action: 'allow' };
  const check = validateProvenanceSyncPayload(payload);
  assert.equal(check.valid, false);
  assert.ok(check.errors.some((e) => /does not match the policy its profile builds/.test(e)));
  assert.throws(() => parseProvenanceProfileFile(renderProvenanceProfileFileUnchecked(payload)), ProvenanceProfileSyncError);
});

function renderProvenanceProfileFileUnchecked(payload) {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

test('a partial profile does not sync — the receiver must get the whole intent', () => {
  const payload = createProvenanceSyncPayload(null, { now: NOW });
  delete payload.profile.replicationWeight;
  const check = validateProvenanceSyncPayload(payload);
  assert.equal(check.valid, false);
  assert.ok(check.errors.some((e) => /missing replicationWeight/.test(e)));
});

test('wrong kind, wrong version, and unreadable JSON are all refused by name', () => {
  const payload = createProvenanceSyncPayload(null, { now: NOW });
  assert.equal(validateProvenanceSyncPayload({ ...payload, kind: 'something-else' }).valid, false);
  assert.equal(validateProvenanceSyncPayload({ ...payload, version: 99 }).valid, false);
  assert.throws(() => parseProvenanceProfileFile('{not json'), /not readable JSON/);
});

/* ── The store: the apply path on a real filesystem ──────────────────────── */

test('no synced file means the NAMED default — defaults are never dressed as synced', async () => {
  const root = workspace();
  try {
    const loaded = await loadSyncedProvenanceProfile(root);
    assert.equal(loaded.source, 'default');
    assert.deepEqual(loaded.profile, { ...DEFAULT_WEIGHTING_PROFILE });
    assert.equal(loaded.updatedAt, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('save then load round-trips through the real .helmion path', async () => {
  const root = workspace();
  try {
    await saveSyncedProvenanceProfile(root, STRICTER, { now: NOW, source: 'pc-settings' });
    assert.equal(provenanceProfilePath(root), join(root, PROVENANCE_PROFILE_RELATIVE_PATH));
    const loaded = await loadSyncedProvenanceProfile(root);
    assert.equal(loaded.source, 'synced');
    assert.equal(loaded.profile.highContestationConsensusMax, 0.85);
    assert.equal(loaded.origin, 'pc-settings');
    assert.deepEqual(loaded.policy, buildProvenancePolicy(loaded.profile));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a corrupt synced file THROWS — the loader never silently falls back to defaults', async () => {
  const root = workspace();
  try {
    const path = provenanceProfilePath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"kind":"provenance-weighting-profile","version":1,"profile":{}}');
    await assert.rejects(() => loadSyncedProvenanceProfile(root), ProvenanceProfileSyncError);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/* ── The synced profile actually governs ─────────────────────────────────── */

const HASH = 'e'.repeat(64);
const borderlineClaim = () => ({
  claimId: 'sync-1',
  provenanceRecord: createProvenanceRecord({
    recordId: 's1', sourceUrl: 'https://example.org/paper', sourceHash: HASH,
    signatureStatus: 'verified', attributionStatus: 'verified',
  }),
  contestationVector: createContestationVector({
    provenanceScore: 0.9, independenceScore: 0.9, consensusRatio: 0.8, dissentRigor: 0.5,
  }),
});

test('a synced stricter profile changes the decision on BOTH the policy evaluator and the M1 hook', async () => {
  const root = workspace();
  try {
    // Before any sync: the borderline claim (consensus 0.8) is allowed.
    const before = await loadSyncedProvenanceProfile(root);
    assert.equal(evaluateProvenancePolicy(borderlineClaim(), before.policy).action, 'allow');

    await saveSyncedProvenanceProfile(root, STRICTER, { now: NOW });
    const after = await loadSyncedProvenanceProfile(root);

    // The policy surface, running the synced policy:
    const viaPolicy = evaluateProvenancePolicy(borderlineClaim(), after.policy);
    assert.equal(viaPolicy.action, 'annotate');
    assert.equal(viaPolicy.ruleId, 'high-contestation-annotate');

    // And the agent-loop hook path, running the synced profile:
    const viaHook = await runPreResponseVerification({
      text: 'The effect is 40 percent.',
      claims: [borderlineClaim()],
      profile: after.profile,
    });
    assert.equal(viaHook.action, 'annotate');
    assert.match(viaHook.text, /high contestation/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('applyProvenanceSyncPayload hands surfaces exactly the profile and policy they consume', () => {
  const applied = applyProvenanceSyncPayload(createProvenanceSyncPayload(STRICTER, { now: NOW, source: 'phone' }));
  assert.equal(applied.profile.highContestationDissentRigorMin, 0.4);
  assert.equal(applied.origin, 'phone');
  assert.equal(applied.policy.rules.find((r) => r.id === 'high-contestation-annotate').when.highContestation.consensusMax, 0.85);
});
