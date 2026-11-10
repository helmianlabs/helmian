// The ledger join (pipeline map §3, gap G2): the install pipeline
// and the connector library each keep a ledger of "what tools this
// workspace allowed" — these pins hold the bridge between them.
//
// Direction 1 (pipeline → library):
//   (a) only an INSTALLED pipeline produces a library report, and
//       the report's baseline fingerprint is the ledger's own;
//   (b) the report's validation refuses credential values, state
//       assertions, a self-named entry id, and a relative path;
//   (c) the write route's install-report action records INTENT in
//       the tool-connections store (kind 'mcp-stdio', state
//       'registered', never 'verified'), is owner/admin-gated, and
//       answers with the library entry honestly NOT created — the
//       sql/074 wall named, not papered over.
//
// Direction 2 (library → pipeline):
//   (d) a connection's FIRST frozen snapshot is its arming baseline
//       (store getFirstSnapshot), distinct from its current one;
//   (e) the export the admin read produces carries baseline +
//       current + the library's own drift verdict;
//   (f) ONE DRIFT STORY: the same raw tool list plans to the same
//       snapshotHash on both sides (planToolSnapshot is the single
//       function both call); a changed list names its drift in the
//       pipeline-side check AND in the export's own verdict;
//   (g) the CLI drift road consumes the export (--arming-baseline /
//       --tools-file are wired in bin/helmion.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildInstallLibraryReport,
  mcpLocalEntryId,
  mcpLocalToolConnectionKey,
  validateInstallLibraryReport,
} from '../src/core/mcp-library-report.mjs';
import { runInstallPipeline } from '../src/core/mcp-install-pipeline.mjs';
import {
  checkToolListAgainstArmingBaseline,
  loadArmingBaselineExport,
  readLedger,
} from '../src/core/mcp-install-ledger.mjs';
import { createConnectorLibraryStore, planToolSnapshot } from '../src/cloud/connector-library.mjs';
import {
  buildArmingBaselineExport,
  parseArmingBaselineExport,
} from '../src/cloud/connector-arming-baseline.mjs';
import { createConnectorLibraryWriteHandler } from '../src/cloud/connector-library-write-route.mjs';
import {
  handleConnectorLibraryRoute,
  CONNECTOR_LIBRARY_ARMING_BASELINE_PATH,
} from '../src/cloud/connector-library-read-route.mjs';

class TenantAuthorizationError extends Error {}

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const BENIGN = join(repoRoot, 'test-support', 'mcp-candidates', 'benign-unit-converter');
const TENANT = 'tenant-a';
const OWNER = { subject: 'user:troy', tenantId: TENANT, role: 'owner' };
const MEMBER = { subject: 'user:member', tenantId: TENANT, role: 'member' };

const APPROVE = async () => ({
  stage: 'approval', approved: true, challenge: 'test-phrase',
  respondedAt: new Date().toISOString(), reason: 'test harness approved',
});

async function installedReport() {
  const scratch = await mkdtemp(join(tmpdir(), 'helmion-ledger-join-'));
  const report = await runInstallPipeline({
    root: BENIGN,
    ledgerDir: join(scratch, 'ledger'),
    installRoot: join(scratch, 'servers'),
    connectionString: null,
    approve: APPROVE,
  });
  return { scratch, report };
}

// ------------------------------------------------------------ direction 1

