// Universal stocking (Troy's order, 2026-11-15 — connectors
// across the board on every seat).
//
// What is proven here, on the real catalog, the real store (over
// the fake pool pattern the connector suites share), the real
// library read, and the panel's own models:
//   - every seat's library lists the SAME Helmian-brokered row
//     set: the full union catalog (the native, all five registry
//     picks, all twenty vendor-published servers — 26 connector
//     names), with no seat missing a row another seat has. Two
//     seats of opposite shapes are compared directly (NVIDIA: no
//     vendor furniture at all; Gemini: Google mirrors only), and
//     then every seat is compared against the same set.
//   - connection state stays inside its own walls: a connection
//     made through one seat's row is the workspace set's
//     connection for that ENTRY (SYNC S1 — the panel's Connect
//     button says so in its own words: "for your workspace —
//     every agent shares it"), so it reads connected on every
//     seat's copy of that one entry — and NOWHERE else: no other
//     entry connects on any seat, another person sees nothing
//     connected, another tenant sees nothing connected. The
//     per-seat state that IS separate stays separate: the channel
//     arm toggles are keyed per seat and per channel, and arming
//     a connector on one seat arms it on no other.
//   - the in-panel Manage model (connector-panel.mjs's
//     manageModel) rules each row's acts from its own facts: a
//     connected brokered row can be armed, re-ruled for tool
//     access, and disconnected; a not-connected brokered row
//     carries Connect; the Helmian native never carries
//     disconnect (its state is not a library connection record);
//     a vendor mirror carries no Helmian act at all.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIVE_SEATS,
  catalogEntriesForSeat,
  createCatalogRefresh,
} from '../src/cloud/connector-catalog.mjs';
import { createConnectorLibraryStore } from '../src/cloud/connector-library.mjs';
import { createSeatLibraryRead } from '../src/cloud/connector-library-read.mjs';
import {
  emptyConnectorToggles,
  isConnectorOn,
  level2Model,
  manageModel,
  toggleConnector,
} from '../web/marketing/app/connector-panel.mjs';

const TENANT = 'tenant-a';
const TENANT_B = 'tenant-b';
const PERSON = 'user:troy';
const OTHER_PERSON = 'user:someone-else';

// The universal brokered name set: every connector name that has
// a Helmian-brokered row, in the order the catalog lists them.
const UNIVERSAL_NAMES = [
  'GitHub', 'Weather', 'Atlassian', 'Notion', 'Linear', 'Stripe',
  'Vercel', 'Slack', 'Asana', 'HubSpot', 'Gmail', 'Google Calendar',
  'Google Drive', 'Meltwater', 'S&P Global', 'Idiolect', 'Gamma',
  'Canva', 'Dropbox', 'OneDrive', 'Outlook', 'Microsoft Teams',
  'SharePoint', 'Box', 'Salesforce', 'Cloudflare Docs',
];

// ---------------------------------------------------------------- fake pool
// The connector suites' shared in-memory pattern (sql/074 tables),
// copied from connector-microsoft-family.test.mjs.

