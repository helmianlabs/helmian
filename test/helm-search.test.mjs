// Bite H5 of the Maestro/Helm/Librarian fix programme (DESIGN
// 3.3, bite H5; BITE-MAP line 14): Helm gains the search road.
// A general question that reaches Helm — no state answer, no
// filed answer — is answered from a live search behind ONE
// provider interface (src/cloud/helm-search.mjs: Tavily
// primary, Exa fallback), composed from the retrieved pages'
// own text with citations naming the pages read, posted as
// agent:helm, and filed through the Librarian — the one pen —
// as a dated entry under key helm:<messageId>, so a repeated
// question is answered from the record with no second search.
//
// The desk proof, all against scripted fakes (no live keys, no
// live provider calls anywhere in this file):
//   - the two providers against a scripted fetch: request
//     shape, result parsing, page reads, failure as a throw;
//   - the composite: no keys is null (the room's no-key road),
//     Tavily failing or returning nothing usable fails over to
//     Exa behind the same interface, both failing is null;
//   - the citation assembly: excerpts are the pages' own
//     words, the citations name every page read;
//   - the answerer: success, read-failure fallback to the
//     result's own text, and every degradation (no searcher,
//     a throwing search, empty results, unreadable pages)
//     returning null — the caller's availability-line cue;
//   - the mesh end to end on the H3 fake pool: a general
//     question gets the searched, source-named answer and
//     files exactly one dated helm:<messageId> entry through
//     the Librarian; asking again is answered from the record
//     without a second search; provider failure and the
//     no-key configuration degrade to the availability line
//     plus exactly one miss filing and file no answer; an
//     Exa-posture answer (mayFileAnswers false, the terms
//     reading in helm-search.mjs) posts with citations and
//     files nothing;
//   - the store on Postgres (HELMIAN_TEST_PG_URL): the filing
//     lands once under the tenant's slug however often it is
//     filed, and the recall read finds it.
//
// Terms posture asserted here, read at the clause level on
// 2026-11-16 (bite H5's REPORT.md carries the reading):
// Tavily's terms bar no storage of results, so its answers
// file; Exa's section 4.2(a) bars reproducing or deriving
// works from what its services return, so its answers are
// answered from but not filed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  composeHelmSearchAnswer,
  createHelmSearch,
  exaHelmSearchProvider,
  tavilyHelmSearchProvider,
} from '../src/cloud/helm-search.mjs';
import { HELM_AVAILABILITY_LINE, HELM_SUBJECT, helmSearchAnswer } from '../src/cloud/envoy-helm.mjs';
import { createLibrarianStore, fileHelmSearchAnswer, librarianHelmEntryFor } from '../src/cloud/envoy-librarian.mjs';
import { createEnvoyMesh } from '../src/cloud/envoy-mesh.mjs';
import { emptyConfig, serializeConfig } from '../src/cloud/envoy-agents.mjs';

// ------------------------------------------------------------ the providers

// A scripted fetch: routes by URL fragment to a handler that
// returns { status?, body } or throws; records every call.
function scriptedFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = { url: String(url), headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    for (const [fragment, handler] of routes) {
      if (call.url.includes(fragment)) {
        const out = await handler(call);
        const status = out?.status ?? 200;
        return { ok: status >= 200 && status < 300, status, json: async () => out?.body ?? {} };
      }
    }
    throw new Error(`no scripted route for ${call.url}`);
  };
  return { fetchImpl, calls };
}

const TAVILY_SEARCH_BODY = {
  results: [
    { title: 'Oslo — Encyclopaedia', url: 'https://example.no/oslo', content: 'Oslo is the capital of Norway.' },
    { title: 'Norway facts', url: 'https://example.org/norway', content: 'Norway is a country in Northern Europe.' },
  ],
};
const NORWAY_PAGE = 'Norway is a country in Northern Europe.\n\nOslo is the capital and most populous city of Norway, founded around 1048 by King Harald Hardrada.';

