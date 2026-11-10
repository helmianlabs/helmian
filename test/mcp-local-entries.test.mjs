// MCP-local entries (ledger join direction 1, finished): the
// migration sql/080 gives connector_entries a fourth kind —
// 'mcp-local', a stdio server the install pipeline placed on a
// person's machine — and the install-report action now creates the
// real entry from a valid report. These pins hold:
//
//   (a) the migration's shape and its safety argument: the kind set
//       widened, the local-facts columns added, sql/074's broker
//       predicate preserved verbatim for every existing kind, and
//       NO data statement against connector_entries anywhere in
//       the file — existing rows are judged, never rewritten;
//   (b) the store's line: an mcp-local entry's lawful shape (local
//       facts instead of an endpoint; authMode 'none'; the
//       'verified' label the pipeline earns), refusals for every
//       wrong shape, and no local facts on any other kind;
//   (c) the install-report action end to end: the entry is created
//       with the pipeline baseline recorded ON it (the same
//       fingerprint the local ledger keeps), a duplicate report
//       returns the one entry — never a second row — and a
//       re-report with a new baseline refreshes that entry;
//   (d) the read: an mcp-local row presents like other
//       Helmian-brokered entries with its local facts on the row,
//       and never reads 'connected';
//   (e) arming honesty: dispatch resolves an mcp-local pair to a
//       'local-only' record BEFORE any connection or token is read,
//       the record carries the local facts, and the runner's
//       sanitizer passes them through shape-checked;
//   (f) no connect road records a connection for a local install
//       (route refusal + the store's own refusal).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runInstallPipeline } from '../src/core/mcp-install-pipeline.mjs';
import { createConnectorLibraryStore } from '../src/cloud/connector-library.mjs';
import { createConnectorLibraryWriteHandler } from '../src/cloud/connector-library-write-route.mjs';
import { createSeatLibraryRead } from '../src/cloud/connector-library-read.mjs';
import { resolveArmingRecord } from '../src/cloud/connector-arming-dispatch.mjs';
import { sanitizeArmingRecords } from '../src/agent/connector-arming.mjs';

class TenantAuthorizationError extends Error {}

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const BENIGN = join(repoRoot, 'test-support', 'mcp-candidates', 'benign-unit-converter');
const TENANT = 'tenant-a';
const OWNER = { subject: 'user:troy', tenantId: TENANT, role: 'owner' };
const APPROVE = async () => ({
  stage: 'approval', approved: true, challenge: 'test-phrase',
  respondedAt: new Date().toISOString(), reason: 'test harness approved',
});

let installedCache = null;
async function installedReport() {
  if (!installedCache) {
    const scratch = await mkdtemp(join(tmpdir(), 'helmion-mcp-local-'));
    const report = await runInstallPipeline({
      root: BENIGN,
      ledgerDir: join(scratch, 'ledger'),
      installRoot: join(scratch, 'servers'),
      connectionString: null,
      approve: APPROVE,
    });
    installedCache = { scratch, report };
  }
  return installedCache;
}

