// The polling half of the relay — the one that is cheap enough to leave running.
//
// The properties worth pinning are the ones that decide whether a message can
// go missing or a bill can run away:
//
//   a failed poll must NOT advance the cursor  ·  a truncated page must not
//   trickle  ·  a refused key must stop  ·  the interval must fall back to cold
//   on its own, or "hot for two minutes" quietly becomes hot forever.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COLD_INTERVAL_MS,
  HOT_INTERVAL_MS,
  HOT_WINDOW_MS,
  MAX_OUTBOX,
  createRelayPoller,
} from '../src/relay/poller.mjs';

const ok = (payload) => ({
  ok: true,
  status: 200,
  json: async () => payload,
  text: async () => JSON.stringify(payload),
});
const status = (code, body = {}) => ({
  ok: code < 400,
  status: code,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/**
 * A poller whose clock and scheduler the test owns. Nothing here waits on real
 * time, so a two-minute hot window is exercised in microseconds.
 */
function harness({ replies = [], role = 'desktop' } = {}) {
  const calls = [];
  let clock = 1_000_000;
  const timers = [];
  const received = [];
  const statuses = [];

  const poller = createRelayPoller({
    baseUrl: 'https://relay.test/api/relay-http',
    key: 'shared-secret',
    channel: 'troy',
    role,
    onMessage: (m) => received.push(m),
    onStatus: (s) => statuses.push(s),
    now: () => clock,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), method: init?.method ?? 'GET', body: init?.body });
      const next = replies.shift();
      if (typeof next === 'function') return next();
      return next ?? ok({ cursor: 0, messages: [], presence: {}, more: false });
    },
  });

  return {
    poller, calls, received, statuses, timers,
    advance: (ms) => { clock += ms; },
    runTimer: async () => { const t = timers.shift(); await t.fn(); return t; },
    lastWait: () => timers.at(-1)?.ms,
  };
}

test('a poll says who it is and where it got to', async () => {
  const h = harness({ replies: [ok({ cursor: 12, messages: [], presence: {}, more: false })] });
  await h.poller.start();
  const call = h.calls[0];
  assert.equal(call.url.searchParams.get('channel'), 'troy');
  assert.equal(call.url.searchParams.get('role'), 'desktop');
  assert.equal(call.url.searchParams.get('since'), '0');
  assert.equal(h.poller.cursor, 12, 'a fresh start adopts the relay head rather than replaying history');
});

test('a delivered message advances the cursor and reaches the caller', async () => {
  const h = harness({
    replies: [ok({
      cursor: 9,
      messages: [
        { id: 8, from: 'phone', body: 'start the build', at: '2026-07-30T10:00:00.000Z' },
        { id: 9, from: 'phone', body: 'and tell me when it is done' },
      ],
      presence: { phone: { present: true, secondsAgo: 2 } },
      more: false,
    })],
  });
  await h.poller.start();
  assert.equal(h.received.length, 2);
  assert.equal(h.received[0].body, 'start the build');
  assert.equal(h.poller.cursor, 9);
  assert.equal(h.poller.presence.phone.present, true);
});

test('OUR OWN WORDS ARE NEVER SHOWN AS THE OTHER END SPEAKING', async () => {
  const h = harness({
    replies: [ok({ cursor: 5, messages: [{ id: 5, from: 'desktop', body: 'our own line' }], presence: {}, more: false })],
  });
  await h.poller.start();
  assert.equal(h.received.length, 0);
  assert.equal(h.poller.cursor, 5, 'but it still counts, so it is not replayed forever');
});

test('a malformed message in the page is skipped, and the good ones still arrive', async () => {
  const h = harness({
    replies: [ok({
      cursor: 4,
      messages: [
        { id: 2, from: 'phone', body: { not: 'a string' } },
        { id: 3, from: 'phone' },
        { id: 4, from: 'phone', body: 'this one is fine' },
      ],
      presence: {}, more: false,
    })],
  });
  await h.poller.start();
  assert.equal(h.received.length, 1);
  assert.equal(h.received[0].body, 'this one is fine');
});

test('A FAILED POLL DOES NOT ADVANCE THE CURSOR — a retry is free', async () => {
  const h = harness({
    replies: [
      ok({ cursor: 20, messages: [], presence: {}, more: false }),
      status(500, { error: 'store error' }),
      ok({ cursor: 20, messages: [{ id: 21, from: 'phone', body: 'still here' }], presence: {}, more: false }),
    ],
  });
  await h.poller.start();
  assert.equal(h.poller.cursor, 20);

  await h.runTimer(); // the failure
  assert.equal(h.poller.cursor, 20, 'a failure must not move the cursor past unseen rows');
  assert.match(h.statuses.at(-1).error, /500/);

  await h.runTimer(); // the recovery
  assert.equal(h.received.length, 1);
  assert.equal(h.poller.cursor, 21);
});

test('a 200 with no cursor is treated as a FAILURE, not a quiet success', async () => {
  // A broken deploy that answers 200 with an error page would otherwise show a
  // green status line forever while delivering nothing.
  const h = harness({ replies: [ok({ hello: 'not the relay' })] });
  await h.poller.start();
  assert.match(h.statuses.at(-1).error, /without a cursor/);
  assert.equal(h.poller.cursor, 0);
});

