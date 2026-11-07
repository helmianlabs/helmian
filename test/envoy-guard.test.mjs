// Guard spine bite 2: typed seat actions are evaluated through the
// governance kernel BEFORE dispatch (envoy-guard.mjs, wired into
// envoy-mesh.mjs agentWork). The unit half drives the real gate
// (evaluateToolCall) through hermetic temp workspaces; the seam half
// runs the two demo-staging fixtures end to end at agentWork against a
// real database when HELMIAN_TEST_PG_URL is set.

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

// --- The dispatch seam, end to end (needs a real database) ------------

const pgUrl = process.env.HELMIAN_TEST_PG_URL;
const pgSkip = pgUrl ? false : 'HELMIAN_TEST_PG_URL is not set';

test('agentWork evaluates before dispatch: refusals surface in the channel and never dispatch', { skip: pgSkip }, async () => {
  const { default: pg } = await import('pg');
  const { createEnvoyMesh } = await import('../src/cloud/envoy-mesh.mjs');
  const pool = new pg.Pool({ connectionString: pgUrl });
  const tenantId = `tenant_envoy_guard_${Date.now().toString(36)}`;
  try {
    await pool.query('insert into helmion.tenants (tenant_id, display_name) values ($1,$2)', [tenantId, 'Envoy Guard Test']);
    await pool.query('insert into helmion.tenant_memberships (tenant_id, subject, role) values ($1,$2,$3)', [tenantId, 'user:owner', 'owner']);
    const owner = {
      tenantId, subject: 'user:owner',
      get sessionId() { return 'sess-guard'; },
      get requestId() { return 'req-guard'; },
    };
    const device = {
      tenantId, subject: 'user:owner', viaDeviceToken: true,
      get sessionId() { return 'sess-guard-device'; },
      get requestId() { return 'req-guard-device'; },
    };
    const store = createEnvoyMesh({ pool });
    const channel = await store.createChannel(owner, { title: 'Guard Check' });
    const channelId = channel.channel.id;
    await store.changeConfig(owner, { channelId, action: 'add_agent', agent: 'claude' });
    await store.changeConfig(owner, { channelId, action: 'add_agent', agent: 'grok' });
    await new Promise((r) => setTimeout(r, 20));

    const workFor = async () => (await store.agentWork(device, 'claude,grok')).work
      .filter((w) => String(w.channel.id) === String(channelId));
    const messages = async () => (await store.listMessages(owner, { channelId, limit: 50 })).messages;

    // Fixture 1: the password ask is not dispatched to anyone; the
    // refusal is Claude's reply in the channel and carries the outcome
    // record; later polls still hand out nothing for it.
    const passwordMsg = (await store.appendMessage(owner, { channelId, body: PASSWORD_ASK, idempotencyKey: 'guard-pw' })).receipt.message;
    assert.equal((await workFor()).some((w) => w.message.id === passwordMsg.id), false);
    const passwordRefusal = (await messages()).find((m) => m.guard?.action?.type === 'credential.resolve');
    assert.ok(passwordRefusal, 'the refusal is posted in the channel');
    assert.equal(passwordRefusal.authorName, 'Claude');
    assert.match(passwordRefusal.body, /The Executive Guard refused this ask/);
    assert.match(passwordRefusal.body, /revealing a stored credential/);
    assert.equal(passwordRefusal.guard.verdict, 'refuse');
    assert.equal(passwordRefusal.guard.match, 'password');
    assert.equal((await workFor()).some((w) => w.message.id === passwordMsg.id), false);

    // Fixture 2: the delete ask, same shape, addressed to Grok.
    const deleteMsg = (await store.appendMessage(owner, { channelId, body: DELETE_ASK, idempotencyKey: 'guard-del' })).receipt.message;
    assert.equal((await workFor()).some((w) => w.message.id === deleteMsg.id), false);
    const deleteRefusal = (await messages()).find((m) => m.guard?.action?.type === 'file.delete');
    assert.ok(deleteRefusal, 'the refusal is posted in the channel');
    assert.equal(deleteRefusal.authorName, 'Grok');
    assert.match(deleteRefusal.body, /deleting files/);
    assert.equal(deleteRefusal.guard.verdict, 'refuse');
    assert.equal(deleteRefusal.guard.match, 'delete');

    // An ordinary build ask dispatches, with the allow outcome riding
    // on the work item as its record.
    const buildMsg = (await store.appendMessage(owner, { channelId, body: BUILD_ASK, idempotencyKey: 'guard-build' })).receipt.message;
    const buildItem = (await workFor()).find((w) => w.message.id === buildMsg.id);
    assert.ok(buildItem, 'the build ask is dispatched');
    assert.deepEqual(buildItem.agents, ['claude']);
    assert.equal(buildItem.action.type, 'file.write');
    assert.equal(buildItem.evaluation.verdict, 'allow');
    await store.postAsAgent(device, { provider: 'claude', channelId, messageId: buildItem.message.id, inReplyTo: buildItem.message.id, body: 'Landing page built.' });

    // A plain chat message dispatches with no evaluation record at all.
    const chatMsg = (await store.appendMessage(owner, { channelId, body: '@Claude how is the launch looking today?', idempotencyKey: 'guard-chat' })).receipt.message;
    const chatItem = (await workFor()).find((w) => w.message.id === chatMsg.id);
    assert.ok(chatItem, 'the chat message is dispatched');
    assert.equal(chatItem.action.type, 'chat');
    assert.equal('evaluation' in chatItem, false);
    await store.postAsAgent(device, { provider: 'claude', channelId, messageId: chatItem.message.id, inReplyTo: chatItem.message.id, body: 'Looking good.' });

    // Nothing is left outstanding, and a refusal never became work.
    const remaining = await workFor();
    assert.equal(remaining.length, 0);
    assert.equal((await messages()).some((m) => m.guard && remaining.some((w) => w.message.id === m.id)), false);
  } finally {
    await pool.query('delete from helmion.tenants where tenant_id = $1', [tenantId]).catch(() => {});
    await pool.end();
  }
});
