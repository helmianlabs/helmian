// The PC approvals client (approvals pop-up build, Bite 1), run against a
// fake fetch and a fake storage in the chromeStorage() shape.
//
// WHY THIS SUITE EXISTS. background/pc-approvals-client.js is the extension's
// only road to the Helmian proxy's PC approvals list — the list Troy decides
// from the pop-up instead of the web page. Its contract is the proxy's
// status codes (200/401/403/404/409/502/503), and its safety properties are
// folding rules: an unreadable answer is never an empty list, a stale list
// is always marked stale, and a decision counts only when the refreshed
// list drops the item. Those rules are exactly what a fake fetch can pin,
// so they are pinned here. What this suite cannot prove — whether a real
// extension fetch carries Troy's Helmian session cookie to the proxy — is
// a real-browser question and is named as unproven in the bite report.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PC_APPROVALS_STATE_KEY,
  PC_APPROVALS_BASE,
  POLL_S,
  ERROR_BACKOFF_S,
  getPcApprovalsState,
  pcApprovalsView,
  fetchPcApprovalsView,
  decidePcApproval,
  pollPcApprovals,
  badgeTextFor,
  foldPcApproval,
  foldPcApprovalsList,
} from '../background/pc-approvals-client.js';
import { APPROVALS_STATE_KEY } from '../background/approvals-client.js';

const NOW = 1_700_000_000_000;

/** Storage in the ledger chromeStorage() shape: get(key) -> value, set(key, value). */
function fakeStorage(seed = {}) {
  const data = new Map(Object.entries(structuredClone(seed)));
  return {
    data,
    async get(key) { return data.has(key) ? structuredClone(data.get(key)) : undefined; },
    async set(key, value) { data.set(key, structuredClone(value)); },
    async remove(key) { data.delete(key); },
  };
}

/** A scripted fetch: each call shifts one step {status, json|text|throw}. */
function fakeFetch(script = []) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const step = script.length ? script.shift() : { status: 200, json: { approvals: [] } };
    if (step.throw) throw step.throw;
    return {
      status: step.status,
      text: async () => (step.text != null ? step.text : JSON.stringify(step.json ?? {})),
    };
  };
  return { fetchImpl, calls };
}

function rawItem(id, over = {}) {
  return {
    approvalId: id,
    status: 'pending',
    summary: `Run thing ${id}`,
    reason: 'because',
    tool: 'hands',
    site: 'chat.example',
    deviceId: 'pc-1',
    createdAt: '2026-11-12T10:00:00.000Z',
    expiresAt: '2026-11-13T10:00:00.000Z',
    ...over,
  };
}

function seedWithItems(items) {
  return fakeStorage({
    [PC_APPROVALS_STATE_KEY]: {
      session: 'in', owner: true, items, count: items.length,
      lastError: '', stale: false, updatedAt: NOW - 1000, nextAt: 0, errors: 0,
    },
  });
}

