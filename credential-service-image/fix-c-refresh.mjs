// FIX BITE C — Part 1 (ops): run the existing catalog refresh once per
// live tenant, with a before/after read-back of the connector library
// store (seat 'claude' entry count + whether an 'idiolect' entry
// exists), for both live tenants. Runs inside the
// helmian-credential-service container with HELMION_DATABASE_URL from
// the container env (never printed). The catalog + store modules are
// byte copies of current main (19ccf140) from the mirror-m2 tree.
import pg from 'pg';
import { createConnectorLibraryStore } from './fix-c-library.mjs';
import { createCatalogRefresh } from './fix-c-catalog.mjs';

const pool = new pg.Pool({ connectionString: process.env.HELMION_DATABASE_URL });
const TENANTS = [
  ['Helmian', '0d7ca4d3-a2f4-458a-936b-d8a002a569e0'],
  ['Troy83352', 'a765502b-f25e-477a-991b-f69baf23ac02'],
];

async function snapshot(label) {
  for (const [name, tenantId] of TENANTS) {
    const total = await pool.query(
      'select count(*)::int as n from helmion.connector_entries where tenant_id=$1', [tenantId]);
    const claude = await pool.query(
      "select count(*)::int as n from helmion.connector_entries where tenant_id=$1 and seat_id='claude'", [tenantId]);
    const idio = await pool.query(
      "select id, kind, name, broker_mode, auth_mode from helmion.connector_entries where tenant_id=$1 and seat_id='claude' and id='idiolect'", [tenantId]);
    const perSeat = await pool.query(
      'select seat_id, count(*)::int as n from helmion.connector_entries where tenant_id=$1 group by seat_id order by seat_id', [tenantId]);
    console.log(label, name, 'total=', total.rows[0].n, 'claude=', claude.rows[0].n,
      'idiolect=', JSON.stringify(idio.rows));
    console.log(label, name, 'per-seat=', JSON.stringify(perSeat.rows));
  }
}

try {
  await snapshot('BEFORE');
  const store = createConnectorLibraryStore(pool);
  const refresh = createCatalogRefresh({
    libraryStore: store,
    subject: 'system:catalog-refresh-fix-c-2026-11-09',
  });
  for (const [name, tenantId] of TENANTS) {
    const summary = await refresh.refreshAll(tenantId);
    const applied = summary.seats.reduce((n, s) => n + s.applied.length, 0);
    const conflicts = summary.seats.flatMap((s) => s.conflicts);
    console.log('REFRESH', name, 'applied=', applied, 'conflicts=', JSON.stringify(conflicts));
  }
  await snapshot('AFTER');
} finally {
  await pool.end();
}
