import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createPcApprovalsHandler, PC_APPROVALS_PATH, PC_APPROVALS_DECIDE_PATH, PC_UPCOMING_PATH } from '../src/cloud/guard-pc-approvals.mjs';
import { guardQueueReadModel } from '../web/marketing/app/app-model.mjs';

const ENV = { HELMIAN_GUARD_URL: 'https://guard.test', HELMIAN_GUARD_APPROVER_TOKEN: 'approver-token-0123456789abcdef', HELMIAN_GUARD_APPROVER_SUBJECTS: 'user_troy1234' };
function req({ method = 'GET', cookie, bearer, body, type = 'application/json' } = {}) {
  const r = Readable.from(body ? [JSON.stringify(body)] : []);
  r.method = method;
  r.headers = { ...(cookie ? { cookie: `helmion_admin_session=${cookie}` } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body ? { 'content-type': type } : {}) };
  return r;
}
function res() { const out = { status: 0, body: null }; return { out, writeHead(s) { out.status = s; }, end(t) { out.body = JSON.parse(t); } }; }
const identity = () => ({ getSession: (c) => (c === 'troy-cookie' ? { subject: 'user_troy1234' } : c === 'bryce-cookie' ? { subject: 'user_bryce999' } : null) });
const verifyBearer = async (t) => (t === 'troy-clerk' ? { subject: 'user_troy1234' } : null);
function guardFetch(calls) {
  return async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/v1/approvals?status=pending')) return { status: 200, json: async () => ({ approvals: [{ id: 'e1297528-2117-4430-9c76-ea10bd833c19', status: 'pending', reason: 'needs a human', deviceId: 'hands-mcp', createdAt: 1, expiresAt: 901, action: { summary: 'hands write_file', site: 'hands.helmian', riskSignals: ['destructive-intent', 'tool:write_file'], contentHash: 'x'.repeat(64) } }] }) };
    if (url.endsWith('/v1/approvals?status=approved')) return { status: 200, json: async () => ({ approvals: [{ id: 'a2222222-2222-4333-8444-555555555555', status: 'approved', reason: 'approved by user_troy1234', deviceId: 'hands-mcp', createdAt: 100, expiresAt: 500, action: { summary: 'hands move_file', site: 'hands.helmian', riskSignals: ['tool:move_file'], contentHash: 'y'.repeat(64) } }] }) };
    if (url.endsWith('/v1/approvals?status=expired')) {
      const now = Math.floor(Date.now() / 1000);
      return { status: 200, json: async () => ({ approvals: [
        { id: 'e3333333-3333-4333-8444-555555555555', status: 'expired', deviceId: 'hands-mcp', createdAt: now - 7200, expiresAt: now - 3600, action: { summary: 'hands delete_file', riskSignals: ['tool:delete_file'] } },
        { id: 'e4444444-4444-4333-8444-555555555555', status: 'expired', deviceId: 'hands-mcp', createdAt: now - 100000, expiresAt: now - 90000, action: { summary: 'hands old ask', riskSignals: [] } },
      ] }) };
    }
    if (url.includes('/decide')) return { status: 200, json: async () => ({ approval: { id: 'e1297528-2117-4430-9c76-ea10bd833c19', status: JSON.parse(init.body).approve ? 'approved' : 'denied' } }) };
    return { status: 404, json: async () => ({}) };
  };
}

test('fails closed when not configured', async () => {
  const r = res();
  await createPcApprovalsHandler({ env: {}, identity, verifyBearer })(req({ cookie: 'troy-cookie' }), r, PC_APPROVALS_PATH);
  assert.equal(r.out.status, 503);
});

test('only allow-listed subjects (not any tenant owner) can list or decide', async () => {
  const calls = [];
  const h = createPcApprovalsHandler({ env: ENV, identity, verifyBearer, fetchImpl: guardFetch(calls) });
  let r = res(); await h(req({}), r, PC_APPROVALS_PATH); assert.equal(r.out.status, 401);
  r = res(); await h(req({ cookie: 'bryce-cookie' }), r, PC_APPROVALS_PATH); assert.equal(r.out.status, 403);
  assert.equal(calls.length, 0, 'Guard never called for unauthorized users');
});

