import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { level2Model, stateLabelFor } from '../app/connector-panel.mjs';
import * as workspace from '../app/envoy-workspace.js';
import { opensKeyFormFromSeed, seedKnownKeyEntries } from '../app/connector-key-form.mjs';

// Sync S2c (panel presentation) — a projected custom entry meets
// its person on a NON-provenance agent (sync S2a, server half):
// the entry was created on one agent and is projected into every
// agent's library under the same id, but the custom-entry GATE is
// per (seat, entry), so on an agent that never ran the gate the
// entry truthfully reads not-connected with its gate missing.
//
// COMPOSITION: this tree's bundled server predates S1/S2a, so the
// library read is stubbed here in its POST-S2a shape, taken from
// S2a's REPORT and its read-side code (rowOf in
// sync-s2a-custom-entries/tree/src/cloud/connector-library-read.mjs):
// the row answers in the READING seat's name (seatId 'gemini'),
// carries workspaceCustom + provenanceSeatId ('claude', the seat
// it was created on), kind 'custom', state 'not-connected', and
// stateDetail { gate } where the gate is THIS seat's own row —
// none exists, so customGateDetail(null) shapes it exactly as
// below (state 'missing', passed false, no receipt, no error).
//
// The truth this file pins for that row:
//   · the row APPEARS in this agent's library (the composed
//     plus-menu model stands it in the Connectors list);
//   · its state words are the connection-truth vocabulary —
//     not connected, with the plain next step named: connecting
//     runs its safety check for this agent (the gate, named the
//     way the panel's custom-form copy names it: "safety check").
//     A missing gate is NOT a fault: no "Not ready", no "has not
//     passed", no "failed" wording;
//   · its Connect is LIVE and reaches the connect start
//     (POST /api/admin/connector-library/connect) — the road
//     whose server side registers + probes THIS seat's gate
//     (S2a's proof: connecting via gemini created and verified
//     gemini's own gate row). For a header entry that includes
//     NOT taking the key form's read-seed shortcut, which would
//     skip the connect start entirely;
//   · every OTHER gate state keeps its old ruling: a check that
//     ran and failed, or is registered/probing, still blocks
//     Connect with its old words; a passed gate is a plain
//     "Not connected" with a live Connect.

const projectedRow = (over = {}) => ({
  // rowOf's shape, in its field order (S2a read-side code).
  iconRef: null,
  name: 'Weather Tools',
  oneLiner: 'Weather Tools',
  vendorLabel: 'Connector by Custom',
  trustLabel: 'custom',
  state: 'not-connected',
  entryId: 'custom-weather-tools',
  seatId: 'gemini',
  kind: 'custom',
  brokerMode: 'helmian',
  authMode: 'header',
  category: null,
  accountIdentity: null,
  stateDetail: {
    gate: { state: 'missing', passed: false, lastVerifiedAt: null, lastToolsCount: null, lastError: null },
  },
  workspaceCustom: true,
  provenanceSeatId: 'claude',
  ...over,
});

const libraryOf = (rows) => ({ seatId: 'gemini', personId: 'user:troy', connectedCount: 0, rows });

function flatModelRows(model) {
  const out = [];
  const walk = (rows) => { for (const r of rows ?? []) { out.push(r); if (r.rows) walk(r.rows); } };
  walk(model?.rows);
  return out;
}

test('sync S2c: a projected custom entry on a non-provenance agent appears, reads not-connected in plain words, and carries a live Connect', () => {
  const readRow = projectedRow();
  // The real Level 2 model over the stubbed post-S2a read.
  const level2 = level2Model(libraryOf([readRow]), {}, 'c1');
  assert.equal(level2.connected.length, 0, 'the row is not dressed up as connected');
  assert.equal(level2.catalog.length, 1, 'the row appears in this agent\u2019s library list');
  const row = level2.catalog[0];
  assert.equal(row.entryId, 'custom-weather-tools', 'the same entry id the creating agent holds — one entry, not a copy');
  assert.equal(row.seatId, 'gemini', 'the row answers in the reading agent\u2019s name');
  assert.equal(row.kind, 'custom');
  assert.deepEqual(
    { state: row.gate.state, passed: row.gate.passed },
    { state: 'missing', passed: false },
    'the model keeps the gate truth itself — missing on this agent, not passed, not hidden',
  );
  // State words: the connection truth, plainly, with the next
  // step named. A missing gate is a check that has not RUN for
  // this agent — never a fault word.
  assert.equal(row.state, 'not-connected');
  assert.equal(
    row.stateLabel,
    'Not connected \u2014 connecting runs its safety check for this agent',
    'the row reads not-connected, and says connecting runs the safety check for this agent',
  );
  assert.ok(!/not ready|has not passed|failed/i.test(row.stateLabel), 'no fault framing for a gate that simply has not run on this agent');
  assert.equal(stateLabelFor(readRow), row.stateLabel, 'the label helper and the row model agree');
  // Connect: live, and never a toggle (nothing is connected).
  assert.equal(row.connectable, true, 'Connect stands on the row — the connect start is what runs this agent\u2019s gate');
  assert.equal(row.toggleable, false, 'an unconnected row carries no channel toggle');
  assert.equal(row.reconnect, false);
  // The composed panel model (the real rendering path's model):
  // the row stands in Gemini's Connectors list as a Connect row,
  // exactly once.
  const model = workspace.plusMenuLevel2Model({
    seatId: 'gemini',
    library: libraryOf([projectedRow()]),
    conversationId: 'c1',
  });
  const mine = flatModelRows(model).filter((r) => r.row?.entryId === 'custom-weather-tools');
  assert.equal(mine.length, 1, 'the projected row renders exactly once in the composed panel');
  assert.equal(mine[0].kind, 'connect', 'it stands as a Connect row, not a resting state row');
  assert.equal(mine[0].row.stateLabel, row.stateLabel, 'the composed row carries the same plain words');
});