test('A TRUNCATED PAGE GOES STRAIGHT BACK — a burst does not trickle one page per interval', async () => {
  const h = harness({
    replies: [ok({ cursor: 200, messages: [{ id: 200, from: 'phone', body: 'x' }], presence: {}, more: true })],
  });
  await h.poller.start();
  assert.equal(h.lastWait(), 0, 'more:true schedules the next poll immediately');
});

test('THE HOT WINDOW EXPIRES BY ITSELF — otherwise "hot for two minutes" becomes hot forever', async () => {
  const h = harness({
    replies: [
      ok({ cursor: 1, messages: [{ id: 1, from: 'phone', body: 'hello' }], presence: {}, more: false }),
      ok({ cursor: 1, messages: [], presence: {}, more: false }),
    ],
  });
  await h.poller.start();
  assert.equal(h.lastWait(), HOT_INTERVAL_MS, 'traffic makes it responsive');

  h.advance(HOT_WINDOW_MS + 1);
  await h.runTimer();
  assert.equal(h.lastWait(), COLD_INTERVAL_MS, 'and silence lets it settle back down');
});

test('a quiet channel polls at the cold interval, which is what makes it affordable', async () => {
  const h = harness({ replies: [ok({ cursor: 0, messages: [], presence: {}, more: false })] });
  await h.poller.start();
  assert.equal(h.lastWait(), COLD_INTERVAL_MS);
  // 2 GB x 30s-interval polls is a rounding error against 360 GB-hrs a month;
  // a held socket is 48 GB-hrs a day. That difference is the whole design.
  assert.ok(COLD_INTERVAL_MS >= 30_000);
});

test('A REFUSED KEY IS TERMINAL — it does not poll a locked door forever', async () => {
  const h = harness({ replies: [status(401, { error: 'unauthorized' })] });
  await h.poller.start();
  assert.equal(h.poller.state, 'stopped');
  assert.equal(h.timers.length, 0, 'nothing was scheduled');
  assert.match(h.statuses.at(-1).reason, /refused the key/);
});

test('the error backoff grows and is capped', async () => {
  const h = harness({ replies: Array.from({ length: 8 }, () => status(503, { error: 'down' })) });
  await h.poller.start();
  const waits = [h.lastWait()];
  for (let i = 0; i < 6; i += 1) { await h.runTimer(); waits.push(h.lastWait()); }
  assert.ok(waits[1] > waits[0], 'it backs off');
  assert.ok(waits.every((w) => w <= 120_000), 'and never past the cap');
});

test('A LINE TYPED WHILE THE RELAY IS DOWN IS HELD, then sent before the next poll', async () => {
  const h = harness({
    replies: [
      ok({ cursor: 0, messages: [], presence: {}, more: false }),
      () => { throw new Error('network down'); },   // the POST
      ok({ cursor: 0, messages: [], presence: {}, more: false }), // the retry POST
      ok({ cursor: 0, messages: [], presence: {}, more: false }), // and the GET
    ],
  });
  await h.poller.start();

  const queued = h.poller.send('kick off the deploy');
  assert.equal(queued.queued, true);
  assert.equal(h.poller.pending, 1);

  await h.runTimer();
  assert.equal(h.poller.pending, 1, 'still held while the network was down');

  await h.runTimer();
  assert.equal(h.poller.pending, 0, 'and gone once it came back');
  const post = h.calls.find((c) => c.method === 'POST' && c.body?.includes('deploy'));
  assert.ok(post, 'it went as a POST');
  assert.equal(JSON.parse(post.body).body, 'kick off the deploy');
});

test('a line the relay will NEVER accept is dropped rather than blocking the queue behind it', async () => {
  const h = harness({
    replies: [
      ok({ cursor: 0, messages: [], presence: {}, more: false }),
      status(413, { error: 'body too long' }),
      ok({ ok: true, id: 2 }),
      ok({ cursor: 0, messages: [], presence: {}, more: false }),
    ],
  });
  await h.poller.start();
  h.poller.send('the doomed one');
  h.poller.send('the one behind it');
  await h.runTimer();
  assert.equal(h.poller.pending, 0, 'the rejected line did not wedge the queue');
  assert.match(h.statuses.find((s) => s.rejected)?.rejected ?? '', /413/);
});

test('the outbox is bounded', () => {
  const h = harness();
  for (let i = 0; i < MAX_OUTBOX; i += 1) h.poller.send(`line ${i}`);
  const overflow = h.poller.send('one too many');
  assert.equal(overflow.sent, false);
  assert.match(overflow.reason, /outbox is full/);
});

test('stop() ends it, and a stopped poller schedules nothing', async () => {
  const h = harness({ replies: [ok({ cursor: 0, messages: [], presence: {}, more: false })] });
  await h.poller.start();
  h.timers.length = 0;
  h.poller.stop();
  assert.equal(h.poller.state, 'stopped');
  assert.equal(h.timers.length, 0);
});

test('it refuses to be built without what it cannot work without', () => {
  assert.throws(() => createRelayPoller({ key: 'k', channel: 'troy' }), /needs a baseUrl/);
  assert.throws(() => createRelayPoller({ baseUrl: 'https://x/', channel: 'troy' }), /needs a key/);
  assert.throws(
    () => createRelayPoller({ baseUrl: 'https://x/', key: 'k', channel: 'troy', fetchImpl: null }),
    /no fetch available/,
  );
});