test('helm search: the Tavily provider searches and reads through its two endpoints (bite H5)', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    ['api.tavily.com/search', () => ({ body: TAVILY_SEARCH_BODY })],
    ['api.tavily.com/extract', () => ({ body: { results: [{ url: 'https://example.no/oslo', raw_content: NORWAY_PAGE }] } })],
  ]);
  const provider = tavilyHelmSearchProvider({ apiKey: 'tvly-test', fetchImpl });
  assert.equal(provider.name, 'tavily');
  assert.equal(provider.mayFileAnswers, true, 'Tavily answers file (its terms bar no storage of results)');
  const results = await provider.searchWeb('what is the capital of Norway?');
  assert.deepEqual(results, [
    { title: 'Oslo — Encyclopaedia', url: 'https://example.no/oslo', content: 'Oslo is the capital of Norway.' },
    { title: 'Norway facts', url: 'https://example.org/norway', content: 'Norway is a country in Northern Europe.' },
  ]);
  const searchCall = calls.find((c) => c.url.includes('/search'));
  assert.equal(searchCall.headers.authorization, 'Bearer tvly-test');
  assert.equal(searchCall.body.query, 'what is the capital of Norway?');
  assert.equal(searchCall.body.include_answer, false, 'Helm never asks the provider for its generated answer — the answer is composed from retrieved text');
  const page = await provider.readPage('https://example.no/oslo');
  assert.equal(page.text, NORWAY_PAGE);
  assert.equal(page.url, 'https://example.no/oslo');
  assert.equal(tavilyHelmSearchProvider({ apiKey: '', fetchImpl }), null, 'no key, no provider');
});

test('helm search: a provider HTTP failure throws, so the composite can fail over (bite H5)', async () => {
  const { fetchImpl } = scriptedFetch([['api.tavily.com/search', () => ({ status: 503, body: {} })]]);
  const provider = tavilyHelmSearchProvider({ apiKey: 'tvly-test', fetchImpl });
  await assert.rejects(() => provider.searchWeb('anything'), /HTTP 503/);
});

test('helm search: the Exa provider searches and reads through its two endpoints (bite H5)', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    ['api.exa.ai/search', () => ({ body: { results: [{ title: 'Oslo — Encyclopaedia', url: 'https://example.no/oslo', text: 'Oslo is the capital of Norway.' }] } })],
    ['api.exa.ai/contents', () => ({ body: { results: [{ title: 'Oslo — Encyclopaedia', url: 'https://example.no/oslo', text: NORWAY_PAGE }] } })],
  ]);
  const provider = exaHelmSearchProvider({ apiKey: 'exa-test', fetchImpl });
  assert.equal(provider.name, 'exa');
  assert.equal(provider.mayFileAnswers, false, 'Exa answers are answered from but not filed (its terms, section 4.2(a))');
  const results = await provider.searchWeb('what is the capital of Norway?');
  assert.deepEqual(results, [{ title: 'Oslo — Encyclopaedia', url: 'https://example.no/oslo', content: 'Oslo is the capital of Norway.' }]);
  assert.equal(calls.find((c) => c.url.includes('/search')).headers['x-api-key'], 'exa-test');
  const page = await provider.readPage('https://example.no/oslo');
  assert.equal(page.text, NORWAY_PAGE);
  assert.equal(page.title, 'Oslo — Encyclopaedia');
  assert.equal(exaHelmSearchProvider({ apiKey: '', fetchImpl }), null, 'no key, no provider');
});

// ------------------------------------------------------------ the composite

test('helm search: no provider key configured is a closed road, never a broken one (bite H5)', () => {
  assert.equal(createHelmSearch({ tavilyKey: '', exaKey: '' }), null);
  assert.deepEqual(createHelmSearch({ tavilyKey: '', exaKey: 'exa-test', fetchImpl: async () => { throw new Error('unused'); } }).providers, ['exa']);
  assert.deepEqual(createHelmSearch({ tavilyKey: 'tvly-test', exaKey: 'exa-test', fetchImpl: async () => { throw new Error('unused'); } }).providers, ['tavily', 'exa']);
});

