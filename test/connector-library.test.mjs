// Connector library (sql/074) — SPEC §2 records, build bite 1 gate.
//
// The gate, from the spec:
//   (1) a record written for seat A is invisible to seat B's reads;
//   (2) no raw token value appears in any record, log line, or API
//       response — a token is planted and every surface is grepped;
//   (3) the snapshot hash changes when a tool's schema changes and does
//       not change when it doesn't.
// Plus the §2 laws the records carry: brokerMode set at creation and
// never inferred, vendor entries take mirrors never token connections,
// (person, seat, entry) uniqueness, undeclared = write.
//
// The store is exercised against an in-memory fake pool that simulates
// the four tables (the repo's established pattern — see
// tool-connections.test.mjs). The fake records every query so the token
// grep covers the SQL traffic too.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createConnectorLibraryStore,
  buildConnectorTokenRef,
  validateVaultTokenRef,
  planToolSnapshot,
  diffToolSnapshots,
  deriveToolAnnotation,
  effectiveToolAnnotation,
  CONNECTOR_POSTURES,
} from '../src/cloud/connector-library.mjs';

const TENANT = 'tenant-a';
const SUBJECT = 'user:troy';
const PERSON = 'user:troy';
const OTHER_PERSON = 'user:someone-else';

// ---------------------------------------------------------------- fake pool
function fakePool() {
  const entries = new Map();
  const connections = new Map();
  const snapshots = new Map();
  const mirrors = new Map();
  const queries = [];
  let tenant = null;
  let connSeq = 0;
  let snapSeq = 0;
  const entryKey = (seat, id) => `${tenant}|${seat}|${id}`;
  const connKey = (p, s, e) => `${tenant}|${p}|${s}|${e}`;
  const now = () => new Date();

  return {
    queries,
    async connect() {
      return {
        async query(text, vals = []) {
          queries.push({ text, vals });
          if (text.includes("set_config('helmion.tenant_id'")) { tenant = vals[0]; return { rows: [], rowCount: 0 }; }
          if (['begin', 'commit', 'rollback'].includes(text.trim())) return { rows: [], rowCount: 0 };

          // ---- connector_entries
          if (text.includes('insert into helmion.connector_entries')) {
            const [seatId, id, kind, name, oneLiner, iconRef, vendorName, trustLabel, category,
              brokerMode, endpoint, vendorRefJson, authMode, clientIdentity, scopesSummary,
              addedBy, workspaceProvisioned] = vals;
            const row = {
              tenant_id: tenant, seat_id: seatId, id, kind, name, one_liner: oneLiner,
              icon_ref: iconRef, vendor_name: vendorName, trust_label: trustLabel, category,
              broker_mode: brokerMode, mcp_endpoint_url: endpoint,
              vendor_connector_ref: vendorRefJson ? JSON.parse(vendorRefJson) : null,
              auth_mode: authMode, client_identity: clientIdentity, scopes_summary: scopesSummary,
              added_by: addedBy, added_at: now(), workspace_provisioned: workspaceProvisioned,
              state: 'available', created_at: now(), updated_at: now(),
            };
            entries.set(entryKey(seatId, id), row);
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('delete from helmion.connector_entries')) {
            const row = entries.get(entryKey(vals[0], vals[1]));
            if (!row) return { rows: [], rowCount: 0 };
            entries.delete(entryKey(vals[0], vals[1]));
            for (const [k, c] of connections) if (c.seat_id === vals[0] && c.entry_id === vals[1] && c.tenant_id === tenant) { connections.delete(k); for (const [sid, s] of snapshots) if (s.connection_id === c.id) snapshots.delete(sid); }
            for (const [k, m] of mirrors) if (m.seat_id === vals[0] && m.entry_id === vals[1] && m.tenant_id === tenant) mirrors.delete(k);
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('update helmion.connector_entries') && text.includes('set state = $3')) {
            const row = entries.get(entryKey(vals[0], vals[1]));
            if (!row) return { rows: [], rowCount: 0 };
            row.state = vals[2]; row.updated_at = now();
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('update helmion.connector_entries')) {
            const row = entries.get(entryKey(vals[0], vals[1]));
            if (!row) return { rows: [], rowCount: 0 };
            const [, , name, oneLiner, iconRef, vendorName, trustLabel, category, endpoint, vendorRefJson, authMode, clientIdentity, scopesSummary, workspaceProvisioned] = vals;
            Object.assign(row, {
              name, one_liner: oneLiner, icon_ref: iconRef, vendor_name: vendorName,
              trust_label: trustLabel, category, mcp_endpoint_url: endpoint,
              vendor_connector_ref: vendorRefJson ? JSON.parse(vendorRefJson) : null,
              auth_mode: authMode, client_identity: clientIdentity, scopes_summary: scopesSummary,
              workspace_provisioned: workspaceProvisioned, updated_at: now(),
            });
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('from helmion.connector_entries') && text.includes('order by id')) {
            const out = [...entries.values()].filter((r) => r.tenant_id === tenant && r.seat_id === vals[0]);
            return { rows: out.map((r) => ({ ...r })), rowCount: out.length };
          }
          if (text.includes('from helmion.connector_entries')) {
            const row = entries.get(entryKey(vals[0], vals[1]));
            return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
          }

          // ---- connector_snapshots (before connections: its select is by id)
          if (text.includes('insert into helmion.connector_snapshots')) {
            const row = {
              id: ++snapSeq, tenant_id: tenant, connection_id: vals[0],
              taken_at: now(), tools: JSON.parse(vals[1]), snapshot_hash: vals[2],
            };
            snapshots.set(row.id, row);
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('from helmion.connector_snapshots')) {
            const row = snapshots.get(vals[0]);
            return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
          }

          // ---- connector_connections
          if (text.includes('insert into helmion.connector_connections')) {
            const [personId, seatId, entryId, accountIdentity, accessRef, refreshRef, scopesJson, posture] = vals;
            const row = {
              id: ++connSeq, tenant_id: tenant, person_id: personId, seat_id: seatId, entry_id: entryId,
              account_identity: accountIdentity, access_token_ref: accessRef, refresh_token_ref: refreshRef,
              granted_scopes: JSON.parse(scopesJson), posture, tool_enable_map: {}, tool_snapshot_ref: null,
              state: 'connected', last_discovery_at: null, last_used_at: null, created_at: now(), updated_at: now(),
            };
            connections.set(connKey(personId, seatId, entryId), row);
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('update helmion.connector_connections')) {
            const row = connections.get(connKey(vals[0], vals[1], vals[2]));
            if (!row) return { rows: [], rowCount: 0 };
            if (text.includes("set state = 'disconnected'")) {
              row.state = 'disconnected'; row.access_token_ref = null; row.refresh_token_ref = null; row.tool_snapshot_ref = null;
            } else if (text.includes('set access_token_ref = $4')) {
              row.access_token_ref = vals[3]; row.refresh_token_ref = vals[4];
              row.account_identity = vals[5]; row.granted_scopes = JSON.parse(vals[6]); row.state = 'connected';
            } else if (text.includes('set tool_snapshot_ref = $4')) {
              row.tool_snapshot_ref = vals[3]; row.last_discovery_at = now(); row.tool_enable_map = JSON.parse(vals[4]);
            } else if (text.includes('set tool_enable_map = $4::jsonb')) {
              row.tool_enable_map = JSON.parse(vals[3]);
            } else if (text.includes('set posture = $4')) {
              row.posture = vals[3];
            } else if (text.includes("set state = 'needs-reconnect'")) {
              row.state = 'needs-reconnect';
            } else if (text.includes('set last_used_at = clock_timestamp()')) {
              row.last_used_at = now();
            } else {
              throw new Error(`fake pool: unhandled connection update: ${text}`);
            }
            row.updated_at = now();
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('from helmion.connector_connections') && text.includes('order by entry_id')) {
            const out = [...connections.values()].filter((r) => r.tenant_id === tenant && r.person_id === vals[0] && r.seat_id === vals[1]);
            return { rows: out.map((r) => ({ ...r })), rowCount: out.length };
          }
          if (text.includes('from helmion.connector_connections')) {
            const row = connections.get(connKey(vals[0], vals[1], vals[2]));
            return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
          }

          // ---- connector_mirrors
          if (text.includes('insert into helmion.connector_mirrors')) {
            const [personId, seatId, entryId, reportedState, reportedAccount, reportedAt] = vals;
            const key = connKey(personId, seatId, entryId);
            const existing = mirrors.get(key);
            const row = existing ?? {
              tenant_id: tenant, person_id: personId, seat_id: seatId, entry_id: entryId, created_at: now(),
            };
            row.reported_state = reportedState;
            row.reported_account_identity = reportedAccount;
            row.reported_at = reportedAt ? new Date(reportedAt) : now();
            row.updated_at = now();
            mirrors.set(key, row);
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('from helmion.connector_mirrors') && text.includes('order by entry_id')) {
            const out = [...mirrors.values()].filter((r) => r.tenant_id === tenant && r.person_id === vals[0] && r.seat_id === vals[1]);
            return { rows: out.map((r) => ({ ...r })), rowCount: out.length };
          }
          if (text.includes('from helmion.connector_mirrors')) {
            const row = mirrors.get(connKey(vals[0], vals[1], vals[2]));
            return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
          }

          throw new Error(`fake pool: unhandled query: ${text}`);
        },
        release() {},
      };
    },
  };
}