test('list folding maps the proxy shape, drops deviceId, sorts soonest expiry first', async () => {
  const storage = fakeStorage();
  const { fetchImpl, calls } = fakeFetch([{
    status: 200,
    json: {
      approvals: [
        rawItem('late', { expiresAt: '2026-11-14T10:00:00.000Z' }),
        rawItem('soon', { expiresAt: '2026-11-12T22:00:00.000Z' }),
        rawItem('noexpiry', { expiresAt: '' }),
      ],
    },
  }]);
  const r = await fetchPcApprovalsView(storage, { fetchImpl, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${PC_APPROVALS_BASE}/api/admin/guard/pc-approvals`);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.credentials, 'include');
  assert.deepEqual(r.view.items.map((i) => i.id), ['soon', 'late', 'noexpiry']);
  assert.deepEqual(r.view.items[0], {
    id: 'soon',
    summary: 'Run thing soon',
    tool: 'hands',
    site: 'chat.example',
    reason: 'because',
    createdAt: '2026-11-12T10:00:00.000Z',
    expiresAt: '2026-11-12T22:00:00.000Z',
  });
  assert.equal(r.view.state, 'list');
  assert.equal(r.view.count, 3);
  const s = await getPcApprovalsState(storage);
  assert.equal(s.nextAt, NOW + POLL_S * 1000);
  assert.equal(s.updatedAt, NOW);
  assert.equal(s.stale, false);
});

test('folding drops junk: no id, non-pending status, non-objects; blanks get safe defaults', () => {
  assert.equal(foldPcApproval(null), null);
  assert.equal(foldPcApproval('nope'), null);
  assert.equal(foldPcApproval({ status: 'pending' }), null);
  assert.equal(foldPcApproval(rawItem('x', { status: 'approved' })), null);
  assert.equal(foldPcApproval(rawItem('x', { status: 'expired' })), null);
  const folded = foldPcApproval({ approvalId: 42 });
  assert.deepEqual(folded, { id: '42', summary: 'Action', tool: '', site: '', reason: '', createdAt: '', expiresAt: '' });
  assert.equal(foldPcApprovalsList(null), null);
  assert.equal(foldPcApprovalsList({}), null);
  assert.equal(foldPcApprovalsList({ approvals: 'nope' }), null);
  assert.deepEqual(foldPcApprovalsList({ approvals: [] }), []);
});

test('an unreadable 200 keeps the last list, marks it stale, and backs off', async () => {
  const kept = [foldPcApproval(rawItem('a1'))];
  const storage = seedWithItems(kept);
  const { fetchImpl } = fakeFetch([{ status: 200, text: '<html>not json</html>' }]);
  const r = await fetchPcApprovalsView(storage, { fetchImpl, now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.error, /could not be read/);
  assert.equal(r.view.state, 'unavailable');
  assert.equal(r.view.stale, true);
  assert.deepEqual(r.view.items.map((i) => i.id), ['a1']);
  assert.equal(r.view.updatedAt, NOW - 1000, 'the stale list keeps its own time');
  const s = await getPcApprovalsState(storage);
  assert.equal(s.nextAt, NOW + ERROR_BACKOFF_S * 1000);
  assert.equal(s.errors, 1);
});

test('a network failure keeps the last list, marks it stale, and backs off', async () => {
  const storage = seedWithItems([foldPcApproval(rawItem('a1'))]);
  const { fetchImpl } = fakeFetch([{ throw: new Error('offline') }]);
  const r = await fetchPcApprovalsView(storage, { fetchImpl, now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.error, /could not be reached/);
  assert.equal(r.view.state, 'unavailable');
  assert.deepEqual(r.view.items.map((i) => i.id), ['a1']);
  const s = await getPcApprovalsState(storage);
  assert.equal(s.nextAt, NOW + ERROR_BACKOFF_S * 1000);
});

test('401 folds to signed-out, clears the list, and keeps the poll cadence', async () => {
  const storage = seedWithItems([foldPcApproval(rawItem('a1'))]);
  const { fetchImpl } = fakeFetch([{ status: 401, json: {} }]);
  const r = await fetchPcApprovalsView(storage, { fetchImpl, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.view.state, 'signed-out');
  assert.equal(r.view.session, 'out');
  assert.deepEqual(r.view.items, []);
  assert.equal(r.view.count, 0);
  const s = await getPcApprovalsState(storage);
  // Not zeroed: the sign-in lives on the website, so the poll must keep
  // quietly checking or it could never notice him signing back in.
  assert.equal(s.nextAt, NOW + POLL_S * 1000);
});

test('a signed-out poll re-checks when due and recovers when the session is back', async () => {
  const storage = fakeStorage();
  const { fetchImpl, calls } = fakeFetch([
    { status: 401, json: {} },
    { status: 200, json: { approvals: [rawItem('a1')] } },
  ]);
  const first = await pollPcApprovals(storage, { fetchImpl, now: NOW });
  assert.equal(first.session, 'out');
  assert.equal(first.count, 0);
  const early = await pollPcApprovals(storage, { fetchImpl, now: NOW + 30_000 });
  assert.equal(early.skipped, 'not-due');
  assert.equal(calls.length, 1);
  const back = await pollPcApprovals(storage, { fetchImpl, now: NOW + POLL_S * 1000 });
  assert.equal(back.session, 'in');
  assert.equal(back.count, 1);
  assert.equal(calls.length, 2);
});

test('403 folds to not-owner with the web page owner line and no list', async () => {
  const storage = seedWithItems([foldPcApproval(rawItem('a1'))]);
  const { fetchImpl } = fakeFetch([{ status: 403, json: {} }]);
  const r = await fetchPcApprovalsView(storage, { fetchImpl, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.view.state, 'not-owner');
  assert.match(r.view.lastError, /PC owner's account/);
  assert.deepEqual(r.view.items, []);
});

test('502 keeps the list stale as unavailable; 503 says approvals are not set up', async () => {
  const storage = seedWithItems([foldPcApproval(rawItem('a1'))]);
  const down = fakeFetch([{ status: 502, json: {} }]);
  const r1 = await fetchPcApprovalsView(storage, { fetchImpl: down.fetchImpl, now: NOW });
  assert.equal(r1.ok, false);
  assert.equal(r1.view.state, 'unavailable');
  assert.match(r1.view.lastError, /Guard could not be reached/);
  assert.deepEqual(r1.view.items.map((i) => i.id), ['a1']);

  const unset = fakeFetch([{ status: 503, json: {} }]);
  const r2 = await fetchPcApprovalsView(storage, { fetchImpl: unset.fetchImpl, now: NOW });
  assert.equal(r2.ok, false);
  assert.match(r2.view.lastError, /not set up/);
});

test('decide succeeds only when the refreshed list drops the item', async () => {
  const item = foldPcApproval(rawItem('a1'));
  const storage = seedWithItems([item]);
  const { fetchImpl, calls } = fakeFetch([
    { status: 200, json: { approval: { approvalId: 'a1', status: 'approved' } } },
    { status: 200, json: { approvals: [] } },
  ]);
  const r = await decidePcApproval(storage, 'a1', 'approve', { fetchImpl, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.view.count, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${PC_APPROVALS_BASE}/api/admin/guard/pc-approvals/decide`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'include');
  assert.deepEqual(JSON.parse(calls[0].init.body), { approvalId: 'a1', approve: true });
  assert.equal(calls[1].init.method, 'GET');
});

test('decide sends approve:false for a deny', async () => {
  const storage = seedWithItems([foldPcApproval(rawItem('a1'))]);
  const { fetchImpl, calls } = fakeFetch([
    { status: 200, json: { approval: { approvalId: 'a1', status: 'denied' } } },
    { status: 200, json: { approvals: [] } },
  ]);
  const r = await decidePcApproval(storage, 'a1', 'deny', { fetchImpl, now: NOW });
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(calls[0].init.body), { approvalId: 'a1', approve: false });
});

