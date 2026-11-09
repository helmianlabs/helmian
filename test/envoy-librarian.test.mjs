// The librarian (envoy-librarian.mjs): the dispatch write-back,
// chat auto-naming, the per-chat evidence roll-up, the setPlan-class
// audit coverage, and the knowledge base — the mistakes-and-
// solutions store whose filing engine is the Scribe librarian's,
// ported (see the module header and sql/076).
//
// Pure tests for the naming/entry/engine functions; the real store
// over a fake pool in the guard-findings test idiom (a client that
// dispatches on the SQL's shape); fail-soft wrapper proofs; and
// wiring assertions for the mesh/evidence seams in the maestro-
// follow test's source-assertion style. The end-to-end dispatch
// behaviour rides the curated suites' Postgres-gated tests; this
// file needs no database.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  createLibrarianStore, librarianEntryFor, deriveChannelName, isGenericChannelTitle,
  fileDispatchAsk, nameChannelIfGeneric, fileIncidentFromDispatch, readChannelEvidence,
  readKnowledgeBaseBlock, classifyIncident, learnKbRule, kbFindWords, detectIncidentShape,
  KB_PRESET_RULES, LIBRARIAN_ENTRY_MAX_CHARS,
} from '../src/cloud/envoy-librarian.mjs';
import { agentPrompt } from '../src/cloud/envoy-agents.mjs';
import { createAppSessionStore } from '../src/cloud/app-sessions.mjs';
import { CONFIG_SUBJECT } from '../src/cloud/envoy-agents.mjs';

const OWNER = { tenantId: 'tenant-a', subject: 'user-owner-1', role: 'owner' };
const CHAN = '11111111-2222-3333-4444-555555555555';

// ---------- pure: naming and entries ----------

test('deriveChannelName: mentions are routing, words are the name, bounds hold', () => {
  assert.equal(deriveChannelName('@Claude plan the launch page'), 'Plan the launch page');
  assert.equal(deriveChannelName('@Claude'), null);
  assert.equal(deriveChannelName(''), null);
  assert.equal(deriveChannelName('fix the billing export for the dairy co-op run'), 'Fix the billing export for the');
  const long = deriveChannelName('supercalifragilistic expialidocious antidisestablishmentarianism floccinaucinihilipilification');
  assert.ok(long.length <= 48, `name capped at 48 chars, got ${long.length}`);
});

test('isGenericChannelTitle: only the placeholder set is generic', () => {
  for (const t of ['New chat', 'new channel', 'Untitled', ' untitled chat ']) assert.equal(isGenericChannelTitle(t), true, t);
  for (const t of ['Launch page', 'new chat about billing', '']) assert.equal(isGenericChannelTitle(t), false, t);
});

test('librarianEntryFor: bounded, evidence survives, seats deduped and capped', () => {
  const big = librarianEntryFor({
    channelId: CHAN, messageId: 'm-1', channelTitle: 'T'.repeat(500), humanName: 'Troy', humanSubject: 'user-owner-1',
    seats: ['claude', 'claude', ...Array.from({ length: 20 }, (_, i) => `seat-${i}`)],
    guardDecision: 'allow', excerpt: 'x'.repeat(5000), at: '2026-11-09T00:00:00.000Z',
  });
  assert.equal(big.key, `chat:${CHAN}:m-1`);
  assert.ok(JSON.stringify(big.value).length <= LIBRARIAN_ENTRY_MAX_CHARS, 'entry JSON within the cap');
  assert.equal(big.value.human, 'Troy');
  assert.equal(big.value.guard, 'allow');
  assert.equal(big.value.seats.length, 12);
  assert.equal(librarianEntryFor({ channelId: '', messageId: 'm' }), null);
  assert.equal(librarianEntryFor({ channelId: 'c' }), null);
});

// ---------- pure: the filing engine (the Scribe port) ----------