// ------------------------------------------------------------ fake pool
// Exactly the queries the entry paths issue, with the extended
// (sql/080) column set: the insert's values arrive in the store's
// column order, local facts last before the state literal.
function fakePool() {
  const entries = new Map();
  let tenant = null;
  const entryKey = (seat, id) => `${tenant}|${seat}|${id}`;
  const now = () => new Date();
  return {
    entries,
    async connect() {
      return {
        release() {},
        async query(text, vals = []) {
          if (text.includes("set_config('helmion.tenant_id'")) { tenant = vals[0]; return { rows: [], rowCount: 0 }; }
          if (['begin', 'commit', 'rollback'].includes(text.trim())) return { rows: [], rowCount: 0 };
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
              installed_path: installedPath,
              config_snippet: configSnippetJson ? JSON.parse(configSnippetJson) : null,
              baseline_fingerprint: baselineFingerprint,
              state: 'available', created_at: now(), updated_at: now(),
            };
            entries.set(entryKey(seatId, id), row);
            return { rows: [row], rowCount: 1 };
          }
          if (text.includes('update helmion.connector_entries')) {
            const row = entries.get(entryKey(vals[0], vals[1]));
            if (!row) return { rows: [], rowCount: 0 };
            const [, , name, oneLiner, iconRef, vendorName, trustLabel, category, endpoint,
              vendorRefJson, authMode, clientIdentity, scopesSummary, workspaceProvisioned,
              installedPath, configSnippetJson, baselineFingerprint] = vals;
            Object.assign(row, {
              name, one_liner: oneLiner, icon_ref: iconRef, vendor_name: vendorName,
              trust_label: trustLabel, category, mcp_endpoint_url: endpoint,
              vendor_connector_ref: vendorRefJson ? JSON.parse(vendorRefJson) : null,
              auth_mode: authMode, client_identity: clientIdentity, scopes_summary: scopesSummary,
              workspace_provisioned: workspaceProvisioned, installed_path: installedPath,
              config_snippet: configSnippetJson ? JSON.parse(configSnippetJson) : null,
              baseline_fingerprint: baselineFingerprint, updated_at: now(),
            });
            return { rows: [row], rowCount: 1 };
          }
          if (text.includes('from helmion.connector_entries')) {
            const [seatId, id] = vals;
            const all = [...entries.values()].filter((r) => r.tenant_id === tenant && r.seat_id === seatId);
            const rows = id ? all.filter((r) => r.id === id) : all;
            return { rows, rowCount: rows.length };
          }
          if (text.includes('from helmion.connector_connections')) return { rows: [], rowCount: 0 };
          if (text.includes('from helmion.connector_mirrors')) return { rows: [], rowCount: 0 };
          throw new Error(`fake pool: unhandled query: ${text.slice(0, 80)}`);
        },
      };
    },
  };
}

function fakeToolConnections() {
  const rows = new Map();
  const calls = [];
  const keyOf = (k) => `${k.scopeKind}|${k.scopeId}|${k.serviceId}`;
  return {
    calls,
    async register(tenantId, subject, input) {
      calls.push(['register', input, subject]);
      if ('state' in input) throw Object.assign(new Error('state cannot be set at registration'), { status: 400 });
      const row = {
        tenantId, scopeKind: input.scopeKind, scopeId: input.scopeId, serviceId: input.serviceId,
        kind: input.kind, serverRef: input.serverRef, credentialReference: null,
        accountLabel: input.accountLabel ?? null, state: 'registered',
        lastVerifiedAt: null, lastToolsCount: null, updatedBySubject: subject,
      };
      rows.set(keyOf(input), row);
      return row;
    },
    async get(tenantId, key) { return rows.get(keyOf(key)) ?? null; },
  };
}

function writeHarness({ store, toolConnections, actor = OWNER }) {
  const handler = createConnectorLibraryWriteHandler({
    store,
    toolConnections,
    gateProbe: async () => { throw new Error('no gate probe in this harness'); },
    fetchImpl: async () => { throw new Error('no network in tests'); },
  });
  const sent = [];
  return {
    sent,
    async run(path, { body = {}, method = 'POST' } = {}) {
      const handled = await handler({
        request: { method },
        response: {},
        requestUrl: new URL(path, 'https://helmian.cloud'),
        activeTenantActor: async () => actor,
        send: (response, status, payload, contentType) => { sent.push({ status, payload, contentType }); },
        TenantAuthorizationError,
        readJson: async () => body,
      });
      const last = sent[sent.length - 1];
      let json = null;
      try { json = JSON.parse(last?.payload ?? ''); } catch { /* html */ }
      return { handled, status: last?.status, json };
    },
  };
}

const LOCAL_INPUT = (report) => ({
  seatId: 'claude',
  id: report.libraryReport.entryId,
  kind: 'mcp-local',
  brokerMode: 'helmian',
  name: report.serverName,
  oneLiner: 'Local MCP server on a person\u2019s machine, installed by the Helmian install pipeline',
  vendorName: 'Helmian',
  authMode: 'none',
  installedPath: report.installedPath,
  configSnippet: report.configSnippet,
  baselineFingerprint: report.libraryReport.baseline.fingerprint,
  addedBy: 'user:troy',
});

