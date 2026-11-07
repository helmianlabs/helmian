// Notebook in the channel prompt (EVERY-SEAT-COVERAGE-MAP-2026-11-06,
// build-order bite 2): the tenant's shared notebook — active blockers,
// context entries, and the lessons resolved blockers carry, all from
// the helmion tables behind the MCP door's getContext read — is read
// at dispatch time by envoy-mesh.mjs agentWork, ridden on the work
// item, and rendered into agentPrompt between the role line and the
// recent conversation. The unit half shapes and bounds the block,
// drives the real reader over a fake pool (scoping, dedupe,
// fail-soft), and pins agentPrompt's with/without shapes; the seam
// half runs agentWork end to end against a real database when
// HELMIAN_TEST_PG_URL is set.

import assert from 'node:assert/strict';
import test from 'node:test';
import { agentPrompt } from '../src/cloud/envoy-agents.mjs';
import {
  NOTEBOOK_MAX_LINES_PER_SECTION, NOTEBOOK_MAX_TOTAL_CHARS,
  formatNotebookBlock, readNotebookBlock, renderNotebookValue,
} from '../src/cloud/envoy-notebook.mjs';

const BLOCKER = { severity: 'critical', description: 'Twilio is off in production: call-off texts cannot send' };
const ENTRY = { key: 'seat-build-winner-2026-11-06', value: "Groq's landing page won the seat build in the November 6 staging (chosen over the other seats' pages)" };
const LESSON = 'Never substring-match error codes in tool output; parse the result envelope instead';

test('formatNotebookBlock: blockers first, then entries, then lessons, each in its section', () => {
  const block = formatNotebookBlock({ blockers: [BLOCKER], entries: [ENTRY], lessons: [LESSON] });
  assert.ok(block.startsWith('Shared notebook'), 'the block is labeled with its source');
  const b = block.indexOf('Blockers:');
  const e = block.indexOf('Notebook entries:');
  const l = block.indexOf('Lessons:');
  assert.ok(b > 0 && e > b && l > e, 'sections render in the stated order');
  assert.ok(block.indexOf(BLOCKER.description) > b && block.indexOf(BLOCKER.description) < e);
  assert.match(block, /\[critical\] Twilio is off/);
  assert.ok(block.indexOf(ENTRY.value) > e && block.indexOf(ENTRY.value) < l);
  assert.match(block, new RegExp(`${ENTRY.key}:`));
  assert.ok(block.indexOf(LESSON) > l);
});

test('formatNotebookBlock: structured entry values render compact JSON', () => {
  assert.equal(renderNotebookValue('plain fact'), 'plain fact');
  assert.equal(renderNotebookValue({ road: 'neon', tables: 12 }), '{"road":"neon","tables":12}');
  assert.equal(renderNotebookValue(42), '42');
  const block = formatNotebookBlock({ entries: [{ key: 'herald-db', value: { endpoint: 'ep-proud-truth' } }] });
  assert.match(block, /herald-db: \{"endpoint":"ep-proud-truth"\}/);
});

test('formatNotebookBlock: an empty notebook renders nothing — no header, no empty sections', () => {
  assert.equal(formatNotebookBlock(), null);
  assert.equal(formatNotebookBlock({}), null);
  assert.equal(formatNotebookBlock({ blockers: [], entries: [], lessons: [] }), null);
  assert.equal(formatNotebookBlock({ blockers: [{ severity: 'low', description: '   ' }], entries: [{ key: '', value: '' }] }), null);
});

