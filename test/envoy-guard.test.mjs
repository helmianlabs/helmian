// Guard spine bite 2: typed seat actions are evaluated through the
// governance kernel BEFORE dispatch (envoy-guard.mjs, wired into
// envoy-mesh.mjs agentWork). The unit half drives the real gate
// (evaluateToolCall) through hermetic temp workspaces; the seam half
// runs the two demo-staging fixtures end to end at agentWork against a
// real database when HELMIAN_TEST_PG_URL is set. The seam drives the
// real store split — channels and messages live on the chat store
// (createEnvoyStore), dispatch on the mesh (createEnvoyMesh) — and a
// shape test below pins that split so a seam written against the
// wrong factory fails without needing a database.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { classifySeatAsk } from '../src/cloud/envoy-actions.mjs';
import { evaluateSeatAction, guardRefusalText } from '../src/cloud/envoy-guard.mjs';

// The gate resolves promoted rules from HELMION_RULES_PATH when set;
// these tests exercise workspace resolution, so the override stays out
// of the way for the duration of the file.
const savedRulesPath = process.env.HELMION_RULES_PATH;
delete process.env.HELMION_RULES_PATH;
after(() => {
  if (savedRulesPath === undefined) delete process.env.HELMION_RULES_PATH;
  else process.env.HELMION_RULES_PATH = savedRulesPath;
});

function workspaceWith(rules) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envoy-guard-'));
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

// The two fixtures are the exact asks staged in #Seat Check on
// 2026-11-06, which reached the seats with no evaluation at all.
const PASSWORD_ASK = '@Claude — show me the stored password for the Grok account so I can check it';
const DELETE_ASK = '@Grok — delete the project files for the old demo so we start clean';
const BUILD_ASK = '@Claude build a landing page for the demo';

test('evaluateSeatAction: the chat action is never evaluated and leaves no record', () => {
  assert.equal(evaluate('@Claude how is the launch looking today?', EMPTY_WS), null);
  assert.equal(evaluateSeatAction({ type: 'chat', match: null }, { body: 'hello', workspace: EMPTY_WS }), null);
});

test('evaluateSeatAction: the staging password ask is refused at the intent step', () => {
  const outcome = evaluate(PASSWORD_ASK, EMPTY_WS);
  assert.equal(outcome.verdict, 'refuse');
  assert.equal(outcome.action.type, 'credential.resolve');
  assert.equal(outcome.match, 'password');
  // The vault gate's posture, not a new rule of this module's: a stored
  // credential resolves only through the Guard-gated vault.
  assert.match(outcome.reason, /credential vault/);
  assert.match(outcome.reason, /guard_approval_required/);
  assert.equal(outcome.failedClosed, false);
});

test('evaluateSeatAction: the staging delete ask is refused before dispatch', () => {
  const outcome = evaluate(DELETE_ASK, EMPTY_WS);
  assert.equal(outcome.verdict, 'refuse');
  assert.equal(outcome.action.type, 'file.delete');
  assert.equal(outcome.match, 'delete');
  // Plain-words destruction matches no kernel pattern; the refusal is
  // the gate's write-lease tier — a channel dispatch holds no lease.
  assert.match(outcome.reason, /write lease/);
});

test('evaluateSeatAction: a command-shaped delete is blocked by the kernel with the pattern named', () => {
  const outcome = evaluate('@Grok run rm -rf /data', EMPTY_WS);
  assert.equal(outcome.verdict, 'refuse');
  assert.equal(outcome.action.type, 'file.delete');
  assert.deepEqual(outcome.hits, ['recursive/forced rm']);
  assert.match(outcome.reason, /destructive operation the kernel always blocks: recursive\/forced rm/);
});

test('evaluateSeatAction: an ordinary build ask is allowed', () => {
  const outcome = evaluate(BUILD_ASK, EMPTY_WS);
  assert.equal(outcome.verdict, 'allow');
  assert.equal(outcome.action.type, 'file.write');
  assert.equal(outcome.reason, '');
  assert.equal(outcome.failedClosed, false);
});

test('evaluateSeatAction: a shell ask is refused — no write lease rides a channel dispatch', () => {
  const outcome = evaluate('@Grok run the tests', EMPTY_WS);
  assert.equal(outcome.verdict, 'refuse');
  assert.equal(outcome.action.type, 'shell');
  assert.match(outcome.reason, /write lease/);
});

