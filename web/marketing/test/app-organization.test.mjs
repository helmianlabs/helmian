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

import { readFileSync } from 'node:fs';
const indexHtml = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
const appJs = readFileSync(new URL('../app/app.js', import.meta.url), 'utf8');

test('the Organization view carries the attribute rules table and create form', () => {
  for (const id of ['org-rules', 'rule-id', 'rule-effect', 'rule-actions', 'rule-cond-path', 'rule-cond-op', 'rule-cond-value', 'rule-reason', 'rule-create-btn', 'rule-status']) {
    assert.ok(indexHtml.includes(`id="${id}"`), `missing #${id}`);
  }
});

test('the app loads, creates and removes attribute rules through the panel routes', () => {
  assert.match(appJs, /api\('\/api\/admin\/organization\/attribute-rules'\)/);
  assert.match(appJs, /post\('\/api\/admin\/organization\/attribute-rules', \{ ruleId, effect, actions, conditions, reason \}\)/);
  assert.match(appJs, /post\('\/api\/admin\/organization\/attribute-rules\/delete', \{ ruleId, reason \}\)/);
  assert.match(appJs, /attributeRulesModel/);
});

test('the role catalog renders as stacked cards, not side-by-side rows', () => {
  assert.match(appJs, /el\('div', 'cap muted sm', r\.capabilities\.join\(', '\)\)/);
});

test('the Evidence view surfaces an attribute-policy refusal instead of stale rows', () => {
  assert.match(appJs, /state\.eventsDenied === 'AUDIT_ATTRIBUTE_POLICY_DENIED'/);
  assert.match(appJs, /Audit read refused: an attribute rule for this workspace denies audit\.read for your role/);
});