function makeStore() {
  const pool = fakePool();
  return { store: createConnectorLibraryStore(pool), pool };
}

// ----------------------------------------------------------------- fixtures
const helmianEntry = (over = {}) => ({
  seatId: 'claude', id: 'gmail', kind: 'catalog', name: 'Gmail',
  oneLiner: 'Draft replies, search your inbox, summarise threads',
  vendorName: 'Google', trustLabel: 'verified', category: 'productivity',
  brokerMode: 'helmian', mcpEndpointUrl: 'https://gmail.example.com/mcp',
  authMode: 'oauth', scopesSummary: 'Read and send mail', addedBy: 'system',
  ...over,
});
const vendorEntry = (over = {}) => ({
  seatId: 'claude', id: 'gmail-brokered', kind: 'catalog', name: 'Gmail',
  oneLiner: 'Draft replies, search your inbox, summarise threads',
  vendorName: 'Google', trustLabel: 'verified', category: 'productivity',
  brokerMode: 'vendor',
  vendorConnectorRef: { ref: 'anthropic:gmail', manageUrl: 'https://claude.ai/settings/connectors' },
  authMode: 'oauth', addedBy: 'system',
  ...over,
});
const refFor = (tenantId, seatId, entryId, personId, tokenKind) =>
  buildConnectorTokenRef({ tenantId, seatId, entryId, personId, tokenKind });
