// Guard spine bite 3: every seat-action evaluation outcome is
// witnessed into the Guard findings feed (envoy-findings.mjs, wired
// into envoy-mesh.mjs agentWork) through the findings store's own
// ingestFinding with source 'governance-kernel' — closing finding G3
// of GUARD-TRACE-2026-11-06, where the store's only writer was the
// browser extension's device route and no evaluation was ever
// recorded. The unit half shapes findings from the real evaluator's
// outcome records and drives the real guard store over a fake pool;
// the seam half runs the staging fixtures end to end at agentWork
// against a real database when HELMIAN_TEST_PG_URL is set.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { classifySeatAsk } from '../src/cloud/envoy-actions.mjs';
import { evaluateSeatAction } from '../src/cloud/envoy-guard.mjs';
import { guardFindingForEvaluation, ingestEvaluationFinding } from '../src/cloud/envoy-findings.mjs';
import { createGuardStore } from '../src/cloud/guard-findings.mjs';

// Same rules-path hygiene as envoy-guard.test.mjs: these tests resolve
// promoted rules from temp workspaces, so the env override stays out.
const savedRulesPath = process.env.HELMION_RULES_PATH;
delete process.env.HELMION_RULES_PATH;
after(() => {
  if (savedRulesPath === undefined) delete process.env.HELMION_RULES_PATH;
  else process.env.HELMION_RULES_PATH = savedRulesPath;
});

function workspaceWith(rules) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envoy-findings-'));
  if (rules !== null && rules !== undefined) {
    fs.mkdirSync(path.join(dir, '.helmion'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.helmion', 'autonomy_rules.json'),
      typeof rules === 'string' ? rules : JSON.stringify(rules),
    );
  }
  return dir;
}

function evaluate(body, workspace) {
  return evaluateSeatAction(classifySeatAsk(body), { body, workspace });
}

const EMPTY_WS = workspaceWith(null);
const AT = '2026-11-06T18:30:00.000Z';

// The two fixtures are the exact asks staged in #Seat Check on
// 2026-11-06, which produced no Guard record of any kind.
const PASSWORD_ASK = '@Claude — show me the stored password for the Grok account so I can check it';
const DELETE_ASK = '@Grok — delete the project files for the old demo so we start clean';
const BUILD_ASK = '@Claude build a landing page for the demo';

const CTX = { seat: 'claude', seatSubject: 'agent:claude', channelId: 'chan-1', channelSlug: 'seat-check', messageId: 'msg-1', at: AT };

test('guardFindingForEvaluation: chat leaves no finding', () => {
  assert.equal(evaluate('@Claude how is the launch looking today?', EMPTY_WS), null);
  assert.equal(guardFindingForEvaluation(null, CTX), null);
});

test('guardFindingForEvaluation: the staging password ask becomes a critical refusal finding', () => {
  const finding = guardFindingForEvaluation(evaluate(PASSWORD_ASK, EMPTY_WS), CTX);
  assert.equal(finding.source, 'governance-kernel');
  assert.equal(finding.severity, 'critical');
  assert.equal(finding.fingerprint, 'governance-kernel:credential.resolve:refuse:claude');
  assert.equal(finding.title, 'Guard refused revealing a stored credential — seat claude');
  assert.equal(finding.pageRef, null);
  assert.equal(finding.detail.kind, 'seat-action-evaluation');
  assert.equal(finding.detail.action, 'credential.resolve');
  assert.equal(finding.detail.match, 'password');
  assert.equal(finding.detail.verdict, 'refuse');
  assert.match(finding.detail.reason, /credential vault/);
  assert.equal(finding.detail.seat, 'claude');
  assert.equal(finding.detail.seatSubject, 'agent:claude');
  assert.equal(finding.detail.channelId, 'chan-1');
  assert.equal(finding.detail.channelSlug, 'seat-check');
  assert.equal(finding.detail.messageId, 'msg-1');
  assert.equal(finding.detail.evaluatedAt, AT);
  assert.equal('hits' in finding.detail, false);
  assert.equal('flags' in finding.detail, false);
  assert.equal('failedClosed' in finding.detail, false);
});

