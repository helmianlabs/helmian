import assert from 'node:assert/strict';
import test from 'node:test';
import { parseExplicitMigrationVersions, runExplicitMigrationCommand } from '../src/adapters/explicit-migration-cli.mjs';

test('explicit migration CLI parses only an exact comma-separated ordered version list', () => {
  assert.deepEqual(parseExplicitMigrationVersions('035,037'), ['035', '037']);
  for (const input of ['', ' 035,037', '035,037 ', '035, 037', '035,,037', '035,035', '035,latest']) {
    assert.throws(() => parseExplicitMigrationVersions(input), /--versions|duplicate/u);
  }
});

test('explicit migration CLI calls only scoped migration and prints target plus durable receipts', async () => {
  const calls = [];
  const output = [];
  const store = {
    async migrateExplicitlyAllowedSet(versions) {
      calls.push({ operation: 'scoped', versions });
      return {
        target: { endpointId: 'ep-test' }, requestedVersions: versions,
        receipts: [{ version: '035', name: '035_cora_app_build_requests.sql', checksum: 'a'.repeat(64) }, { version: '037', name: '037_cora_app_build_revisions.sql', checksum: 'b'.repeat(64) }],
        results: [{ migration: '035_cora_app_build_requests.sql', applied: true, durability: 'committed' }, { migration: '037_cora_app_build_revisions.sql', applied: true, durability: 'committed' }],
      };
    },
    async migrate() { calls.push({ operation: 'generic' }); throw new Error('must not run'); },
    async close() { calls.push({ operation: 'close' }); },
  };
  await runExplicitMigrationCommand({ rawVersions: '035,037', createStore: async () => { calls.push({ operation: 'open' }); return store; }, write: (value) => output.push(value) });
  assert.deepEqual(calls, [{ operation: 'open' }, { operation: 'scoped', versions: ['035', '037'] }, { operation: 'close' }]);
  const body = JSON.parse(output.join(''));
  assert.deepEqual(body.target, { endpointId: 'ep-test' });
  assert.deepEqual(body.requestedVersions, ['035', '037']);
  assert.equal(body.receipts.length, 2);
  assert.equal(body.durability[0].durability, 'committed');
});

test('invalid or absent explicit versions do not create or write a store', async () => {
  let opened = 0;
  for (const rawVersions of ['', '035, 037', '035,035']) {
    await assert.rejects(
      runExplicitMigrationCommand({ rawVersions, createStore: async () => { opened += 1; throw new Error('must not open'); }, write: () => {} }),
      /--versions|duplicate/u,
    );
  }
  assert.equal(opened, 0);
});
