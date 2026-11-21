import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeTenantAction } from '../src/cloud/tenant-action-authorization.mjs';

const actor = (role, tenantId = 'customer-a') => ({ role, tenantId, subject: `${role}-user` });

test('tenant RBAC/ABAC policy allows and denies the bounded project actions by role', () => {
  for (const role of ['owner', 'admin', 'member']) {
    assert.equal(authorizeTenantAction(actor(role), { action: 'workspace.project.read', tenantId: 'customer-a' }).allowed, true, `${role} can read project metadata`);
  }
  assert.equal(authorizeTenantAction(actor('owner'), { action: 'workspace.project.write', tenantId: 'customer-a' }).allowed, true);
  assert.equal(authorizeTenantAction(actor('admin'), { action: 'workspace.project.write', tenantId: 'customer-a' }).allowed, true);
  const memberDenied = authorizeTenantAction(actor('member'), { action: 'workspace.project.write', tenantId: 'customer-a' });
  assert.equal(memberDenied.allowed, false);
  assert.equal(memberDenied.decision, 'DENY');
  assert.match(memberDenied.reason, /not allowed/u);
  const crossTenantDenied = authorizeTenantAction(actor('admin'), { action: 'workspace.project.write', tenantId: 'other-tenant' });
  assert.equal(crossTenantDenied.allowed, false);
  assert.match(crossTenantDenied.reason, /tenant/u);
});
