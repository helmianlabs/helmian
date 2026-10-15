import assert from 'node:assert/strict';
import test from 'node:test';
import { restorePath } from '../api/helmian-admin.js';

test('restores the original admin path and query from the rewrite', () => {
  assert.equal(restorePath('/api/helmian-admin?__p=/admin'), '/admin/');
  assert.equal(restorePath('/api/helmian-admin?__p=/admin/auth/callback&code=c&state=s'), '/admin/auth/callback?code=c&state=s');
  assert.equal(restorePath('/api/helmian-admin?__p=/api/admin/session'), '/api/admin/session');
  assert.equal(restorePath('/api/helmian-admin'), null);
  assert.equal(restorePath('/api/helmian-admin?__p=/api/herald-control'), null);
});