function fakePool() {
  const entries = new Map();
  const connections = new Map();
  const snapshots = new Map();
  const pendingRows = new Map();
  let tenant = null;
  let connSeq = 0;
  let snapSeq = 0;
  let tick = 0;
  const now = () => new Date(1_700_000_000_000 + (++tick) * 60_000);
  const entryKey = (seat, id) => `${tenant}|${seat}|${id}`;
  const connKey = (p, s, e) => `${tenant}|${p}|${s}|${e}`;

  const applyAssignments = (row, text, vals) => {
    const setClause = text.slice(text.indexOf(' set ') + 5, text.indexOf(' where '));
    for (const part of setClause.split(',')) {
      const m = part.trim().match(/^([a-z_]+)\s*=\s*(.+)$/s);
      if (!m) continue;
      const [, col, expr] = m;
      if (col === 'updated_at') { row.updated_at = now(); continue; }
      if (expr === 'clock_timestamp()') { row[col] = now(); continue; }
      if (expr === 'null') { row[col] = null; continue; }
      const lit = expr.match(/^'([^']*)'$/);
      if (lit) { row[col] = lit[1]; continue; }
      const param = expr.match(/^\$(\d+)(?:::.*)?$/);
      if (param) {
        const v = vals[Number(param[1]) - 1];
        row[col] = expr.includes('::jsonb') && typeof v === 'string' ? JSON.parse(v) : v;
        continue;
      }
      throw new Error(`fake pool: unhandled assignment ${part}`);
    }
    row.updated_at = now();
  };

  return {
    entries, connections, snapshots, pendingRows,
    async connect() {
      return {
        release() {},
        async query(text, vals = []) {
          if (text.includes("set_config('helmion.tenant_id'")) { tenant = vals[0]; return { rows: [], rowCount: 0 }; }
          if (['begin', 'commit', 'rollback'].includes(text.trim())) return { rows: [], rowCount: 0 };

          // ---- connector_entries
          if (text.includes('insert into helmion.connector_entries')) {
            const [seatId, id, kind, name, oneLiner, iconRef, vendorName, trustLabel, category,
              brokerMode, endpoint, vendorRefJson, authMode, clientIdentity, scopesSummary,
              addedBy, workspaceProvisioned, installedPath, configSnippetJson, baselineFingerprint] = vals;
            const row = {
              tenant_id: tenant, seat_id: seatId, id, kind, name, one_liner: oneLiner,
              icon_ref: iconRef, vendor_name: vendorName, trust_label: trustLabel, category,
              broker_mode: brokerMode, mcp_endpoint_url: endpoint,
              vendor_connector_ref: vendorRefJson ? JSON.parse(vendorRefJson) : null,
              auth_mode: authMode, client_identity: clientIdentity, scopes_summary: scopesSummary,
              added_by: addedBy, added_at: now(), workspace_provisioned: workspaceProvisioned,
              installed_path: installedPath ?? null,
              config_snippet: configSnippetJson ? JSON.parse(configSnippetJson) : null,
              baseline_fingerprint: baselineFingerprint ?? null,
              state: 'available', created_at: now(), updated_at: now(),
            };
            entries.set(entryKey(seatId, id), row);
            return { rows: [row], rowCount: 1 };
          }
          if (text.includes('update helmion.connector_entries')) {
            const row = entries.get(entryKey(vals[0], vals[1]));
            if (row) applyAssignments(row, text, vals);
            return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
          }
          if (text.includes('delete from helmion.connector_entries')) {
            let n = 0;
            for (const [k, row] of entries) {
              if (row.tenant_id !== tenant) continue;
              if (text.includes("kind = 'custom'") && row.kind !== 'custom') continue;
              if (row.id === vals[1] || row.id === vals[0]) { entries.delete(k); n += 1; }
            }
            return { rows: [], rowCount: n };
          }
          if (text.includes('from helmion.connector_entries')) {
            let rows = [...entries.values()].filter((r) => r.tenant_id === tenant);
            if (text.includes("kind = 'custom' and added_by = $1")) rows = rows.filter((r) => r.kind === 'custom' && r.added_by === vals[0]);
            else if (text.includes("id = $2 and kind = 'custom'")) rows = rows.filter((r) => r.id === vals[1] && r.kind === 'custom');
            else if (text.includes('seat_id = $1')) {
              rows = rows.filter((r) => r.seat_id === vals[0]);
              if (text.includes('id = $2')) rows = rows.filter((r) => r.id === vals[1]);
            }
            return { rows, rowCount: rows.length };
          }

          // ---- connector_oauth_pending
          if (text.includes('insert into helmion.connector_oauth_pending')) {
            const [stateHash, personId, seatId, entryId, provider, clientId, codeVerifier, redirectUri, scopes, ttl] = vals;
            pendingRows.set(`${tenant}|${stateHash}`, {
              tenant_id: tenant, state_hash: stateHash, person_id: personId, seat_id: seatId,
              entry_id: entryId, provider, client_id: clientId, code_verifier: codeVerifier,
              redirect_uri: redirectUri, scopes, client_secret: vals[10] ?? null,
              token_endpoint: vals[11] ?? null, token_endpoint_auth_method: vals[12] ?? null,
              expires_at: new Date(Date.now() + Number(ttl)),
            });
            return { rows: [], rowCount: 1 };
          }
          if (text.includes('delete from helmion.connector_oauth_pending')) {
            const k = `${tenant}|${vals[0]}`;
            const row = pendingRows.get(k);
            if (row) pendingRows.delete(k);
            return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
          }
          if (text.includes('from helmion.connector_oauth_pending')) {
            const row = pendingRows.get(`${tenant}|${vals[0]}`);
            return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
          }

          // ---- connector_connections
          if (text.includes('insert into helmion.connector_connections')) {
            const [personId, seatId, entryId, accountIdentity, accessRef, refreshRef, scopesJson, posture] = vals;
            const row = {
              id: ++connSeq, tenant_id: tenant, person_id: personId, seat_id: seatId, entry_id: entryId,
              account_identity: accountIdentity, access_token_ref: accessRef, refresh_token_ref: refreshRef,
              granted_scopes: JSON.parse(scopesJson), posture, tool_enable_map: {}, tool_snapshot_ref: null,
              state: 'connected', last_discovery_at: null, last_used_at: null,
              created_at: now(), updated_at: now(),
            };
            connections.set(connKey(personId, seatId, entryId), row);
            return { rows: [row], rowCount: 1 };
          }
          if (text.includes('update helmion.connector_connections')) {
            const row = connections.get(connKey(vals[0], vals[1], vals[2]));
            if (row) applyAssignments(row, text, vals);
            return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
          }
          if (text.includes('from helmion.connector_connections')) {
            let rows = [...connections.values()].filter((r) => r.tenant_id === tenant);
            if (text.includes('select seat_id, entry_id, state, updated_at, id')) {
              rows = rows.filter((r) => r.person_id === vals[0]);
              return {
                rows: rows.map((r) => ({ seat_id: r.seat_id, entry_id: r.entry_id, state: r.state, updated_at: r.updated_at, id: r.id })),
                rowCount: rows.length,
              };
            }
            if (text.includes('entry_id = any($3::text[])')) {
              rows = rows.filter((r) => r.person_id === vals[0] && vals[2].includes(r.entry_id));
            } else if (text.includes('entry_id = $3') && !text.includes('seat_id = $2')) {
              rows = rows.filter((r) => r.person_id === vals[0] && r.entry_id === vals[2]);
            } else if (text.includes('$2::text is not null')) {
              rows = rows.filter((r) => r.person_id === vals[0]);
            } else if (text.includes('seat_id = $2')) {
              rows = rows.filter((r) => r.person_id === vals[0] && r.seat_id === vals[1] && r.entry_id === vals[2]);
            }
            return { rows, rowCount: rows.length };
          }

          // ---- connector_snapshots
          if (text.includes('insert into helmion.connector_snapshots')) {
            const row = { id: ++snapSeq, tenant_id: tenant, connection_id: vals[0], tools: JSON.parse(vals[1]), snapshot_hash: vals[2], taken_at: now() };
            snapshots.set(row.id, row);
            return { rows: [row], rowCount: 1 };
          }
          if (text.includes('from helmion.connector_snapshots')) {
            if (text.includes('connection_id = $1')) {
              const rows = [...snapshots.values()].filter((r) => r.connection_id === vals[0]).sort((a, b) => a.id - b.id);
              return { rows: rows.slice(0, 1), rowCount: rows.length ? 1 : 0 };
            }
            const row = snapshots.get(vals[0]);
            return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
          }

          if (text.includes('from helmion.connector_mirrors')) return { rows: [], rowCount: 0 };
          return { rows: [], rowCount: 0 };
        },
      };
    },
  };
}