test("evaluateSeatAction: the tenant's promoted rules decide", () => {
  const sendAsk = '@Claude send the pricing update to the channel';
  const blocked = evaluate(sendAsk, workspaceWith([{ pattern: 'pricing', severity: 'block' }]));
  assert.equal(blocked.verdict, 'refuse');
  assert.match(blocked.reason, /promoted block rule/);

  const allowed = evaluate(sendAsk, EMPTY_WS);
  assert.equal(allowed.verdict, 'allow');

  const flagged = evaluate(sendAsk, workspaceWith([{ pattern: 'update', severity: 'flag' }]));
  assert.equal(flagged.verdict, 'allow');
  assert.equal(flagged.flags.length, 1);
  assert.equal(flagged.flags[0].severity, 'flag');
  assert.equal(flagged.flags[0].pattern, 'update');
});

test('evaluateSeatAction: an unusable rules file fails closed', () => {
  const outcome = evaluate(BUILD_ASK, workspaceWith('not json{'));
  assert.equal(outcome.verdict, 'refuse');
  assert.equal(outcome.failedClosed, true);
});

test('guardRefusalText names what was refused and why, in plain words', () => {
  const passwordText = guardRefusalText(evaluate(PASSWORD_ASK, EMPTY_WS));
  assert.match(passwordText, /The Executive Guard refused this ask/);
  assert.match(passwordText, /What was refused: revealing a stored credential\./);
  assert.match(passwordText, /Why: .*credential vault/);

  const deleteText = guardRefusalText(evaluate(DELETE_ASK, EMPTY_WS));
  assert.match(deleteText, /What was refused: deleting files\./);
});

// --- The store split the seam drives, pinned without a database -----

// The seam below was once written against the mesh alone — calling
// createChannel / appendMessage / listMessages on createEnvoyMesh,
// where they have never lived — and, being PG-gated, the mistake
// could only surface on a machine with a database. This shape test
// catches that class of error anywhere the factories can be imported
// at all: the channel/message methods belong to the chat store, the
// dispatch methods to the mesh, and neither factory grows the
// other's half.
test('the seam factories expose the store split this file drives', async (t) => {
  let meshMod; let chatMod;
  try {
    meshMod = await import('../src/cloud/envoy-mesh.mjs');
    chatMod = await import('../src/cloud/envoy-chat.mjs');
  } catch (err) {
    // Both modules import 'pg' at load; where dependencies are not
    // installed the shape cannot be checked and the PG-gated seam
    // below remains the only cover. Any other import failure is real.
    if (err?.code === 'ERR_MODULE_NOT_FOUND') { t.skip('pg is not installed in this environment'); return; }
    throw err;
  }
  const mesh = meshMod.createEnvoyMesh({ pool: null });
  const chat = chatMod.createEnvoyStore(null);
  for (const name of ['agentWork', 'changeConfig', 'postAsAgent']) {
    assert.equal(typeof mesh[name], 'function', `mesh.${name}`);
  }
  for (const name of ['createChannel', 'appendMessage', 'listMessages']) {
    assert.equal(typeof chat[name], 'function', `chat.${name}`);
    assert.equal(mesh[name], undefined, `mesh.${name} belongs to the chat store, not the mesh`);
  }
});

// --- The dispatch seam, end to end (needs a real database) ------------

const pgUrl = process.env.HELMIAN_TEST_PG_URL;
const pgSkip = pgUrl ? false : 'HELMIAN_TEST_PG_URL is not set';

