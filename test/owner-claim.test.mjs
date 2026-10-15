import assert from 'node:assert/strict';
import test from 'node:test';
import { claimFirstOwner } from '../src/cloud/owner-claim.mjs';

const env = { HELMION_ADMIN_OWNER_EMAIL: 'Troy@Example.com', HELMION_ADMIN_BOOTSTRAP_TENANT: 'dairyforge' };
function pool(owners) { return { connect: async () => ({ query: async () => ({ rows: [{ n: owners }] }), release() {} }) }; }
const session = { subject: 'user_1', email: 'troy@example.com', emailVerified: true };

test('verified owner email claims an empty tenant once', async () => {
  const calls = [];
  const bootstrap = async (input) => { calls.push(input); return { created: true }; };
  assert.deepEqual(await claimFirstOwner({ pool: pool(0), env, session, bootstrap }), { claimed: true, tenantId: 'dairyforge' });
  assert.equal(calls[0].subject, 'user_1');
  assert.equal(calls[0].confirmed, true);
  assert.equal((await claimFirstOwner({ pool: pool(1), env, session, bootstrap })).reason, 'owner_exists');
  assert.equal(calls.length, 1);
});

test('unverified, other emails, or unset config never claim', async () => {
  const bootstrap = async () => { throw new Error('must not run'); };
  assert.equal((await claimFirstOwner({ pool: pool(0), env, session: { ...session, emailVerified: false }, bootstrap })).reason, 'not_owner_email');
  assert.equal((await claimFirstOwner({ pool: pool(0), env, session: { ...session, email: 'x@example.com' }, bootstrap })).reason, 'not_owner_email');
  assert.equal((await claimFirstOwner({ pool: pool(0), env: {}, session, bootstrap })).reason, 'not_configured');
  assert.equal((await claimFirstOwner({ pool: pool(0), env, session: null, bootstrap })).reason, 'not_configured');
});