const connectInput = (over = {}) => ({
  personId: PERSON, seatId: 'claude', entryId: 'gmail',
  accountIdentity: 'troy@example.com',
  accessTokenRef: refFor(TENANT, 'claude', 'gmail', PERSON, 'access'),
  refreshTokenRef: refFor(TENANT, 'claude', 'gmail', PERSON, 'refresh'),
  grantedScopes: ['gmail.read', 'gmail.send'],
  ...over,
});
const KEY = { personId: PERSON, seatId: 'claude', entryId: 'gmail' };

const toolListV1 = [
  { name: 'search_mail', description: 'Search the inbox', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'send_mail', description: 'Send a message', inputSchema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } } } },
];

// ------------------------------------------------------------------- entries
test('entry creation stores brokerMode as given and returns the five row fields', async () => {
  const { store } = makeStore();
  const entry = await store.createEntry(TENANT, SUBJECT, helmianEntry());
  assert.equal(entry.brokerMode, 'helmian');
  assert.equal(entry.state, 'available');
  assert.equal(entry.name, 'Gmail');
  assert.equal(entry.oneLiner, 'Draft replies, search your inbox, summarise threads');
  assert.equal(entry.vendorName, 'Google');
  assert.equal(entry.trustLabel, 'verified');
  const fetched = await store.getEntry(TENANT, 'claude', 'gmail');
  assert.deepEqual(fetched, entry);
});

test('brokerMode is required at creation — never defaulted, never inferred', async () => {
  const { store } = makeStore();
  const noMode = helmianEntry();
  delete noMode.brokerMode;
  await assert.rejects(() => store.createEntry(TENANT, SUBJECT, noMode), /brokerMode is required/);
  await assert.rejects(() => store.createEntry(TENANT, SUBJECT, helmianEntry({ brokerMode: 'guessed' })), /brokerMode is required/);
});

test('each brokerMode carries exactly its own pipe shape', async () => {
  const { store } = makeStore();
  await assert.rejects(
    () => store.createEntry(TENANT, SUBJECT, vendorEntry({ mcpEndpointUrl: 'https://gmail.example.com/mcp' })),
    /no mcpEndpointUrl/,
  );
  await assert.rejects(
    () => store.createEntry(TENANT, SUBJECT, helmianEntry({ mcpEndpointUrl: undefined })),
    /needs its mcpEndpointUrl/,
  );
  await assert.rejects(
    () => store.createEntry(TENANT, SUBJECT, vendorEntry({ vendorConnectorRef: undefined })),
    /needs vendorConnectorRef/,
  );
  const vendor = await store.createEntry(TENANT, SUBJECT, vendorEntry());
  assert.equal(vendor.brokerMode, 'vendor');
  assert.equal(vendor.mcpEndpointUrl, null);
  assert.equal(vendor.vendorConnectorRef.manageUrl, 'https://claude.ai/settings/connectors');
});

test('custom entries are always trust-labelled custom and are never edited in place', async () => {
  const { store } = makeStore();
  await assert.rejects(
    () => store.createEntry(TENANT, SUBJECT, helmianEntry({ id: 'mine', kind: 'custom', trustLabel: 'verified', addedBy: PERSON })),
    /always trust-labelled "custom"/,
  );
  const custom = await store.createEntry(TENANT, SUBJECT, helmianEntry({
    id: 'mine', kind: 'custom', trustLabel: undefined, addedBy: PERSON, authMode: 'none',
  }));
  assert.equal(custom.trustLabel, 'custom');
  await assert.rejects(
    () => store.createEntry(TENANT, SUBJECT, helmianEntry({ id: 'mine', kind: 'custom', trustLabel: undefined, addedBy: PERSON, name: 'Renamed' })),
    /never edited in place/,
  );
});

