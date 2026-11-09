// "Add from GitHub" + the Tool access read (mirror-design §4 /
// §3.1, build bite M2):
//
//   - the GitHub file source serves ONLY repos a channel in this
//     workspace links to (the link is the room's repo truth) — an
//     unlinked repo is refused before any fetch, whatever it is;
//   - listings and file reads come from the GitHub API —
//     unauthenticated unless a token provider is wired (production
//     wires none today: no establishable lawful token source,
//     FIX-A Step 0). A spent rate limit answers with its own code
//     and words, a private or missing path answers in plain words
//     that cover both, any other upstream error keeps a distinct
//     message, and a file over the 256 KB attach limit is refused
//     by size before its bytes are handed over;
//   - '..' path segments never reach the API;
//   - the read route carries both new GETs behind the same member
//     gate as the library reads, passes a read's status-coded
//     refusal through untouched, and the tool-access answer carries
//     posture + annotations + enable state — never a token
//     reference.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONNECTOR_GITHUB_FILE_PATH,
  GITHUB_FILE_MAX_BYTES,
  createGithubFileRead,
  githubEntryRow,
} from '../src/cloud/connector-github-file.mjs';
import { handleConnectorLibraryRoute } from '../src/cloud/connector-library-read-route.mjs';

class TenantAuthorizationError extends Error {}

const ACTOR = { subject: 'user:troy', tenantId: 'tenant-a', role: 'owner' };

const fakeEnvoyStore = (repos) => ({
  async listChannels() {
    return { channels: repos.map((repo) => ({ id: `ch-${repo}`, github: { repo } })) };
  },
});

function fakeGithubFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init?.headers });
    return handler(new URL(url));
  };
  return { calls, fetchImpl };
}

const jsonResponse = (body, { ok = true, status = 200, headers = {} } = {}) => ({
  ok, status, json: async () => body,
  headers: { get: (name) => (Object.prototype.hasOwnProperty.call(headers, String(name).toLowerCase()) ? headers[String(name).toLowerCase()] : null) },
});

test('githubEntryRow: dirs and files map to the picker shape; other kinds drop', () => {
  assert.deepEqual(githubEntryRow({ name: 'src', path: 'src', type: 'dir' }), { name: 'src', path: 'src', kind: 'dir', size: null });
  assert.deepEqual(githubEntryRow({ name: 'a.md', path: 'docs/a.md', type: 'file', size: 42 }), { name: 'a.md', path: 'docs/a.md', kind: 'file', size: 42 });
  assert.equal(githubEntryRow({ name: 'sub', type: 'submodule' }), null);
  assert.equal(githubEntryRow({ type: 'file' }), null);
  assert.equal(githubEntryRow(null), null);
});

test('github file: an unlinked repo is refused before any fetch; a malformed repo name is refused outright', async () => {
  const { calls, fetchImpl } = fakeGithubFetch(() => { throw new Error('must not fetch'); });
  const read = createGithubFileRead({ envoyStore: fakeEnvoyStore(['helmianlabs/helmian']), fetchImpl });
  await assert.rejects(() => read(ACTOR, { repo: 'someone/else', path: '' }),
    (e) => e.status === 404 && e.code === 'GITHUB_REPO_NOT_LINKED');
  await assert.rejects(() => read(ACTOR, { repo: 'not-a-repo', path: '' }),
    (e) => e.status === 400 && e.code === 'GITHUB_REPO_INVALID');
  await assert.rejects(() => read(ACTOR, { repo: 'a/../b', path: '' }),
    (e) => e.status === 400 && e.code === 'GITHUB_REPO_INVALID');
  assert.equal(calls.length, 0, 'no fetch happens for a refused repo');
});