async function makeWorld() {
  const pool = fakePool();
  const store = createConnectorLibraryStore(pool);
  await createCatalogRefresh({ libraryStore: store, subject: 'system' }).refreshAll(TENANT);
  await createCatalogRefresh({ libraryStore: store, subject: 'system' }).refreshAll(TENANT_B);
  const read = createSeatLibraryRead({ libraryStore: store });
  return { pool, store, read };
}

const brokeredNamesOf = (rows) => {
  const seen = [];
  for (const row of rows) {
    if (row.brokerMode !== 'helmian') continue;
    if (!seen.includes(row.name)) seen.push(row.name);
  }
  return seen.sort();
};

// ------------------------------------------------------------ listing

test('universal listing: two different seats list identical Helmian-brokered row sets', async () => {
  const { read } = await makeWorld();
  const nvidia = await read.readSeatLibrary(TENANT, { personId: PERSON, seatId: 'nvidia' });
  const gemini = await read.readSeatLibrary(TENANT, { personId: PERSON, seatId: 'gemini' });
  const claude = await read.readSeatLibrary(TENANT, { personId: PERSON, seatId: 'claude' });
  assert.deepEqual(brokeredNamesOf(nvidia.rows), [...UNIVERSAL_NAMES].sort(), 'nvidia (no vendor furniture) lists the whole brokered set');
  assert.deepEqual(brokeredNamesOf(gemini.rows), [...UNIVERSAL_NAMES].sort(), 'gemini (mirrors only) lists the whole brokered set');
  assert.deepEqual(brokeredNamesOf(claude.rows), [...UNIVERSAL_NAMES].sort(), 'claude lists the whole brokered set');
  assert.deepEqual(brokeredNamesOf(nvidia.rows), brokeredNamesOf(gemini.rows), 'the two seats’ brokered row sets are identical');
  // And every seat in the room, not just the three compared above.
  for (const seatId of LIVE_SEATS) {
    const view = await read.readSeatLibrary(TENANT, { personId: PERSON, seatId });
    assert.deepEqual(brokeredNamesOf(view.rows), [...UNIVERSAL_NAMES].sort(), `${seatId}: the whole brokered set, no row missing`);
  }
});