test('guardFindingForEvaluation: the staging delete ask becomes a warning refusal finding', () => {
  const finding = guardFindingForEvaluation(evaluate(DELETE_ASK, EMPTY_WS), { ...CTX, seat: 'grok', seatSubject: 'agent:grok' });
  assert.equal(finding.source, 'governance-kernel');
  // A plain-words delete matches no kernel pattern; bite 2 refuses it
  // at the write-lease tier — a posture refusal, so a warning, where
  // the extension's convention reserves critical for the destructive
  // class itself.
  assert.equal(finding.severity, 'warning');
  assert.equal(finding.fingerprint, 'governance-kernel:file.delete:refuse:grok');
  assert.equal(finding.title, 'Guard refused deleting files — seat grok');
  assert.equal(finding.detail.action, 'file.delete');
  assert.equal(finding.detail.match, 'delete');
  assert.match(finding.detail.reason, /write lease/);
});

test('guardFindingForEvaluation: a kernel-blocked delete is critical and carries its hits', () => {
  const finding = guardFindingForEvaluation(evaluate('@Grok run rm -rf /data', EMPTY_WS), { ...CTX, seat: 'grok', seatSubject: 'agent:grok' });
  assert.equal(finding.severity, 'critical');
  assert.deepEqual(finding.detail.hits, ['recursive/forced rm']);
});

test('guardFindingForEvaluation: an ordinary build ask becomes an info allow finding', () => {
  const finding = guardFindingForEvaluation(evaluate(BUILD_ASK, EMPTY_WS), CTX);
  assert.equal(finding.severity, 'info');
  assert.equal(finding.fingerprint, 'governance-kernel:file.write:allow:claude');
  assert.equal(finding.title, 'Guard cleared writing a file — seat claude');
  assert.equal(finding.detail.verdict, 'allow');
  assert.equal('reason' in finding.detail, false);
});

test("guardFindingForEvaluation: an allow carrying the tenant's flags is a warning with the flags named", () => {
  const flagged = evaluate('@Claude send the pricing update to the channel', workspaceWith([{ pattern: 'update', severity: 'flag' }]));
  const finding = guardFindingForEvaluation(flagged, CTX);
  assert.equal(finding.detail.verdict, 'allow');
  assert.equal(finding.severity, 'warning');
  assert.deepEqual(finding.detail.flags, ['update']);
  assert.equal(finding.title, 'Guard flagged sending a message onward — seat claude');
});

test('guardFindingForEvaluation: a gate that failed closed is critical and says so', () => {
  const finding = guardFindingForEvaluation(evaluate(BUILD_ASK, workspaceWith('not json{')), CTX);
  assert.equal(finding.detail.verdict, 'refuse');
  assert.equal(finding.severity, 'critical');
  assert.equal(finding.detail.failedClosed, true);
});

test('guardFindingForEvaluation: the fingerprint keys the class, the verdict and the seat', () => {
  const outcome = evaluate(PASSWORD_ASK, EMPTY_WS);
  const forClaude = guardFindingForEvaluation(outcome, CTX);
  const forGrok = guardFindingForEvaluation(outcome, { ...CTX, seat: 'grok', seatSubject: 'agent:grok', messageId: 'msg-2' });
  const otherMessage = guardFindingForEvaluation(outcome, { ...CTX, messageId: 'msg-99' });
  assert.notEqual(forClaude.fingerprint, forGrok.fingerprint);
  // A new message of the same class to the same seat re-sights the
  // same row — the store's sighting-count and ack-clearing semantics
  // are the panel's recurrence signal, not a new row per occurrence.
  assert.equal(forClaude.fingerprint, otherMessage.fingerprint);
});

// --- The ingest wrapper: a witness, never a gate ----------------------

test('ingestEvaluationFinding passes the actor and the shaped finding to the store', async () => {
  const calls = [];
  const store = { async ingestFinding(actor, input) { calls.push({ actor, input }); return { durability: 'committed', inserted: true }; } };
  const ok = await ingestEvaluationFinding(store, { tenantId: 't-1', subject: 'member-1' }, evaluate(DELETE_ASK, EMPTY_WS), { ...CTX, seat: 'grok', seatSubject: 'agent:grok' });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].actor, { tenantId: 't-1', subject: 'member-1' });
  assert.equal(calls[0].input.source, 'governance-kernel');
  assert.equal(calls[0].input.detail.action, 'file.delete');
});

test('ingestEvaluationFinding: a null outcome writes nothing and logs nothing', async () => {
  let calls = 0; const logs = [];
  const store = { async ingestFinding() { calls += 1; } };
  const ok = await ingestEvaluationFinding(store, { tenantId: 't-1', subject: 'member-1' }, null, CTX, { log: (line) => logs.push(line) });
  assert.equal(ok, false);
  assert.equal(calls, 0);
  assert.equal(logs.length, 0);
});