test('a 200 decide whose refresh still carries the item is NOT a success', async () => {
  const item = foldPcApproval(rawItem('a1'));
  const storage = seedWithItems([item]);
  const { fetchImpl } = fakeFetch([
    { status: 200, json: { approval: { approvalId: 'a1', status: 'approved' } } },
    { status: 200, json: { approvals: [rawItem('a1')] } },
  ]);
  const r = await decidePcApproval(storage, 'a1', 'approve', { fetchImpl, now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.error, /could not be confirmed/);
  assert.deepEqual(r.view.items.map((i) => i.id), ['a1']);
});

test('decide 404 and 409 refresh the list and say the item is gone or decided', async () => {
  const item = foldPcApproval(rawItem('a1'));
  const s404 = seedWithItems([item]);
  const f404 = fakeFetch([{ status: 404, json: {} }, { status: 200, json: { approvals: [] } }]);
  const r404 = await decidePcApproval(s404, 'a1', 'approve', { fetchImpl: f404.fetchImpl, now: NOW });
  assert.equal(r404.ok, false);
  assert.match(r404.error, /expired or was already decided/);
  assert.equal(r404.view.count, 0);
  assert.equal(f404.calls.length, 2, 'the list was refreshed');

  const s409 = seedWithItems([item]);
  const f409 = fakeFetch([{ status: 409, json: {} }, { status: 200, json: { approvals: [] } }]);
  const r409 = await decidePcApproval(s409, 'a1', 'deny', { fetchImpl: f409.fetchImpl, now: NOW });
  assert.equal(r409.ok, false);
  assert.match(r409.error, /already decided/);
  assert.equal(r409.view.count, 0);
});

test('decide 401 signs out, 403 shows the owner line, 502 keeps the item waiting', async () => {
  const item = foldPcApproval(rawItem('a1'));
  const s401 = seedWithItems([item]);
  const f401 = fakeFetch([{ status: 401, json: {} }]);
  const r401 = await decidePcApproval(s401, 'a1', 'approve', { fetchImpl: f401.fetchImpl, now: NOW });
  assert.equal(r401.ok, false);
  assert.equal(r401.view.state, 'signed-out');

  const s403 = seedWithItems([item]);
  const f403 = fakeFetch([{ status: 403, json: {} }]);
  const r403 = await decidePcApproval(s403, 'a1', 'approve', { fetchImpl: f403.fetchImpl, now: NOW });
  assert.equal(r403.ok, false);
  assert.equal(r403.view.state, 'not-owner');

  const s502 = seedWithItems([item]);
  const f502 = fakeFetch([{ status: 502, json: {} }]);
  const r502 = await decidePcApproval(s502, 'a1', 'approve', { fetchImpl: f502.fetchImpl, now: NOW });
  assert.equal(r502.ok, false);
  assert.match(r502.error, /Guard could not be reached/);
  assert.deepEqual(r502.view.items.map((i) => i.id), ['a1'], 'the item is still waiting');
  assert.equal(r502.view.stale, true);
});

test('a decide that cannot be sent leaves the state untouched', async () => {
  const item = foldPcApproval(rawItem('a1'));
  const storage = seedWithItems([item]);
  const { fetchImpl } = fakeFetch([{ throw: new Error('offline') }]);
  const r = await decidePcApproval(storage, 'a1', 'approve', { fetchImpl, now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.error, /still waiting/);
  const s = await getPcApprovalsState(storage);
  assert.equal(s.nextAt, 0, 'no fold happened');
  assert.equal(s.stale, false);
  assert.deepEqual(s.items.map((i) => i.id), ['a1']);
});

test('deciding an item that is not on the list refreshes and says so', async () => {
  const storage = seedWithItems([foldPcApproval(rawItem('a1'))]);
  const { fetchImpl, calls } = fakeFetch([{ status: 200, json: { approvals: [rawItem('a1')] } }]);
  const r = await decidePcApproval(storage, 'missing', 'approve', { fetchImpl, now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.error, /no longer on the list/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'GET', 'it refreshed instead of posting a decision');
});

test('poll cadence: due check, 60 second rhythm, force overrides', async () => {
  const storage = fakeStorage();
  const { fetchImpl, calls } = fakeFetch([
    { status: 200, json: { approvals: [rawItem('a1')] } },
    { status: 200, json: { approvals: [rawItem('a1'), rawItem('a2')] } },
  ]);
  const first = await pollPcApprovals(storage, { fetchImpl, now: NOW });
  assert.equal(first.count, 1);
  const early = await pollPcApprovals(storage, { fetchImpl, now: NOW + 59_000 });
  assert.equal(early.skipped, 'not-due');
  assert.equal(early.count, 1);
  assert.equal(calls.length, 1);
  const forced = await pollPcApprovals(storage, { fetchImpl, now: NOW + 59_000, force: true });
  assert.equal(forced.count, 2);
  assert.equal(calls.length, 2);
});

test('poll backs off five minutes after an error, then tries again', async () => {
  const storage = fakeStorage();
  const { fetchImpl, calls } = fakeFetch([
    { throw: new Error('offline') },
    { status: 200, json: { approvals: [] } },
  ]);
  const failed = await pollPcApprovals(storage, { fetchImpl, now: NOW });
  assert.equal(failed.ok, false);
  const during = await pollPcApprovals(storage, { fetchImpl, now: NOW + POLL_S * 1000 });
  assert.equal(during.skipped, 'not-due');
  assert.equal(calls.length, 1);
  const after = await pollPcApprovals(storage, { fetchImpl, now: NOW + ERROR_BACKOFF_S * 1000 });
  assert.equal(after.ok, true);
  assert.equal(calls.length, 2);
});

test('badge text: blank at zero, the count, capped at 99+', () => {
  assert.equal(badgeTextFor(0), '');
  assert.equal(badgeTextFor(-3), '');
  assert.equal(badgeTextFor(1), '1');
  assert.equal(badgeTextFor(99), '99');
  assert.equal(badgeTextFor(100), '99+');
  assert.equal(badgeTextFor(250), '99+');
});

test('state starts optimistic and empty, and the view shape is data only', async () => {
  const storage = fakeStorage();
  const s = await getPcApprovalsState(storage);
  assert.equal(s.session, 'in');
  assert.equal(s.owner, true);
  assert.deepEqual(pcApprovalsView(s), {
    state: 'list', session: 'in', items: [], count: 0, lastError: '', stale: false, updatedAt: 0,
  });
});

test('this client never touches the Scribe door client state', async () => {
  const doorState = { session: 'in', items: [{ id: 'd1', summary: 'door item', meta: '' }], count: 1 };
  const storage = fakeStorage({ [APPROVALS_STATE_KEY]: doorState });
  assert.notEqual(PC_APPROVALS_STATE_KEY, APPROVALS_STATE_KEY);
  const { fetchImpl } = fakeFetch([
    { status: 200, json: { approvals: [rawItem('a1')] } },
    { status: 200, json: { approval: {} } },
    { status: 200, json: { approvals: [] } },
  ]);
  await fetchPcApprovalsView(storage, { fetchImpl, now: NOW });
  await decidePcApproval(storage, 'a1', 'approve', { fetchImpl, now: NOW });
  assert.deepEqual(await storage.get(APPROVALS_STATE_KEY), doorState, 'door state untouched');
  const mine = await storage.get(PC_APPROVALS_STATE_KEY);
  assert.equal(mine.count, 0);
});