test('universal listing: the panel model carries the same brokered rows on a plain seat as on Claude', async () => {
  const { read } = await makeWorld();
  const names = async (seatId) => {
    const view = await read.readSeatLibrary(TENANT, { personId: PERSON, seatId });
    const level2 = level2Model(view, emptyConnectorToggles(), 'channel:c1');
    return [...level2.connected, ...level2.catalog]
      .filter((r) => r.brokerMode === 'helmian')
      .map((r) => r.name)
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort();
  };
  assert.deepEqual(await names('openrouter'), await names('claude'), 'openrouter’s panel rows equal claude’s');
  assert.deepEqual(await names('openrouter'), [...UNIVERSAL_NAMES].sort());
  // Every brokered row on the plain seat carries its own Connect:
  // not-connected and Helmian-brokered is exactly connectable.
  const view = await read.readSeatLibrary(TENANT, { personId: PERSON, seatId: 'openrouter' });
  const level2 = level2Model(view, emptyConnectorToggles(), 'channel:c1');
  for (const row of [...level2.connected, ...level2.catalog]) {
    if (row.brokerMode === 'helmian' && row.state === 'not-connected' && row.kind !== 'mcp-local') {
      assert.equal(row.connectable, true, `openrouter/${row.entryId}: carries its own Connect`);
    }
  }
});

// ------------------------------------------------------------ state walls