test('helm search: Tavily failing fails over to Exa behind the same interface (bite H5)', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    ['api.tavily.com', () => { throw new Error('tavily is down'); }],
    ['api.exa.ai/search', () => ({ body: { results: [{ title: 'Oslo — Encyclopaedia', url: 'https://example.no/oslo', text: 'Oslo is the capital of Norway.' }] } })],
    ['api.exa.ai/contents', () => ({ body: { results: [{ title: 'Oslo — Encyclopaedia', url: 'https://example.no/oslo', text: NORWAY_PAGE }] } })],
  ]);
  const search = createHelmSearch({ tavilyKey: 'tvly-test', exaKey: 'exa-test', fetchImpl });
  const found = await search.searchWeb('what is the capital of Norway?');
  assert.equal(found.provider, 'exa');
  assert.equal(found.mayFileAnswers, false);
  assert.equal(found.results.length, 1);
  const page = await found.readPage('https://example.no/oslo');
  assert.equal(page.text, NORWAY_PAGE, 'the page is read through the door that found it');
  assert.ok(calls.some((c) => c.url.includes('api.exa.ai/contents')), 'the read went to Exa, not the failed Tavily');
});

test('helm search: Tavily returning nothing usable fails over to Exa; both failing is null (bite H5)', async () => {
  const empty = scriptedFetch([
    ['api.tavily.com/search', () => ({ body: { results: [] } })],
    ['api.exa.ai/search', () => ({ body: { results: [{ title: 'Oslo — Encyclopaedia', url: 'https://example.no/oslo', text: 'Oslo is the capital of Norway.' }] } })],
  ]);
  const search = createHelmSearch({ tavilyKey: 'tvly-test', exaKey: 'exa-test', fetchImpl: empty.fetchImpl });
  assert.equal((await search.searchWeb('what is the capital of Norway?')).provider, 'exa');

  const down = scriptedFetch([
    ['api.tavily.com', () => { throw new Error('down'); }],
    ['api.exa.ai', () => ({ status: 500, body: {} })],
  ]);
  const deadSearch = createHelmSearch({ tavilyKey: 'tvly-test', exaKey: 'exa-test', fetchImpl: down.fetchImpl });
  assert.equal(await deadSearch.searchWeb('what is the capital of Norway?'), null, 'no provider serving is null, never a throw');
});

// ------------------------------------------------------------ the citation assembly

test('helm search: the composed answer quotes the pages and names every page read (bite H5)', () => {
  const composed = composeHelmSearchAnswer({
    question: 'what is the capital of Norway?',
    pages: [
      { title: 'Oslo — Encyclopaedia', url: 'https://example.no/oslo', text: NORWAY_PAGE },
      { title: 'Norway facts', url: 'https://example.org/norway', text: 'Norway is a country in Northern Europe, bordered by Sweden, Finland and Russia.\n\nIts capital is Oslo.' },
    ],
  });
  assert.ok(composed, 'an answer composes from readable pages');
  assert.ok(composed.body.includes('Oslo is the capital and most populous city of Norway'), 'the excerpt is the page\u2019s own words, on the question\u2019s topic');
  assert.ok(composed.body.includes('Sources: Oslo — Encyclopaedia (https://example.no/oslo); Norway facts (https://example.org/norway)'),
    'the citations name every page read, title and URL');
  assert.deepEqual(composed.sources, [
    { title: 'Oslo — Encyclopaedia', url: 'https://example.no/oslo' },
    { title: 'Norway facts', url: 'https://example.org/norway' },
  ]);
  assert.equal(composeHelmSearchAnswer({ question: 'x', pages: [] }), null, 'no pages, no answer');
  assert.equal(composeHelmSearchAnswer({ question: 'x', pages: [{ title: 't', url: 'https://e.example', text: '   ' }] }), null, 'no readable text, no answer');
});

// ------------------------------------------------------------ the answerer

const fakeSearcher = (over = {}) => ({
  searchWeb: async () => ({
    provider: 'tavily',
    mayFileAnswers: true,
    results: [{ title: 'Oslo — Encyclopaedia', url: 'https://example.no/oslo', content: 'Oslo is the capital of Norway.' }],
    readPage: async (url) => ({ title: '', url, text: NORWAY_PAGE }),
    ...over,
  }),
});

