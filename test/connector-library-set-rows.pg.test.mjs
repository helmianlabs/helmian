// Real-Postgres proof for the connector library SET read
// (2026-11-12, the tool-access 42P18 defect).
//
// The fake pools every other suite uses dispatch on SQL
// substrings and never emulate Postgres parameter typing, so the
// set read's unnamed $2 (readSetRows in connector-library.mjs:
// the seat is sent in the key's own position but deliberately
// not filtered on, and the statement never named it) passed
// every gate while production answered 42P18 — "could not
// determine data type of parameter $2" — on every Tool access
// expansion. This file runs the REAL store's getConnection and
// getCurrentSnapshot against a real database, where the server
// itself types the parameters: on the pre-fix query these reads
// raise 42P18; on the fixed query ($2 named by a
// `$2::text is not null` clause, the store's established
// discipline for a carried parameter) they answer.
//
// Shape follows test/tenant-action-policy.pg.test.mjs: the
// suite is gated on HELMION_ADMIN_CONFIG_TEST_DATABASE_URL and
// skips where no scratch database is configured, so it is not
// part of the root `npm test` list. Where it runs, migrations
// come from the neon store's own migrate(), and every seeded
// row lives under a random tenant that the cleanup deletes
// (children cascade from the tenant row).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { createNeonStore } from '../src/adapters/neon.mjs';
import { createConnectorLibraryStore } from '../src/cloud/connector-library.mjs';
import * as connectorLibrary from '../src/cloud/connector-library.mjs';

const connectionString = process.env.HELMION_ADMIN_CONFIG_TEST_DATABASE_URL;
const familyEntryIds = connectorLibrary.familyEntryIds;

test('the set read types its carried seat parameter on a real database (42P18 regression)', {
  skip: !connectionString && 'HELMION_ADMIN_CONFIG_TEST_DATABASE_URL is not configured',
}, async (t) => {
  const pool = new Pool({ connectionString, ssl: false, max: 4 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const tenant = `pg-set-rows-${suffix}`;
  const person = `user:pg-${suffix}`;
  t.after(async () => {
    try {
      await pool.query(`select set_config('helmion.tenant_id', $1, false)`, [tenant]);
      await pool.query('delete from helmion.tenants where tenant_id = $1', [tenant]);
    } catch { /* scratch cleanup is best-effort */ }
    await pool.end();
  });

  const neon = await createNeonStore(null, { pool });
  await neon.migrate();

  // Seed under the tenant's own RLS setting, the same value the
  // store sets per transaction.
  await pool.query(`select set_config('helmion.tenant_id', $1, false)`, [tenant]);
  await pool.query(
    `insert into helmion.tenants(tenant_id, display_name) values ($1, 'Set Rows PG Test')`,
    [tenant],
  );
  const seedEntry = async (seatId, id) => {
    await pool.query(
      `insert into helmion.connector_entries
         (tenant_id, seat_id, id, kind, name, one_liner, vendor_name, trust_label,
          broker_mode, mcp_endpoint_url, auth_mode, added_by)
       values ($1, $2, $3, 'catalog', 'Set Rows Fixture', 'fixture entry', 'Fixture',
               'verified', 'helmian', 'https://example.invalid/mcp', 'oauth', $4)`,
      [tenant, seatId, id, person],
    );
  };
  // The entry is stocked on both seats: the connection's foreign
  // key names the entry's physical row on the connection's seat.
  await seedEntry('claude', 'helmian-notion');
  await seedEntry('gemini', 'helmian-notion');
  const conn = await pool.query(
    `insert into helmion.connector_connections
       (tenant_id, person_id, seat_id, entry_id, account_identity, posture)
     values ($1, $2, 'gemini', 'helmian-notion', 'pg-fixture@example', 'read')
     returning id`,
    [tenant, person],
  );
  const connectionId = conn.rows[0].id;
  const snap = await pool.query(
    `insert into helmion.connector_snapshots (tenant_id, connection_id, tools, snapshot_hash)
     values ($1, $2, $3::jsonb, 'pg-hash-1') returning id`,
    [tenant, connectionId, JSON.stringify([{ name: 'list_things', description: 'Lists things', annotation: 'read' }])],
  );
  await pool.query(
    `update helmion.connector_connections set tool_snapshot_ref = $2 where id = $1`,
    [connectionId, snap.rows[0].id],
  );

  const store = createConnectorLibraryStore(pool);

  // The two reads the Tool access road runs. On the pre-fix set
  // read both raise 42P18 here; the fake pools cannot see it.
  const connection = await store.getConnection(tenant, { personId: person, seatId: 'claude', entryId: 'helmian-notion' });
  assert.ok(connection, 'the set connection resolves on a real database');
  assert.equal(connection.seatId, 'gemini', 'the winner is the physical row on gemini, read from claude');
  assert.equal(connection.state, 'connected');

  const snapshot = await store.getCurrentSnapshot(tenant, { personId: person, seatId: 'claude', entryId: 'helmian-notion' });
  assert.ok(snapshot, 'the current snapshot resolves on a real database');
  assert.equal(snapshot.snapshotHash, 'pg-hash-1');
  assert.deepEqual(snapshot.tools.map((tool) => tool.name), ['list_things']);

  // The family shape, where the build carries connection
  // families: the any($3::text[]) branch carries the same $2.
  if (typeof familyEntryIds === 'function' && familyEntryIds('helmian-outlook')) {
    await seedEntry('claude', 'helmian-outlook');
    await seedEntry('gemini', 'helmian-onedrive');
    await pool.query(
      `insert into helmion.connector_connections
         (tenant_id, person_id, seat_id, entry_id, account_identity, posture)
       values ($1, $2, 'gemini', 'helmian-onedrive', 'pg-fixture@example', 'read')`,
      [tenant, person],
    );
    const familyConnection = await store.getConnection(tenant, { personId: person, seatId: 'claude', entryId: 'helmian-outlook' });
    assert.ok(familyConnection, 'the family connection resolves on a real database');
    assert.equal(familyConnection.entryId, 'helmian-onedrive');
  }
});