test('state walls: a connection lands on its own entry only — never another entry, person, or tenant', async () => {
  const { store, read } = await makeWorld();
  // Connect Weather through Groq's row (store level: the write
  // route's landing is createConnection under the person's key).
  await store.createConnection(TENANT, PERSON, {
    personId: PERSON, seatId: 'groq', entryId: 'registry-weather',
    accountIdentity: 'weather-user',
    accessTokenRef: null,
    refreshTokenRef: null,
    grantedScopes: [],
    posture: 'ask',
  });
  // The set law (SYNC S1): the connection is the workspace set's
  // connection for Weather, so every seat's Weather row reads
  // connected — that sharing is the product's standing rule, and
  // the panel's Connect button states it in its own title.
  for (const seatId of LIVE_SEATS) {
    const view = await read.readSeatLibrary(TENANT, { personId: PERSON, seatId });
    const weather = view.rows.find((r) => r.entryId === 'registry-weather');
    assert.ok(weather, `${seatId}: the Weather row stands`);
    assert.equal(weather.state, 'connected', `${seatId}: Weather reads connected (the set's one connection)`);
    // No other entry connected anywhere: the connection did not
    // leak sideways onto any other connector.
    const others = view.rows.filter((r) => r.entryId !== 'registry-weather' && r.state === 'connected');
    assert.deepEqual(others.map((r) => r.entryId), [], `${seatId}: nothing else connected`);
  }
  // Another person: Weather stands not-connected on every seat.
  for (const seatId of ['groq', 'nvidia', 'claude']) {
    const view = await read.readSeatLibrary(TENANT, { personId: OTHER_PERSON, seatId });
    const weather = view.rows.find((r) => r.entryId === 'registry-weather');
    assert.equal(weather.state, 'not-connected', `${seatId}: another person sees no connection`);
  }
  // Another tenant: nothing connected at all.
  const otherTenant = await read.readSeatLibrary(TENANT_B, { personId: PERSON, seatId: 'groq' });
  assert.deepEqual(otherTenant.rows.filter((r) => r.state === 'connected'), [], 'another tenant: nothing connected');
});

test('reconnect round trip: Weather connects, disconnects, and connects again, same seat and cross-seat', async () => {
  const { store, read } = await makeWorld();
  const weatherState = async (seatId) => {
    const view = await read.readSeatLibrary(TENANT, { personId: PERSON, seatId });
    return view.rows.find((r) => r.entryId === 'registry-weather').state;
  };
  const connect = (seatId) => store.createConnection(TENANT, PERSON, {
    personId: PERSON, seatId, entryId: 'registry-weather',
    accountIdentity: 'No sign-in', accessTokenRef: null, refreshTokenRef: null,
    grantedScopes: [], posture: 'ask',
  });

  // Connect through NVIDIA's row (the seat the 2026-11-15 live
  // proof used): the set's one connection, read on every seat.
  const first = await connect('nvidia');
  assert.equal(first.state, 'connected');
  assert.equal(await weatherState('claude'), 'connected');

  // A second connect over the live connection is still refused —
  // the slot is occupied, on the very seat that holds the row.
  await assert.rejects(() => connect('nvidia'), /already has a connection for this connector/);

  // Disconnect from another seat: the whole set reads
  // not-connected (the regression the live proof caught: from
  // here, every Connect road used to refuse forever).
  const gone = await store.disconnectConnection(TENANT, { personId: PERSON, seatId: 'claude', entryId: 'registry-weather' }, PERSON);
  assert.equal(gone.connection.state, 'disconnected');
  assert.equal(await weatherState('nvidia'), 'not-connected');
  assert.equal(await weatherState('claude'), 'not-connected');

  // Reconnect from the seat whose row stands disconnected: the
  // row revives in place — the same record, never a second one.
  const back = await connect('nvidia');
  assert.equal(back.state, 'connected');
  assert.equal(back.id, first.id, 'the disconnected row revives in place');
  assert.equal(await weatherState('claude'), 'connected');

  // Disconnect again, then reconnect from a seat that holds no
  // row of its own: a fresh row lands there and becomes the set's.
  await store.disconnectConnection(TENANT, { personId: PERSON, seatId: 'nvidia', entryId: 'registry-weather' }, PERSON);
  assert.equal(await weatherState('claude'), 'not-connected');
  const fresh = await connect('claude');
  assert.equal(fresh.state, 'connected');
  assert.notEqual(fresh.id, first.id, 'a fresh physical row for the new connection');
  assert.equal(await weatherState('nvidia'), 'connected');

  // And the cycle closes a second time from the first seat: its
  // older disconnected row revives again, so connect and
  // disconnect stay symmetric however often they alternate.
  await store.disconnectConnection(TENANT, { personId: PERSON, seatId: 'claude', entryId: 'registry-weather' }, PERSON);
  assert.equal(await weatherState('nvidia'), 'not-connected');
  const again = await connect('nvidia');
  assert.equal(again.state, 'connected');
  assert.equal(again.id, first.id, 'the first seat’s own row revives again');
  assert.equal(await weatherState('claude'), 'connected');
});