test('sync S2c: the other gate states keep their old ruling — only a missing gate gains the Connect', () => {
  const withGate = (gate) => projectedRow({ stateDetail: { gate } });
  const modelOf = (readRow) => level2Model(libraryOf([readRow]), {}, 'c1').catalog[0];
  // A check that ran on this agent and failed: still blocked,
  // still worded as a failure — the missing-gate opening is not
  // a hole in the gate.
  const failed = modelOf(withGate({ state: 'failed', passed: false, lastVerifiedAt: null, lastToolsCount: null, lastError: 'boom' }));
  assert.equal(failed.connectable, false, 'a failed safety check still blocks Connect');
  assert.equal(failed.stateLabel, 'Check failed \u2014 not ready');
  // Registered / probing: intent on file, no receipt yet — the
  // old not-ready ruling stands (only 'missing' is the
  // projected-entry case: no gate row exists for this agent).
  for (const state of ['registered', 'probing', 'revoked']) {
    const pending = modelOf(withGate({ state, passed: false, lastVerifiedAt: null, lastToolsCount: null, lastError: null }));
    assert.equal(pending.connectable, false, `gate state ${state} still blocks Connect`);
    assert.equal(pending.stateLabel, 'Not ready \u2014 safety check has not passed', `gate state ${state} keeps its old words`);
  }
  // A passed gate on this agent: a plain not-connected row with
  // a live Connect, exactly as before.
  const verified = modelOf(withGate({ state: 'verified', passed: true, lastVerifiedAt: '2026-11-10T00:00:00.000Z', lastToolsCount: 2, lastError: null }));
  assert.equal(verified.connectable, true, 'a passed gate keeps its live Connect');
  assert.equal(verified.stateLabel, 'Not connected', 'a passed gate reads as a plain Not connected');
  // A custom row whose read carries no gate detail at all (a
  // list-only read): unchanged — plain label, live Connect.
  const noGate = modelOf(projectedRow({ stateDetail: null }));
  assert.equal(noGate.connectable, true);
  assert.equal(noGate.stateLabel, 'Not connected');
});

test('sync S2c: the Connect reaches the connect start — the rendering path posts it, and the key-form seed shortcut does not skip it for a missing gate', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  // The rendering path: a connectable row draws a real Connect
  // button whose click runs startPanelConnect, and that function
  // posts the library connect start for the row's seat + entry —
  // the road whose server side registers + probes that seat's
  // own gate row before anything lands (S2a).
  const rowNode = js.slice(js.indexOf('function libraryRowNode'), js.indexOf('async function startPanelConnect'));
  assert.ok(rowNode.includes('if (row.connectable)'), 'the row renderer branches on the model\u2019s connectable ruling');
  assert.ok(rowNode.includes('void startPanelConnect(which, row)'), 'the Connect button runs the panel connect');
  const start = js.slice(js.indexOf('async function startPanelConnect'), js.indexOf('// The key form (panel-native home bite 2)'));
  assert.ok(start.includes("'/api/admin/connector-library/connect'"), 'the panel connect posts the connect start');
  assert.ok(start.includes('{ seatId: row.seatId, entryId: row.entryId }'), 'the connect start is addressed to the reading agent and the projected entry');
  // The header seed trap, proven live first: the stubbed read
  // row IS key-kind (authMode 'header'), so loading Gemini's
  // library seeds it, and the seed shortcut WOULD open the key
  // form with no connect start at all — the gate would never be
  // run by the click that claims to connect.
  const known = seedKnownKeyEntries({}, [projectedRow()]);
  assert.equal(
    opensKeyFormFromSeed(known, 'gemini', 'custom-weather-tools'),
    true,
    'the read seed alone would shortcut this entry\u2019s Connect to the key form',
  );
  // So startPanelConnect must rule the missing gate BEFORE the
  // seed shortcut: a gate-missing row goes to the connect start
  // first (which runs this agent\u2019s safety check; its
  // needs-credential answer then opens the key form through the
  // normal answer path, pinned by the key-form suites).
  const guardAt = start.search(/gate[\s\S]{0,80}missing/);
  const seedAt = start.indexOf('opensKeyFormFromSeed');
  assert.ok(guardAt !== -1, 'the connect start path names the missing-gate case');
  assert.ok(seedAt !== -1 && guardAt < seedAt, 'the missing-gate ruling stands before the key-form seed shortcut');
  // The gate's name is the panel's own: the custom form's copy
  // calls it the "safety check", and the new row words use the
  // same name — one check, one name, everywhere the person meets it.
  const customForm = await readFile(new URL('../app/connector-custom-form.mjs', import.meta.url), 'utf8');
  assert.ok(customForm.includes('safety check'), 'the custom form names the gate the safety check');
  const panel = await readFile(new URL('../app/connector-panel.mjs', import.meta.url), 'utf8');
  assert.ok(panel.includes('connecting runs its safety check for this agent'), 'the panel words the missing-gate Connect with the same name');
});
