// Long-lived Guard approvals with Scribe mail-back: the chat call returns fast,
// the request stays pending for hours, and the outcome is mailed once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createGuardClient } from '../src/guard-client.mjs';
import { createSpokeHub } from '../src/spoke-hub.mjs';
import { createAudit } from '../src/audit.mjs';
import { createHands } from '../src/hands.mjs';
import { createScribeMailer, mailboxForClient, normalizeMailbox } from '../src/scribe-mailer.mjs';
import { TOOLS, redactSecrets } from '../src/shared/protocol.mjs';
const ALL_CAPS = [...new Set(Object.values(TOOLS).flatMap((t) => t.needs))];
import { listen, mockGuard } from './helpers.mjs';

const BASE = { PUBLIC_URL: 'http://127.0.0.1:1', AUTH_PASSPHRASE: 'x'.repeat(24), STATE_DIR: '/tmp' };
const AUTH = { clientId: 'c1', scopes: ['hands.act'] };

function fakeMailer() {
  const sent = [];
  return { sent, send: async (m) => { sent.push(m); return { sent: true, messageId: sent.length }; } };
}

// A hub stand-in: the "PC" runs write_file for real in a temp dir.
function fakeHub(root) {
  const jobs = [];
  return {
    jobs,
    presence: () => ({ pc: { online: true, lastSeenAt: new Date().toISOString(), capabilities: ALL_CAPS, deviceId: 'pc-test' }, devices: {} }),
    async dispatch(job) {
      jobs.push(job);
      if (job.tool === 'write_file') { await writeFile(job.args.path, job.args.content); return { ok: true, output: `wrote ${job.args.path}` }; }
      return { ok: false, error: 'not supported in fake' };
    },
  };
}

async function setup({ ttlMs = 60000, env = {} } = {}) {
  const guard = mockGuard({ mode: 'ask' });
  const g = await listen(guard.handler);
  const config = loadConfig({ ...BASE, HANDS_ENABLED: 'true', HANDS_HOLD_OPEN_WAIT_MS: '50', HANDS_PENDING_TTL_MS: String(ttlMs), GUARD_URL: g.url, GUARD_DEVICE_TOKEN: guard.deviceToken, GUARD_PUBLIC_KEY_X: guard.x, ...env });
  const guardClient = createGuardClient({ ...config.guard, pollMs: 20, timeoutMs: 1000, approvalWaitMs: 30 });
  const root = await mkdtemp(join(tmpdir(), 'mailback-'));
  const hub = fakeHub(root);
  const audit = createAudit(null);
  const mailer = fakeMailer();
  const hands = createHands({ config, guard: guardClient, hub, audit, mailer, mailboxFor: () => 'claude.ai' }, { watchIntervalMs: 0 });
  return { guard, g, hub, audit, mailer, hands, root };
}

test('config: 12 h pending window by default, env overrides; cc paul off by default', () => {
  const c = loadConfig(BASE);
  assert.equal(c.pendingTtlMs, 12 * 60 * 60 * 1000);
  assert.equal(c.mailCcPaul, false);
  assert.equal(c.scribe.url, null);
  assert.equal(loadConfig({ ...BASE, HANDS_PENDING_TTL_MS: '3600000' }).pendingTtlMs, 3600000);
});