test('catalog refresh updates descriptive fields but can never change brokerMode', async () => {
  const { store } = makeStore();
  await store.createEntry(TENANT, SUBJECT, helmianEntry());
  const refreshed = await store.createEntry(TENANT, SUBJECT, helmianEntry({ oneLiner: 'Search and draft mail' }));
  assert.equal(refreshed.oneLiner, 'Search and draft mail');
  assert.equal(refreshed.brokerMode, 'helmian');
  await assert.rejects(
    () => store.createEntry(TENANT, SUBJECT, helmianEntry({ brokerMode: 'vendor', mcpEndpointUrl: undefined, vendorConnectorRef: { ref: 'x', manageUrl: 'https://example.com/manage' } })),
    /brokerMode is set at creation and never changes/,
  );
});

test('an entry cannot be created already disabled, and endpoints reject smuggled credentials', async () => {
  const { store } = makeStore();
  await assert.rejects(() => store.createEntry(TENANT, SUBJECT, helmianEntry({ state: 'disabled-by-owner' })), /cannot be set at creation/);
  await assert.rejects(
    () => store.createEntry(TENANT, SUBJECT, helmianEntry({ mcpEndpointUrl: 'https://user:pw@gmail.example.com/mcp' })),
    /must not carry credentials/,
  );
  await assert.rejects(
    () => store.createEntry(TENANT, SUBJECT, helmianEntry({ mcpEndpointUrl: 'http://gmail.example.com/mcp' })),
    /must be HTTPS/,
  );
});

// ------------------------------------------------------- GATE 1: seat scoping
test('GATE 1 — a record written for seat A is invisible to seat B reads', async () => {
  const { store } = makeStore();
  await store.createEntry(TENANT, SUBJECT, helmianEntry());
  await store.createEntry(TENANT, SUBJECT, vendorEntry());
  const conn = await store.createConnection(TENANT, SUBJECT, connectInput());
  assert.equal(conn.state, 'connected');
  await store.recordMirrorReport(TENANT, SUBJECT, {
    personId: PERSON, seatId: 'claude', entryId: 'gmail-brokered',
    reportedState: 'connected', reportedAccountIdentity: 'troy@example.com',
  });

  // The same person's reads in the OTHER seat see nothing of it.
  assert.equal(await store.getEntry(TENANT, 'gemini', 'gmail'), null);
  assert.deepEqual(await store.listEntries(TENANT, 'gemini'), []);
  assert.equal(await store.getConnection(TENANT, { personId: PERSON, seatId: 'gemini', entryId: 'gmail' }), null);
  assert.deepEqual(await store.listConnections(TENANT, { personId: PERSON, seatId: 'gemini' }), []);
  assert.equal(await store.getMirror(TENANT, { personId: PERSON, seatId: 'gemini', entryId: 'gmail-brokered' }), null);
  assert.deepEqual(await store.listMirrors(TENANT, { personId: PERSON, seatId: 'gemini' }), []);

  // And a different person in the SAME seat sees none of the personal records.
  assert.equal(await store.getConnection(TENANT, { personId: OTHER_PERSON, seatId: 'claude', entryId: 'gmail' }), null);
  assert.deepEqual(await store.listConnections(TENANT, { personId: OTHER_PERSON, seatId: 'claude' }), []);
  assert.deepEqual(await store.listMirrors(TENANT, { personId: OTHER_PERSON, seatId: 'claude' }), []);

  // Reads without the seat (or person) are refused outright.
  await assert.rejects(() => store.listEntries(TENANT, ''), /seatId is required/);
  await assert.rejects(() => store.listConnections(TENANT, { personId: PERSON }), /seatId is required/);
});