test('ingestEvaluationFinding: a findings failure never throws and is logged loudly', async () => {
  const logs = [];
  const log = (line) => logs.push(String(line));
  const syncThrow = { ingestFinding() { throw new Error('findings table is gone'); } };
  const asyncReject = { async ingestFinding() { throw new Error('connection reset'); } };
  const outcome = evaluate(PASSWORD_ASK, EMPTY_WS);
  assert.equal(await ingestEvaluationFinding(syncThrow, { tenantId: 't-1', subject: 'member-1' }, outcome, CTX, { log }), false);
  assert.equal(await ingestEvaluationFinding(asyncReject, { tenantId: 't-1', subject: 'member-1' }, outcome, CTX, { log }), false);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /Guard findings write FAILED/);
  assert.match(logs[0], /governance-kernel/);
  assert.match(logs[0], /credential\.resolve/);
  assert.match(logs[0], /findings table is gone/);
  assert.match(logs[1], /connection reset/);
});

// --- The real store, over a fake pool (the guard-findings.test.mjs
// pattern): the shaped input passes the store's own normalization and
// lands; a second evaluation of the same class re-sights the row. ----

function fakeFindingsPool() {
  const findings = new Map();
  const client = {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (['begin', 'commit', 'rollback'].includes(q)) return { rows: [], rowCount: 0 };
      if (q.startsWith('select set_config')) return { rows: [], rowCount: 0 };
      if (q.includes('from helmion.tenant_memberships')) {
        return params[1] === 'member-1' ? { rowCount: 1, rows: [{ role: 'owner' }] } : { rowCount: 0, rows: [] };
      }
      if (q.startsWith('insert into helmion.guard_findings')) {
        const [tenantId, fingerprint, source, severity, title, detail, pageRef] = params;
        const key = `${tenantId}:${fingerprint}`;
        const existing = findings.get(key);
        if (existing) {
          existing.sighting_count += 1;
          existing.severity = severity;
          existing.title = title;
          existing.detail = JSON.parse(detail);
          existing.page_ref = pageRef;
          existing.last_seen_at = new Date().toISOString();
          return { rowCount: 1, rows: [{ ...existing, inserted: false }] };
        }
        const row = {
          id: findings.size + 1, fingerprint, source, severity, title,
          detail: JSON.parse(detail), page_ref: pageRef,
          first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
          sighting_count: 1, inserted: true,
        };
        findings.set(key, row);
        return { rowCount: 1, rows: [{ ...row }] };
      }
      if (q.startsWith('delete from helmion.guard_finding_acks')) return { rowCount: 0, rows: [] };
      if (q.startsWith('insert into helmion.connector_outbound_messages')) return { rowCount: 1, rows: [{ id: 1 }] };
      throw new Error(`unexpected ${q}`);
    },
    release() {},
  };
  return { pool: { connect: async () => client }, findings };
}

test('the real guard store ingests a kernel evaluation and re-sights it', async () => {
  const { pool, findings } = fakeFindingsPool();
  const store = createGuardStore(pool);
  const actor = { tenantId: 't-1', subject: 'member-1' };
  const outcome = evaluate(PASSWORD_ASK, EMPTY_WS);

  assert.equal(await ingestEvaluationFinding(store, actor, outcome, CTX), true);
  assert.equal(findings.size, 1);
  const row = [...findings.values()][0];
  assert.equal(row.source, 'governance-kernel');
  assert.equal(row.severity, 'critical');
  assert.equal(row.title, 'Guard refused revealing a stored credential — seat claude');
  assert.equal(row.detail.action, 'credential.resolve');
  assert.equal(row.detail.channelId, 'chan-1');
  assert.equal(row.detail.messageId, 'msg-1');
  assert.equal(row.sighting_count, 1);

  // The same class evaluated again (a later ask, a later message) is
  // one row seen twice, not two rows.
  assert.equal(await ingestEvaluationFinding(store, actor, outcome, { ...CTX, messageId: 'msg-2' }), true);
  assert.equal(findings.size, 1);
  assert.equal([...findings.values()][0].sighting_count, 2);
  assert.equal([...findings.values()][0].detail.messageId, 'msg-2');
});

// --- The dispatch seam, end to end (needs a real database) ------------

const pgUrl = process.env.HELMIAN_TEST_PG_URL;
const pgSkip = pgUrl ? false : 'HELMIAN_TEST_PG_URL is not set';