test('formatNotebookBlock: bounds hold — 40 lines a section, 6,000 characters the block, blockers starve last', () => {
  // Short lines: the per-section line cap is the binding bound.
  const many = Array.from({ length: 50 }, (_, i) => ({ severity: 'low', description: `blocker number ${i}` }));
  const block = formatNotebookBlock({ blockers: many, entries: [ENTRY], lessons: [LESSON] });
  assert.equal(block.split('\n').filter((line) => line.startsWith('- [low]')).length, NOTEBOOK_MAX_LINES_PER_SECTION);
  assert.ok(block.length <= NOTEBOOK_MAX_TOTAL_CHARS);
  assert.ok(block.includes(ENTRY.value) && block.includes(LESSON), 'later sections still fit after 40 short blockers');
  // Fat lines: the total cap binds first, lines are individually
  // capped, and the tail sections starve — never the blockers, and
  // never leaving a bare section heading behind.
  const fat = Array.from({ length: 50 }, (_, i) => ({ severity: 'critical', description: `fat blocker ${i} ${'y'.repeat(290)}` }));
  const fatBlock = formatNotebookBlock({ blockers: fat, entries: [ENTRY], lessons: [LESSON] });
  assert.ok(fatBlock.length <= NOTEBOOK_MAX_TOTAL_CHARS, `block is ${fatBlock.length} chars`);
  const fatLines = fatBlock.split('\n').filter((line) => line.startsWith('- [critical]'));
  assert.ok(fatLines.length >= 1 && fatLines.length < NOTEBOOK_MAX_LINES_PER_SECTION);
  assert.ok(fatLines.every((line) => line.length <= 302), 'every rendered line is capped (marker + line cap)');
  assert.ok(!fatBlock.includes(LESSON), 'the last section starved');
  assert.ok(!/\n(Blockers|Notebook entries|Lessons):$/.test(fatBlock), 'no dangling section heading');
});

// --- The real reader, over a fake pool --------------------------------

function fakeNotebookPool({ blockers = [], entries = [], lessons = [], failOn = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      calls.push({ q, params });
      if (failOn && q.includes(failOn)) throw new Error('notebook table is gone');
      if (q.includes('from helmion.blockers') && q.includes("status in ('open','active','blocked')")) return { rows: blockers, rowCount: blockers.length };
      if (q.includes('from helmion.context_entries')) return { rows: entries, rowCount: entries.length };
      if (q.includes('from helmion.blockers') && q.includes("status = 'resolved'")) return { rows: lessons, rowCount: lessons.length };
      throw new Error(`unexpected ${q}`);
    },
  };
}

test('readNotebookBlock: every read is scoped to the tenant slug plus the shared rows', async () => {
  const pool = fakeNotebookPool({ blockers: [BLOCKER], entries: [{ project_slug: 'tenant-a', ...ENTRY }], lessons: [{ lesson: LESSON }] });
  const block = await readNotebookBlock(pool, 'tenant-a');
  assert.ok(block.includes(BLOCKER.description));
  assert.ok(block.includes(ENTRY.value));
  assert.ok(block.includes(LESSON));
  assert.equal(pool.calls.length, 3);
  for (const call of pool.calls) {
    assert.deepEqual(call.params, ['tenant-a'], 'the tenant id is the only scope parameter');
    assert.match(call.q, /project_slug = \$1 or project_slug is null/, 'tenant rows plus shared rows, nothing else');
  }
});

test('readNotebookBlock: a key filed under the tenant beats the shared row of the same key', async () => {
  // The query orders tenant rows first; the reader keeps the first
  // sighting of a key.
  const pool = fakeNotebookPool({
    entries: [
      { project_slug: 'tenant-a', key: 'winner', value: 'the tenant version' },
      { project_slug: null, key: 'winner', value: 'the shared version' },
      { project_slug: null, key: 'shared-only', value: 'shared fact' },
    ],
  });
  const block = await readNotebookBlock(pool, 'tenant-a');
  assert.ok(block.includes('the tenant version'));
  assert.ok(!block.includes('the shared version'));
  assert.ok(block.includes('shared fact'));
});

test('readNotebookBlock: empty tables read as no block, and a failed read is null with a loud log', async () => {
  const quiet = [];
  assert.equal(await readNotebookBlock(fakeNotebookPool(), 'tenant-a', { log: (l) => quiet.push(String(l)) }), null);
  assert.equal(quiet.length, 0, 'an empty notebook is not a failure and logs nothing');
  const logs = [];
  const pool = fakeNotebookPool({ failOn: 'context_entries' });
  assert.equal(await readNotebookBlock(pool, 'tenant-a', { log: (l) => logs.push(String(l)) }), null);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /notebook read FAILED/);
  assert.match(logs[0], /tenant-a/);
  assert.match(logs[0], /dispatch is unchanged/);
});

// --- agentPrompt: the block rides, absence is byte-identical ----------

const PROMPT_ARGS = { provider: 'groq', channelTitle: 'seat-check', members: ['claude', 'groq'], message: { authorName: 'Troy', body: 'which seat won the build?' } };