test('state walls: the channel arm toggles are per seat — arming on one seat arms it on no other', () => {
  let toggles = emptyConnectorToggles();
  toggles = toggleConnector(toggles, 'channel:c1', 'groq', 'registry-weather');
  assert.equal(isConnectorOn(toggles, 'channel:c1', 'groq', 'registry-weather'), true, 'armed on groq');
  for (const seatId of LIVE_SEATS) {
    if (seatId === 'groq') continue;
    assert.equal(isConnectorOn(toggles, 'channel:c1', seatId, 'registry-weather'), false, `${seatId}: not armed`);
  }
  assert.equal(isConnectorOn(toggles, 'channel:c2', 'groq', 'registry-weather'), false, 'another channel: not armed');
});

// ------------------------------------------------------------ manage model

test('manage model: each row’s acts follow its own facts, on every seat', async () => {
  const { store, read } = await makeWorld();
  await store.createConnection(TENANT, PERSON, {
    personId: PERSON, seatId: 'groq', entryId: 'registry-weather',
    accountIdentity: 'weather-user',
    accessTokenRef: null,
    refreshTokenRef: null,
    grantedScopes: [],
    posture: 'ask',
  });
  for (const seatId of LIVE_SEATS) {
    const view = await read.readSeatLibrary(TENANT, { personId: PERSON, seatId });
    const model = manageModel(view, emptyConnectorToggles(), 'channel:c1');
    const byId = new Map(model.rows.map((r) => [r.entryId, r]));
    const weather = byId.get('registry-weather');
    assert.equal(weather.canArm, true, `${seatId}: connected Weather can be armed`);
    assert.equal(weather.canDisconnect, true, `${seatId}: connected Weather can be disconnected`);
    assert.equal(weather.canToolAccess, true, `${seatId}: connected Weather carries tool access`);
    assert.equal(weather.canConnect, false, `${seatId}: connected Weather offers no Connect`);
    const notion = byId.get('registry-notion');
    assert.equal(notion.canConnect, true, `${seatId}: not-connected Notion carries Connect`);
    assert.equal(notion.canDisconnect, false, `${seatId}: not-connected Notion offers no disconnect`);
    assert.equal(notion.canArm, false, `${seatId}: not-connected Notion cannot be armed`);
    const native = byId.get('helmian-github');
    assert.equal(native.canDisconnect, false, `${seatId}: the native never carries disconnect — its state is not a connection record`);
    assert.equal(native.isMirror, false, `${seatId}: the native is not a mirror`);
  }
  // A mirror's manage facts: no Helmian act at all.
  const gemini = await read.readSeatLibrary(TENANT, { personId: PERSON, seatId: 'gemini' });
  const geminiManage = manageModel(gemini, emptyConnectorToggles(), 'channel:c1');
  const gmailMirror = geminiManage.rows.find((r) => r.entryId === 'gmail');
  assert.equal(gmailMirror.isMirror, true, 'gemini/gmail: a vendor mirror');
  assert.equal(gmailMirror.canArm, false, 'gemini/gmail: no arm');
  assert.equal(gmailMirror.canConnect, false, 'gemini/gmail: no Connect');
  assert.equal(gmailMirror.canDisconnect, false, 'gemini/gmail: no disconnect');
  assert.equal(gmailMirror.canToolAccess, false, 'gemini/gmail: no tool access');
});