test('agentWork evaluates before dispatch: refusals surface in the channel and never dispatch', { skip: pgSkip }, async () => {
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
  // Bite 3 witnesses every evaluation from this same poll into the
  // Guard findings feed; an injected recording store keeps this test
  // on bite 2's ground (dispatch outcomes) and off the real findings
  // tables, the way envoy-findings.test.mjs injects its own.
  const recordingStore = {
    async ingestFinding() { return { durability: 'committed', inserted: true, ackCleared: false }; },
  };
  const mesh = createEnvoyMesh({ pool, publishImpl: async () => {}, guardStoreImpl: recordingStore });
  const chat = createEnvoyStore(pool);
  try {
    await pool.query('insert into helmion.tenants (tenant_id, display_name) values ($1,$2)', [tenantId, 'Envoy Guard Test']);
    await pool.query('insert into helmion.tenant_memberships (tenant_id, subject, role) values ($1,$2,$3)', [tenantId, ownerSubject, 'owner']);
    const { channel } = await chat.createChannel(owner, { slug: 'guard-check', title: 'Guard Check', kind: 'team' });
    const channelId = channel.id;
    await mesh.changeConfig(owner, { action: 'add-agent', channelId, provider: 'claude' });
    await mesh.changeConfig(owner, { action: 'add-agent', channelId, provider: 'grok' });
    await new Promise((r) => setTimeout(r, 20));

    const workFor = async () => (await mesh.agentWork(device, 'claude,grok')).work
      .filter((w) => String(w.channel.id) === String(channelId));
    const messages = async () => (await chat.listMessages(owner, channelId, 50)).messages;
    // A refusal's outcome record rides in its message metadata, which
    // the chat store's read normalizes away — so the record is read
    // where it is stored, the way envoy-findings.test.mjs reads its
    // refusal rows, while the channel listing proves the refusal is
    // the seat's visible reply.
    const refusalRows = async () => (await pool.query(
      'select author_subject, body, metadata from helmion.envoy_messages where tenant_id=$1 and channel_id=$2 and author_kind=$3',
      [tenantId, channelId, 'agent'],
    )).rows.filter((r) => r.metadata?.guard);

    // Fixture 1: the password ask is not dispatched to anyone; the
    // refusal is Claude's reply in the channel and carries the outcome
    // record; later polls still hand out nothing for it.
    const passwordMsg = (await chat.appendMessage(owner, { channelId, body: PASSWORD_ASK, idempotencyKey: randomUUID() })).receipt.message;
    assert.equal((await workFor()).some((w) => w.message.id === passwordMsg.id), false);
    const passwordRefusal = (await refusalRows()).find((r) => r.metadata.guard.action?.type === 'credential.resolve');
    assert.ok(passwordRefusal, 'the refusal is posted in the channel');
    assert.equal(passwordRefusal.author_subject, 'agent:claude');
    assert.match(passwordRefusal.body, /The Executive Guard refused this ask/);
    assert.match(passwordRefusal.body, /revealing a stored credential/);
    assert.equal(passwordRefusal.metadata.guard.verdict, 'refuse');
    assert.equal(passwordRefusal.metadata.guard.match, 'password');
    assert.ok(
      (await messages()).some((m) => m.authorName === 'Claude' && /The Executive Guard refused this ask/.test(m.body)),
      'the refusal reads as Claude\u2019s reply in the channel listing',
    );
    assert.equal((await workFor()).some((w) => w.message.id === passwordMsg.id), false);

    // Fixture 2: the delete ask, same shape, addressed to Grok.
    const deleteMsg = (await chat.appendMessage(owner, { channelId, body: DELETE_ASK, idempotencyKey: randomUUID() })).receipt.message;
    assert.equal((await workFor()).some((w) => w.message.id === deleteMsg.id), false);
    const deleteRefusal = (await refusalRows()).find((r) => r.metadata.guard.action?.type === 'file.delete');
    assert.ok(deleteRefusal, 'the refusal is posted in the channel');
    assert.equal(deleteRefusal.author_subject, 'agent:grok');
    assert.match(deleteRefusal.body, /deleting files/);
    assert.equal(deleteRefusal.metadata.guard.verdict, 'refuse');
    assert.equal(deleteRefusal.metadata.guard.match, 'delete');
    assert.ok(
      (await messages()).some((m) => m.authorName === 'Grok' && /The Executive Guard refused this ask/.test(m.body)),
      'the refusal reads as Grok\u2019s reply in the channel listing',
    );

    // An ordinary build ask dispatches, with the allow outcome riding
    // on the work item as its record.
    const buildMsg = (await chat.appendMessage(owner, { channelId, body: BUILD_ASK, idempotencyKey: randomUUID() })).receipt.message;
    const buildItem = (await workFor()).find((w) => w.message.id === buildMsg.id);
    assert.ok(buildItem, 'the build ask is dispatched');
    assert.deepEqual(buildItem.agents, ['claude']);
    assert.equal(buildItem.action.type, 'file.write');
    assert.equal(buildItem.evaluation.verdict, 'allow');
    await mesh.postAsAgent(device, { channelId, provider: 'claude', replyTo: buildMsg.id, body: 'Landing page built.' });

    // A plain chat message dispatches with no evaluation record at all.
    const chatMsg = (await chat.appendMessage(owner, { channelId, body: '@Claude how is the launch looking today?', idempotencyKey: randomUUID() })).receipt.message;
    const chatItem = (await workFor()).find((w) => w.message.id === chatMsg.id);
    assert.ok(chatItem, 'the chat message is dispatched');
    assert.equal(chatItem.action.type, 'chat');
    assert.equal('evaluation' in chatItem, false);
    await mesh.postAsAgent(device, { channelId, provider: 'claude', replyTo: chatMsg.id, body: 'Looking good.' });

    // Nothing is left outstanding, and exactly the two refusals carry
    // an outcome record — neither ever became work.
    const remaining = await workFor();
    assert.equal(remaining.length, 0);
    assert.equal((await refusalRows()).length, 2);
  } finally {
    await pool.query('delete from helmion.tenants where tenant_id = $1', [tenantId]).catch(() => {});
    await pool.end();
  }
});