test('agentPrompt: a notebook block renders between the role line and the recent conversation', () => {
  const block = formatNotebookBlock({ blockers: [BLOCKER], entries: [ENTRY], lessons: [LESSON] });
  const p = agentPrompt({ ...PROMPT_ARGS, notebook: block });
  const roleAt = p.indexOf('You are Groq');
  const blockAt = p.indexOf('Shared notebook');
  const historyAt = p.indexOf('Recent conversation:');
  assert.ok(roleAt === 0 && blockAt > roleAt && historyAt > blockAt, 'role, then notebook, then history');
  assert.ok(p.includes(ENTRY.value));
  assert.ok(p.endsWith('which seat won the build?'));
});

test('agentPrompt: no notebook (or an empty one) is the prompt as it has always been', () => {
  const plain = agentPrompt(PROMPT_ARGS);
  assert.equal(agentPrompt({ ...PROMPT_ARGS, notebook: null }), plain);
  assert.equal(agentPrompt({ ...PROMPT_ARGS, notebook: '' }), plain);
  assert.equal(agentPrompt({ ...PROMPT_ARGS, notebook: '   ' }), plain);
  assert.doesNotMatch(plain, /Shared notebook/);
  assert.match(plain, /^You are Groq[\s\S]*\n\nRecent conversation:/);
});

// --- The dispatch seam, end to end (needs a real database) ------------

const pgUrl = process.env.HELMIAN_TEST_PG_URL;
const pgSkip = pgUrl ? false : 'HELMIAN_TEST_PG_URL is not set';