test('kbFindWords: whole word, plural-tolerant, never a substring', () => {
  assert.deepEqual(kbFindWords('the deploys failed', ['deploy']), ['deploy']);
  assert.deepEqual(kbFindWords('deployment failed', ['deploy']), []);
  assert.deepEqual(kbFindWords('an API KEY leaked', ['api key']), ['api key']);
});

test('detectIncidentShape: Scribe error markers, else a note', () => {
  assert.equal(detectIncidentShape('TypeError: cannot read properties of undefined'), 'error');
  assert.equal(detectIncidentShape('it just quietly did the wrong thing'), 'note');
});

test('classifyIncident: preset categories, explanations, unsorted, learned outranks preset', () => {
  const shot = classifyIncident({ title: 'Said it works from a screenshot', mistake: 'Reported done from a screenshot without opening the page' });
  assert.equal(shot.category, 'verification');
  const hit = shot.hits.find((h) => h.ruleId === 'content.verification');
  assert.ok(hit, 'the verification rule hit is in the explanation');
  assert.ok(hit.matched.some((m) => m.includes('screenshot')), 'the hit names the word that matched');

  const refused = classifyIncident({ title: 'Guard refused an ask', mistake: 'TypeError: boom while asking', source: 'guard' });
  assert.ok(refused.tags.includes('guard-refusal'), 'source rule tags the refusal');
  assert.ok(refused.tags.includes('error'), 'shape rule tags the error');

  assert.equal(classifyIncident({ title: 'A quiet thing', mistake: 'something unremarkable happened' }).category, 'unsorted');

  const learned = { id: 'learned.process.deploy', layer: 'learned', when: { anyWords: ['deploy'] }, category: 'process', priority: 900, description: 'Learned.' };
  assert.equal(classifyIncident({ title: 'Deploy day', mistake: 'the deploy broke' }, [learned]).category, 'process', 'a learned rule outranks the deploy preset');
});

test('learnKbRule: one distinctive word, collision-checked, nothing to learn when already filed', () => {
  const incident = { title: 'Frobnicate exploded again', mistake: 'the frobnicate exploded during the run' };
  const rule = learnKbRule(incident, 'tooling', [], []);
  assert.equal(rule.id, 'learned.tooling.frobnicate');
  assert.equal(rule.layer, 'learned');
  assert.equal(rule.priority, 900);

  const colliding = [{ title: 'Frobnicate deploy notes', mistake: 'the frobnicate deploy shipped' }];
  const rule2 = learnKbRule(incident, 'tooling', [], colliding);
  assert.notEqual(rule2?.id, 'learned.tooling.frobnicate', 'a word that files other incidents elsewhere is never learned');
  assert.equal(rule2?.id, 'learned.tooling.exploded');

  const already = { title: 'Deploy broke', mistake: 'the deploy failed' };
  assert.equal(learnKbRule(already, 'deploy', [], []), null, 'already files there — nothing to learn');
  assert.ok(KB_PRESET_RULES.length >= 10, 'the preset rulebook is populated');
});

// ---------- the fake pool (guard-findings idiom) ----------

