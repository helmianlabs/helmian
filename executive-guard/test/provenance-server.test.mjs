// Bite 2 of the live chain (Scribe 1154): the Executive Guard server loads
// the Milestone 3 provenance ruleset and evaluates claims over real HTTP.
// A malformed ruleset stops construction; the endpoints are device-auth
// only; every evaluation lands in the audit trail.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { startGuard, DEVICE_TOKEN } from '../test-support/helpers.mjs';
import { createExecutiveGuard } from '../src/server.mjs';
import { memoryAudit } from '../src/audit.mjs';
import { generateSigningKey, loadSigningKey } from '../src/signing.mjs';
import { buildProvenancePolicy } from '../../src/core/provenance-policy.mjs';

const HASH = createHash('sha256').update('page bytes').digest('hex');
const VERIFIED = {
  recordId: 'r', sourceUrl: 'https://a.example', sourceHash: HASH,
  retrievedAt: '2026-11-20T00:00:00.000Z', signatureStatus: 'verified',
  attributionStatus: 'verified', publisher: 'a.example', author: 'A', signer: 'a.example',
  conflicts: [], hasIndependentReplication: true,
};
const VECTOR = { provenanceScore: 0.9, independenceScore: 0.9, consensusRatio: 0.95, dissentRigor: 0.1 };

test('the loaded ruleset is served to an authenticated device and refused without one', async (t) => {
  const g = await startGuard();
  t.after(() => g.close());
  const ok = await g.call('GET', '/v1/provenance/policy', { token: DEVICE_TOKEN });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.policy.version, 1);
  assert.equal(ok.body.policy.defaultAction, 'annotate');
  assert.ok(ok.body.policy.rules.some((r) => r.id === 'failed-signature-block'));
  const anon = await g.call('GET', '/v1/provenance/policy', {});
  assert.equal(anon.status, 401);
});

test('a verified claim evaluates to allow with the verified badge, over HTTP', async (t) => {
  const g = await startGuard();
  t.after(() => g.close());
  const res = await g.call('POST', '/v1/provenance/evaluate', {
    token: DEVICE_TOKEN,
    body: { claim: { claimId: 'c1', provenanceRecord: VERIFIED, contestationVector: VECTOR } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.evaluation.action, 'allow');
  assert.equal(res.body.badge.id, 'verified-provenance');
  assert.equal(res.body.badge.tone, 'green');
});

test('an unsigned source evaluates to annotate with the unverified badge', async (t) => {
  const g = await startGuard();
  t.after(() => g.close());
  const res = await g.call('POST', '/v1/provenance/evaluate', {
    token: DEVICE_TOKEN,
    body: {
      claim: {
        claimId: 'c2',
        provenanceRecord: { ...VERIFIED, signatureStatus: 'absent', signer: '' },
        contestationVector: VECTOR,
      },
    },
  });
  assert.equal(res.body.evaluation.action, 'annotate');
  assert.equal(res.body.badge.id, 'unverified-provenance');
});

test('a failed signature is blocked by the server, and the evaluation is in the audit trail', async (t) => {
  const g = await startGuard();
  t.after(() => g.close());
  const res = await g.call('POST', '/v1/provenance/evaluate', {
    token: DEVICE_TOKEN,
    body: {
      claim: {
        claimId: 'c3',
        provenanceRecord: { ...VERIFIED, signatureStatus: 'failed' },
        contestationVector: VECTOR,
      },
    },
  });
  assert.equal(res.body.evaluation.action, 'block');
  assert.equal(res.body.evaluation.ruleId, 'failed-signature-block');
  const entries = g.audit.all().filter((e) => e.event === 'provenance.evaluated');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].claimId, 'c3');
  assert.equal(entries[0].action, 'block');
});

test('a claim without a claimId is a 400, and a malformed ruleset stops the server from starting', async (t) => {
  const g = await startGuard();
  t.after(() => g.close());
  const bad = await g.call('POST', '/v1/provenance/evaluate', { token: DEVICE_TOKEN, body: { claim: {} } });
  assert.equal(bad.status, 400);

  const broken = buildProvenancePolicy();
  broken.rules.push({ id: 'failed-signature-block', when: {}, action: 'allow', reason: 'duplicate id' });
  assert.throws(
    () => createExecutiveGuard({
      key: loadSigningKey(generateSigningKey()),
      audit: memoryAudit(),
      provenancePolicy: broken,
    }),
    /duplicate rule id/,
  );
});

test('a server built on a stricter profile enforces the stricter thresholds', async (t) => {
  const strict = buildProvenancePolicy({ highContestationConsensusMax: 0.99, highContestationDissentRigorMin: 0.05 });
  const g = await startGuard({ provenancePolicy: strict });
  t.after(() => g.close());
  const res = await g.call('POST', '/v1/provenance/evaluate', {
    token: DEVICE_TOKEN,
    body: { claim: { claimId: 'c4', provenanceRecord: VERIFIED, contestationVector: VECTOR } },
  });
  assert.equal(res.body.evaluation.action, 'annotate');
  assert.equal(res.body.evaluation.ruleId, 'high-contestation-annotate');
});