test('pending -> returns fast with request id + mailbox -> approve -> runs once -> result mailed', async () => {
  const t = await setup();
  const target = join(t.root, 'a.txt');
  const r = await t.hands.call('write_file', { path: target, content: 'hello' }, AUTH);
  assert.match(r.content[0].text, /Waiting for Troy's approval in Executive Guard; request hreq_/);
  assert.match(r.content[0].text, /mailed to your Scribe mailbox "claude.ai"/);
  assert.match(r.content[0].text, /12|1 minutes|stays open/);
  const requestId = /request (hreq_[^ ]+) /.exec(r.content[0].text)[1];
  await assert.rejects(readFile(target));
  await t.hands.watchOnce();
  assert.equal(t.mailer.sent.length, 0, 'nothing mailed while still pending');
  t.guard.decide([...t.guard.approvals.keys()][0], true);
  await t.hands.watchOnce();
  await t.hands.watchOnce(); // idempotent: second pass does nothing
  assert.equal(await readFile(target, 'utf8'), 'hello');
  assert.equal(t.hub.jobs.length, 1, 'ran exactly once');
  assert.equal(t.mailer.sent.length, 1);
  const m = t.mailer.sent[0];
  assert.equal(m.to, 'claude.ai');
  assert.match(m.subject, new RegExp(requestId));
  assert.match(m.body, /approved it in Executive Guard and it ran/);
  // resume_action afterwards cannot run it again
  const again = await t.hands.resume(requestId, AUTH);
  assert.ok(again.isError);
  assert.equal(t.hub.jobs.length, 1);
  assert.equal(t.guard.outcomes.length, 1);
  t.hands.stop(); await t.g.close();
});

test('deny -> nothing runs, denial mailed once', async () => {
  const t = await setup();
  await t.hands.call('write_file', { path: join(t.root, 'b.txt'), content: 'x' }, AUTH);
  t.guard.decide([...t.guard.approvals.keys()][0], false);
  await t.hands.watchOnce(); await t.hands.watchOnce();
  assert.equal(t.hub.jobs.length, 0);
  assert.equal(t.mailer.sent.length, 1);
  assert.match(t.mailer.sent[0].subject, /denied/);
  assert.match(t.mailer.sent[0].body, /nothing ran/);
  t.hands.stop(); await t.g.close();
});

test('expire (Guard side) -> nothing runs, expiry mailed', async () => {
  const t = await setup();
  await t.hands.call('write_file', { path: join(t.root, 'c.txt'), content: 'x' }, AUTH);
  t.guard.expire([...t.guard.approvals.keys()][0]);
  await t.hands.watchOnce();
  assert.equal(t.hub.jobs.length, 0);
  assert.equal(t.mailer.sent.length, 1);
  assert.match(t.mailer.sent[0].subject, /expired/);
  t.hands.stop(); await t.g.close();
});

test('expire (hands window) -> mailed even if Guard never answers, and a late approval cannot run it', async () => {
  const t = await setup({ ttlMs: 200 });
  await t.hands.call('write_file', { path: join(t.root, 'd.txt'), content: 'x' }, AUTH);
  await new Promise((r) => setTimeout(r, 250));
  await t.hands.watchOnce();
  assert.equal(t.mailer.sent.length, 1);
  assert.match(t.mailer.sent[0].body, /expired and nothing ran/);
  t.guard.decide([...t.guard.approvals.keys()][0], true);
  await t.hands.watchOnce();
  assert.equal(t.hub.jobs.length, 0);
  assert.equal(t.mailer.sent.length, 1);
  t.hands.stop(); await t.g.close();
});

test('cc paul flag mails a copy; explicit mailbox argument wins', async () => {
  const t = await setup({ env: { HANDS_MAIL_CC_PAUL: 'true' } });
  await t.hands.call('write_file', { path: join(t.root, 'e.txt'), content: 'x', mailbox: 'Gemini' }, AUTH);
  t.guard.decide([...t.guard.approvals.keys()][0], true);
  await t.hands.watchOnce();
  assert.deepEqual(t.mailer.sent.map((m) => m.to), ['gemini', 'paul']);
  t.hands.stop(); await t.g.close();
});

test('no mailbox known -> old resume_action reply, nothing mailed', async () => {
  const t = await setup();
  const hands = createHands({ config: loadConfig({ ...BASE, HANDS_ENABLED: 'true', HANDS_HOLD_OPEN_WAIT_MS: '50', GUARD_URL: t.g.url, GUARD_DEVICE_TOKEN: t.guard.deviceToken, GUARD_PUBLIC_KEY_X: t.guard.x }), guard: createGuardClient({ url: t.g.url, deviceToken: t.guard.deviceToken, publicKeyX: t.guard.x, deviceId: 'hands-mcp', pollMs: 20, approvalWaitMs: 30 }), hub: t.hub, audit: t.audit, mailer: t.mailer, mailboxFor: () => null }, { watchIntervalMs: 0 });
  const r = await hands.call('write_file', { path: join(t.root, 'f.txt'), content: 'x' }, AUTH);
  assert.match(r.content[0].text, /call resume_action/);
  t.guard.decide([...t.guard.approvals.keys()][0], true);
  await hands.watchOnce();
  assert.equal(t.mailer.sent.length, 0);
  hands.stop(); t.hands.stop(); await t.g.close();
});

test('mailer: redacts secrets, sends send_message over MCP, never leaks the token in errors', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"id": 42}' }] } }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  const m = createScribeMailer({ url: 'https://scribe.test/mcp', token: 'tok_abcdefghijklmnop', fetchImpl });
  const r = await m.send({ to: 'claude.ai', subject: 's', body: 'output: password=hunter22 and ghp_abcdefghijklmnopqrstuvwx' });
  assert.deepEqual(r, { sent: true, messageId: 42 });
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.params.name, 'send_message');
  assert.equal(body.params.arguments.from, 'hands');
  assert.doesNotMatch(body.params.arguments.body, /hunter22|ghp_/);
  const bad = createScribeMailer({ url: 'https://scribe.test/mcp', token: 'tok_abcdefghijklmnop', fetchImpl: async () => { throw new Error('tok_abcdefghijklmnop'); } });
  const r2 = await bad.send({ to: 'x', subject: 's', body: 'b' });
  assert.equal(r2.sent, false);
  assert.doesNotMatch(JSON.stringify(r2), /tok_/);
  assert.equal(createScribeMailer({ url: null }), null);
});

test('mailbox mapping', () => {
  assert.equal(mailboxForClient('Claude'), 'claude.ai');
  assert.equal(mailboxForClient('ChatGPT'), 'chatgpt');
  assert.equal(mailboxForClient('Le Chat'), 'mistral');
  assert.equal(mailboxForClient('random'), null);
  assert.equal(normalizeMailbox('all'), null);
  assert.equal(normalizeMailbox('bad name!'), null);
  assert.match(redactSecrets('Bearer abcdefghijklmnopqrstuv'), /\[redacted\]/);
});