function fakeLibrarianPool() {
  const state = {
    members: new Map([['tenant-a|user-owner-1', 'owner'], ['tenant-b|user-owner-2', 'owner']]),
    entries: new Map(),
    channels: new Map(),
    incidents: [],
    rules: new Map(),
    audit: [],
    findings: [],
    messages: [],
    seq: 0,
  };
  let snapshot = null;
  const client = {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (q === 'begin') {
        snapshot = JSON.stringify({ entries: [...state.entries], channels: [...state.channels], incidents: state.incidents, rules: [...state.rules] });
        return { rows: [], rowCount: 0 };
      }
      if (q === 'rollback') {
        if (snapshot) {
          const s = JSON.parse(snapshot);
          state.entries = new Map(s.entries); state.channels = new Map(s.channels);
          state.incidents = s.incidents; state.rules = new Map(s.rules);
          snapshot = null;
        }
        return { rows: [], rowCount: 0 };
      }
      if (q === 'commit') { snapshot = null; return { rows: [], rowCount: 0 }; }
      if (q.startsWith('select set_config')) return { rows: [], rowCount: 0 };
      if (q.includes('from helmion.tenant_memberships')) {
        const role = state.members.get(`${params[0]}|${params[1]}`);
        return role ? { rowCount: 1, rows: [{ tenant_id: params[0], role }] } : { rowCount: 0, rows: [] };
      }
      if (q.startsWith('insert into helmion.projects')) return { rows: [], rowCount: 1 };
      if (q.startsWith('insert into helmion.context_entries')) {
        state.entries.set(`${params[0]}|${params[1]}`, JSON.parse(params[2]));
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith('update helmion.envoy_channels')) {
        const row = state.channels.get(`${params[0]}|${params[1]}`);
        if (row && row.title === params[3]) { row.title = params[2]; return { rows: [], rowCount: 1 }; }
        return { rows: [], rowCount: 0 };
      }
      if (q.startsWith('select id, slug, title, kind, created_by_subject, created_at from helmion.envoy_channels')) {
        const row = state.channels.get(`${params[0]}|${params[1]}`);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (q.includes('from helmion.audit_events') && q.includes('canonical_target')) {
        const rows = state.audit.filter((r) => r.tenant_id === params[0] && r.channel_id === params[1]).slice(0, params[2]);
        return { rows, rowCount: rows.length };
      }
      if (q.includes('from helmion.guard_findings')) {
        const rows = state.findings.filter((r) => r.tenant_id === params[0] && r.channel_id === params[1]).slice(0, params[2]);
        return { rows, rowCount: rows.length };
      }
      if (q.includes('from helmion.envoy_messages')) {
        const byKind = new Map();
        for (const m of state.messages.filter((r) => r.tenant_id === params[0] && r.channel_id === params[1] && r.author_subject !== params[2])) {
          byKind.set(m.author_kind, (byKind.get(m.author_kind) ?? 0) + 1);
        }
        const rows = [...byKind.entries()].map(([author_kind, n]) => ({ author_kind, n }));
        return { rows, rowCount: rows.length };
      }
      if (q.startsWith('select rule from helmion.librarian_rules')) {
        const rows = [...state.rules.values()].filter((r) => r.tenant_id === params[0] && r.status === 'active').map((r) => ({ rule: r.rule }));
        return { rows, rowCount: rows.length };
      }
      if (q.startsWith('insert into helmion.librarian_rules')) {
        const key = `${params[0]}|${params[1]}`;
        if (!state.rules.has(key)) state.rules.set(key, { tenant_id: params[0], id: params[1], layer: params[2], rule: JSON.parse(params[3]), status: 'active' });
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith('insert into helmion.librarian_incidents')) {
        const [id, tenant, key, category, title, mistake, solution, actor, source, evidence, status, supersedesId, filedBy] = params;
        if (key && state.incidents.some((i) => i.tenant_id === tenant && i.key === key)) return { rows: [], rowCount: 0 };
        state.incidents.push({
          id, tenant_id: tenant, key, category, title, mistake, solution, actor, source,
          evidence: JSON.parse(evidence), status, supersedes_id: supersedesId, superseded_by_id: null,
          filed_by: filedBy, created_at: new Date(1_700_000_000_000 + (state.seq++) * 1000).toISOString(),
        });
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith('update helmion.librarian_incidents set solution')) {
        const row = state.incidents.find((i) => i.tenant_id === params[0] && i.id === params[1] && i.status === 'open');
        if (!row) return { rows: [], rowCount: 0 };
        row.solution = params[2]; row.status = 'solved';
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith("update helmion.librarian_incidents set status = 'superseded'")) {
        const row = state.incidents.find((i) => i.tenant_id === params[0] && i.id === params[1] && i.status !== 'superseded');
        if (!row) return { rows: [], rowCount: 0 };
        row.status = 'superseded'; row.superseded_by_id = params[2];
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith('update helmion.librarian_incidents set category')) {
        const row = state.incidents.find((i) => i.tenant_id === params[0] && i.id === params[1]);
        if (!row) return { rows: [], rowCount: 0 };
        row.category = params[2];
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith('select id, title, mistake, source from helmion.librarian_incidents')) {
        const row = state.incidents.find((i) => i.tenant_id === params[0] && i.id === params[1]);
        return { rows: row ? [{ id: row.id, title: row.title, mistake: row.mistake, source: row.source }] : [], rowCount: row ? 1 : 0 };
      }
      if (q.startsWith('select title, mistake, source from helmion.librarian_incidents')) {
        const rows = state.incidents.filter((i) => i.tenant_id === params[0] && i.id !== params[1]).slice(-50).reverse()
          .map((i) => ({ title: i.title, mistake: i.mistake, source: i.source }));
        return { rows, rowCount: rows.length };
      }
      if (q.startsWith('select category, title, solution from helmion.librarian_incidents')) {
        const rows = state.incidents.filter((i) => i.tenant_id === params[0] && i.status === 'solved').slice(-params[1]).reverse()
          .map((i) => ({ category: i.category, title: i.title, solution: i.solution }));
        return { rows, rowCount: rows.length };
      }
      if (q.startsWith('select count(*)::int as n from helmion.librarian_incidents')) {
        const n = state.incidents.filter((i) => i.tenant_id === params[0] && i.status === 'open').length;
        return { rows: [{ n }], rowCount: 1 };
      }
      if (q.startsWith('select id, key, category, title, mistake, solution, actor, source, evidence, status, supersedes_id, superseded_by_id, created_at')) {
        let rows = state.incidents.filter((i) => i.tenant_id === params[0]);
        let p = 1;
        if (q.includes(' and category = ')) { const cat = params[p++]; rows = rows.filter((i) => i.category === cat); }
        if (q.includes('ilike')) {
          const needle = String(params[p++]).replaceAll('%', '').toLowerCase();
          rows = rows.filter((i) => [i.title, i.mistake, i.solution ?? ''].some((f) => f.toLowerCase().includes(needle)));
        }
        const limit = params[p];
        rows = rows.slice().reverse().slice(0, limit);
        return { rows, rowCount: rows.length };
      }
      throw new Error(`unexpected ${q}`);
    },
    release() {},
  };
  return { pool: { connect: async () => client }, state };
}