// ------------------------------------------------------- (a) migration

test('migration sql/080: kind widened, local columns added, 074 predicate preserved, no data rewritten', async () => {
  const sql = await readFile(join(repoRoot, 'sql', '080_connector_mcp_local_entries.sql'), 'utf8');
  // The kind set, widened by exactly one member.
  assert.match(sql, /check \(kind in \('catalog','helmian-native','custom','mcp-local'\)\)/);
  // The local facts as columns, added only if missing.
  for (const col of ['installed_path', 'config_snippet', 'baseline_fingerprint']) {
    assert.match(sql, new RegExp(`add column if not exists ${col}`), `${col} is added if not exists`);
  }
  // sql/074's broker predicate survives verbatim inside the
  // non-mcp-local disjunct — existing rows are judged by the rule
  // they were created under.
  assert.match(sql, /\(broker_mode = 'helmian' and mcp_endpoint_url is not null and vendor_connector_ref is null\)/);
  assert.match(sql, /\(broker_mode = 'vendor' and mcp_endpoint_url is null and vendor_connector_ref is not null\)/);
  // The mcp-local shape stands INSTEAD of the endpoint requirement.
  assert.match(sql, /kind = 'mcp-local'[\s\S]*?installed_path is not null[\s\S]*?config_snippet is not null/);
  // No data statement touches the entries table: the migration
  // judges existing rows, it never rewrites them.
  assert.ok(!/^\s*(update|insert into|delete from)\s+helmion\.connector_entries/im.test(sql),
    'sql/080 contains no UPDATE/INSERT/DELETE against connector_entries');
  // And the file fails loudly rather than guessing at the schema.
  assert.match(sql, /refusing to guess at the schema/);
});

// ------------------------------------------------------------ (b) store

test('store: an mcp-local entry is created with its local facts and no endpoint', async () => {
  const { report } = await installedReport();
  const store = createConnectorLibraryStore(fakePool());
  const entry = await store.createEntry(TENANT, 'user:troy', LOCAL_INPUT(report));
  assert.equal(entry.kind, 'mcp-local');
  assert.equal(entry.brokerMode, 'helmian');
  assert.equal(entry.mcpEndpointUrl, null);
  assert.equal(entry.vendorConnectorRef, null);
  assert.equal(entry.installedPath, report.installedPath);
  assert.deepEqual(entry.configSnippet, report.configSnippet);
  // The baseline recorded with the entry IS the pipeline ledger's
  // fingerprint — one hash, both tellings.
  assert.equal(entry.baselineFingerprint, report.stages.baseline.fingerprint);
  assert.equal(entry.trustLabel, 'verified');
  assert.equal(entry.authMode, 'none');
  const readBack = await store.getEntry(TENANT, 'claude', entry.id);
  assert.deepEqual(readBack, entry);
});

