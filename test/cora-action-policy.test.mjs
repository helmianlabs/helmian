import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCoraActionPolicy } from '../src/cora/action-policy.mjs';

const normal = { role_verified: true, in_scope: true };

test('normal navigation, reads, drafts, and preparation are allowed in scope', () => {
  for (const action of ['navigate', 'read', 'draft', 'prepare']) {
    const result = evaluateCoraActionPolicy({ ...normal, action });
    assert.equal(result.decision, 'allow', action);
    assert.equal(result.approval_required, false);
  }
});

test('high-risk actions require confirmation and approval step-up', () => {
  const result = evaluateCoraActionPolicy({ ...normal, action: 'write', money: true, external_write: true });
  assert.equal(result.decision, 'step-up');
  assert.equal(result.approval_required, true);
  assert.equal(result.confirmation_required, true);
  assert.deepEqual(result.reasons, ['external_write', 'money']);
});

test('missing role or scope and unknown classes deny', () => {
  assert.equal(evaluateCoraActionPolicy({ action: 'read', in_scope: true }).decision, 'deny');
  assert.equal(evaluateCoraActionPolicy({ ...normal, action: 'arbitrary' }).decision, 'deny');
});