// ---------- the store over the fake pool: filing + naming ----------

test('fileAsk: one entry per ask however often it is filed, evidence riding', async () => {
  const { pool, state } = fakeLibrarianPool();
  const store = createLibrarianStore(pool);
  const job = { channelId: CHAN, channelTitle: 'General', messageId: 'm-1', humanSubject: 'user-owner-1', humanName: 'Troy', seats: ['claude'], guardDecision: 'allow', excerpt: 'plan the launch page', at: '2026-11-09T00:00:00.000Z' };
  assert.equal((await store.fileAsk(OWNER, job)).filed, true);
  assert.equal((await store.fileAsk(OWNER, job)).filed, true);
  assert.equal(state.entries.size, 1, 're-filing upserts the one key');
  const value = state.entries.get(`tenant-a|chat:${CHAN}:m-1`);
  assert.equal(value.channel, 'General');
  assert.equal(value.human, 'Troy');
  assert.deepEqual(value.seats, ['claude']);
  assert.equal(value.guard, 'allow');
  assert.equal(value.ask, 'plan the launch page');
});

test('renameChannelIfGeneric: fires once, never overwrites a human name', async () => {
  const { pool, state } = fakeLibrarianPool();
  state.channels.set(`tenant-a|${CHAN}`, { id: CHAN, slug: 'general', title: 'New chat', kind: 'team', created_by_subject: 'user-owner-1', created_at: '2026-11-09T00:00:00.000Z' });
  const store = createLibrarianStore(pool);
  assert.equal(await store.renameChannelIfGeneric(OWNER, { channelId: CHAN, observedTitle: 'New chat', name: 'Plan the launch page' }), true);
  assert.equal(state.channels.get(`tenant-a|${CHAN}`).title, 'Plan the launch page');
  assert.equal(await store.renameChannelIfGeneric(OWNER, { channelId: CHAN, observedTitle: 'New chat', name: 'Something else' }), false, 'the CAS misses once the name is real');
  state.channels.get(`tenant-a|${CHAN}`).title = 'My own name';
  assert.equal(await store.renameChannelIfGeneric(OWNER, { channelId: CHAN, observedTitle: 'New chat', name: 'Librarian name' }), false, 'a human-set name is never overwritten');
  assert.equal(state.channels.get(`tenant-a|${CHAN}`).title, 'My own name');
  assert.equal(await store.renameChannelIfGeneric(OWNER, { channelId: CHAN, observedTitle: 'My own name', name: 'X' }), false, 'a non-generic observed title is refused outright');
});