test('store: mcp-local shape refusals — endpoint, relative path, sign-in mode, wrong label, foreign snippet', async () => {
  const { report } = await installedReport();
  const store = createConnectorLibraryStore(fakePool());
  const base = LOCAL_INPUT(report);
  await assert.rejects(() => store.createEntry(TENANT, 'user:troy', { ...base, mcpEndpointUrl: 'https://example.com/mcp' }),
    /has no mcpEndpointUrl/);
  await assert.rejects(() => store.createEntry(TENANT, 'user:troy', { ...base, installedPath: 'relative/dir' }),
    /absolute path/);
  await assert.rejects(() => store.createEntry(TENANT, 'user:troy', { ...base, authMode: 'oauth' }),
    /authMode is "none"/);
  await assert.rejects(() => store.createEntry(TENANT, 'user:troy', { ...base, trustLabel: 'community' }),
    /trust-labelled "verified"/);
  await assert.rejects(() => store.createEntry(TENANT, 'user:troy', { ...base, baselineFingerprint: 'xyz' }),
    /sha256 hex/);
  await assert.rejects(() => store.createEntry(TENANT, 'user:troy', {
    ...base,
    configSnippet: { mcpServers: { 'another-server': { command: 'node', args: ['x.js'] } } },
  }), /carry this server's \{ command, args \} entry/);
  await assert.rejects(() => store.createEntry(TENANT, 'user:troy', { ...base, installedPath: undefined, configSnippet: undefined }),
    /installedPath is required/);
});

test('store: local facts are refused on every other kind', async () => {
  const { report } = await installedReport();
  const store = createConnectorLibraryStore(fakePool());
  const custom = {
    seatId: 'claude', id: 'custom-x', kind: 'custom', brokerMode: 'helmian', name: 'X',
    oneLiner: 'x', vendorName: 'Custom', authMode: 'none',
    mcpEndpointUrl: 'https://example.com/mcp', addedBy: 'user:troy',
  };
  await assert.rejects(() => store.createEntry(TENANT, 'user:troy', { ...custom, installedPath: report.installedPath }),
    /belongs to mcp-local entries only/);
  await assert.rejects(() => store.createEntry(TENANT, 'user:troy', { ...custom, baselineFingerprint: report.libraryReport.baseline.fingerprint }),
    /belongs to mcp-local entries only/);
});

test('store: no connection can be recorded for a local install', async () => {
  const { report } = await installedReport();
  const store = createConnectorLibraryStore(fakePool());
  const entry = await store.createEntry(TENANT, 'user:troy', LOCAL_INPUT(report));
  await assert.rejects(() => store.createConnection(TENANT, 'user:troy', {
    personId: 'user:troy', seatId: 'claude', entryId: entry.id, accountIdentity: 'No sign-in',
  }), /Helmian holds no connection for it/);
});

// ------------------------------------------------------ (c) the action

test('install-report: creates the entry with the baseline on it; a duplicate report returns the one entry', async () => {
  const { report } = await installedReport();
  const pool = fakePool();
  const store = createConnectorLibraryStore(pool);
  const tc = fakeToolConnections();
  const h = writeHarness({ store, toolConnections: tc });

  const first = await h.run('/api/admin/connector-library/entries/install-report', {
    body: { seatId: 'claude', installReport: report.libraryReport },
  });
  assert.equal(first.status, 201);
  assert.equal(first.json.entryCreated, true);
  assert.equal(first.json.libraryEntry.kind, 'mcp-local');
  assert.equal(first.json.libraryEntry.baselineFingerprint, report.libraryReport.baseline.fingerprint);
  assert.equal(first.json.baseline.recordedInLibrary, true);
  assert.equal(first.json.toolConnection.state, 'registered');

  const second = await h.run('/api/admin/connector-library/entries/install-report', {
    body: { seatId: 'claude', installReport: report.libraryReport },
  });
  assert.equal(second.status, 201);
  assert.equal(second.json.entryCreated, false);
  assert.equal(second.json.libraryEntry.id, first.json.libraryEntry.id);
  assert.equal(pool.entries.size, 1, 'a duplicate report never makes a second row');

  // A re-report after a re-install (a new baseline under the same
  // derived id) refreshes the one entry's recorded fingerprint.
  const NEW_FP = 'a'.repeat(64);
  const reinstalled = {
    ...report.libraryReport,
    baseline: { ...report.libraryReport.baseline, fingerprint: NEW_FP },
  };
  const third = await h.run('/api/admin/connector-library/entries/install-report', {
    body: { seatId: 'claude', installReport: reinstalled },
  });
  assert.equal(third.status, 201);
  assert.equal(third.json.entryCreated, false);
  assert.equal(third.json.libraryEntry.baselineFingerprint, NEW_FP);
  assert.equal(pool.entries.size, 1);
});

// ------------------------------------------------------------ (d) read

test('read: an mcp-local row carries its local facts and never reads connected', async () => {
  const { report } = await installedReport();
  const pool = fakePool();
  const store = createConnectorLibraryStore(pool);
  const entry = await store.createEntry(TENANT, 'user:troy', LOCAL_INPUT(report));
  const read = createSeatLibraryRead({ libraryStore: store, toolConnectionsStore: null });
  const out = await read.readSeatLibrary(TENANT, { personId: 'user:troy', seatId: 'claude' });
  const row = out.rows.find((r) => r.entryId === entry.id);
  assert.ok(row, 'the mcp-local entry is a row in the seat library');
  assert.equal(row.kind, 'mcp-local');
  assert.equal(row.brokerMode, 'helmian');
  assert.equal(row.state, 'not-connected');
  assert.equal(row.stateDetail.source, 'mcp-install-pipeline');
  assert.equal(row.stateDetail.local.installedPath, report.installedPath);
  assert.equal(row.stateDetail.local.baselineFingerprint, report.libraryReport.baseline.fingerprint);
  assert.deepEqual(row.localInstall, {
    installedPath: report.installedPath,
    configSnippet: report.configSnippet,
    baselineFingerprint: report.libraryReport.baseline.fingerprint,
  });
  assert.equal(out.connectedCount, 0);
});

// --------------------------------------------------------- (e) arming

test('dispatch: an mcp-local pair resolves local-only before any connection or token is read', async () => {
  const { report } = await installedReport();
  const entry = {
    seatId: 'claude', id: report.libraryReport.entryId, kind: 'mcp-local', name: report.serverName,
    brokerMode: 'helmian', mcpEndpointUrl: null, authMode: 'none', state: 'available',
    vendorName: 'Helmian', installedPath: report.installedPath,
    configSnippet: report.configSnippet, baselineFingerprint: report.libraryReport.baseline.fingerprint,
  };
  const calls = [];
  const store = {
    async getEntry() { calls.push('getEntry'); return entry; },
    async getConnection() { calls.push('getConnection'); return { state: 'connected', posture: 'all', toolEnableMap: {} }; },
    async getCurrentSnapshot() { calls.push('getCurrentSnapshot'); return { tools: [] }; },
  };
  const credentials = {
    async resolveVaultCredential() { calls.push('resolveVaultCredential'); return { accepted: true, credential: 'tok' }; },
  };
  const record = await resolveArmingRecord({
    store, credentials, listTools: async () => { calls.push('listTools'); return { supported: true, tools: [] }; },
    operatorTokens: {}, tenantId: TENANT, personId: 'user:troy', seatId: 'claude', entryId: entry.id,
  });
  assert.equal(record.state, 'local-only');
  assert.equal(record.reason, 'local-only');
  assert.match(record.detail, /local install on a person/);
  assert.equal(record.accessToken, undefined);
  assert.deepEqual(record.localInstall, {
    installedPath: report.installedPath,
    configSnippet: report.configSnippet,
    baselineFingerprint: report.libraryReport.baseline.fingerprint,
  });
  assert.deepEqual(calls, ['getEntry'], 'the connection, token, and tool roads are never walked for a local install');

  // The runner's door passes the local facts through, shape-checked.
  const [clean] = sanitizeArmingRecords([record]);
  assert.equal(clean.state, 'local-only');
  assert.deepEqual(clean.localInstall, record.localInstall);
  const [spoiled] = sanitizeArmingRecords([{ ...record, localInstall: { installedPath: 42, configSnippet: ['nope'], baselineFingerprint: 'zz' } }]);
  assert.deepEqual(spoiled.localInstall, { installedPath: null, configSnippet: null, baselineFingerprint: 'zz' });
});

// ------------------------------------------------------- (f) no connect

test('connect: the connect road refuses a local install plainly', async () => {
  const { report } = await installedReport();
  const pool = fakePool();
  const store = createConnectorLibraryStore(pool);
  await store.createEntry(TENANT, 'user:troy', LOCAL_INPUT(report));
  const h = writeHarness({ store, toolConnections: fakeToolConnections() });
  const out = await h.run('/api/admin/connector-library/connect', {
    body: { seatId: 'claude', entryId: report.libraryReport.entryId },
  });
  assert.equal(out.status, 400);
  assert.equal(out.json.code, 'MCP_LOCAL_NOT_CONNECTABLE');
  assert.match(out.json.error, /local install on a person/);
});
