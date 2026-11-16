import pg from 'pg';
import { createConnectorLibraryStore } from './connector-library.mjs';
import { createSeatLibraryRead } from './connector-library-read.mjs';
import { catalogStarterActions, catalogEntriesForSeat } from './connector-catalog.mjs';

const pool = new pg.Pool({ connectionString: process.env.HELMION_DATABASE_URL });
const TENANTS = [
  ['Helmian', '0d7ca4d3-a2f4-458a-936b-d8a002a569e0'],
  ['Troy83352', 'a765502b-f25e-477a-991b-f69baf23ac02'],
];
try {
  const store = createConnectorLibraryStore(pool);
  const read = createSeatLibraryRead({ libraryStore: store });
  console.log('CATALOG claude ids=', JSON.stringify(catalogEntriesForSeat('claude').map((e) => e.id)));
  console.log('CATALOG idiolect starters=', JSON.stringify(catalogStarterActions('claude', 'idiolect')));
  for (const [name, tenantId] of TENANTS) {
    const entries = await store.listEntries(tenantId, 'claude');
    console.log(name, 'STORE entries=', entries.length, 'ids=', JSON.stringify(entries.map((e) => e.id)));
    const idio = entries.find((e) => e.id === 'idiolect');
    console.log(name, 'STORE idiolect entry=', JSON.stringify(idio ?? null));
    const persons = await pool.query('select distinct person_id from helmion.connector_connections where tenant_id=$1', [tenantId]);
    console.log(name, 'connection person_ids=', JSON.stringify(persons.rows.map((r) => r.person_id)));
    const result = await read.readSeatLibrary(tenantId, { personId: 'probe:walk2-diagnosis', seatId: 'claude' });
    console.log(name, 'READ rows=', result.rows.length, 'ids=', JSON.stringify(result.rows.map((r) => r.entryId)));
    const row = result.rows.find((r) => r.entryId === 'idiolect');
    console.log(name, 'READ idiolect row=', JSON.stringify(row ?? null));
    console.log(name, 'READ seed=', JSON.stringify(result.seed));
    if (row) {
      const expected = catalogStarterActions('claude', 'idiolect');
      console.log(name, 'starters deep-equal catalog=', JSON.stringify(row.starterActions) === JSON.stringify(expected));
    }
  }
} finally { await pool.end(); }