// ---------- the store: the knowledge base ----------

test('fileIncident: classified by the engine, solved when a fix rides, idempotent on its key', async () => {
  const { pool, state } = fakeLibrarianPool();
  const store = createLibrarianStore(pool);
  const open = await store.fileIncident(OWNER, { key: 'k-1', title: 'Said done from a screenshot', mistake: 'a screenshot was the only proof offered' });
  assert.equal(open.filed, true);
  assert.equal(open.category, 'verification');
  assert.equal(state.incidents[0].status, 'open');
  const again = await store.fileIncident(OWNER, { key: 'k-1', title: 'Said done from a screenshot', mistake: 'a screenshot was the only proof offered' });
  assert.equal(again.filed, false, 'the same key never double-files');
  assert.equal(state.incidents.length, 1);
  const solved = await store.fileIncident(OWNER, { title: 'Deploy served the old bundle', mistake: 'the deploy landed but the bundle hash never moved', solution: 'check the bundle hash after every deploy' });
  assert.equal(solved.category, 'deploy');
  assert.equal(state.incidents[1].status, 'solved', 'a solution riding files the incident solved');
});

test('solveIncident and supersedeIncident: the flywheel loop, pointers both ways', async () => {
  const { pool, state } = fakeLibrarianPool();
  const store = createLibrarianStore(pool);
  const first = await store.fileIncident(OWNER, { title: 'Old fix attempt', mistake: 'patched around the error' });
  assert.equal(await store.solveIncident(OWNER, { id: first.id, solution: 'read the code, fixed the one line' }), true);
  assert.equal(await store.solveIncident(OWNER, { id: first.id, solution: 'again' }), false, 'only an open incident can be solved');
  const second = await store.fileIncident(OWNER, { title: 'Another wall', mistake: 'hit the same wall' });
  const replacement = await store.supersedeIncident(OWNER, { oldId: second.id, incident: { title: 'The real fix', mistake: 'hit the same wall', solution: 'the road that works' } });
  assert.equal(replacement.filed, true);
  const old = state.incidents.find((i) => i.id === second.id);
  const fresh = state.incidents.find((i) => i.id === replacement.id);
  assert.equal(old.status, 'superseded');
  assert.equal(old.superseded_by_id, replacement.id, 'the old row points forward');
  assert.equal(fresh.supersedes_id, second.id, 'the new row points back');
  await assert.rejects(store.supersedeIncident(OWNER, { oldId: 'missing', incident: { title: 'x', mistake: 'y' } }), /did not file|not there/, 'superseding nothing files nothing');
  assert.equal(state.incidents.filter((i) => i.title === 'x').length, 0, 'the failed supersede rolled back');
});

