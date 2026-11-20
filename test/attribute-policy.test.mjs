import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTRIBUTE_POLICY_VERSION,
  assertAttributePolicy,
  evaluateAttributePolicy,
  normalizeAttributeRules,
} from '../src/cloud/attribute-policy.mjs';

const context = {
  tenantId: 'tenant-a', subject: 'user-a', role: 'member', sessionId: 'session-a', requestId: 'request-a',
  attributes: { department: 'dispatch', region: 'west', clearance: 3 },
};

test('attribute policy allows a verified tenant actor when role and attributes match', () => {
  const result = evaluateAttributePolicy({
    action: 'envoy.send', context,
    rules: [{ id: 'dispatch-send', effect: 'ALLOW', actions: ['envoy.send'], conditions: { 'actor.role': 'member', 'actor.department': 'dispatch', 'resource.tenantId': 'tenant-a' } }],
    resource: { tenantId: 'tenant-a', channel: 'dispatch' },
  });
  assert.equal(result.decision, 'ALLOW');
  assert.deepEqual(result.matchedRuleIds, ['dispatch-send']);
  assert.equal(result.policyVersion, ATTRIBUTE_POLICY_VERSION);
});

test('deny rules override matching allows and expose only bounded audit attributes', () => {
  const result = evaluateAttributePolicy({
    action: 'cora.publish', context: { ...context, role: 'admin' },
    rules: [
      { id: 'admins-publish', effect: 'ALLOW', actions: ['cora.publish'], conditions: { 'actor.role': { in: ['owner', 'admin'] } } },
      { id: 'freeze-west', effect: 'DENY', actions: ['cora.publish'], conditions: { 'actor.region': 'west' }, reason: 'west region is frozen' },
    ],
  });
  assert.equal(result.decision, 'DENY');
  assert.equal(result.reason, 'west region is frozen');
  assert.deepEqual(result.evaluatedAttributes, { tenantId: 'tenant-a', actorSubject: 'user-a', actorRole: 'admin' });
});

test('missing match fails closed and supported operators evaluate attributes', () => {
  const result = evaluateAttributePolicy({
    action: 'audit.export', context,
    rules: [{ id: 'auditor-export', effect: 'ALLOW', actions: ['audit.export'], conditions: { 'actor.clearance': { gte: 3 }, 'actor.department': { contains: 'patch' }, 'request.format': { in: ['csv', 'json'] }, 'actor.mfa': { exists: true } } }],
    request: { format: 'csv' },
  });
  assert.equal(result.decision, 'DENY');
  assert.equal(result.reason, 'no matching allow rule');
  assert.deepEqual(result.matchedRuleIds, []);
});

test('cross-tenant resource is denied before policy rules can grant access', () => {
  const result = evaluateAttributePolicy({
    action: 'audit.read', context,
    resource: { tenantId: 'tenant-b' },
    rules: [{ id: 'wildcard-read', effect: 'ALLOW', actions: ['audit.read'], conditions: { 'actor.role': { in: ['owner', 'admin', 'member', 'auditor'] } } }],
  });
  assert.equal(result.decision, 'DENY');
  assert.match(result.reason, /resource tenant/);
  assert.deepEqual(result.matchedRuleIds, []);
});

test('copied attributes cannot override verified tenant or actor identity', () => {
  const result = evaluateAttributePolicy({
    action: 'audit.read',
    context: { ...context, attributes: { ...context.attributes, tenantId: 'tenant-b', subject: 'forged', role: 'owner' } },
    resource: { tenantId: 'tenant-a' },
    rules: [{ id: 'member-read', effect: 'ALLOW', actions: ['audit.read'], conditions: { 'actor.role': 'member', 'actor.subject': 'user-a', 'actor.tenantId': 'tenant-a' } }],
  });
  assert.equal(result.decision, 'ALLOW');
  assert.deepEqual(result.evaluatedAttributes, { tenantId: 'tenant-a', actorSubject: 'user-a', actorRole: 'member' });
});

test('normalization and assertion reject malformed rules and denied decisions', () => {
  assert.throws(() => normalizeAttributeRules([{ effect: 'ALLOW', actions: ['x'], conditions: { 'secret.path': true } }]), /attribute path/);
  assert.throws(() => assertAttributePolicy({ action: 'x', context, rules: [] }), (error) => error.code === 'ATTRIBUTE_POLICY_DENIED');
});
