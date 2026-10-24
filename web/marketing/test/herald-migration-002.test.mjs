import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { HERALD_ACCOUNT_CONTROL_SQL } from '../../../src/cloud/herald-account-control-sql.mjs';
import {
  HERALD_MIGRATION_002_PATH,
  HERALD_MIGRATION_002_TABLES,
  handleHeraldMigration002Route,
  runHeraldMigration002,
} from '../../../src/cloud/herald-migration-002.mjs';

const url = () => new URL(HERALD_MIGRATION_002_PATH, 'https://helmian.cloud');

function routeCall({ actor, activeTenantActor, runMigration } = {}) {
  const calls = [];
  const send = (response, status, body) => calls.push({ status, body: JSON.parse(body) });
  return {
    calls,
    invoke: () => handleHeraldMigration002Route({
      request: { method: 'POST', headers: {} },
      response: {},
      requestUrl: url(),
      activeTenantActor: activeTenantActor ?? (async () => actor),
      send,
      runMigration,
    }),
  };
}

test('Herald migration 002 gate refuses non-owner actors before running', async () => {
  let runs = 0;
  const runMigration = async () => { runs += 1; };

  const nonOwner = routeCall({
    actor: { subject: 'user_admin', tenantId: 'tenant_1', role: 'admin' },
    runMigration,
  });
  assert.equal(await nonOwner.invoke(), true);
  assert.equal(nonOwner.calls[0].status, 403);
  assert.equal(nonOwner.calls[0].body.code, 'HERALD_MIGRATION_002_OWNER_REQUIRED');
  assert.equal(runs, 0);

  const unauthenticated = routeCall({
    activeTenantActor: async () => { throw Object.assign(new Error('Identity required'), { status: 403 }); },
    runMigration,
  });
  assert.equal(await unauthenticated.invoke(), true);
  assert.equal(unauthenticated.calls[0].status, 403);
  assert.equal(unauthenticated.calls[0].body.code, 'HERALD_MIGRATION_002_FORBIDDEN');
  assert.equal(runs, 0);
});

test('migration route is wired through the existing live-admin delegate hook', async () => {
  const delegate = await readFile(new URL('../../../src/cloud/envoy-ably.mjs', import.meta.url), 'utf8');
  assert.match(delegate, /import \{ handleHeraldMigration002Route \} from '\.\/herald-migration-002\.mjs';/);
  assert.match(delegate, /handleHeraldMigration002Route\(\{ request, response, requestUrl, activeTenantActor, send, TenantAuthorizationError \}\)/);
});

test('embedded Herald account-control SQL is byte-identical to the repo SQL file', async () => {
  const sqlBytes = await readFile(new URL('../../../sql/herald-account-control.sql', import.meta.url));
  assert.deepEqual(Buffer.from(HERALD_ACCOUNT_CONTROL_SQL, 'utf8'), sqlBytes);
});

test('migration verify list matches the standalone migration script exactly', async () => {
  const script = await readFile(new URL('../scripts/apply-herald-account-migration.mjs', import.meta.url), 'utf8');
  const expectedBlock = script.match(/const expected = \[([\s\S]*?)\];/)?.[1] ?? '';
  const expected = [...expectedBlock.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.equal(expected.length, 8);
  assert.deepEqual(HERALD_MIGRATION_002_TABLES, expected);
  assert.match(script, /hashtext\('helmian-herald-account-control-v1'\)/);
});

function fakeClient({ existingBefore = [], failMigration = false } = {}) {
  const calls = [];
  let verifyCount = 0;
  return {
    calls,
    async connect() { calls.push('connect'); },
    async query(sql, params) {
      calls.push({ sql, params });
      if (String(sql).includes('select relname from pg_class')) {
        verifyCount += 1;
        const names = verifyCount === 1 ? existingBefore : [...HERALD_MIGRATION_002_TABLES].sort();
        return { rows: names.map((relname) => ({ relname })) };
      }
      if (sql === HERALD_ACCOUNT_CONTROL_SQL && failMigration) throw new Error('migration failed');
      return { rows: [] };
    },
    async end() { calls.push('end'); },
  };
}

test('runner mirrors the script transaction and reports a double run honestly', async () => {
  const env = { HELMION_HERALD_DATABASE_URL: 'postgres://example.invalid/herald' };

  const firstClient = fakeClient();
  let seenConnectionString = null;
  const first = await runHeraldMigration002({
    env,
    createClient: async (connectionString) => { seenConnectionString = connectionString; return firstClient; },
  });
  assert.equal(seenConnectionString, env.HELMION_HERALD_DATABASE_URL);
  assert.equal(first.alreadyApplied, false);
  assert.equal(first.state, 'applied');
  assert.deepEqual(new Set(first.verifiedTables), new Set(HERALD_MIGRATION_002_TABLES));
  assert.ok(firstClient.calls.some(({ sql }) => sql === HERALD_ACCOUNT_CONTROL_SQL));
  assert.ok(firstClient.calls.some(({ sql }) => String(sql).includes("hashtext('helmian-herald-account-control-v1')")));
  assert.ok(firstClient.calls.some(({ sql }) => sql === 'commit'));
  assert.equal(firstClient.calls.some(({ sql }) => sql === 'rollback'), false);

  const secondClient = fakeClient({ existingBefore: [...HERALD_MIGRATION_002_TABLES] });
  const second = await runHeraldMigration002({ env, createClient: async () => secondClient });
  assert.equal(second.alreadyApplied, true);
  assert.equal(second.state, 'already_applied');
  assert.deepEqual(new Set(second.verifiedTables), new Set(HERALD_MIGRATION_002_TABLES));
});

test('runner rolls back when the migration fails', async () => {
  const client = fakeClient({ failMigration: true });
  await assert.rejects(
    () => runHeraldMigration002({
      env: { HELMION_HERALD_DATABASE_URL: 'postgres://example.invalid/herald' },
      createClient: async () => client,
    }),
    /migration failed/,
  );
  assert.ok(client.calls.some(({ sql }) => sql === 'rollback'));
  assert.equal(client.calls.some(({ sql }) => sql === 'commit'), false);
});

test('owner route returns the verified table list on success', async () => {
  const call = routeCall({
    actor: { subject: 'user_owner', tenantId: 'tenant_1', role: 'owner' },
    runMigration: async () => ({
      alreadyApplied: true,
      state: 'already_applied',
      verifiedTables: [...HERALD_MIGRATION_002_TABLES].sort(),
    }),
  });
  assert.equal(await call.invoke(), true);
  assert.equal(call.calls[0].status, 200);
  assert.equal(call.calls[0].body.ok, true);
  assert.deepEqual(new Set(call.calls[0].body.verifiedTables), new Set(HERALD_MIGRATION_002_TABLES));
  assert.equal(call.calls[0].body.alreadyApplied, true);
});