test('helm search: the answerer composes from the read pages and carries the provider posture (bite H5)', async () => {
  const answer = await helmSearchAnswer({ search: fakeSearcher(), question: 'what is the capital of Norway?', log: () => {} });
  assert.ok(answer);
  assert.equal(answer.provider, 'tavily');
  assert.equal(answer.mayFileAnswers, true);
  assert.ok(answer.body.includes('Oslo is the capital and most populous city of Norway'), 'the read page\u2019s deeper text, not just the result snippet');
  assert.ok(answer.body.includes('Sources: Oslo — Encyclopaedia (https://example.no/oslo)'));
});

test('helm search: a failed page read falls back to the search result\u2019s own text (bite H5)', async () => {
  const answer = await helmSearchAnswer({
    search: fakeSearcher({ readPage: async () => { throw new Error('extract failed'); } }),
    question: 'what is the capital of Norway?',
    log: () => {},
  });
  assert.ok(answer, 'the result\u2019s own cleaned text still grounds an answer');
  assert.ok(answer.body.includes('Oslo is the capital of Norway.'));
});

test('helm search: every degradation returns null — the availability line\u2019s cue (bite H5)', async () => {
  const log = () => {};
  assert.equal(await helmSearchAnswer({ search: null, question: 'q', log }), null, 'no searcher (no key)');
  assert.equal(await helmSearchAnswer({ search: { searchWeb: async () => { throw new Error('boom'); } }, question: 'q', log }), null, 'a throwing search');
  assert.equal(await helmSearchAnswer({ search: { searchWeb: async () => null }, question: 'q', log }), null, 'no provider served');
  assert.equal(await helmSearchAnswer({
    search: fakeSearcher({ results: [{ title: 't', url: 'https://e.example', content: '' }], readPage: async () => null }),
    question: 'q', log,
  }), null, 'results with no readable text anywhere');
});

// ------------------------------------------------------------ the mesh road

// The H3 fake pool, carried over: one channel's rows, stateful
// (inserts land in the row set), the miss filings captured.
const H5_TENANT = 'tenant-h5';
const H5_CHANNEL_ID = '22222222-3333-4444-8555-666666666666';
const H5_DEVICE = { tenantId: H5_TENANT, subject: 'user_author', role: 'owner', viaDeviceToken: true };
const h5Row = (over) => ({
  id: randomUUID(), channel_id: H5_CHANNEL_ID, author_subject: 'user_author', author_kind: 'human',
  body: '', idempotency_key: `h5-${randomUUID()}`, created_at: new Date(), metadata: null, ...over,
});