test('owner lists pending approvals via cookie (/app) and decides via Clerk bearer (Herald)', async () => {
  const calls = [];
  const h = createPcApprovalsHandler({ env: ENV, identity, verifyBearer, fetchImpl: guardFetch(calls) });
  let r = res(); await h(req({ cookie: 'troy-cookie' }), r, PC_APPROVALS_PATH);
  assert.equal(r.out.status, 200);
  assert.equal(r.out.body.approvals[0].tool, 'write_file');
  assert.equal(r.out.body.approvals[0].summary, 'hands write_file');
  assert.equal('contentHash' in r.out.body.approvals[0], false);
  assert.equal(calls[0].init.headers.authorization, `Bearer ${ENV.HELMIAN_GUARD_APPROVER_TOKEN}`);
  r = res(); await h(req({ method: 'POST', bearer: 'troy-clerk', body: { approvalId: 'e1297528-2117-4430-9c76-ea10bd833c19', approve: false } }), r, PC_APPROVALS_DECIDE_PATH);
  assert.equal(r.out.status, 200);
  assert.equal(r.out.body.approval.status, 'denied');
  assert.match(JSON.parse(calls[1].init.body).reason, /denied by user_troy1234/);
});

test('upcoming merges pending + approved, soonest expiry first, and says who is waiting', async () => {
  const calls = [];
  const h = createPcApprovalsHandler({ env: ENV, identity, verifyBearer, fetchImpl: guardFetch(calls) });
  const r = res(); await h(req({ cookie: 'troy-cookie' }), r, PC_UPCOMING_PATH);
  assert.equal(r.out.status, 200);
  assert.deepEqual(calls.map((c) => c.url), [
    'https://guard.test/v1/approvals?status=pending',
    'https://guard.test/v1/approvals?status=approved',
    'https://guard.test/v1/approvals?status=expired',
  ]);
  assert.equal(r.out.body.queue.length, 2);
  assert.equal(r.out.body.queue[0].status, 'approved', 'approved item expires sooner (500 < 901), so it sorts first');
  assert.equal(r.out.body.queue[0].waitingOn, 'pc');
  assert.equal(r.out.body.queue[0].tool, 'move_file');
  assert.equal('contentHash' in r.out.body.queue[0], false);
  assert.equal(r.out.body.queue[1].status, 'pending');
  assert.equal(r.out.body.queue[1].waitingOn, 'you');
  assert.deepEqual(r.out.body.counts, { pending: 1, approved: 1, total: 2, expiredRecent: 1 }, 'only the last-24h expiry counts as recent');
});

test('upcoming is owner-only and never calls Guard for strangers', async () => {
  const calls = [];
  const h = createPcApprovalsHandler({ env: ENV, identity, verifyBearer, fetchImpl: guardFetch(calls) });
  let r = res(); await h(req({}), r, PC_UPCOMING_PATH); assert.equal(r.out.status, 401);
  r = res(); await h(req({ cookie: 'bryce-cookie' }), r, PC_UPCOMING_PATH); assert.equal(r.out.status, 403);
  assert.equal(calls.length, 0, 'Guard never called for unauthorized users');
});

test('upcoming fails soft with a 502 JSON error when Guard is unreachable or errors', async () => {
  const down = createPcApprovalsHandler({ env: ENV, identity, verifyBearer, fetchImpl: async () => { throw new Error('connect refused'); } });
  let r = res(); await down(req({ cookie: 'troy-cookie' }), r, PC_UPCOMING_PATH);
  assert.equal(r.out.status, 502);
  assert.equal(r.out.body.error, 'GUARD_UNAVAILABLE');
  const halfDown = createPcApprovalsHandler({ env: ENV, identity, verifyBearer, fetchImpl: async (url) => (url.includes('status=approved') ? { status: 500, json: async () => ({}) } : guardFetch([])(url)) });
  r = res(); await halfDown(req({ cookie: 'troy-cookie' }), r, PC_UPCOMING_PATH);
  assert.equal(r.out.status, 502);
  assert.equal(r.out.body.error, 'GUARD_UNAVAILABLE');
});

