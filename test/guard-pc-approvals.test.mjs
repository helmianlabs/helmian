import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createPcApprovalsHandler, PC_APPROVALS_PATH, PC_APPROVALS_DECIDE_PATH, PC_UPCOMING_PATH } from '../src/cloud/guard-pc-approvals.mjs';

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

test('decide validates input and requires JSON', async () => {
  const h = createPcApprovalsHandler({ env: ENV, identity, verifyBearer, fetchImpl: guardFetch([]) });
  let r = res(); await h(req({ method: 'POST', cookie: 'troy-cookie', body: { approvalId: 'x', approve: 'yes' } }), r, PC_APPROVALS_DECIDE_PATH); assert.equal(r.out.status, 400);
  r = res(); await h(req({ method: 'POST', cookie: 'troy-cookie', body: { approvalId: 'e1297528-2117', approve: true }, type: 'text/plain' }), r, PC_APPROVALS_DECIDE_PATH); assert.equal(r.out.status, 415);
});
