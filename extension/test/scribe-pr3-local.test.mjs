// The door-knock client against PR #3's REAL courier code (PGlite, in-process).
// Runs only when SCRIBE_PR3_APP points at a checkout of
// troy83352/shared-memory-mcp PR #3 server.src/app with node_modules installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { memoryStorage } from '../background/ledger.js';
import { pollScribe, readScribeState, setScribeSettings, inboxView } from '../background/scribe-client.js';

const APP = process.env.SCRIBE_PR3_APP;
const TOKEN = 'local-harness-token-not-real-0001';
const HARNESS = fileURLToPath(new URL('../test-support/scribe-pr3-harness.ts', import.meta.url));

async function start(installed) {
  const child = spawn(process.execPath, ['--import', 'tsx', HARNESS], { cwd: APP, env: { ...process.env, SCRIBE_PR3_APP: APP, HARNESS_TOKEN: TOKEN, HARNESS_INSTALLED: installed ? '1' : '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (c) => { buf += c; const m = /READY (\S+)/.exec(buf); if (m) resolve(m[1]); });
    child.on('exit', (code) => reject(new Error(`harness exited ${code}`)));
  });
  const seed = (body) => fetch(`${url}/__seed`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
  return { url, seed, close: () => child.kill() };
}

test('PR #3 real code: unread, aliases, cursor, read state', { skip: !APP && 'set SCRIBE_PR3_APP', timeout: 60000 }, async () => {
  const h = await start(true);
  try {
    await h.seed({ op: 'send', msg: { to: 'faith-and-light-news', subject: 'One', body: 'secret body', from: 'grok-bot' } });
    await h.seed({ op: 'send', msg: { to: 'muse', subject: 'Two', body: 'b2', from: 'paul', priority: 'high' } });
    const s = memoryStorage();
    await setScribeSettings(s, { enabled: true, baseUrl: h.url, token: TOKEN, mailboxes: 'news' });
    const r1 = await pollScribe(s, { now: 0, rand: () => 0.5 });
    assert.equal(r1.unread, 2);
    assert.deepEqual(r1.fresh[0].items.map((i) => [i.from, i.subject, i.priority]), [['paul', 'One', 'normal'], ['paul', 'Two', 'high']]);
    assert.doesNotMatch(JSON.stringify(await inboxView(s)), /secret body/);
    const cursor = (await readScribeState(s)).boxes.muse.cursor;
    const ids = r1.fresh[0].items.map((i) => i.id);
    assert.equal(cursor, Math.max(...ids));
    assert.equal((await pollScribe(s, { now: 61_000, rand: () => 0.5 })).fresh.length, 0);
    await h.seed({ op: 'read', ids: [ids[0]], agent: 'muse' });
    await h.seed({ op: 'send', msg: { to: 'muse', subject: 'Three', body: 'b3', from: 'troy' } });
    const r3 = await pollScribe(s, { now: 122_000, rand: () => 0.5 });
    assert.equal(r3.unread, 2);
    assert.deepEqual(r3.fresh[0].items.map((i) => i.subject), ['Three']);
    const bad = memoryStorage();
    await setScribeSettings(bad, { enabled: true, baseUrl: h.url, token: 'wrong-token-but-long-enough', mailboxes: 'muse' });
    assert.equal((await pollScribe(bad)).skipped, 'token-rejected');
  } finally { h.close(); }
});

test('PR #3 real code: 503 courier_not_installed without migration 006', { skip: !APP && 'set SCRIBE_PR3_APP', timeout: 60000 }, async () => {
  const h = await start(false);
  try {
    const s = memoryStorage();
    await setScribeSettings(s, { enabled: true, baseUrl: h.url, token: TOKEN, mailboxes: 'troy' });
    const r = await pollScribe(s, { now: 0, rand: () => 0.5 });
    assert.equal(r.serverState, 'not-installed');
    assert.equal((await readScribeState(s)).boxes.troy.nextAt, 900_000);
  } finally { h.close(); }
});
