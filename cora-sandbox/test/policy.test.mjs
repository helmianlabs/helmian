import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../policy.mjs';

const T1 = 'tenant-1';
const sub = (role, surface = 'web', tenantId = T1) => ({ tenantId, role, surface, userId: 'u1' });
const res = (tenantId = T1, hash = 'h1') => ({ tenantId, hash });
const approved = (hash = 'h1') => ({ approval: { state: 'approved', hash } });

const CASES = [
  ['viewer reads a page', sub('viewer'), 'page.read', res(), {}, 'allow'],
  ['viewer cannot build', sub('viewer'), 'page.build', res(), {}, 'deny'],
  ['operator builds', sub('operator'), 'page.build', res(), {}, 'allow'],
  ['operator cannot propose a change', sub('operator'), 'change.propose', res(), {}, 'deny'],
  ['dispatcher proposes a change', sub('dispatcher'), 'change.propose', res(), {}, 'allow'],
  ['dispatcher cannot apply', sub('dispatcher'), 'change.apply', res(), approved(), 'deny'],
  ['supervisor proposes a change', sub('supervisor'), 'change.propose', res(), {}, 'allow'],
  ['admin applies an approved matching change', sub('admin'), 'change.apply', res(), approved(), 'allow'],
  ['admin apply without approval is denied', sub('admin'), 'change.apply', res(), {}, 'deny'],
  ['admin apply with pending approval is denied', sub('admin'), 'change.apply', res(), { approval: { state: 'pending', hash: 'h1' } }, 'deny'],
  ['admin apply with hash mismatch is denied', sub('admin'), 'change.apply', res(), approved('other'), 'deny'],
  ['owner manages connectors', sub('owner'), 'connector.manage', res(), {}, 'allow'],
  ['admin manages connectors', sub('admin'), 'connector.manage', res(), {}, 'allow'],
  ['dispatcher cannot manage connectors', sub('dispatcher'), 'connector.manage', res(), {}, 'deny'],
  ['admin cannot read another tenant', sub('admin'), 'page.read', res('tenant-2'), {}, 'deny'],
  ['owner cannot build in another tenant', sub('owner'), 'page.build', res('tenant-2'), {}, 'deny'],
  ['driver surface reads a page', sub('viewer', 'driver'), 'page.read', res(), {}, 'allow'],
  ['driver surface cannot build', sub('operator', 'driver'), 'page.build', res(), {}, 'deny'],
  ['driver surface cannot apply even when approved', sub('admin', 'driver'), 'change.apply', res(), approved(), 'deny'],
  ['agent surface builds a page', sub('operator', 'agent'), 'page.build', res(), {}, 'allow'],
  ['agent surface cannot apply even when approved', sub('admin', 'agent'), 'change.apply', res(), approved(), 'deny'],
  ['guard approves a change', sub('guard', 'guard'), 'change.approve', res(), {}, 'allow'],
  ['web admin cannot approve (guard only)', sub('admin'), 'change.approve', res(), {}, 'deny'],
  ['guard surface cannot read pages', sub('guard', 'guard'), 'page.read', res(), {}, 'deny'],
  ['superadmin applies an approved change', sub('superadmin'), 'change.apply', res(), approved(), 'allow'],
  ['unknown action is denied', sub('owner'), 'page.delete', res(), {}, 'deny'],
  ['missing subject tenant is denied', { role: 'owner', surface: 'web' }, 'page.read', res(), {}, 'deny'],
  ['unknown role is denied', sub('intern'), 'page.read', res(), {}, 'deny'],
  ['unknown surface is denied', sub('owner', 'kiosk'), 'page.read', res(), {}, 'deny'],
];

for (const [name, subject, action, resource, env, expected] of CASES) {
  test(`policy: ${name} -> ${expected}`, () => {
    const decision = evaluate(subject, action, resource, env);
    assert.equal(decision.decision, expected, `rule=${decision.rule} reason=${decision.reason}`);
  });
}

test('policy: has at least 20 table cases', () => {
  assert.ok(CASES.length >= 20, `only ${CASES.length} cases`);
});