test('github file: a linked repo lists its root and folders (link match is case-insensitive)', async () => {
  const { calls, fetchImpl } = fakeGithubFetch((url) => {
    if (url.pathname === '/repos/HelmianLabs/Helmian/contents/') {
      return jsonResponse([
        { name: 'docs', path: 'docs', type: 'dir' },
        { name: 'README.md', path: 'README.md', type: 'file', size: 120 },
        { name: 'sub', path: 'sub', type: 'submodule' },
      ]);
    }
    throw new Error(`unexpected ${url.pathname}`);
  });
  const read = createGithubFileRead({ envoyStore: fakeEnvoyStore(['helmianlabs/helmian']), fetchImpl });
  const out = await read(ACTOR, { repo: 'HelmianLabs/Helmian', path: '' });
  assert.equal(out.kind, 'dir');
  assert.deepEqual(out.entries.map((e) => [e.name, e.kind]), [['docs', 'dir'], ['README.md', 'file']]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, undefined, 'the public read carries no token — the cloud holds none');
});

test('github file: a file read returns base64 with whitespace stripped; parent segments are removed, never resolved upward', async () => {
  const { calls, fetchImpl } = fakeGithubFetch(() => jsonResponse({ type: 'file', name: 'guide.md', size: 5, content: 'aGVs\nbG8=\n' }));
  const read = createGithubFileRead({ envoyStore: fakeEnvoyStore(['helmianlabs/helmian']), fetchImpl });
  const out = await read(ACTOR, { repo: 'helmianlabs/helmian', path: 'docs/guide.md' });
  assert.equal(out.kind, 'file');
  assert.equal(out.name, 'guide.md');
  assert.equal(out.data, 'aGVsbG8=');
  assert.equal(Buffer.from(out.data, 'base64').toString('utf8'), 'hello');
  assert.equal(new URL(calls[0].url).pathname, '/repos/helmianlabs/helmian/contents/docs/guide.md');
  // A traversal attempt: '..' segments are dropped outright, so the
  // request stays inside the repo's contents tree — it can never
  // climb out of /repos/{owner}/{repo}/contents/.
  await read(ACTOR, { repo: 'helmianlabs/helmian', path: '../../secret.md' });
  const climbed = new URL(calls[1].url).pathname;
  assert.ok(!climbed.split('/').includes('..'), 'no parent segment reaches the API');
  assert.equal(climbed, '/repos/helmianlabs/helmian/contents/secret.md');
});

test('github file: over the attach limit is refused by size before bytes travel', async () => {
  const { fetchImpl } = fakeGithubFetch(() => jsonResponse({ type: 'file', name: 'big.bin', size: GITHUB_FILE_MAX_BYTES + 1, content: '' }));
  const read = createGithubFileRead({ envoyStore: fakeEnvoyStore(['helmianlabs/helmian']), fetchImpl });
  await assert.rejects(() => read(ACTOR, { repo: 'helmianlabs/helmian', path: 'big.bin' }),
    (e) => e.status === 413 && e.code === 'GITHUB_FILE_TOO_BIG');
});

test('github file: a private or missing path answers in words that cover both and claim neither', async () => {
  const { fetchImpl } = fakeGithubFetch(() => jsonResponse({ message: 'Not Found' }, { ok: false, status: 404 }));
  const read = createGithubFileRead({ envoyStore: fakeEnvoyStore(['helmianlabs/helmian']), fetchImpl });
  await assert.rejects(() => read(ACTOR, { repo: 'helmianlabs/helmian', path: 'secret.md' }),
    (e) => e.status === 404 && e.code === 'GITHUB_FILE_UNAVAILABLE' && /may be private/.test(e.message));
  const down = createGithubFileRead({
    envoyStore: fakeEnvoyStore(['helmianlabs/helmian']),
    fetchImpl: async () => { throw new Error('socket gone'); },
  });
  await assert.rejects(() => down(ACTOR, { repo: 'helmianlabs/helmian', path: '' }),
    (e) => e.status === 502 && e.code === 'GITHUB_FILE_UNAVAILABLE');
});