test('refileIncident: a human re-file teaches the librarian a learned rule', async () => {
  const { pool, state } = fakeLibrarianPool();
  const store = createLibrarianStore(pool);
  const filed = await store.fileIncident(OWNER, { title: 'Kraken sync failed', mistake: 'the kraken sync failed again', source: 'seat' });
  assert.equal(filed.category, 'unsorted', 'no preset knows the kraken');
  const refiled = await store.refileIncident(OWNER, { id: filed.id, toCategory: 'tooling' });
  assert.equal(refiled.refiled, true);
  assert.equal(refiled.learnedRule, 'learned.tooling.kraken');
  assert.equal(state.incidents[0].category, 'tooling');
  const next = await store.fileIncident(OWNER, { title: 'Kraken again', mistake: 'the kraken broke again' });
  assert.equal(next.category, 'tooling', 'the learned rule files the next kraken on its own');
});

test('lookupIncidents: category and word filters, tenant-isolated', async () => {
  const { pool } = fakeLibrarianPool();
  const store = createLibrarianStore(pool);
  await store.fileIncident(OWNER, { title: 'Deploy one', mistake: 'the deploy failed' });
  await store.fileIncident(OWNER, { title: 'Kraken sync', mistake: 'the kraken sync failed' });
  await store.fileIncident(OWNER, { title: 'Kraken two', mistake: 'the kraken again', category: 'deploy' });
  assert.deepEqual((await store.lookupIncidents(OWNER, { category: 'deploy' })).map((i) => i.title), ['Kraken two', 'Deploy one']);
  assert.deepEqual((await store.lookupIncidents(OWNER, { query: 'kraken' })).map((i) => i.title), ['Kraken two', 'Kraken sync']);
  const other = { tenantId: 'tenant-b', subject: 'user-owner-2', role: 'owner' };
  assert.deepEqual(await store.lookupIncidents(other, {}), [], 'another tenant recalls nothing of this one');
});

