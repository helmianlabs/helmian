// Parameter-discipline proof for the connector library store
// (2026-11-12, the tool-access 42P18 defect).
//
// The production failure: GET /api/admin/connector-library/
// tool-access answered 503 for every expansion, and the function
// log (once the read route learned to log its failures) named it:
// "could not determine data type of parameter $2 [pg code 42P18]".
// The set read behind getConnection / getCurrentSnapshot
// (readSetRows in connector-library.mjs) sends the seat in the
// key's own position ($2) for shape consistency but deliberately
// does not filter on it — and its SQL never NAMED $2 at all.
// node-pg sends every parameter untyped and Postgres infers each
// one's type from where the statement uses it; a parameter inside
// the referenced range that the statement never names has no type
// to infer, so the read dies at parse time. The sibling reads
// that carry a parameter without filtering on it
// (readCustomEntryRows, readConnectionRowsForPerson) keep a
// `$n::text is not null` clause for exactly this reason; the set
// read was missing it.
//
// Every other suite drives the store over a fake pool that
// dispatches on SQL substrings and destructures the values
// positionally — parameter typing is never emulated, which is
// how this survived. This file drives the REAL store over a
// strict fake that enforces the one Postgres rule that matters
// here: every parameter position inside the statement's
// referenced range must be named by the statement, or the query
// fails with a 42P18-shaped error, exactly as the server does.
// The first test pins the harness itself against the pre-fix
// query text, so the fake can never silently go soft again.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createConnectorLibraryStore } from '../src/cloud/connector-library.mjs';
import * as connectorLibrary from '../src/cloud/connector-library.mjs';

// A namespace read, not a named import: the family read exists
// only on builds that carry connection families, and the family
// test below skips itself where the export is absent.
const familyEntryIds = connectorLibrary.familyEntryIds;

const TENANT = 'tenant-a';
const PERSON = 'user:troy';

// The set read exactly as it shipped before the fix (both the
// plain shape production runs and, with any($3::text[]), the
// family shape): $2 is sent and never named.
const PREFIX_PLAIN_SQL = `select * from helmion.connector_connections
        where tenant_id = current_setting('helmion.tenant_id', true) and person_id = $1 and entry_id = $3
        order by updated_at desc, id desc`;

function untypedParamError(n) {
  return Object.assign(new Error(`could not determine data type of parameter $${n}`), { code: '42P18' });
}

