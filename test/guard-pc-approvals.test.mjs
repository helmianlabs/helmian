import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createPcApprovalsHandler, PC_APPROVALS_PATH, PC_APPROVALS_DECIDE_PATH } from '../src/cloud/guard-pc-approvals.mjs';

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

test('decide validates input and requires JSON', async () => {
  const h = createPcApprovalsHandler({ env: ENV, identity, verifyBearer, fetchImpl: guardFetch([]) });
  let r = res(); await h(req({ method: 'POST', cookie: 'troy-cookie', body: { approvalId: 'x', approve: 'yes' } }), r, PC_APPROVALS_DECIDE_PATH); assert.equal(r.out.status, 400);
  r = res(); await h(req({ method: 'POST', cookie: 'troy-cookie', body: { approvalId: 'e1297528-2117', approve: true }, type: 'text/plain' }), r, PC_APPROVALS_DECIDE_PATH); assert.equal(r.out.status, 415);
});