test('a hub-raised PC approval in the real Executive Guard shape lands in the approvals the view reads', async () => {
  // The payload below is field-for-field what the deployed Executive Guard
  // (executive-guard/src/server.mjs: decide() + publicApproval) emits for a
  // hands make_dir ask: seconds timestamps, actionHash + ruleId on the
  // record, and the frozen action { kind, site, contentHash, riskSignals,
  // summary }. If the route ever stops mapping this shape through, a PC ask
  // raised hub-side silently never renders in /app — this test is the pin.
  const realGuardApproval = {
    id: '02641f0c-7295-4257-a8d5-017874af5e8e',
    status: 'pending',
    createdAt: 1792954049,
    expiresAt: 1792954949,
    deviceId: 'hands-mcp',
    actionHash: '8fdedf9c60699bb9ee85cd04aaa0b2f39b03397015da446eb3162698a7b54b97',
    action: {
      kind: 'agent.tool',
      site: 'hands.helmian',
      contentHash: 'a'.repeat(64),
      riskSignals: ['destructive-intent', 'hands.act', 'tool:make_dir'],
      summary: 'hands make_dir → D:\\HelmianSpokeTest',
    },
    ruleId: 'destructive-needs-approval',
    reason: 'destructive actions need a human approval',
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { status: 200, json: async () => ({ approvals: [realGuardApproval] }) };
  };
  const h = createPcApprovalsHandler({ env: ENV, identity, verifyBearer, fetchImpl });
  const r = res(); await h(req({ cookie: 'troy-cookie' }), r, PC_APPROVALS_PATH);
  assert.equal(r.out.status, 200);
  assert.equal(calls[0].url, 'https://guard.test/v1/approvals?status=pending');
  assert.equal(r.out.body.approvals.length, 1, 'the pending PC ask survives the route into the list the approvals view renders');
  const [a] = r.out.body.approvals;
  assert.equal(a.approvalId, realGuardApproval.id);
  assert.equal(a.status, 'pending');
  assert.equal(a.tool, 'make_dir');
  assert.equal(a.summary, 'hands make_dir → D:\\HelmianSpokeTest');
  assert.equal(a.deviceId, 'hands-mcp');
  assert.equal(a.createdAt, new Date(1792954049 * 1000).toISOString(), 'Guard seconds become ISO for the view');
  assert.equal(a.expiresAt, new Date(1792954949 * 1000).toISOString());
  assert.equal('contentHash' in a, false);
  assert.equal('actionHash' in a, false);
});