function strictPool({ entries = [], connections = [], snapshots = [] } = {}) {
  let tenant = null;
  const bySetOrder = (a, b) => (new Date(b.updated_at) - new Date(a.updated_at)) || (b.id - a.id);
  const client = {
    async query(text, vals = []) {
      // Postgres parameter discipline, enforced before dispatch:
      // the statement's highest referenced position bounds the
      // parameter list, and every position inside that range must
      // be named somewhere in the statement — a position that is
      // only ever SENT has no inferable type (42P18). (None of
      // this store's SQL carries a $n inside a string literal.)
      const referenced = new Set([...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
      const maxRef = referenced.size ? Math.max(...referenced) : 0;
      for (let i = 1; i <= maxRef; i += 1) {
        if (!referenced.has(i)) throw untypedParamError(i);
      }
      if (vals.length < maxRef) {
        throw new Error(`bind message supplies ${vals.length} parameters, but the statement requires ${maxRef}`);
      }

      if (text.includes("set_config('helmion.tenant_id'")) { tenant = vals[0]; return { rows: [], rowCount: 0 }; }
      if (['begin', 'commit', 'rollback'].includes(text.trim())) return { rows: [], rowCount: 0 };

      if (text.includes('from helmion.connector_entries')) {
        const row = entries.find((r) => r.tenant_id === tenant && r.seat_id === vals[0] && r.id === vals[1]);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }
      if (text.includes('from helmion.connector_connections')) {
        let out;
        if (text.includes('entry_id = any($3::text[])')) {
          out = connections.filter((r) => r.tenant_id === tenant && r.person_id === vals[0] && vals[2].includes(r.entry_id));
        } else if (text.includes('entry_id = $3')) {
          out = connections.filter((r) => r.tenant_id === tenant && r.person_id === vals[0] && r.entry_id === vals[2]);
        } else {
          throw new Error(`strict fake: unhandled connections select: ${text}`);
        }
        out = out.sort(bySetOrder);
        return { rows: out.map((r) => ({ ...r })), rowCount: out.length };
      }
      if (text.includes('from helmion.connector_snapshots') && text.includes('where id = $1')) {
        const row = snapshots.find((r) => r.id === vals[0]);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }
      throw new Error(`strict fake: unhandled query: ${text}`);
    },
    release() {},
  };
  return {
    async connect() { return client; },
  };
}

const T0 = new Date('2026-11-12T00:00:00Z');
function entryRow(seatId, id) {
  return {
    tenant_id: TENANT, seat_id: seatId, id, kind: 'catalog', broker_mode: 'helmian',
    state: 'available', added_by: PERSON, created_at: T0, updated_at: T0,
  };
}
function connectionRow(overrides = {}) {
  return {
    id: 7, tenant_id: TENANT, person_id: PERSON, seat_id: 'gemini', entry_id: 'helmian-notion',
    account_identity: 'troy@example', access_token_ref: null, refresh_token_ref: null,
    granted_scopes: [], posture: 'read', tool_enable_map: { list_things: true },
    tool_snapshot_ref: 42, state: 'connected',
    last_discovery_at: null, last_used_at: null, created_at: T0, updated_at: T0,
    ...overrides,
  };
}
const SNAPSHOT_ROW = {
  id: 42, tenant_id: TENANT, connection_id: 7, taken_at: T0,
  tools: [{ name: 'list_things', description: 'Lists things', annotation: 'read' }],
  snapshot_hash: 'hash-42',
};

test('the strict pool enforces Postgres parameter discipline (harness fidelity)', async () => {
  const pool = strictPool();
  const client = await pool.connect();
  await assert.rejects(
    () => client.query(PREFIX_PLAIN_SQL, [PERSON, 'claude', 'helmian-notion']),
    (error) => error.code === '42P18' && error.message === 'could not determine data type of parameter $2',
  );
});

test('getConnection resolves the set row across seats under a parameter-strict pool', async () => {
  const store = createConnectorLibraryStore(strictPool({
    entries: [entryRow('claude', 'helmian-notion')],
    connections: [connectionRow()],
    snapshots: [SNAPSHOT_ROW],
  }));
  const connection = await store.getConnection(TENANT, { personId: PERSON, seatId: 'claude', entryId: 'helmian-notion' });
  assert.ok(connection, 'the set connection resolves');
  assert.equal(connection.seatId, 'gemini', 'the physical row lives on gemini; the set read finds it from claude');
  assert.equal(connection.state, 'connected');
  assert.equal(connection.toolSnapshotRef, 42);
});

test('getConnection answers null (not a throw) when the set holds no row', async () => {
  const store = createConnectorLibraryStore(strictPool({
    entries: [entryRow('claude', 'helmian-vercel')],
    connections: [connectionRow()],
    snapshots: [SNAPSHOT_ROW],
  }));
  const connection = await store.getConnection(TENANT, { personId: PERSON, seatId: 'claude', entryId: 'helmian-vercel' });
  assert.equal(connection, null);
});

test('getCurrentSnapshot returns the frozen snapshot under a parameter-strict pool', async () => {
  const store = createConnectorLibraryStore(strictPool({
    entries: [entryRow('claude', 'helmian-notion')],
    connections: [connectionRow()],
    snapshots: [SNAPSHOT_ROW],
  }));
  const snapshot = await store.getCurrentSnapshot(TENANT, { personId: PERSON, seatId: 'claude', entryId: 'helmian-notion' });
  assert.ok(snapshot, 'the current snapshot resolves');
  assert.equal(snapshot.id, 42);
  assert.equal(snapshot.snapshotHash, 'hash-42');
  assert.deepEqual(snapshot.tools.map((t) => t.name), ['list_things']);
});

test('getConnection resolves a connection-family entry under a parameter-strict pool', {
  skip: typeof familyEntryIds !== 'function' && 'this build has no connection families',
}, async () => {
  const family = familyEntryIds('helmian-outlook');
  assert.ok(Array.isArray(family) && family.includes('helmian-onedrive'), 'the microsoft family is the fixture shape');
  const store = createConnectorLibraryStore(strictPool({
    entries: [entryRow('claude', 'helmian-outlook')],
    connections: [connectionRow({ id: 9, entry_id: 'helmian-onedrive', tool_snapshot_ref: null })],
    snapshots: [],
  }));
  const connection = await store.getConnection(TENANT, { personId: PERSON, seatId: 'claude', entryId: 'helmian-outlook' });
  assert.ok(connection, 'the family connection resolves');
  assert.equal(connection.entryId, 'helmian-onedrive', 'the family winner is the row recorded under the sibling member');
});