test('github file: a token provider\u2019s token rides as a Bearer header; a failing or blank provider falls back to the public read', async () => {
  const { calls, fetchImpl } = fakeGithubFetch(() => jsonResponse([]));
  const authed = createGithubFileRead({
    envoyStore: fakeEnvoyStore(['helmianlabs/helmian']),
    fetchImpl,
    tokenProvider: async () => 'test-operator-token',
  });
  await authed(ACTOR, { repo: 'helmianlabs/helmian', path: '' });
  assert.equal(calls[0].headers.authorization, 'Bearer test-operator-token', 'the provider\u2019s token is sent on the API call');
  const broken = createGithubFileRead({
    envoyStore: fakeEnvoyStore(['helmianlabs/helmian']),
    fetchImpl,
    tokenProvider: async () => { throw new Error('vault unreachable'); },
  });
  const out = await broken(ACTOR, { repo: 'helmianlabs/helmian', path: '' });
  assert.equal(out.kind, 'dir');
  assert.equal(calls[1].headers.authorization, undefined, 'a provider failure never breaks the public read');
  const blank = createGithubFileRead({
    envoyStore: fakeEnvoyStore(['helmianlabs/helmian']),
    fetchImpl,
    tokenProvider: async () => '   ',
  });
  await blank(ACTOR, { repo: 'helmianlabs/helmian', path: '' });
  assert.equal(calls[2].headers.authorization, undefined, 'a blank token is no token');
});