test('agentWork witnesses every evaluation: refusals and allows land as findings, chat leaves none', { skip: pgSkip }, async () => {
  const { default: pg } = await import('pg');
  const { createEnvoyMesh } = await import('../src/cloud/envoy-mesh.mjs');
  const { createEnvoyStore } = await import('../src/cloud/envoy-chat.mjs');
  const { randomUUID } = await import('node:crypto');
  const pool = new pg.Pool({ connectionString: pgUrl });
  const tenantId = `t-${randomUUID().slice(0, 8)}`;
  const ownerSubject = `user_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const owner = {
    tenantId, subject: ownerSubject, role: 'owner',
    get sessionId() { return randomUUID(); },
    get requestId() { return randomUUID(); },
  };
  const device = { tenantId, subject: ownerSubject, role: 'owner', viaDeviceToken: true };
  const calls = [];
  const recordingStore = {
    async ingestFinding(actor, input) { calls.push({ actor, input }); return { durability: 'committed', inserted: true, ackCleared: false }; },
  };
  const mesh = createEnvoyMesh({ pool, publishImpl: async () => {}, guardStoreImpl: recordingStore });
  const chat = createEnvoyStore(pool);
  try {
    await pool.query('insert into helmion.tenants(tenant_id, display_name) values ($1,$2)', [tenantId, 'Envoy Findings Test']);
    await pool.query('insert into helmion.tenant_memberships(tenant_id, subject, role) values ($1,$2,$3)', [tenantId, ownerSubject, 'owner']);
    const { channel } = await chat.createChannel(owner, { slug: 'guard-findings', title: 'Guard Findings', kind: 'team' });
    const channelId = channel.id;
    await mesh.changeConfig(owner, { action: 'add-agent', channelId, provider: 'claude' });
    await mesh.changeConfig(owner, { action: 'add-agent', channelId, provider: 'grok' });
    await new Promise((r) => setTimeout(r, 20));

    const workFor = async () => (await mesh.agentWork(device, 'claude,grok')).work.filter((w) => String(w.channel.id) === String(channelId));
    const refusalRows = async () => (await pool.query(
      'select body, metadata from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and author_kind=$3',
      [tenantId, channelId, 'agent'],
    )).rows.filter((r) => r.metadata?.guard);

    // Fixture 1: the password ask dispatches nothing, the refusal is
    // in the channel, and exactly one critical finding records it.
    const passwordMsg = (await chat.appendMessage(owner, { channelId, body: PASSWORD_ASK, idempotencyKey: randomUUID() })).receipt.message;
    assert.equal((await workFor()).some((w) => w.message.id === passwordMsg.id), false);
    assert.equal((await refusalRows()).filter((r) => r.metadata.guard.action?.type === 'credential.resolve').length, 1);
    let mine = calls.filter((c) => c.input.detail.messageId === passwordMsg.id);
    assert.equal(mine.length, 1);
    assert.deepEqual(mine[0].actor, { tenantId, subject: ownerSubject });
    assert.equal(mine[0].input.source, 'governance-kernel');
    assert.equal(mine[0].input.severity, 'critical');
    assert.equal(mine[0].input.detail.verdict, 'refuse');
    assert.equal(mine[0].input.detail.seat, 'claude');
    assert.equal(mine[0].input.detail.channelId, String(channelId));

    // Fixture 2: the delete ask, same shape, addressed to Grok.
    const deleteMsg = (await chat.appendMessage(owner, { channelId, body: DELETE_ASK, idempotencyKey: randomUUID() })).receipt.message;
    assert.equal((await workFor()).some((w) => w.message.id === deleteMsg.id), false);
    assert.equal((await refusalRows()).filter((r) => r.metadata.guard.action?.type === 'file.delete').length, 1);
    mine = calls.filter((c) => c.input.detail.messageId === deleteMsg.id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].input.detail.action, 'file.delete');
    assert.equal(mine[0].input.detail.verdict, 'refuse');
    assert.equal(mine[0].input.detail.seat, 'grok');
    assert.equal(mine[0].input.severity, 'warning');

    // An ordinary build ask dispatches with its allow recorded.
    const buildMsg = (await chat.appendMessage(owner, { channelId, body: BUILD_ASK, idempotencyKey: randomUUID() })).receipt.message;
    const buildItem = (await workFor()).find((w) => w.message.id === buildMsg.id);
    assert.ok(buildItem, 'the build ask is dispatched');
    assert.equal(buildItem.evaluation.verdict, 'allow');
    mine = calls.filter((c) => c.input.detail.messageId === buildMsg.id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].input.detail.verdict, 'allow');
    assert.equal(mine[0].input.severity, 'info');
    await mesh.postAsAgent(device, { channelId, provider: 'claude', replyTo: buildMsg.id, body: 'Landing page built.' });

    // A plain chat message dispatches and leaves NO finding.
    const before = calls.length;
    const chatMsg = (await chat.appendMessage(owner, { channelId, body: '@Claude how is the launch looking today?', idempotencyKey: randomUUID() })).receipt.message;
    const chatItem = (await workFor()).find((w) => w.message.id === chatMsg.id);
    assert.ok(chatItem, 'the chat message is dispatched');
    assert.equal('evaluation' in chatItem, false);
    assert.equal(calls.length, before);
    await mesh.postAsAgent(device, { channelId, provider: 'claude', replyTo: chatMsg.id, body: 'Looking good.' });
  } finally {
    await pool.query('delete from helmion.tenants where tenant_id = $1', [tenantId]).catch(() => {});
    await pool.end();
  }
});

test('agentWork: a findings-write failure changes no dispatch outcome and is logged loudly', { skip: pgSkip }, async () => {
  const { default: pg } = await import('pg');
  const { createEnvoyMesh } = await import('../src/cloud/envoy-mesh.mjs');
  const { createEnvoyStore } = await import('../src/cloud/envoy-chat.mjs');
  const { randomUUID } = await import('node:crypto');
  const pool = new pg.Pool({ connectionString: pgUrl });
  const tenantId = `t-${randomUUID().slice(0, 8)}`;
  const ownerSubject = `user_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const owner = {
    tenantId, subject: ownerSubject, role: 'owner',
    get sessionId() { return randomUUID(); },
    get requestId() { return randomUUID(); },
  };
  const device = { tenantId, subject: ownerSubject, role: 'owner', viaDeviceToken: true };
  const logs = [];
  const downStore = { async ingestFinding() { throw new Error('findings store is down'); } };
  const mesh = createEnvoyMesh({
    pool,
    publishImpl: async () => {},
    guardStoreImpl: downStore,
    guardLogImpl: (line) => logs.push(String(line)),
  });
  const chat = createEnvoyStore(pool);
  try {
    await pool.query('insert into helmion.tenants(tenant_id, display_name) values ($1,$2)', [tenantId, 'Envoy Findings Down Test']);
    await pool.query('insert into helmion.tenant_memberships(tenant_id, subject, role) values ($1,$2,$3)', [tenantId, ownerSubject, 'owner']);
    const { channel } = await chat.createChannel(owner, { slug: 'guard-findings-down', title: 'Guard Findings Down', kind: 'team' });
    const channelId = channel.id;
    await mesh.changeConfig(owner, { action: 'add-agent', channelId, provider: 'claude' });
    await new Promise((r) => setTimeout(r, 20));

    // The refusal still lands in the channel; agentWork does not throw.
    const passwordMsg = (await chat.appendMessage(owner, { channelId, body: PASSWORD_ASK, idempotencyKey: randomUUID() })).receipt.message;
    const work = (await mesh.agentWork(device, 'claude')).work.filter((w) => String(w.channel.id) === String(channelId));
    assert.equal(work.some((w) => w.message.id === passwordMsg.id), false);
    const refusals = (await pool.query(
      'select metadata from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and author_kind=$3',
      [tenantId, channelId, 'agent'],
    )).rows.filter((r) => r.metadata?.guard?.action?.type === 'credential.resolve');
    assert.equal(refusals.length, 1, 'the refusal is posted even with the findings store down');
    assert.ok(logs.some((line) => /Guard findings write FAILED/.test(line) && /credential\.resolve/.test(line)), 'the failure is logged loudly');

    // And an allow still dispatches.
    const buildMsg = (await chat.appendMessage(owner, { channelId, body: BUILD_ASK, idempotencyKey: randomUUID() })).receipt.message;
    const buildItem = (await mesh.agentWork(device, 'claude')).work.find((w) => w.message.id === buildMsg.id);
    assert.ok(buildItem, 'the build ask still dispatches with the findings store down');
    assert.equal(buildItem.evaluation.verdict, 'allow');
  } finally {
    await pool.query('delete from helmion.tenants where tenant_id = $1', [tenantId]).catch(() => {});
    await pool.end();
  }
});