// --------------------------------------------------- GATE 2: token hygiene
test('GATE 2 — no raw token value appears in any record, log line, or response', async () => {
  const { store, pool } = makeStore();
  const PLANTED = 'PLANTED-TOKEN-9f8e7d6c5b-NEVER-STORED';
  const corpus = [];
  const logLines = [];
  const original = {};
  for (const level of ['log', 'info', 'warn', 'error']) {
    original[level] = console[level];
    console[level] = (...args) => logLines.push(args.map(String).join(' '));
  }
  try {
    await store.createEntry(TENANT, SUBJECT, helmianEntry());
    // A raw token offered under a value-shaped key is refused by name.
    await assert.rejects(
      () => store.createConnection(TENANT, SUBJECT, connectInput({ accessToken: PLANTED, accessTokenRef: undefined })),
      (error) => { corpus.push(error.message); return /carries a credential value/.test(error.message); },
    );
    // A raw token offered AS the reference is refused (not a vault pointer).
    await assert.rejects(
      () => store.createConnection(TENANT, SUBJECT, connectInput({ accessTokenRef: PLANTED })),
      (error) => { corpus.push(error.message); return /must be a vault reference/.test(error.message); },
    );
    // A vault pointer naming ANOTHER tenant is refused.
    await assert.rejects(
      () => store.createConnection(TENANT, SUBJECT, connectInput({ accessTokenRef: `vault://tenant/other-tenant/connector.claude.gmail/p-x.${'a'}.access` })),
      (error) => { corpus.push(error.message); return /another tenant/.test(error.message); },
    );
    // The honest road: references only.
    const conn = await store.createConnection(TENANT, SUBJECT, connectInput());
    corpus.push(JSON.stringify(conn));
    corpus.push(JSON.stringify(await store.getConnection(TENANT, KEY)));
    corpus.push(JSON.stringify(await store.listConnections(TENANT, { personId: PERSON, seatId: 'claude' })));
    const snap = await store.freezeSnapshot(TENANT, KEY, toolListV1, SUBJECT);
    corpus.push(JSON.stringify(snap));
    corpus.push(JSON.stringify(await store.getCurrentSnapshot(TENANT, KEY)));
    corpus.push(JSON.stringify(await store.listEntries(TENANT, 'claude')));
    const { connection, revokedRefs } = await store.disconnectConnection(TENANT, KEY, SUBJECT, { revoke: async () => {} });
    corpus.push(JSON.stringify(connection), JSON.stringify(revokedRefs));
  } finally {
    for (const level of ['log', 'info', 'warn', 'error']) console[level] = original[level];
  }
  corpus.push(JSON.stringify(pool.queries));
  corpus.push(logLines.join('\n'));
  const everything = corpus.join('\n');
  assert.ok(!everything.includes(PLANTED), 'the planted token value leaked into a record, error, query, or log line');
  // And the minted reference shape is the vault's own, keyed per person.
  const ref = refFor(TENANT, 'claude', 'gmail', PERSON, 'access');
  assert.match(ref, /^vault:\/\/tenant\/tenant-a\/connector\.claude\.gmail\/p-[0-9a-f]{32}\.access$/);
  assert.equal(validateVaultTokenRef(ref, TENANT), ref);
  assert.notEqual(refFor(TENANT, 'claude', 'gmail', OTHER_PERSON, 'access'), ref);
});