test('github file: a spent rate limit answers with its own code and words — never the private/missing words', async () => {
  const limited = createGithubFileRead({
    envoyStore: fakeEnvoyStore(['helmianlabs/helmian']),
    fetchImpl: async () => jsonResponse({ message: 'API rate limit exceeded' }, { ok: false, status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
  });
  await assert.rejects(() => limited(ACTOR, { repo: 'helmianlabs/helmian', path: 'README.md' }),
    (e) => e.status === 503 && e.code === 'GITHUB_RATE_LIMITED' && /rate limit for this server is spent/.test(e.message) && !/private/.test(e.message));
  const throttled = createGithubFileRead({
    envoyStore: fakeEnvoyStore(['helmianlabs/helmian']),
    fetchImpl: async () => jsonResponse({ message: 'Too Many Requests' }, { ok: false, status: 429 }),
  });
  await assert.rejects(() => throttled(ACTOR, { repo: 'helmianlabs/helmian', path: '' }),
    (e) => e.status === 503 && e.code === 'GITHUB_RATE_LIMITED');
  // The remaining-budget header alone marks the throttle even on
  // another status: the budget being gone is the fact that matters.
  const headerOnly = createGithubFileRead({
    envoyStore: fakeEnvoyStore(['helmianlabs/helmian']),
    fetchImpl: async () => jsonResponse({ message: 'Forbidden' }, { ok: false, status: 403, headers: { 'x-ratelimit-remaining': '12' } }),
  });
  await assert.rejects(() => headerOnly(ACTOR, { repo: 'helmianlabs/helmian', path: '' }),
    (e) => e.code === 'GITHUB_RATE_LIMITED', 'a 403 is a throttle answer on this road');
});

test('github file: another upstream error keeps a distinct message — not the missing/private words, not the rate-limit words', async () => {
  const { fetchImpl } = fakeGithubFetch(() => jsonResponse({ message: 'Internal Server Error' }, { ok: false, status: 500 }));
  const read = createGithubFileRead({ envoyStore: fakeEnvoyStore(['helmianlabs/helmian']), fetchImpl });
  await assert.rejects(() => read(ACTOR, { repo: 'helmianlabs/helmian', path: 'x.md' }),
    (e) => e.status === 502 && e.code === 'GITHUB_FILE_UNAVAILABLE' && /HTTP 500/.test(e.message) && !/private/.test(e.message) && !/rate limit/.test(e.message));
});

// ------------------------------------------------------------ the route

function routeHarness({ actor = ACTOR, actorError = null, toolAccess = null, githubFile = null } = {}) {
  const sent = [];
  return {
    sent,
    async run(path, { method = 'GET' } = {}) {
      const handled = await handleConnectorLibraryRoute({
        request: { method },
        response: {},
        requestUrl: new URL(path, 'https://helmian.cloud'),
        activeTenantActor: async () => { if (actorError) throw actorError; return actor; },
        send: (response, status, payload) => { sent.push({ status, payload }); },
        TenantAuthorizationError,
        read: { async readSeatLibrary() { return { rows: [], connectedCount: 0, seed: null }; } },
        toolAccess,
        githubFile,
      });
      const last = sent[sent.length - 1];
      let json = null;
      try { json = JSON.parse(last?.payload ?? ''); } catch { /* not json */ }
      return { handled, status: last?.status, json };
    },
  };
}

test('route: tool-access answers posture + annotated tools for the caller, with no token reference anywhere', async () => {
  const seen = [];
  const h = routeHarness({
    toolAccess: async (tenantId, key) => {
      seen.push([tenantId, key]);
      return {
        connected: true, posture: 'read', snapshotTakenAt: '2026-11-09T10:00:00.000Z', snapshotHash: 'abc',
        tools: [{ name: 'search', description: 'Search', annotation: 'read', effectiveAnnotation: 'read', enabled: true }],
      };
    },
  });
  const out = await h.run('/api/admin/connector-library/tool-access?seat=claude&entry=custom-mcp');
  assert.equal(out.status, 200);
  assert.equal(out.json.posture, 'read');
  assert.equal(out.json.tools[0].annotation, 'read');
  assert.deepEqual(seen, [['tenant-a', { personId: 'user:troy', seatId: 'claude', entryId: 'custom-mcp' }]]);
  assert.ok(!JSON.stringify(out.json).includes('TokenRef'), 'no credential reference rides the answer');
  assert.equal((await h.run('/api/admin/connector-library/tool-access?seat=claude')).status, 400, 'seat and entry are both required');
});

test('route: github-file passes the read through, and a status-coded refusal keeps its status + words', async () => {
  const h = routeHarness({
    githubFile: async (actor, { repo, path }) => ({ kind: 'dir', repo, path, entries: [] }),
  });
  const ok = await h.run(`${CONNECTOR_GITHUB_FILE_PATH}?repo=helmianlabs/helmian&path=docs`);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.kind, 'dir');
  const refusing = routeHarness({
    githubFile: async () => { throw Object.assign(new Error('that repository is not linked to any channel in this workspace — link it to a channel first'), { status: 404, code: 'GITHUB_REPO_NOT_LINKED' }); },
  });
  const no = await refusing.run(`${CONNECTOR_GITHUB_FILE_PATH}?repo=someone/else`);
  assert.equal(no.status, 404);
  assert.equal(no.json.code, 'GITHUB_REPO_NOT_LINKED');
  assert.match(no.json.error, /not linked to any channel/);
});

test('route: a rate-limited github read reaches the picker as 503 with the route\u2019s plain words in the error field', async () => {
  const h = routeHarness({
    githubFile: createGithubFileRead({
      envoyStore: fakeEnvoyStore(['helmianlabs/helmian']),
      fetchImpl: async () => jsonResponse({ message: 'API rate limit exceeded' }, { ok: false, status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
    }),
  });
  const out = await h.run(`${CONNECTOR_GITHUB_FILE_PATH}?repo=helmianlabs/helmian&path=README.md`);
  assert.equal(out.status, 503);
  assert.equal(out.json.code, 'GITHUB_RATE_LIMITED');
  assert.match(out.json.error, /rate limit for this server is spent/, 'the words ride the body — the picker renders them, not the code');
});

test('route: both new reads sit behind the same member gate; other methods and paths are refused or unhandled', async () => {
  const gated = routeHarness({ actorError: new TenantAuthorizationError('nope'), toolAccess: async () => ({}), githubFile: async () => ({}) });
  assert.equal((await gated.run('/api/admin/connector-library/tool-access?seat=claude&entry=x')).status, 403);
  assert.equal((await gated.run(`${CONNECTOR_GITHUB_FILE_PATH}?repo=a/b`)).status, 403);
  const h = routeHarness({ toolAccess: async () => ({}) });
  assert.equal((await h.run('/api/admin/connector-library/tool-access?seat=claude&entry=x', { method: 'POST' })).status, 405);
  assert.equal((await h.run('/api/admin/something-else')).handled, false);
  assert.equal((await h.run('/api/admin/connector-library/tool-access?seat=claude&entry=x&tenantId=other')).status, 400, 'authority selectors are refused on the new reads too');
});