test('readKnowledgeBaseBlock: solved lines + open count, bounded, empty is null', async () => {
  const { pool } = fakeLibrarianPool();
  const store = createLibrarianStore(pool);
  assert.equal(await readKnowledgeBaseBlock(pool, OWNER, { log: () => {} }), null, 'no knowledge base, no block — the prompt is unchanged');
  await store.fileIncident(OWNER, { title: 'Screenshot proof', mistake: 'claimed done from a screenshot', solution: 'exercise the real flow' });
  await store.fileIncident(OWNER, { title: 'Open wall', mistake: 'still unsolved' });
  const block = await readKnowledgeBaseBlock(pool, OWNER, { log: () => {} });
  assert.match(block, /Knowledge base \(mistakes already made/);
  assert.match(block, /\[verification\] Screenshot proof — Fix: exercise the real flow/);
  assert.match(block, /\(1 more incident is filed without a fix yet\.\)/);
  for (let i = 0; i < 12; i++) await store.fileIncident(OWNER, { title: `Solved ${i}`, mistake: `mistake ${i}`, solution: `fix ${i}` });
  const bounded = await readKnowledgeBaseBlock(pool, OWNER, { log: () => {} });
  assert.equal((bounded.match(/^- \[/gm) ?? []).length, 8, 'at most the recall limit of solved incidents ride a dispatch');
  assert.ok(bounded.length <= 2400, 'the whole block is capped');
});

// ---------- the roll-up ----------

test('readChannelEvidence: the three piles joined for one channel, gated, isolated', async () => {
  const { pool, state } = fakeLibrarianPool();
  state.channels.set(`tenant-a|${CHAN}`, { id: CHAN, slug: 'general', title: 'General', kind: 'team', created_by_subject: 'user-owner-1', created_at: '2026-11-09T00:00:00.000Z' });
  state.audit.push(
    { id: '1', tenant_id: 'tenant-a', channel_id: CHAN, actor_subject: 'user-owner-1', actor_role: 'owner', action_type: 'app.task.planned', decision: 'ALLOW', privacy_summary: 'Planned 3 steps', created_at: '2026-11-09T01:00:00.000Z' },
    { id: '2', tenant_id: 'tenant-b', channel_id: CHAN, actor_subject: 'x', actor_role: 'owner', action_type: 'other', decision: 'ALLOW', privacy_summary: 'not yours', created_at: '2026-11-09T01:00:00.000Z' },
  );
  state.findings.push(
    { id: '1', tenant_id: 'tenant-a', channel_id: CHAN, fingerprint: 'f1', severity: 'warning', title: 'Warn', first_seen_at: '2026-11-09T01:00:00.000Z', last_seen_at: '2026-11-09T02:00:00.000Z', sighting_count: 2 },
    { id: '2', tenant_id: 'tenant-a', channel_id: CHAN, fingerprint: 'f2', severity: 'critical', title: 'Crit', first_seen_at: '2026-11-09T01:00:00.000Z', last_seen_at: '2026-11-09T02:00:00.000Z', sighting_count: 1 },
  );
  state.messages.push(
    { tenant_id: 'tenant-a', channel_id: CHAN, author_subject: 'user-owner-1', author_kind: 'human' },
    { tenant_id: 'tenant-a', channel_id: CHAN, author_subject: 'user-owner-1', author_kind: 'human' },
    { tenant_id: 'tenant-a', channel_id: CHAN, author_subject: 'agent:claude', author_kind: 'agent' },
    { tenant_id: 'tenant-a', channel_id: CHAN, author_subject: CONFIG_SUBJECT, author_kind: 'system' },
  );
  const rollup = await readChannelEvidence(pool, OWNER, CHAN);
  assert.equal(rollup.channel.title, 'General');
  assert.equal(rollup.channel.createdBySubject, 'user-owner-1');
  assert.equal(rollup.audit.length, 1, "only this tenant's audit rows");
  assert.equal(rollup.audit[0].actionType, 'app.task.planned');
  assert.deepEqual(rollup.guardCounts, { info: 0, warning: 1, critical: 1 });
  assert.deepEqual(rollup.messages, { total: 3, byKind: { human: 2, agent: 1 } }, 'config rows are not messages');
  const missing = await readChannelEvidence(pool, OWNER, '99999999-8888-7777-6666-555555555555');
  assert.equal(missing.channel, null);
  assert.deepEqual(missing.audit, []);
  await assert.rejects(readChannelEvidence(pool, { tenantId: 'tenant-a', subject: 'user-owner-1', role: 'member' }, CHAN), (e) => e.status === 403);
});

// ---------- fail-soft: the wrappers never throw ----------

test('fail-soft wrappers: a throwing store changes nothing and logs loudly', async () => {
  const broken = {
    async fileAsk() { throw new Error('connection reset'); },
    async renameChannelIfGeneric() { throw new Error('connection reset'); },
    async fileIncident() { throw new Error('connection reset'); },
  };
  const logs = [];
  const log = (m) => logs.push(String(m));
  const job = { channelId: CHAN, messageId: 'm-1', excerpt: 'hi', seats: [], at: '2026-11-09T00:00:00.000Z' };
  assert.equal(await fileDispatchAsk(broken, OWNER, job, { log }), false);
  assert.equal(await nameChannelIfGeneric(broken, OWNER, { channelId: CHAN, observedTitle: 'New chat', fromBody: 'plan the thing' }, { log }), false);
  assert.equal(await fileIncidentFromDispatch(broken, OWNER, { key: 'k', title: 't', mistake: 'm' }, { log }), false);
  assert.equal(logs.length, 3);
  assert.ok(logs.every((l) => l.includes('connection reset') && l.includes('dispatch stands')), 'every failure is loud and names the standing dispatch');
});

// ---------- agentPrompt: the knowledge base block renders ----------

test('agentPrompt: the knowledge base rides after the notebook; absent, the prompt is untouched', () => {
  const base = { provider: 'claude', channelTitle: 'General', members: ['claude'], context: [], message: { body: 'hi', authorKind: 'human', authorName: 'Troy' } };
  const plain = agentPrompt(base);
  assert.equal(agentPrompt({ ...base, knowledgeBase: null }), plain, 'no block, byte-for-byte the old prompt');
  const withKb = agentPrompt({ ...base, notebook: 'Shared notebook: facts.', knowledgeBase: 'Knowledge base: fixes.' });
  assert.ok(withKb.indexOf('Shared notebook') < withKb.indexOf('Knowledge base'), 'notebook first, knowledge base after');
  assert.ok(withKb.indexOf('Knowledge base') < withKb.indexOf('Recent conversation'), 'both blocks precede the conversation');
});

// ---------- app sessions: the setPlan-class audit coverage ----------

test('app sessions: setPlan appends its audit row, and a step reset to pending appends one too', async () => {
  const SID = '0b3f2a8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
  const appends = [];
  const client = {
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rows: [], rowCount: 0 };
      if (q.includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ tenant_id: 't1', role: 'owner' }] };
      if (q.startsWith('select name from helmion.app_sessions')) return { rowCount: 1, rows: [{ name: 'Build' }] };
      if (q.startsWith('delete from helmion.app_session_steps')) return { rows: [], rowCount: 0 };
      if (q.startsWith('insert into helmion.app_session_steps')) {
        return { rowCount: params[2].length, rows: params[2].map((label, i) => ({ position: i, label, status: 'pending', updated_at: '2026-11-09T00:00:00.000Z' })) };
      }
      if (q.startsWith('update helmion.app_session_steps')) {
        return { rowCount: 1, rows: [{ position: params[2], label: 'Step one', status: params[3], updated_at: '2026-11-09T00:00:00.000Z', name: 'Build' }] };
      }
      if (q.startsWith('insert into helmion.audit_events')) { appends.push(params); return { rowCount: 1, rows: [{ id: appends.length }] }; }
      throw new Error(`unexpected ${q}`);
    },
    release() {},
  };
  const store = createAppSessionStore({ connect: async () => client });
  const actor = { tenantId: 't1', subject: 'user-1', role: 'owner' };
  await store.setPlan(actor, { sessionId: SID, steps: ['Step one', 'Step two'] });
  assert.equal(appends.at(-1)[5], 'app.task.planned', 'setPlan writes its audit row in the neighbour shape');
  await store.updateStep(actor, { sessionId: SID, position: 0, status: 'pending' });
  assert.equal(appends.at(-1)[5], 'app.task.step_pending', 'a reset to pending is audited like every other transition (the closed hole)');
  await store.updateStep(actor, { sessionId: SID, position: 0, status: 'done' });
  assert.equal(appends.at(-1)[5], 'app.task.step_done');
});