// ------------------------------------------- GATE 3: snapshot hash behaviour
test('GATE 3 — snapshot hash changes when a tool schema changes, and not when it doesn\'t', () => {
  const base = planToolSnapshot(toolListV1);
  const again = planToolSnapshot(toolListV1.map((t) => ({ ...t })));
  assert.equal(again.snapshotHash, base.snapshotHash);
  // Order in the tools/list result does not matter.
  const reordered = planToolSnapshot([toolListV1[1], toolListV1[0]]);
  assert.equal(reordered.snapshotHash, base.snapshotHash);

  const schemaChanged = planToolSnapshot([
    toolListV1[0],
    { ...toolListV1[1], inputSchema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' }, cc: { type: 'string' } } } },
  ]);
  assert.notEqual(schemaChanged.snapshotHash, base.snapshotHash);
  const sendMail = schemaChanged.tools.find((t) => t.name === 'send_mail');
  assert.notEqual(sendMail.inputSchemaHash, base.tools.find((t) => t.name === 'send_mail').inputSchemaHash);
  // The unchanged tool's hash does not move.
  assert.equal(
    schemaChanged.tools.find((t) => t.name === 'search_mail').inputSchemaHash,
    base.tools.find((t) => t.name === 'search_mail').inputSchemaHash,
  );

  const descriptionChanged = planToolSnapshot([{ ...toolListV1[0], description: 'Search all mail' }, toolListV1[1]]);
  assert.notEqual(descriptionChanged.snapshotHash, base.snapshotHash);

  const diff = diffToolSnapshots(base.tools, schemaChanged.tools);
  assert.deepEqual(diff, { added: [], removed: [], changed: ['send_mail'] });
});

test('snapshot stores hashes and annotations — never the raw schema; undeclared is write', async () => {
  const { store } = makeStore();
  await store.createEntry(TENANT, SUBJECT, helmianEntry());
  await store.createConnection(TENANT, SUBJECT, connectInput());
  const snap = await store.freezeSnapshot(TENANT, KEY, toolListV1, SUBJECT);
  const search = snap.tools.find((t) => t.name === 'search_mail');
  const send = snap.tools.find((t) => t.name === 'send_mail');
  assert.equal(search.annotation, 'read');
  assert.equal(send.annotation, 'undeclared');
  assert.equal(effectiveToolAnnotation(send.annotation), 'write');
  assert.equal(deriveToolAnnotation({ readOnlyHint: false }), 'write');
  assert.equal(deriveToolAnnotation(undefined), 'undeclared');
  assert.match(search.inputSchemaHash, /^[0-9a-f]{64}$/);
  assert.ok(!('inputSchema' in search) && !('inputSchema' in send));
  assert.ok(!JSON.stringify(snap).includes('"properties"'), 'the raw schema leaked into the snapshot record');
  const conn = await store.getConnection(TENANT, KEY);
  assert.equal(conn.toolSnapshotRef, snap.id);
  assert.ok(conn.lastDiscoveryAt);
});

test('re-freeze merge: new and changed tools enter OFF, unchanged tools keep their setting', async () => {
  const { store } = makeStore();
  await store.createEntry(TENANT, SUBJECT, helmianEntry());
  await store.createConnection(TENANT, SUBJECT, connectInput());
  await store.freezeSnapshot(TENANT, KEY, toolListV1, SUBJECT);
  let conn = await store.getConnection(TENANT, KEY);
  assert.deepEqual(conn.toolEnableMap, { search_mail: true, send_mail: true });

  // The person turns search off; a re-freeze with send_mail changed and a
  // brand-new tool must keep search off, force send_mail off, add the new
  // tool off.
  await store.setToolEnableMap(TENANT, KEY, { search_mail: false }, SUBJECT);
  const v2 = [
    toolListV1[0],
    { ...toolListV1[1], inputSchema: { type: 'object', properties: { to: { type: 'string' } } } },
    { name: 'archive_mail', description: 'Archive a thread', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
  ];
  const snap2 = await store.freezeSnapshot(TENANT, KEY, v2, SUBJECT);
  conn = await store.getConnection(TENANT, KEY);
  assert.equal(conn.toolSnapshotRef, snap2.id);
  assert.deepEqual(conn.toolEnableMap, { search_mail: false, send_mail: false, archive_mail: false });
  assert.equal(snap2.tools.find((t) => t.name === 'archive_mail').annotation, 'write');

  // Enabling a tool the snapshot does not hold is refused.
  await assert.rejects(() => store.setToolEnableMap(TENANT, KEY, { delete_everything: true }, SUBJECT), /not in this connection's frozen snapshot/);
});

// --------------------------------------------------------------- connections
test('the (person, seat, entry) triple is unique — a second create is refused, not overwritten', async () => {
  const { store } = makeStore();
  await store.createEntry(TENANT, SUBJECT, helmianEntry());
  await store.createConnection(TENANT, SUBJECT, connectInput());
  await assert.rejects(() => store.createConnection(TENANT, SUBJECT, connectInput()), (e) => e.status === 409);
  // The same connector in another seat is a SECOND connection (§3.4).
  await store.createEntry(TENANT, SUBJECT, helmianEntry({ seatId: 'gemini' }));
  const second = await store.createConnection(TENANT, SUBJECT, connectInput({
    seatId: 'gemini',
    accessTokenRef: refFor(TENANT, 'gemini', 'gmail', PERSON, 'access'),
    refreshTokenRef: refFor(TENANT, 'gemini', 'gmail', PERSON, 'refresh'),
  }));
  assert.equal(second.seatId, 'gemini');
  assert.notEqual(second.accessTokenRef, refFor(TENANT, 'claude', 'gmail', PERSON, 'access'));
});

test('posture defaults to ask and only ever moves by an explicit set', async () => {
  const { store } = makeStore();
  await store.createEntry(TENANT, SUBJECT, helmianEntry());
  const conn = await store.createConnection(TENANT, SUBJECT, connectInput());
  assert.equal(conn.posture, 'ask');
  assert.ok(CONNECTOR_POSTURES.includes('all'));
  const moved = await store.setPosture(TENANT, KEY, 'read', SUBJECT);
  assert.equal(moved.posture, 'read');
  await assert.rejects(() => store.setPosture(TENANT, KEY, 'everything', SUBJECT), /posture must be one of/);
  await assert.rejects(() => store.createConnection(TENANT, SUBJECT, connectInput({ personId: OTHER_PERSON, posture: 'all-in' })), /posture must be one of/);
});

test('a no-auth entry takes a connection with no token references — and refuses any', async () => {
  const { store } = makeStore();
  await store.createEntry(TENANT, SUBJECT, helmianEntry({ id: 'open-tools', authMode: 'none', mcpEndpointUrl: 'https://open.example.com/mcp' }));
  const key = { personId: PERSON, seatId: 'claude', entryId: 'open-tools' };
  await assert.rejects(
    () => store.createConnection(TENANT, SUBJECT, { ...key, accountIdentity: 'anon', accessTokenRef: refFor(TENANT, 'claude', 'open-tools', PERSON, 'access') }),
    /no tokens to reference/,
  );
  const conn = await store.createConnection(TENANT, SUBJECT, { ...key, accountIdentity: 'anon' });
  assert.equal(conn.accessTokenRef, null);
  assert.equal(conn.state, 'connected');
});

test('a disabled-by-owner entry refuses new connections until re-enabled', async () => {
  const { store } = makeStore();
  await store.createEntry(TENANT, SUBJECT, helmianEntry());
  await store.setEntryState(TENANT, 'claude', 'gmail', 'disabled-by-owner', SUBJECT);
  await assert.rejects(() => store.createConnection(TENANT, SUBJECT, connectInput()), (e) => e.status === 409);
  await store.setEntryState(TENANT, 'claude', 'gmail', 'available', SUBJECT);
  const conn = await store.createConnection(TENANT, SUBJECT, connectInput());
  assert.equal(conn.state, 'connected');
});

test('needs-reconnect is an honest state, and fresh tokens land the connection again', async () => {
  const { store } = makeStore();
  await store.createEntry(TENANT, SUBJECT, helmianEntry());
  await store.createConnection(TENANT, SUBJECT, connectInput());
  const stale = await store.markNeedsReconnect(TENANT, KEY, SUBJECT);
  assert.equal(stale.state, 'needs-reconnect');
  const renewed = await store.updateConnectionTokens(TENANT, KEY, {
    accessTokenRef: refFor(TENANT, 'claude', 'gmail', PERSON, 'access'),
    refreshTokenRef: null,
  }, SUBJECT);
  assert.equal(renewed.state, 'connected');
  assert.equal(renewed.refreshTokenRef, null);
  const used = await store.touchLastUsed(TENANT, KEY);
  assert.ok(used.lastUsedAt);
});

test('disconnect revokes through the vault road hook and clears the references', async () => {
  const { store } = makeStore();
  await store.createEntry(TENANT, SUBJECT, helmianEntry());
  const conn = await store.createConnection(TENANT, SUBJECT, connectInput());
  await store.freezeSnapshot(TENANT, KEY, toolListV1, SUBJECT);
  const revoked = [];
  const { connection, revokedRefs } = await store.disconnectConnection(TENANT, KEY, SUBJECT, {
    revoke: async (ref) => { revoked.push(ref); },
  });
  assert.deepEqual(revoked, [conn.accessTokenRef, conn.refreshTokenRef]);
  assert.deepEqual(revokedRefs, revoked);
  assert.equal(connection.state, 'disconnected');
  assert.equal(connection.accessTokenRef, null);
  assert.equal(connection.refreshTokenRef, null);
  assert.equal(connection.toolSnapshotRef, null);
  assert.equal(await store.getCurrentSnapshot(TENANT, KEY), null);
  const again = await store.disconnectConnection(TENANT, KEY, SUBJECT);
  assert.deepEqual(again.revokedRefs, []);
});

test('reconnect after disconnect revives the person’s own row in place — the round trip lands connected again', async () => {
  const { store } = makeStore();
  await store.createEntry(TENANT, SUBJECT, helmianEntry());
  const first = await store.createConnection(TENANT, SUBJECT, connectInput());
  // A posture the person chose survives the round trip: disconnect
  // clears credentials, not the person's Guard setting.
  await store.setPosture(TENANT, KEY, 'read', SUBJECT);
  const { connection: down } = await store.disconnectConnection(TENANT, KEY, SUBJECT, { revoke: async () => {} });
  assert.equal(down.state, 'disconnected');
  assert.equal(down.accessTokenRef, null);
  // The reconnect: the same create every connect road ends in (the
  // OAuth callback included), carrying the fresh sign-in's identity
  // and scopes.
  const back = await store.createConnection(TENANT, SUBJECT, connectInput({
    accountIdentity: 'troy.again@example.com',
    grantedScopes: ['gmail.read'],
  }));
  assert.equal(back.state, 'connected');
  assert.equal(back.id, first.id); // the same row, revived — never a second record
  assert.equal(back.accountIdentity, 'troy.again@example.com');
  assert.deepEqual(back.grantedScopes, ['gmail.read']);
  assert.equal(back.accessTokenRef, first.accessTokenRef);
  assert.equal(back.posture, 'read');
  const mine = await store.listConnections(TENANT, { personId: PERSON, seatId: 'claude' });
  assert.equal(mine.length, 1);
  assert.equal(mine[0].state, 'connected');
});

test('a no-sign-in connection reconnects after disconnect — the Weather round trip', async () => {
  const { store } = makeStore();
  await store.createEntry(TENANT, SUBJECT, helmianEntry({ id: 'weather', authMode: 'none', mcpEndpointUrl: 'https://weather.example.com/mcp' }));
  const key = { personId: PERSON, seatId: 'claude', entryId: 'weather' };
  const first = await store.createConnection(TENANT, SUBJECT, { ...key, accountIdentity: 'No sign-in', grantedScopes: [] });
  assert.equal(first.state, 'connected');
  await store.disconnectConnection(TENANT, key, SUBJECT);
  const back = await store.createConnection(TENANT, SUBJECT, { ...key, accountIdentity: 'No sign-in', grantedScopes: [] });
  assert.equal(back.state, 'connected');
  assert.equal(back.id, first.id);
  assert.equal(back.accessTokenRef, null);
  assert.equal(back.refreshTokenRef, null);
});

test('a live duplicate still refuses — needs-reconnect is not a disconnected row', async () => {
  const { store } = makeStore();
  await store.createEntry(TENANT, SUBJECT, helmianEntry());
  await store.createConnection(TENANT, SUBJECT, connectInput());
  await store.markNeedsReconnect(TENANT, KEY, SUBJECT);
  await assert.rejects(
    () => store.createConnection(TENANT, SUBJECT, connectInput()),
    (e) => e.status === 409 && /already has a connection for this connector in this seat/.test(e.message),
  );
});

test('a reconnect never reaches another person’s row', async () => {
  const { store } = makeStore();
  await store.createEntry(TENANT, SUBJECT, helmianEntry());
  const mineFirst = await store.createConnection(TENANT, SUBJECT, connectInput());
  await store.disconnectConnection(TENANT, KEY, SUBJECT);
  // Another person connects the same connector in the same seat — their own row.
  const theirs = await store.createConnection(TENANT, SUBJECT, connectInput({
    personId: OTHER_PERSON,
    accountIdentity: 'someone@example.com',
    accessTokenRef: refFor(TENANT, 'claude', 'gmail', OTHER_PERSON, 'access'),
    refreshTokenRef: refFor(TENANT, 'claude', 'gmail', OTHER_PERSON, 'refresh'),
  }));
  assert.notEqual(theirs.id, mineFirst.id);
  // My reconnect revives MY row and leaves theirs untouched.
  const mineBack = await store.createConnection(TENANT, SUBJECT, connectInput());
  assert.equal(mineBack.id, mineFirst.id);
  const theirsNow = await store.getConnection(TENANT, { personId: OTHER_PERSON, seatId: 'claude', entryId: 'gmail' });
  assert.equal(theirsNow.id, theirs.id);
  assert.equal(theirsNow.state, 'connected');
  assert.equal(theirsNow.accountIdentity, 'someone@example.com');
  assert.equal((await store.listConnections(TENANT, { personId: PERSON, seatId: 'claude' })).length, 1);
  assert.equal((await store.listConnections(TENANT, { personId: OTHER_PERSON, seatId: 'claude' })).length, 1);
});

// ------------------------------------------------------------------- mirrors
test('vendor-brokered entries take mirror records — never token connections', async () => {
  const { store } = makeStore();
  await store.createEntry(TENANT, SUBJECT, vendorEntry());
  await assert.rejects(
    () => store.createConnection(TENANT, SUBJECT, connectInput({ entryId: 'gmail-brokered' })),
    /vendor-brokered/,
  );
  const mirror = await store.recordMirrorReport(TENANT, SUBJECT, {
    personId: PERSON, seatId: 'claude', entryId: 'gmail-brokered',
    reportedState: 'connected', reportedAccountIdentity: 'troy@example.com',
    reportedAt: '2026-11-08T10:00:00.000Z',
  });
  assert.equal(mirror.reportedState, 'connected');
  assert.equal(mirror.reportedAccountIdentity, 'troy@example.com');
  // A later report replaces the earlier one — the mirror is only ever the
  // LAST thing the vendor side reported.
  const updated = await store.recordMirrorReport(TENANT, SUBJECT, {
    personId: PERSON, seatId: 'claude', entryId: 'gmail-brokered', reportedState: 'not-connected',
  });
  assert.equal(updated.reportedState, 'not-connected');
  assert.equal(updated.reportedAccountIdentity, null);
  assert.equal((await store.listMirrors(TENANT, { personId: PERSON, seatId: 'claude' })).length, 1);

  // And a mirror report against a helmian entry is refused.
  await store.createEntry(TENANT, SUBJECT, helmianEntry());
  await assert.rejects(
    () => store.recordMirrorReport(TENANT, SUBJECT, { personId: PERSON, seatId: 'claude', entryId: 'gmail', reportedState: 'connected' }),
    /vendor-brokered entries only/,
  );
});

test('removeEntry cascades the entry\'s connections, mirrors, and snapshots', async () => {
  const { store } = makeStore();
  await store.createEntry(TENANT, SUBJECT, helmianEntry());
  await store.createConnection(TENANT, SUBJECT, connectInput());
  await store.freezeSnapshot(TENANT, KEY, toolListV1, SUBJECT);
  await store.removeEntry(TENANT, 'claude', 'gmail', SUBJECT);
  assert.equal(await store.getEntry(TENANT, 'claude', 'gmail'), null);
  assert.equal(await store.getConnection(TENANT, KEY), null);
  assert.equal(await store.getCurrentSnapshot(TENANT, KEY), null);
});