test('direction 1: an installed pipeline produces a library report carrying the ledger baseline', async () => {
  const { scratch, report } = await installedReport();
  try {
    assert.equal(report.finalDecision, 'installed');
    const lib = report.libraryReport;
    assert.ok(lib, 'installed report carries a libraryReport');
    assert.equal(lib.kind, 'mcp-local');
    assert.equal(lib.brokerMode, 'helmian');
    assert.equal(lib.entryId, 'mcp-local-unit-converter-mcp');
    assert.equal(lib.entryId, mcpLocalEntryId(report.serverName));
    assert.equal(lib.installedPath, report.installedPath);
    assert.deepEqual(lib.configSnippet, report.configSnippet);
    assert.equal(lib.baseline.fingerprint, report.stages.baseline.fingerprint);
    assert.deepEqual(lib.declaredTools, ['currency.convert', 'units.convert', 'units.list']);
    // The local ledger's own installed record names the derived id —
    // the two ledgers agree on what the server is called.
    const ledger = await readLedger({ ledgerDir: join(scratch, 'ledger') });
    const installed = ledger.find((e) => e.decision === 'installed');
    assert.equal(installed.detail.libraryEntryId, 'mcp-local-unit-converter-mcp');
    assert.equal(installed.detail.fingerprint, lib.baseline.fingerprint);
    // And the produced report passes its own receiving-end validation.
    assert.equal(validateInstallLibraryReport(lib).entryId, lib.entryId);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('direction 1: a pipeline that installs nothing produces no library report', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'helmion-ledger-join-'));
  try {
    const report = await runInstallPipeline({
      root: BENIGN,
      ledgerDir: join(scratch, 'ledger'),
      installRoot: join(scratch, 'servers'),
      connectionString: null,
      approve: async () => ({
        stage: 'approval', approved: false, challenge: 'test-phrase',
        respondedAt: new Date().toISOString(), reason: 'human declined',
      }),
    });
    assert.equal(report.finalDecision, 'rejected-by-human');
    assert.equal(report.libraryReport, null);
    assert.equal(buildInstallLibraryReport(report), null);
    assert.equal(buildInstallLibraryReport({ finalDecision: 'blocked-by-code-read' }), null);
    assert.equal(buildInstallLibraryReport(null), null);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('direction 1: report validation refuses credentials, state claims, self-named ids, relative paths', async () => {
  const { scratch, report } = await installedReport();
  try {
    const lib = report.libraryReport;
    assert.throws(() => validateInstallLibraryReport({ ...lib, accessToken: 'sk-live' }), /credential value never rides/);
    assert.throws(() => validateInstallLibraryReport({ ...lib, state: 'verified' }), /may not assert a state/);
    assert.throws(() => validateInstallLibraryReport({ ...lib, entryId: 'custom-squatter' }), /derived from its serverName/);
    assert.throws(() => validateInstallLibraryReport({ ...lib, installedPath: 'relative/dir' }), /absolute path/);
    assert.throws(() => validateInstallLibraryReport({ ...lib, baseline: { ...lib.baseline, fingerprint: 'xyz' } }), /ledger fingerprint/);
    assert.throws(() => validateInstallLibraryReport({ ...lib, kind: 'custom' }), /kind must be/);
    assert.equal(mcpLocalToolConnectionKey('claude', 'unit-converter-mcp').serviceId, 'mcp-local-unit-converter-mcp');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// A tool-connections fake with the real store's contract in JS:
// register writes intent only and refuses a caller-supplied state.
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

function writeHarness({ actor = OWNER, toolConnections } = {}) {
  const handler = createConnectorLibraryWriteHandler({
    store: {}, // presence only — the install-report action never touches the library store
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

test('direction 1: the install-report action records intent — registered, never verified — and names the entry wall', async () => {
  const { scratch, report } = await installedReport();
  try {
    const tc = fakeToolConnections();
    const h = writeHarness({ toolConnections: tc });
    const out = await h.run('/api/admin/connector-library/entries/install-report', {
      body: { seatId: 'claude', installReport: report.libraryReport },
    });
    assert.equal(out.status, 201);
    assert.equal(out.json.status, 'install-recorded');
    assert.equal(out.json.entryId, 'mcp-local-unit-converter-mcp');
    // The intent row: the gate's receipt path, a local-stdio kind,
    // the installed path as the server ref, no credential reference.
    const register = tc.calls.find(([n]) => n === 'register');
    assert.ok(register, 'register() was called');
    assert.equal(register[1].kind, 'mcp-stdio');
    assert.equal(register[1].serverRef, report.installedPath);
    assert.equal(register[1].scopeId, 'claude');
    assert.equal(register[1].serviceId, 'mcp-local-unit-converter-mcp');
    assert.equal(register[1].credentialReference, null);
    assert.equal(register[2], 'user:troy');
    assert.equal(out.json.toolConnection.state, 'registered');
    assert.equal(out.json.toolConnection.lastVerifiedAt, null);
    // The entry is honestly NOT created, and the answer names why
    // and what road is missing — no fabricated row, no fake URL.
    assert.equal(out.json.libraryEntry, null);
    assert.match(out.json.entryNotCreated.blockedBy, /sql\/074/);
    assert.match(out.json.entryNotCreated.missingRoad, /migration/);
    // The baseline fingerprint is echoed as received, with its
    // durable home named — not dressed up as recorded in the library.
    assert.equal(out.json.baseline.fingerprint, report.libraryReport.baseline.fingerprint);
    assert.equal(out.json.baseline.recordedInLibrary, false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('direction 1: the install-report action is owner-gated and refuses credential values', async () => {
  const { scratch, report } = await installedReport();
  try {
    const memberHarness = writeHarness({ actor: MEMBER, toolConnections: fakeToolConnections() });
    const asMember = await memberHarness.run('/api/admin/connector-library/entries/install-report', {
      body: { seatId: 'claude', installReport: report.libraryReport },
    });
    assert.equal(asMember.status, 403);

    const tc = fakeToolConnections();
    const h = writeHarness({ toolConnections: tc });
    const withSecret = await h.run('/api/admin/connector-library/entries/install-report', {
      body: { seatId: 'claude', installReport: { ...report.libraryReport, apiKey: 'sk-live' } },
    });
    assert.equal(withSecret.status, 400);
    assert.equal(tc.calls.length, 0, 'a refused report records nothing');

    const noStore = writeHarness({ toolConnections: null });
    const unrecorded = await noStore.run('/api/admin/connector-library/entries/install-report', {
      body: { seatId: 'claude', installReport: report.libraryReport },
    });
    assert.equal(unrecorded.status, 503);
    assert.equal(unrecorded.json.code, 'INSTALL_REPORT_NOT_RECORDED');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ direction 2

// A compact fake pool carrying exactly the queries the snapshot
// flow issues (the connector-library.test.mjs fake's semantics,
// narrowed to entries/connections/snapshots).
function fakePool() {
  const entries = new Map();
  const connections = new Map();
  const snapshots = new Map();
  let tenant = null;
  let connSeq = 0;
  let snapSeq = 0;
  const now = () => new Date();
  const entryKey = (seat, id) => `${tenant}|${seat}|${id}`;
  const connKey = (p, s, e) => `${tenant}|${p}|${s}|${e}`;
  return {
    async connect() {
      return {
        async query(text, vals = []) {
          if (text.includes("set_config('helmion.tenant_id'")) { tenant = vals[0]; return { rows: [], rowCount: 0 }; }
          if (['begin', 'commit', 'rollback'].includes(text.trim())) return { rows: [], rowCount: 0 };
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
          if (text.includes('from helmion.connector_entries')) {
            const row = entries.get(entryKey(vals[0], vals[1]));
            return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
          }
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
          if (text.includes('insert into helmion.connector_snapshots')) {
            const row = {
              id: ++snapSeq, tenant_id: tenant, connection_id: vals[0],
              taken_at: now(), tools: JSON.parse(vals[1]), snapshot_hash: vals[2],
            };
            snapshots.set(row.id, row);
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('from helmion.connector_snapshots') && text.includes('connection_id')) {
            const out = [...snapshots.values()]
              .filter((r) => r.connection_id === vals[0])
              .sort((a, b) => a.id - b.id);
            return { rows: out.length ? [{ ...out[0] }] : [], rowCount: out.length ? 1 : 0 };
          }
          if (text.includes('from helmion.connector_snapshots')) {
            const row = snapshots.get(vals[0]);
            return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
          }
          if (text.includes('update helmion.connector_connections')) {
            const row = connections.get(connKey(vals[0], vals[1], vals[2]));
            if (!row) return { rows: [], rowCount: 0 };
            if (text.includes('set tool_snapshot_ref = $4')) {
              row.tool_snapshot_ref = vals[3]; row.last_discovery_at = now(); row.tool_enable_map = JSON.parse(vals[4]);
            } else {
              throw new Error(`fake pool: unhandled connection update: ${text}`);
            }
            row.updated_at = now();
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('from helmion.connector_connections')) {
            const row = connections.get(connKey(vals[0], vals[1], vals[2]));
            return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
          }
          throw new Error(`fake pool: unhandled query: ${text}`);
        },
        release() {},
      };
    },
  };
}

const RAW_TOOLS_V1 = [
  { name: 'read_weather', description: 'Read the weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'set_alert', description: 'Set an alert', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false } },
];
const RAW_TOOLS_V2 = [
  { name: 'read_weather', description: 'Read the weather', inputSchema: { type: 'object', properties: { city: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'set_alert', description: 'Set an alert', inputSchema: { type: 'object', properties: { level: { type: 'string' } } }, annotations: { readOnlyHint: false } },
  { name: 'send_sms', description: 'Text the alert', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false } },
];

test('direction 2: first snapshot is the arming baseline; export and pipeline check tell one drift story', async () => {
  const store = createConnectorLibraryStore(fakePool());
  const key = { personId: 'user:troy', seatId: 'claude', entryId: 'custom-weather' };
  const entry = await store.createEntry(TENANT, 'user:troy', {
    seatId: 'claude', id: 'custom-weather', kind: 'custom', name: 'Weather', oneLiner: 'Weather tools',
    vendorName: 'Custom', brokerMode: 'helmian', mcpEndpointUrl: 'https://weather.example/mcp', authMode: 'none',
    addedBy: 'user:troy',
  });
  await store.createConnection(TENANT, 'user:troy', { ...key, accountIdentity: 'No sign-in', grantedScopes: [] });

  // First freeze (at connect / first arm in production): THE baseline.
  const first = await store.freezeSnapshot(TENANT, key, RAW_TOOLS_V1, 'user:troy');
  assert.equal(await store.getFirstSnapshot(TENANT, key).then((s) => s.snapshotHash), first.snapshotHash);
  // Second freeze: the tool list grew — this is the current, not the baseline.
  const second = await store.freezeSnapshot(TENANT, key, RAW_TOOLS_V2, 'user:troy');
  const baseline = await store.getFirstSnapshot(TENANT, key);
  const current = await store.getCurrentSnapshot(TENANT, key);
  assert.equal(baseline.snapshotHash, first.snapshotHash);
  assert.equal(current.snapshotHash, second.snapshotHash);
  assert.notEqual(baseline.snapshotHash, current.snapshotHash);

  // The export: baseline + current + the library's own drift verdict.
  const doc = buildArmingBaselineExport({ entry, baselineSnapshot: baseline, currentSnapshot: current });
  assert.equal(doc.format, 'helmian-arming-baseline');
  assert.equal(doc.baseline.snapshotHash, first.snapshotHash);
  assert.equal(doc.current.snapshotHash, second.snapshotHash);
  assert.equal(doc.drift.drifted, true);
  assert.deepEqual(doc.drift.added, ['send_sms']);
  assert.deepEqual(doc.drift.changed, ['set_alert']);
  const parsed = parseArmingBaselineExport(doc);
  assert.equal(parsed.baselineHash, first.snapshotHash);

  // ONE HASH: the pipeline side plans the same raw list through the
  // same function and lands on the baseline's hash exactly.
  assert.equal(planToolSnapshot(RAW_TOOLS_V1).snapshotHash, first.snapshotHash);
  const same = checkToolListAgainstArmingBaseline({ baseline: doc, tools: RAW_TOOLS_V1 });
  assert.equal(same.status, 'unchanged');
  assert.equal(same.currentHash, same.baselineHash);
  // A changed list names its drift in the pipeline telling too —
  // the same tool names the export's diff named.
  const changed = checkToolListAgainstArmingBaseline({ baseline: doc, tools: RAW_TOOLS_V2 });
  assert.equal(changed.status, 'drift-detected');
  assert.deepEqual(changed.diff.added, ['send_sms']);
  assert.deepEqual(changed.diff.changed, ['set_alert']);
  assert.match(changed.message, /send_sms/);

  // The export survives the file road the drift command walks.
  const scratch = await mkdtemp(join(tmpdir(), 'helmion-baseline-'));
  try {
    const path = join(scratch, 'baseline.json');
    await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`);
    const loaded = await loadArmingBaselineExport(path);
    assert.equal(loaded.baseline.snapshotHash, first.snapshotHash);
    assert.equal(checkToolListAgainstArmingBaseline({ baseline: loaded, tools: RAW_TOOLS_V1 }).status, 'unchanged');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('direction 2: the arming-baseline read answers the export, refuses selectors, and never fabricates', async () => {
  const actor = { subject: 'user:troy', tenantId: TENANT, role: 'owner' };
  const sent = [];
  const call = async (url, armingBaseline) => {
    sent.length = 0;
    const handled = await handleConnectorLibraryRoute({
      request: { method: 'GET' },
      response: {},
      requestUrl: new URL(url, 'https://helmian.cloud'),
      activeTenantActor: async () => actor,
      send: (response, status, payload) => { sent.push({ status, payload }); },
      TenantAuthorizationError,
      armingBaseline,
    });
    const last = sent[sent.length - 1];
    return { handled, status: last?.status, json: last ? JSON.parse(last.payload) : null };
  };

  const withDoc = await call(`${CONNECTOR_LIBRARY_ARMING_BASELINE_PATH}?seat=claude&entry=custom-weather`, async () => ({
    export: { format: 'helmian-arming-baseline', version: 1, baseline: { snapshotHash: 'abc', tools: [] } },
  }));
  assert.equal(withDoc.handled, true);
  assert.equal(withDoc.status, 200);
  assert.equal(withDoc.json.export.format, 'helmian-arming-baseline');

  const nothing = await call(`${CONNECTOR_LIBRARY_ARMING_BASELINE_PATH}?seat=claude&entry=custom-weather`, async () => ({
    export: null, reason: 'no-frozen-snapshot',
  }));
  assert.equal(nothing.status, 200);
  assert.equal(nothing.json.export, null);
  assert.equal(nothing.json.reason, 'no-frozen-snapshot');

  const missing = await call(CONNECTOR_LIBRARY_ARMING_BASELINE_PATH, async () => ({ export: null }));
  assert.equal(missing.status, 400);

  const selector = await call(`${CONNECTOR_LIBRARY_ARMING_BASELINE_PATH}?seat=claude&entry=x&personId=user:other`, async () => ({ export: null }));
  assert.equal(selector.status, 400);
});

test('direction 2: the CLI drift road consumes the export (source pin)', async () => {
  const cli = await readFile(join(repoRoot, 'bin', 'helmion.mjs'), 'utf8');
  assert.match(cli, /--arming-baseline/);
  assert.match(cli, /--tools-file/);
  assert.match(cli, /checkToolListAgainstArmingBaseline/);
  assert.match(cli, /must be given together/);
});

test('export validation refuses a document with no baseline', () => {
  assert.throws(() => parseArmingBaselineExport({ format: 'helmian-arming-baseline', version: 1 }), /no baseline snapshot/);
  assert.throws(() => parseArmingBaselineExport({ format: 'other', version: 1, baseline: { snapshotHash: 'x', tools: [] } }), /format must be/);
  assert.throws(
    () => checkToolListAgainstArmingBaseline({ baseline: { format: 'helmian-arming-baseline', version: 1 }, tools: [] }),
    /no baseline snapshot/,
  );
});