async function seedTenant(pool, chat, mesh, slug) {
  const { randomUUID } = await import('node:crypto');
  const tenantId = `t-${randomUUID().slice(0, 8)}`;
  const ownerSubject = `user_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const owner = {
    tenantId, subject: ownerSubject, role: 'owner',
    get sessionId() { return randomUUID(); },
    get requestId() { return randomUUID(); },
  };
  const device = { tenantId, subject: ownerSubject, role: 'owner', viaDeviceToken: true };
  await pool.query('insert into helmion.tenants(tenant_id, display_name) values ($1,$2)', [tenantId, slug]);
  await pool.query('insert into helmion.tenant_memberships(tenant_id, subject, role) values ($1,$2,$3)', [tenantId, ownerSubject, 'owner']);
  const { channel } = await chat.createChannel(owner, { slug, title: slug, kind: 'team' });
  await mesh.changeConfig(owner, { action: 'add-agent', channelId: channel.id, provider: 'claude' });
  await new Promise((r) => setTimeout(r, 20));
  return { tenantId, owner, device, channelId: channel.id };
}

async function cleanupTenant(pool, tenantId) {
  await pool.query('delete from helmion.tenants where tenant_id = $1', [tenantId]).catch(() => {});
  // Notebook rows hang off helmion.projects by the tenant-id slug;
  // deleting the project cascades them away.
  await pool.query('delete from helmion.projects where slug = $1', [tenantId]).catch(() => {});
}

test('agentWork: the work item carries the tenant notebook — its own entries and the shared ones, never another tenant\'s', { skip: pgSkip }, async () => {
  const { default: pg } = await import('pg');
  const { createEnvoyMesh } = await import('../src/cloud/envoy-mesh.mjs');
  const { createEnvoyStore } = await import('../src/cloud/envoy-chat.mjs');
  const { randomUUID } = await import('node:crypto');
  const pool = new pg.Pool({ connectionString: pgUrl });
  const mesh = createEnvoyMesh({ pool, publishImpl: async () => {} });
  const chat = createEnvoyStore(pool);
  const a = await seedTenant(pool, chat, mesh, 'notebook-a');
  const b = await seedTenant(pool, chat, mesh, 'notebook-b');
  try {
    // Notebook rows: A's slug is its tenant id (helmion.projects FK),
    // B likewise, plus one shared (NULL slug) entry.
    await pool.query('insert into helmion.projects(slug, name) values ($1,$2),($3,$4)', [a.tenantId, 'A', b.tenantId, 'B']);
    await pool.query(
      `insert into helmion.context_entries(project_slug, key, value) values ($1,'winner', $2::jsonb), ($3,'winner', $4::jsonb), (null,'shared-fact', $5::jsonb)`,
      [a.tenantId, JSON.stringify('tenant A fact: the A build won'), b.tenantId, JSON.stringify('TENANT B SECRET FACT'), JSON.stringify('the shared fact everyone may know')],
    );
    await pool.query(
      `insert into helmion.blockers(project_slug, status, severity, description) values ($1,'OPEN','critical','tenant A is blocked on the wash-tag photos')`,
      [a.tenantId],
    );
    await pool.query(
      `insert into helmion.blockers(project_slug, status, severity, description, lesson, resolved_at) values ($1,'RESOLVED','low','an old blocker', 'tenant A lesson: measure the box, do not guess', now())`,
      [a.tenantId],
    );

    const msg = (await chat.appendMessage(a.owner, { channelId: a.channelId, body: '@Claude what is the state of the notebook?', idempotencyKey: randomUUID() })).receipt.message;
    const item = (await mesh.agentWork(a.device, 'claude')).work.find((w) => w.message.id === msg.id);
    assert.ok(item, 'the ask is dispatched');
    assert.equal(typeof item.notebook, 'string', 'the work item carries the notebook block');
    assert.ok(item.notebook.includes('tenant A fact: the A build won'));
    assert.ok(item.notebook.includes('the shared fact everyone may know'), 'shared (NULL slug) rows ride along');
    assert.ok(item.notebook.includes('tenant A is blocked on the wash-tag photos'));
    assert.ok(item.notebook.includes('tenant A lesson: measure the box, do not guess'));
    assert.ok(!item.notebook.includes('TENANT B SECRET FACT'), "tenant B's entries never appear in tenant A's block");
    assert.ok(item.notebook.indexOf('wash-tag photos') < item.notebook.indexOf('tenant A lesson'), 'blockers before lessons in the carried block');

    // And the composed prompt carries it to the seat.
    const prompt = agentPrompt({ provider: 'claude', channelTitle: 'notebook-a', members: ['claude'], context: item.context, message: item.message, notebook: item.notebook });
    assert.ok(prompt.includes('tenant A fact: the A build won'));
  } finally {
    await cleanupTenant(pool, a.tenantId);
    await cleanupTenant(pool, b.tenantId);
    await pool.end();
  }
});

test('agentWork: a tenant with an empty notebook gets a work item with no notebook field', { skip: pgSkip }, async () => {
  const { default: pg } = await import('pg');
  const { createEnvoyMesh } = await import('../src/cloud/envoy-mesh.mjs');
  const { createEnvoyStore } = await import('../src/cloud/envoy-chat.mjs');
  const { randomUUID } = await import('node:crypto');
  const pool = new pg.Pool({ connectionString: pgUrl });
  const mesh = createEnvoyMesh({ pool, publishImpl: async () => {} });
  const chat = createEnvoyStore(pool);
  const c = await seedTenant(pool, chat, mesh, 'notebook-empty');
  try {
    const msg = (await chat.appendMessage(c.owner, { channelId: c.channelId, body: '@Claude hello there', idempotencyKey: randomUUID() })).receipt.message;
    const item = (await mesh.agentWork(c.device, 'claude')).work.find((w) => w.message.id === msg.id);
    assert.ok(item, 'the ask is dispatched');
    assert.equal('notebook' in item, false, 'no block, no field — the prompt stays exactly as it was');
  } finally {
    await cleanupTenant(pool, c.tenantId);
    await pool.end();
  }
});

test('agentWork: a notebook read failure changes no dispatch outcome and is logged loudly', { skip: pgSkip }, async () => {
  const { default: pg } = await import('pg');
  const { createEnvoyMesh } = await import('../src/cloud/envoy-mesh.mjs');
  const { createEnvoyStore } = await import('../src/cloud/envoy-chat.mjs');
  const { randomUUID } = await import('node:crypto');
  const pool = new pg.Pool({ connectionString: pgUrl });
  const logs = [];
  const mesh = createEnvoyMesh({
    pool,
    publishImpl: async () => {},
    notebookImpl: async () => { throw new Error('notebook store is down'); },
    notebookLogImpl: (line) => logs.push(String(line)),
  });
  const chat = createEnvoyStore(pool);
  const d = await seedTenant(pool, chat, mesh, 'notebook-down');
  try {
    const msg = (await chat.appendMessage(d.owner, { channelId: d.channelId, body: '@Claude hello there', idempotencyKey: randomUUID() })).receipt.message;
    const item = (await mesh.agentWork(d.device, 'claude')).work.find((w) => w.message.id === msg.id);
    assert.ok(item, 'the ask still dispatches with the notebook down');
    assert.equal('notebook' in item, false);
    assert.ok(logs.some((line) => /notebook read FAILED/.test(line) && /notebook store is down/.test(line)), 'the failure is logged loudly');
  } finally {
    await cleanupTenant(pool, d.tenantId);
    await pool.end();
  }
});
