// The door approvals client (background/approvals-client.js), run against a
// fake fetch and a fake storage in the chromeStorage() shape.
//
// WHY THIS SUITE EXISTS. The door road had no client suite of its own; the
// stale-approval fix (the pop-up forcing its opening asks) leans on one
// property of this poll above all: force must break BOTH gates that can
// hold a stale list in place — the 60 s cadence and the 5-minute error
// backoff — and the fresh page must replace the stored list, so an approval
// decided on another surface (the door page on a phone) leaves the stored
// state the desktop badge and pop-up render from. Those legs are pinned
// here. What this suite cannot prove — a real browser carrying the door
// session — is named as unproven in the bite report.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  APPROVALS_STATE_KEY,
  POLL_S,
  ERROR_BACKOFF_S,
  getApprovalsState,
  pollApprovals,
  badgeTextFor,
} from '../background/approvals-client.js';

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

/** A scripted fetch: each call shifts one step {status, text|throw}. */
function fakeFetch(script = []) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const step = script.length ? script.shift() : { status: 200, text: EMPTY_PAGE };
    if (step.throw) throw step.throw;
    return { status: step.status, text: async () => step.text ?? '' };
  };
  return { fetchImpl, calls };
}

const EMPTY_PAGE = '<html><body><p class="empty">Nothing is waiting.</p></body></html>';

function listPage(items) {
  const rows = items.map((i) => (
    `<div class="req"><form method="POST" action="/approvals/${i.id}/decide">`
    + `<input type="hidden" name="csrf" value="csrf-${i.id}" />`
    + `<div class="sum">${i.summary}</div><div class="meta">${i.meta}</div></form></div>`
  )).join('');
  return `<html><body>${rows}</body></html>`;
}

function seedSignedIn(over = {}) {
  return fakeStorage({
    [APPROVALS_STATE_KEY]: {
      session: 'in',
      items: [{ id: 'd1', summary: 'Wipe the spare drive', meta: 'hands-mcp', csrf: 'csrf-d1' }],
      count: 1, flash: '', lastError: '', stale: false,
      updatedAt: NOW - 1000, nextAt: 0, errors: 0, badgeOwned: false,
      ...over,
    },
  });
}

test('an unforced poll inside the cadence is not-due and fetches nothing', async () => {
  const storage = seedSignedIn({ nextAt: NOW + POLL_S * 1000 });
  const { fetchImpl, calls } = fakeFetch();
  const r = await pollApprovals(storage, { fetchImpl, now: NOW + 1000 });
  assert.equal(r.skipped, 'not-due');
  assert.equal(r.count, 1, 'the stored list stands');
  assert.equal(calls.length, 0);
});

test('a forced poll overrides the cadence and folds the fresh page', async () => {
  const storage = seedSignedIn({ nextAt: NOW + POLL_S * 1000 });
  const { fetchImpl, calls } = fakeFetch([{ status: 200, text: EMPTY_PAGE }]);
  const r = await pollApprovals(storage, { fetchImpl, now: NOW + 1000, force: true });
  assert.equal(r.ok, true);
  assert.equal(r.count, 0, 'the item decided elsewhere is gone from the fresh page');
  assert.equal(calls.length, 1);
  const s = await getApprovalsState(storage);
  assert.deepEqual(s.items, []);
  assert.equal(s.count, 0);
  assert.equal(badgeTextFor(s.count), '', 'the badge clears with the stored count');
});

test('a forced poll runs inside the error backoff and folds the fresh page', async () => {
  const storage = seedSignedIn();
  const { fetchImpl, calls } = fakeFetch([
    { throw: new Error('offline') },
    { status: 200, text: listPage([{ id: 'd2', summary: 'Send the log file', meta: 'scribe' }]) },
  ]);
  const failed = await pollApprovals(storage, { fetchImpl, now: NOW });
  assert.equal(failed.ok, false);
  assert.equal(failed.count, 1, 'the stored item is kept while the door is unreachable');
  const during = await pollApprovals(storage, { fetchImpl, now: NOW + POLL_S * 1000 });
  assert.equal(during.skipped, 'not-due', 'unforced polls still honour the backoff');
  assert.equal(calls.length, 1);
  const forced = await pollApprovals(storage, { fetchImpl, now: NOW + POLL_S * 1000, force: true });
  assert.equal(forced.ok, true);
  assert.equal(calls.length, 2, 'the forced poll fetched inside the backoff window');
  assert.equal(forced.count, 1);
  const s = await getApprovalsState(storage);
  assert.deepEqual(s.items.map((i) => i.id), ['d2'], 'the stored list is the fresh page, not the stale one');
  assert.equal(s.stale, false);
  assert.equal(s.nextAt, NOW + 2 * POLL_S * 1000, 'a successful poll returns to the 60 s cadence');
  assert.ok(ERROR_BACKOFF_S > POLL_S, 'the backoff the force broke was the long one');
});

test('a stored doorUrl naming the retired door is treated as unset and the poll goes to the current door', async () => {
  // Older builds seeded their default into stored state, and that default
  // was the pre-separation door, which no longer answers. A stored value
  // naming it must not strand the client on a dead address.
  const storage = seedSignedIn({ doorUrl: 'https://connect.helmian.cloud' });
  const { fetchImpl, calls } = fakeFetch([{ status: 200, text: EMPTY_PAGE }]);
  const r = await pollApprovals(storage, { fetchImpl, now: NOW, force: true });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith('https://scribe.dairyforge.com/'), `poll went to ${calls[0].url}`);
});