function fakeHelmPool({ configBody, rows = [] }) {
  const state = { rows: [...rows], inserts: [], updates: [], misses: [] };
  let insertSeq = 0;
  const client = {
    async query(text, vals = []) {
      const sql = String(text);
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [], rowCount: 0 };
      if (sql.includes("set_config('helmion.tenant_id'")) return { rows: [{}], rowCount: 1 };
      if (sql.includes('tenant_memberships')) return { rows: [{ role: 'owner' }], rowCount: 1 };
      if (sql.includes('from helmion.desktop_links')) return { rows: [{ n: 0 }], rowCount: 1 };
      if (sql.includes('runner_provider_presence')) return { rows: [], rowCount: 0 };
      if (sql.includes('provider_connections')) return { rows: [], rowCount: 0 };
      if (sql.includes('distinct on (channel_id)')) return { rows: [{ channel_id: H5_CHANNEL_ID, body: configBody }], rowCount: 1 };
      if (sql.includes("metadata -> 'maestroAssignment'")) return { rows: [], rowCount: 0 };
      if (sql.includes('lateral')) {
        const newestFirst = [...state.rows].reverse();
        if (!newestFirst.length) {
          return { rows: [{ ch_id: H5_CHANNEL_ID, ch_slug: 'build', ch_title: 'Build', ch_kind: 'team', id: null, channel_id: null, author_subject: null, author_kind: null, body: null, idempotency_key: null, created_at: null, metadata: null }], rowCount: 1 };
        }
        return { rows: newestFirst.map((r) => ({ ch_id: H5_CHANNEL_ID, ch_slug: 'build', ch_title: 'Build', ch_kind: 'team', ...r })), rowCount: newestFirst.length };
      }
      if (sql.includes('from helmion.envoy_channels')) return { rows: [{ id: H5_CHANNEL_ID, slug: 'build', title: 'Build', kind: 'team' }], rowCount: 1 };
      if (sql.startsWith('insert into helmion.helm_kb_misses')) {
        state.misses.push({ tenantId: vals[0], channelId: vals[1], senderSubject: vals[2], question: vals[3] });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('insert into helmion.envoy_messages')) {
        const dupe = state.rows.find((r) => r.channel_id === vals[1] && r.author_subject === vals[2] && r.idempotency_key === vals[5]);
        if (dupe) return { rows: [], rowCount: 0 };
        const row = {
          id: `99999999-0000-4000-8000-${String(++insertSeq).padStart(12, '0')}`, channel_id: vals[1],
          author_subject: vals[2], author_kind: vals[3], body: vals[4], idempotency_key: vals[5],
          created_at: new Date(), metadata: vals[6] ? JSON.parse(vals[6]) : null,
        };
        state.rows.push(row);
        state.inserts.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes('idempotency_key=$4')) {
        const row = state.rows.find((r) => r.channel_id === vals[1] && r.author_subject === vals[2] && r.idempotency_key === vals[3]);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.startsWith('update helmion.envoy_messages')) {
        const row = state.rows.find((r) => String(r.id) === String(vals[2]));
        if (row) {
          row.metadata = { ...(row.metadata ?? {}), ...JSON.parse(vals[4]) };
          state.updates.push({ messageId: vals[2], mark: JSON.parse(vals[4]) });
        }
        return { rows: [], rowCount: row ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return { pool: { async connect() { return client; } }, state };
}

function h5Mesh(pool, extra = {}) {
  const filedHelmAnswers = [];
  const mesh = createEnvoyMesh({
    pool,
    publishImpl: async () => {},
    agentStateImpl: async () => ({ state: 'ready', gated: false }),
    notebookImpl: async () => null,
    kbImpl: async () => null,
    librarianImpl: {
      async fileAsk() { return { filed: true }; },
      async renameChannelIfGeneric() { return true; },
      async fileIncident() { return { filed: true }; },
      async fileHelmAnswer(actor, job) { filedHelmAnswers.push(job); return { filed: true, key: `helm:${job.messageId}` }; },
    },
    helmLogImpl: () => {},
    ...extra,
  });
  return { mesh, filedHelmAnswers };
}
const helmInserts = (state) => state.inserts.filter((r) => r.author_subject === HELM_SUBJECT);
const h5Config = () => {
  const config = emptyConfig();
  config.agents = ['claude'];
  return serializeConfig(config);
};

test('mesh on fakes: a general question gets a searched, source-named answer, filed once under helm:<messageId> (bite H5)', async () => {
  const ask = h5Row({ body: '@Helm what is the capital of Norway?' });
  const { pool, state } = fakeHelmPool({ configBody: h5Config(), rows: [ask] });
  const { mesh, filedHelmAnswers } = h5Mesh(pool, { helmSearchImpl: async () => fakeSearcher(), helmEntriesReadImpl: async () => [] });
  await mesh.agentWork(H5_DEVICE, 'claude');
  await mesh.drainFilingTail();
  assert.equal(helmInserts(state).length, 1, 'one Helm answer');
  const body = helmInserts(state)[0].body;
  assert.ok(body.includes('Oslo is the capital and most populous city of Norway'), 'the answer is composed from the retrieved page text');
  assert.ok(body.includes('Sources: Oslo — Encyclopaedia (https://example.no/oslo)'), 'the answer names its source');
  assert.notEqual(body, HELM_AVAILABILITY_LINE, 'the searched answer replaces the availability line');
  assert.equal(state.misses.length, 0, 'an answered question files no miss');
  assert.equal(filedHelmAnswers.length, 1, 'exactly one filing rides the tail');
  const job = filedHelmAnswers[0];
  assert.equal(job.messageId, ask.id);
  assert.equal(librarianHelmEntryFor(job).key, `helm:${ask.id}`, 'the filing keys under helm:<messageId>');
  assert.equal(job.answer, body, 'what files is the answer that was posted, citations and all');
  assert.equal(job.provider, 'tavily');
  assert.ok(Number.isFinite(Date.parse(job.at)), 'the filing is dated');
  assert.deepEqual(job.sources, [{ title: 'Oslo — Encyclopaedia', url: 'https://example.no/oslo' }]);
});

test('mesh on fakes: asking again is answered from the filed record, with no second search (bite H5)', async () => {
  const filedBody = composeHelmSearchAnswer({
    question: 'what is the capital of Norway?',
    pages: [{ title: 'Oslo — Encyclopaedia', url: 'https://example.no/oslo', text: NORWAY_PAGE }],
  }).body;
  const firstAskId = '11111111-2222-4333-8444-555555555555';
  let searchCalls = 0;
  const countingSearcher = {
    searchWeb: async () => { searchCalls += 1; return fakeSearcher().searchWeb(); },
  };
  const ask = h5Row({ body: '@Helm what is the capital of Norway?' });
  const { pool, state } = fakeHelmPool({ configBody: h5Config(), rows: [ask] });
  const { mesh, filedHelmAnswers } = h5Mesh(pool, {
    helmSearchImpl: async () => countingSearcher,
    helmEntriesReadImpl: async () => [{ key: `helm:${firstAskId}`, value: { fact: filedBody } }],
  });
  await mesh.agentWork(H5_DEVICE, 'claude');
  await mesh.drainFilingTail();
  assert.equal(helmInserts(state).length, 1, 'one Helm answer');
  assert.equal(helmInserts(state)[0].body, filedBody, 'the filed search answer is quoted verbatim from the record');
  assert.equal(searchCalls, 0, 'no second search was rented');
  assert.equal(filedHelmAnswers.length, 0, 'nothing new files — the record already stands');
  assert.equal(state.misses.length, 0);
});

test('mesh on fakes: a provider failure degrades to the availability line and one miss, and files no answer (bite H5)', async () => {
  const ask = h5Row({ body: '@Helm what is the capital of Norway?' });
  const { pool, state } = fakeHelmPool({ configBody: h5Config(), rows: [ask] });
  const { mesh, filedHelmAnswers } = h5Mesh(pool, { helmSearchImpl: async () => ({ searchWeb: async () => null }), helmEntriesReadImpl: async () => [] });
  await mesh.agentWork(H5_DEVICE, 'claude');
  await mesh.drainFilingTail();
  assert.equal(helmInserts(state).length, 1, 'Helm still answers — honestly');
  assert.equal(helmInserts(state)[0].body, HELM_AVAILABILITY_LINE);
  assert.equal(state.misses.length, 1, 'exactly one miss filing');
  assert.equal(filedHelmAnswers.length, 0, 'no answer files');
});

test('mesh on fakes: with no provider key configured the road is today\u2019s behaviour exactly (bite H5)', async () => {
  const ask = h5Row({ body: '@Helm what is the capital of Norway?' });
  const { pool, state } = fakeHelmPool({ configBody: h5Config(), rows: [ask] });
  const { mesh, filedHelmAnswers } = h5Mesh(pool, { helmSearchImpl: async () => null, helmEntriesReadImpl: async () => [] });
  await mesh.agentWork(H5_DEVICE, 'claude');
  await mesh.drainFilingTail();
  assert.equal(helmInserts(state)[0].body, HELM_AVAILABILITY_LINE);
  assert.equal(state.misses.length, 1);
  assert.equal(filedHelmAnswers.length, 0);
});

test('mesh on fakes: an Exa-posture answer posts with citations and files nothing (bite H5)', async () => {
  const ask = h5Row({ body: '@Helm what is the capital of Norway?' });
  const { pool, state } = fakeHelmPool({ configBody: h5Config(), rows: [ask] });
  const exaSearcher = fakeSearcher({
    provider: 'exa',
    mayFileAnswers: false,
  });
  const { mesh, filedHelmAnswers } = h5Mesh(pool, { helmSearchImpl: async () => exaSearcher, helmEntriesReadImpl: async () => [] });
  await mesh.agentWork(H5_DEVICE, 'claude');
  await mesh.drainFilingTail();
  assert.equal(helmInserts(state).length, 1, 'the answer posts');
  assert.ok(helmInserts(state)[0].body.includes('Sources: Oslo — Encyclopaedia (https://example.no/oslo)'), 'with its citations');
  assert.equal(state.misses.length, 0, 'an answered question files no miss');
  assert.equal(filedHelmAnswers.length, 0, 'and no filing: Exa\u2019s terms bar the derived record (helm-search.mjs)');
});

// ------------------------------------------------------------ the store on Postgres

const pgUrl = process.env.HELMIAN_TEST_PG_URL;
const pgSkip = pgUrl ? false : 'HELMIAN_TEST_PG_URL is not set';

test('helm search filing on Postgres: exactly one dated entry under helm:<messageId>, found by recall (bite H5)', { skip: pgSkip }, async () => {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: pgUrl, max: 4 });
  const tenantId = `t-${randomUUID().slice(0, 8)}`;
  const actor = { tenantId, subject: `user_${randomUUID().replaceAll('-', '').slice(0, 20)}`, role: 'owner', get sessionId() { return randomUUID(); }, get requestId() { return randomUUID(); } };
  const silent = { log: () => {} };
  try {
    await pool.query('insert into helmion.tenants(tenant_id, display_name) values ($1,$2)', [tenantId, 'Helm search test']);
    await pool.query('insert into helmion.tenant_memberships(tenant_id, subject, role) values ($1,$2,$3)', [tenantId, actor.subject, 'owner']);
    const store = createLibrarianStore(pool);
    const answerBody = composeHelmSearchAnswer({
      question: 'what is the capital of Norway?',
      pages: [{ title: 'Oslo — Encyclopaedia', url: 'https://example.no/oslo', text: NORWAY_PAGE }],
    }).body;
    const job = {
      channelId: randomUUID(), channelTitle: 'Build', messageId: 'm-search-1',
      humanSubject: actor.subject, humanName: 'Troy',
      question: 'what is the capital of Norway?', answer: answerBody,
      sources: [{ title: 'Oslo — Encyclopaedia', url: 'https://example.no/oslo' }],
      provider: 'tavily', at: '2026-11-16T09:00:00.000Z',
    };
    assert.equal(await fileHelmSearchAnswer(store, actor, job, silent), true);
    assert.equal(await fileHelmSearchAnswer(store, actor, job, silent), true, 'a replayed filing still lands — on the same one entry');
    const again = await store.fileHelmAnswer(actor, job);
    assert.equal(again.filed, false);
    assert.equal(again.alreadyFiled, true, 'the second filing is recognised, not rewritten');
    const rows = (await pool.query(
      'select project_slug, value from helmion.context_entries where project_slug = $1 and key = $2',
      [tenantId, 'helm:m-search-1'],
    )).rows;
    assert.equal(rows.length, 1, 'exactly one entry under helm:<messageId>');
    assert.equal(rows[0].value.fact, answerBody, 'the filed fact is the posted answer, citations and all');
    assert.equal(rows[0].value.at, '2026-11-16T09:00:00.000Z', 'the entry is dated');
    assert.equal(rows[0].value.provider, 'tavily');
    assert.deepEqual(rows[0].value.sources, [{ title: 'Oslo — Encyclopaedia', url: 'https://example.no/oslo' }]);
    const recall = await store.lookupFacts(actor, { query: 'capital of Norway' });
    assert.equal(recall.found, true, 'the recall read (bite L2) finds the filed search answer');
    assert.equal(recall.key, 'helm:m-search-1');
    assert.equal(recall.text, answerBody);
  } finally {
    await pool.end();
  }
});