test('guard answering 200 with a non-JSON body is GUARD_BAD_RESPONSE, never a silent empty queue', async () => {
  // What a placeholder or proxy page on the Guard's host looks like through
  // fetch: the parse rejects with a SyntaxError. This used to be swallowed
  // into {} and answered as 200 with an empty list — "no PC actions
  // waiting" while the Guard's real state was unknown.
  const htmlFetch = async () => ({ status: 200, json: async () => { throw new SyntaxError(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`); } });
  const h = createPcApprovalsHandler({ env: ENV, identity, verifyBearer, fetchImpl: htmlFetch });
  let r = res(); await h(req({ cookie: 'troy-cookie' }), r, PC_APPROVALS_PATH);
  assert.equal(r.out.status, 502);
  assert.equal(r.out.body.error, 'GUARD_BAD_RESPONSE');
  r = res(); await h(req({ cookie: 'troy-cookie' }), r, PC_UPCOMING_PATH);
  assert.equal(r.out.status, 502);
  assert.equal(r.out.body.error, 'GUARD_BAD_RESPONSE');
});

test('guard answering JSON of the wrong shape (a scalar) is GUARD_BAD_RESPONSE', async () => {
  const scalarFetch = async () => ({ status: 200, json: async () => 'ok' });
  const h = createPcApprovalsHandler({ env: ENV, identity, verifyBearer, fetchImpl: scalarFetch });
  const r = res(); await h(req({ cookie: 'troy-cookie' }), r, PC_APPROVALS_PATH);
  assert.equal(r.out.status, 502);
  assert.equal(r.out.body.error, 'GUARD_BAD_RESPONSE');
});

test('decide does not fabricate an approval from an unreadable Guard answer', async () => {
  const htmlFetch = async () => ({ status: 200, json: async () => { throw new SyntaxError('not json'); } });
  const h = createPcApprovalsHandler({ env: ENV, identity, verifyBearer, fetchImpl: htmlFetch });
  const r = res(); await h(req({ method: 'POST', cookie: 'troy-cookie', body: { approvalId: 'e1297528-2117-4430-9c76-ea10bd833c19', approve: true } }), r, PC_APPROVALS_DECIDE_PATH);
  assert.equal(r.out.status, 502);
  assert.equal(r.out.body.error, 'GUARD_BAD_RESPONSE');
  assert.equal(r.out.body.approval, undefined);
});

test('route -> reader: every real envelope of both read routes classifies into its designed page state, none unreadable', async () => {
  // The 2026-11-09 live walk sat in the page's 'unreadable' state on the
  // Approvals surface while the Guard was up. This pin runs the route's
  // REAL answers (both read paths, every Guard behaviour and auth state
  // the route can produce) through the page's own classifier: the healthy
  // envelopes must reach 'ok', each failure envelope its own state, and
  // nothing the route can emit may land in 'unreadable' — that state is
  // reserved for answers that never came from this route at all.
  const classify = async (h, request, path) => {
    const r = res(); await h(request, r, path);
    return guardQueueReadModel(r.out.status, JSON.stringify(r.out.body));
  };
  // Healthy Guard: empty queue and one pending both read ok on both routes.
  const healthy = createPcApprovalsHandler({ env: ENV, identity, verifyBearer, fetchImpl: guardFetch([]) });
  for (const path of [PC_APPROVALS_PATH, PC_UPCOMING_PATH]) {
    const read = await classify(healthy, req({ cookie: 'troy-cookie' }), path);
    assert.equal(read.state, 'ok', `${path} healthy`);
  }
  const emptyFetch = async () => ({ status: 200, json: async () => ({ approvals: [] }) });
  const empty = createPcApprovalsHandler({ env: ENV, identity, verifyBearer, fetchImpl: emptyFetch });
  for (const path of [PC_APPROVALS_PATH, PC_UPCOMING_PATH]) {
    const read = await classify(empty, req({ cookie: 'troy-cookie' }), path);
    assert.equal(read.state, 'ok', `${path} empty queue`);
    assert.deepEqual(path === PC_APPROVALS_PATH ? read.body.approvals : read.body.queue, []);
  }
  // Guard answering unreadable bodies -> guard-bad-response on both routes.
  const htmlFetch = async () => ({ status: 200, json: async () => { throw new SyntaxError('not json'); } });
  const html = createPcApprovalsHandler({ env: ENV, identity, verifyBearer, fetchImpl: htmlFetch });
  for (const path of [PC_APPROVALS_PATH, PC_UPCOMING_PATH]) {
    assert.equal((await classify(html, req({ cookie: 'troy-cookie' }), path)).state, 'guard-bad-response', `${path} html guard`);
  }
  // Guard down -> guard-unreachable on both routes.
  const down = createPcApprovalsHandler({ env: ENV, identity, verifyBearer, fetchImpl: async () => { throw new Error('connect refused'); } });
  for (const path of [PC_APPROVALS_PATH, PC_UPCOMING_PATH]) {
    assert.equal((await classify(down, req({ cookie: 'troy-cookie' }), path)).state, 'guard-unreachable', `${path} guard down`);
  }
  // The route's own auth/config states keep their page states.
  const unconfigured = createPcApprovalsHandler({ env: {}, identity, verifyBearer });
  assert.equal((await classify(unconfigured, req({ cookie: 'troy-cookie' }), PC_APPROVALS_PATH)).state, 'not-configured');
  assert.equal((await classify(healthy, req({}), PC_APPROVALS_PATH)).state, 'unauthenticated');
  assert.equal((await classify(healthy, req({ cookie: 'bryce-cookie' }), PC_APPROVALS_PATH)).state, 'forbidden');
});

test('an upstream refusal (403, empty body — the shape a refusing proxy actually sends) is the approver verdict, never an outage or a shape problem', async () => {
  // Proven live 2026-11-09: the Guard's public door answers remote
  // callers of /v1/approvals with 403 and an EMPTY body (response size
  // 0 in the door's own access log, 14k+ times) before the Guard ever
  // sees the request. Through fetch that is status 403 + a json() that
  // throws. The route must answer its designed refusal envelope, and
  // the page's classifier must read it as 'forbidden' (the approver
  // state) — not guard-unreachable, not guard-bad-response, not
  // unreadable.
  const refusedFetch = async () => ({ status: 403, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } });
  const h = createPcApprovalsHandler({ env: ENV, identity, verifyBearer, fetchImpl: refusedFetch });
  for (const path of [PC_APPROVALS_PATH, PC_UPCOMING_PATH]) {
    const r = res(); await h(req({ cookie: 'troy-cookie' }), r, path);
    assert.equal(r.out.status, 403, `${path} answers 403`);
    assert.equal(r.out.body.error, 'GUARD_APPROVER_REFUSED', `${path} refusal envelope`);
    assert.equal(r.out.body.status, 403, `${path} carries the upstream status`);
    assert.equal(guardQueueReadModel(r.out.status, JSON.stringify(r.out.body)).state, 'forbidden', `${path} classifies as the approver state`);
  }
});

test('an upstream refusal carrying the Guard refusal body ({error, message}) maps to the same designed envelope', async () => {
  // The Guard's own refusals are JSON with exactly the keys error +
  // message (captured from the box: its 401 for a bad token). If the
  // Guard itself ever refuses our approver credential with a 403 in
  // that family, the mapping is identical.
  const guardRefusedFetch = async () => ({ status: 403, json: async () => ({ error: 'forbidden', message: 'approver is not authorized for this road' }) });
  const h = createPcApprovalsHandler({ env: ENV, identity, verifyBearer, fetchImpl: guardRefusedFetch });
  for (const path of [PC_APPROVALS_PATH, PC_UPCOMING_PATH]) {
    const r = res(); await h(req({ cookie: 'troy-cookie' }), r, path);
    assert.equal(r.out.status, 403, `${path} answers 403`);
    assert.equal(r.out.body.error, 'GUARD_APPROVER_REFUSED', `${path} refusal envelope`);
    assert.equal(guardQueueReadModel(r.out.status, JSON.stringify(r.out.body)).state, 'forbidden', `${path} classifies as the approver state`);
  }
});

test('an upstream 401 (the Guard does not know our approver token) is the same refusal state, and decide refuses the same way', async () => {
  const unknownTokenFetch = async () => ({ status: 401, json: async () => ({ error: 'unauthorized', message: 'unknown approver token' }) });
  const h = createPcApprovalsHandler({ env: ENV, identity, verifyBearer, fetchImpl: unknownTokenFetch });
  const r = res(); await h(req({ cookie: 'troy-cookie' }), r, PC_APPROVALS_PATH);
  assert.equal(r.out.status, 403);
  assert.equal(r.out.body.error, 'GUARD_APPROVER_REFUSED');
  assert.equal(r.out.body.status, 401, 'the upstream status is carried, not hidden');
  assert.equal(guardQueueReadModel(r.out.status, JSON.stringify(r.out.body)).state, 'forbidden');
  const d = res(); await h(req({ method: 'POST', cookie: 'troy-cookie', body: { approvalId: 'e1297528-2117-4430-9c76-ea10bd833c19', approve: true } }), d, PC_APPROVALS_DECIDE_PATH);
  assert.equal(d.out.status, 403);
  assert.equal(d.out.body.error, 'GUARD_APPROVER_REFUSED');
});

test('decide validates input and requires JSON', async () => {
  const h = createPcApprovalsHandler({ env: ENV, identity, verifyBearer, fetchImpl: guardFetch([]) });
  let r = res(); await h(req({ method: 'POST', cookie: 'troy-cookie', body: { approvalId: 'x', approve: 'yes' } }), r, PC_APPROVALS_DECIDE_PATH); assert.equal(r.out.status, 400);
  r = res(); await h(req({ method: 'POST', cookie: 'troy-cookie', body: { approvalId: 'e1297528-2117', approve: true }, type: 'text/plain' }), r, PC_APPROVALS_DECIDE_PATH); assert.equal(r.out.status, 415);
});
