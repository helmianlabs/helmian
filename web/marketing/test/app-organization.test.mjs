import assert from 'node:assert/strict';
import test from 'node:test';
import { organizationModel, viewFromHash, VIEW_TITLES_PLAIN } from '../app/app-model.mjs';

test('organization is a real view with a plain title', () => {
  assert.equal(viewFromHash('#organization'), 'organization');
  assert.equal(VIEW_TITLES_PLAIN.organization, 'Organization');
});

test('organizationModel shapes members and the role catalog for the panel', () => {
  const model = organizationModel({
    memberships: [
      { subject: 'user-1', serverRole: 'owner', jobTitle: 'owner', capabilities: ['read_audit'], active: true },
      { subject: 'box-worker', serverRole: 'device', jobTitle: null, capabilities: [], active: true },
      { subject: 'user-2', serverRole: 'member', jobTitle: 'dispatcher', capabilities: ['read_envoy', 'send_envoy'], active: false },
    ],
    roles: [
      { jobTitle: 'dispatcher', serverRole: 'member', capabilities: ['read_envoy', 'send_envoy'] },
      { jobTitle: '', serverRole: 'member', capabilities: [] },
    ],
  });
  assert.equal(model.members.length, 3);
  assert.deepEqual(model.members[0], { subject: 'user-1', serverRole: 'owner', jobTitle: 'owner', capabilities: ['read_audit'], active: true });
  assert.equal(model.members[1].jobTitle, 'job title not assigned');
  assert.equal(model.members[2].active, false);
  assert.deepEqual(model.roles, [{ jobTitle: 'dispatcher', serverRole: 'member', capabilities: ['read_envoy', 'send_envoy'] }]);
});

test('organizationModel tolerates an empty or missing body', () => {
  assert.deepEqual(organizationModel(), { members: [], roles: [] });
  assert.deepEqual(organizationModel({}), { members: [], roles: [] });
});
