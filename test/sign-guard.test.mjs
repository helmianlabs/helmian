import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, run, PLACEHOLDER_GECKO_ID } from '../tools/sign-guard.mjs';

test('firefox: blocked without AMO keys and while the gecko id is the placeholder', async () => {
  const p = await plan('firefox', {});
  assert.deepEqual(p.missing, ['AMO_JWT_ISSUER', 'AMO_JWT_SECRET']);
  assert.ok(p.blockers.some((b) => b.includes(PLACEHOLDER_GECKO_ID)));
  assert.ok(p.command.includes('unlisted'), 'never the listed channel');
  assert.equal(p.ready, false);
});

test('dry run by default, and --execute refuses without Troy sign-off', async () => {
  const env = { AMO_JWT_ISSUER: 'user:1', AMO_JWT_SECRET: 'fake-secret-value' };
  assert.equal((await run('firefox', { env })).executed, false);
  const r = await run('firefox', { env, execute: true });
  assert.equal(r.executed, false);
  assert.match(r.note, /GUARD_SIGNING_APPROVED/);
  assert.doesNotMatch(JSON.stringify(r), /fake-secret-value/);
  const r2 = await run('firefox', { env: { ...env, GUARD_SIGNING_APPROVED: 'yes' }, execute: true });
  assert.equal(r2.executed, false, 'placeholder id still blocks');
});

test('chrome and edge plans list their needs; edge never auto-submits', async () => {
  assert.deepEqual((await plan('chrome', {})).missing, ['CHROME_CRX_KEY_PATH', 'CHROME_BIN']);
  const e = await plan('edge', { EDGE_PRODUCT_ID: 'x', EDGE_CLIENT_ID: 'y', EDGE_API_KEY: 'z' });
  assert.equal(e.ready, false);
  await assert.rejects(plan('safari', {}));
});