// ---------- wiring: the seams the mesh and evidence surface expose ----------

test('wiring: the mesh files refusal incidents and rides the knowledge base; the evidence route exists', async () => {
  const mesh = await readFile(new URL('../src/cloud/envoy-mesh.mjs', import.meta.url), 'utf8');
  assert.ok(mesh.includes('incidentJobs.push({ key: `guard-ask:'), 'a refused human ask becomes a knowledge base incident job');
  assert.ok(mesh.includes('fileIncidentFromDispatch(librarian, actor, incident'), 'incidents file post-commit through the fail-soft wrapper');
  assert.ok(mesh.includes('const knowledgeBase = await loadKnowledgeBase();'), 'the recall block loads at dispatch');
  assert.ok(mesh.includes('...(knowledgeBase ? { knowledgeBase } : {})'), 'and rides the work item beside the notebook');
  const evidence = await readFile(new URL('../src/cloud/evidence.mjs', import.meta.url), 'utf8');
  assert.ok(evidence.includes('/api/admin/envoy/channel-evidence'), 'the roll-up has its route');
  assert.ok(evidence.includes('getChannelEvidence'), 'behind the evidence store, owner/admin-gated like its neighbours');
  const migration = await readFile(new URL('../sql/076_librarian_kb.sql', import.meta.url), 'utf8');
  assert.match(migration, /create table if not exists helmion\.librarian_incidents/);
  assert.match(migration, /create table if not exists helmion\.librarian_rules/);
  assert.match(migration, /superseded_by_id/, 'the supersede chain is in the schema');
});
