// The relay: the only Helmion lane reachable from the open internet.
//
// So most of this file is refusals. The parser is held to the same standard as
// the advisory parser — A MESS IS NEVER A MESSAGE — and the client is held to
// the one property that makes a dropped socket survivable: a reconnect must not
// cost a message, in either direction.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KINDS,
  MAX_BODY_CHARS,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  deliverTo,
  frame,
  isValidChannel,
  parseFrame,
} from '../src/relay/protocol.mjs';
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  CLOSE_UNAUTHORIZED,
  MAX_OUTBOX,
  createRelayClient,
} from '../src/relay/client.mjs';

const say = (from, body) => JSON.stringify({ v: PROTOCOL_VERSION, kind: 'say', from, body });

// ── the parser ───────────────────────────────────────────────────────────────

test('A MESS IS NEVER A MESSAGE', () => {
  for (const junk of [
    null, undefined, '', '   ', 'hello', '{not json', '[]', 'null', '42', '"a string"',
    JSON.stringify([{ v: 1, kind: 'say', from: 'phone', body: 'hi' }]),
  ]) {
    const result = parseFrame(junk);
    assert.equal(result.ok, false, `${JSON.stringify(junk)} must be refused`);
    assert.ok(result.reason.length > 0, 'and it must say why');
  }
});

test('a frame from a future protocol version is refused, not guessed at', () => {
  const result = parseFrame(JSON.stringify({ v: 99, kind: 'say', from: 'phone', body: 'hi' }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /protocol version/);
});

test('an unknown kind and an unknown role are both refused', () => {
  assert.equal(parseFrame(JSON.stringify({ v: 1, kind: 'exec', from: 'phone', body: 'rm -rf /' })).ok, false);
  assert.equal(parseFrame(JSON.stringify({ v: 1, kind: 'say', from: 'server', body: 'hi' })).ok, false);
  assert.ok(!KINDS.includes('exec'), 'there is deliberately no execute kind in this protocol');
});

test('THE SIZE LIMIT IS IN BYTES, not characters', () => {
  // A length check on a UTF-16 string undercounts every multi-byte character.
  // '🙂' is 2 units long and 4 bytes, so a naive check lets through a frame
  // twice the intended size.
  const emoji = '🙂';
  const count = Math.ceil(MAX_FRAME_BYTES / Buffer.byteLength(emoji, 'utf8')) + 10;
  const big = JSON.stringify({ v: 1, kind: 'say', from: 'phone', body: emoji.repeat(count) });
  assert.ok(big.length < Buffer.byteLength(big, 'utf8'), 'the fixture really is multi-byte');
  const result = parseFrame(big);
  assert.equal(result.ok, false);
  assert.match(result.reason, /bytes/);
});

test('an over-long body is refused even inside a legal-sized frame', () => {
  const result = parseFrame(JSON.stringify({ v: 1, kind: 'say', from: 'phone', body: 'x'.repeat(MAX_BODY_CHARS + 1) }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /chars/);
});

test('a non-string body is REFUSED, never coerced', () => {
  // String({}) is "[object Object]". Coercing here is how nonsense becomes a
  // permanent line in a transcript.
  for (const body of [{}, [], 42, true]) {
    const result = parseFrame(JSON.stringify({ v: 1, kind: 'say', from: 'phone', body }));
    assert.equal(result.ok, false, `body ${JSON.stringify(body)} must be refused`);
    assert.match(result.reason, /body must be a string/);
  }
});

test('a bad cursor or id is refused rather than rounded', () => {
  for (const bad of [-1, 1.5, '7', Number.MAX_VALUE]) {
    assert.equal(parseFrame(JSON.stringify({ v: 1, kind: 'hello', from: 'desktop', cursor: bad })).ok, false);
    assert.equal(parseFrame(JSON.stringify({ v: 1, kind: 'say', from: 'phone', body: 'hi', id: bad })).ok, false);
  }
});

test('UNKNOWN FIELDS DO NOT TRAVEL — only the declared shape survives', () => {
  const result = parseFrame(JSON.stringify({
    v: 1, kind: 'say', from: 'phone', body: 'hi',
    exec: 'rm -rf /', __proto__mark: 'x', cwd: 'E:\\Helmion',
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.frame).sort(), ['body', 'from', 'kind', 'v']);
  assert.equal(result.frame.exec, undefined, 'a field we do not know is dropped, not carried');
});

test('a well-formed frame is read exactly as sent', () => {
  const result = parseFrame(JSON.stringify({ v: 1, kind: 'say', from: 'phone', body: 'start the build', id: 12 }));
  assert.equal(result.ok, true);
  assert.equal(result.frame.body, 'start the build');
  assert.equal(result.frame.id, 12);
});

test('a channel name is boring on purpose', () => {
  assert.equal(isValidChannel('troy'), true);
  assert.equal(isValidChannel('troy-phone_1'), true);
  for (const bad of ['', 'a', 'Troy', "troy'; DROP TABLE x;--", 'troy phone', '../etc', 'x'.repeat(80), null]) {
    assert.equal(isValidChannel(bad), false, `${JSON.stringify(bad)} must be refused`);
  }
});

test('delivery is a flip, written down — a sender never receives its own words', () => {
  assert.equal(deliverTo('phone'), 'desktop');
  assert.equal(deliverTo('desktop'), 'phone');
  assert.equal(deliverTo('anything-else'), null);
});

test('frame() refuses to build something the parser would reject', () => {
  assert.throws(() => frame({ kind: 'exec', from: 'phone' }), /unknown frame kind/);
  assert.throws(() => frame({ kind: 'say', from: 'server' }), /unknown sender role/);
});

// ── the client ───────────────────────────────────────────────────────────────

// A socket stand-in. No network, no timers of its own — the test drives it.
function fakeSocket() {
  const sent = [];
  const ws = {
    sent,
    closed: null,
    send(text) { sent.push(text); },
    close(code, reason) { ws.closed = { code, reason }; },
    emitOpen() { ws.onopen?.({}); },
    emitMessage(data) { ws.onmessage?.({ data }); },
    emitClose(code) { ws.onclose?.({ code }); },
  };
  return ws;
}

function harness({ role = 'desktop' } = {}) {
  const sockets = [];
  const urls = [];
  const timers = [];
  const received = [];
  const statuses = [];
  const client = createRelayClient({
    url: 'wss://example.test/api/relay',
    key: 'secret',
    channel: 'troy',
    role,
    onMessage: (f) => received.push(f),
    onStatus: (s) => statuses.push(s),
    connect: (dialUrl) => { urls.push(dialUrl); const s = fakeSocket(); sockets.push(s); return s; },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
    random: () => 1, // full jitter at its maximum, so waits are predictable
  });
  const runTimer = () => { const t = timers.shift(); t.fn(); return t; };
  return { client, sockets, urls, timers, received, statuses, runTimer };
}

const hello = (cursor = 0) => JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello', from: 'desktop', cursor });

test('it DIALS OUT and never listens — the url carries who and where we are', () => {
  const h = harness();
  h.client.start();
  const dialed = new URL(h.urls[0]);
  assert.equal(dialed.searchParams.get('channel'), 'troy');
  assert.equal(dialed.searchParams.get('role'), 'desktop');
  assert.equal(dialed.searchParams.get('since'), '0');
  assert.equal(dialed.searchParams.get('key'), 'secret');
});

test('OPEN IS NOT CONNECTED — the backoff resets on hello, not on the socket opening', () => {
  // A relay that accepts the TCP connection and immediately closes would
  // otherwise reset the delay on every attempt and hammer it once a second
  // forever. Proven by driving exactly that: open, close, repeatedly.
  const h = harness();
  h.client.start();
  for (let i = 0; i < 4; i += 1) {
    h.sockets[i].emitOpen();
    h.sockets[i].emitClose(1006);
    h.runTimer();
  }
  const waits = h.statuses.filter((s) => s.retryInMs).map((s) => s.retryInMs);
  assert.deepEqual(waits, [BACKOFF_BASE_MS, BACKOFF_BASE_MS * 2, BACKOFF_BASE_MS * 4, BACKOFF_BASE_MS * 8],
    'the wait must keep growing across accept-then-close cycles');
});

test('the backoff is capped, so it never wanders into hours', () => {
  const h = harness();
  h.client.start();
  for (let i = 0; i < 12; i += 1) { h.sockets[i].emitClose(1006); h.runTimer(); }
  const waits = h.statuses.filter((s) => s.retryInMs).map((s) => s.retryInMs);
  assert.ok(waits.every((w) => w <= BACKOFF_CAP_MS), 'no wait may exceed the cap');
  assert.equal(waits.at(-1), BACKOFF_CAP_MS, 'and it reaches the cap');
});

test('A REJECTED KEY IS TERMINAL — it does not knock forever', () => {
  const h = harness();
  h.client.start();
  h.sockets[0].emitClose(CLOSE_UNAUTHORIZED);
  assert.equal(h.client.state, 'stopped');
  assert.equal(h.timers.length, 0, 'nothing was scheduled');
  assert.match(h.statuses.at(-1).reason, /refused the key/);
});

test('THE CURSOR SURVIVES A DROP — a reconnect asks for exactly what it missed', () => {
  const h = harness();
  h.client.start();
  h.sockets[0].emitOpen();
  h.sockets[0].emitMessage(hello(0));
  h.sockets[0].emitMessage(JSON.stringify({ v: 1, kind: 'say', from: 'phone', body: 'first', id: 7 }));
  h.sockets[0].emitMessage(JSON.stringify({ v: 1, kind: 'say', from: 'phone', body: 'second', id: 8 }));
  assert.equal(h.client.cursor, 8);

  h.sockets[0].emitClose(1006);
  h.runTimer();
  assert.equal(new URL(h.urls[1]).searchParams.get('since'), '8',
    'the second dial resumes from the last id seen, so the drop cost latency and not a message');
});

test('the server may advance the cursor past what we hold, and never backwards', () => {
  const h = harness();
  h.client.start();
  h.sockets[0].emitOpen();
  h.sockets[0].emitMessage(hello(40));
  assert.equal(h.client.cursor, 40);
  h.sockets[0].emitMessage(hello(5));
  assert.equal(h.client.cursor, 40, 'a lower cursor never rewinds us into replaying old traffic');
});

test('THE OUTBOX HOLDS A LINE TYPED WHILE THE RELAY IS DOWN, and flushes it on reconnect', () => {
  const h = harness();
  h.client.start();
  const queued = h.client.send('start the nightly build');
  assert.equal(queued.sent, false);
  assert.equal(queued.queued, true);
  assert.equal(h.client.pending, 1);

  h.sockets[0].emitOpen();
  assert.equal(h.client.pending, 1, 'still held — open is not connected');
  h.sockets[0].emitMessage(hello(0));

  assert.equal(h.client.pending, 0, 'flushed once the relay actually accepted us');
  const sent = JSON.parse(h.sockets[0].sent[0]);
  assert.equal(sent.kind, 'say');
  assert.equal(sent.body, 'start the nightly build');
});

test('the outbox is BOUNDED — a long outage cannot eat the machine', () => {
  const h = harness();
  h.client.start();
  for (let i = 0; i < MAX_OUTBOX; i += 1) h.client.send(`line ${i}`);
  assert.equal(h.client.pending, MAX_OUTBOX);
  const overflow = h.client.send('one too many');
  assert.equal(overflow.sent, false);
  assert.equal(overflow.queued, undefined);
  assert.match(overflow.reason, /outbox is full/);
});

test('an over-long line is refused at send, with the numbers', () => {
  const h = harness();
  h.client.start();
  const result = h.client.send('x'.repeat(MAX_BODY_CHARS + 1));
  assert.equal(result.sent, false);
  assert.match(result.reason, new RegExp(`${MAX_BODY_CHARS}`));
});

test('AN ECHO OF OUR OWN WORDS IS DROPPED, not shown as the other end speaking', () => {
  const h = harness({ role: 'desktop' });
  h.client.start();
  h.sockets[0].emitOpen();
  h.sockets[0].emitMessage(hello(0));
  h.sockets[0].emitMessage(say('desktop', 'this is our own line coming back'));
  assert.equal(h.received.length, 0);
  assert.match(h.statuses.at(-1).refused, /stamped as our own/);
});

test('a malformed frame is counted and dropped, and does not break the connection', () => {
  const h = harness();
  h.client.start();
  h.sockets[0].emitOpen();
  h.sockets[0].emitMessage(hello(0));
  h.sockets[0].emitMessage('{ this is torn');
  h.sockets[0].emitMessage(say('phone', 'and this one is fine'));
  assert.equal(h.client.droppedFrames, 1);
  assert.equal(h.received.length, 1, 'the good frame still arrived');
  assert.equal(h.client.state, 'connected');
});

test('it answers a ping, so the relay can tell a live desktop from a wedged one', () => {
  const h = harness();
  h.client.start();
  h.sockets[0].emitOpen();
  h.sockets[0].emitMessage(hello(0));
  h.sockets[0].emitMessage(JSON.stringify({ v: 1, kind: 'ping', from: 'phone' }));
  const pong = h.sockets[0].sent.map(JSON.parse).find((f) => f.kind === 'pong');
  assert.ok(pong, 'a pong went back');
  assert.equal(pong.from, 'desktop');
});

test('stop() is final — no reconnect is scheduled after it', () => {
  const h = harness();
  h.client.start();
  h.sockets[0].emitOpen();
  h.sockets[0].emitMessage(hello(0));
  h.client.stop();
  assert.equal(h.client.state, 'stopped');
  assert.equal(h.sockets[0].closed.code, 1000);
  h.sockets[0].emitClose(1000);
  assert.equal(h.timers.length, 0, 'a close arriving after stop must not restart it');
});

test('it refuses to be built without the things it cannot work without', () => {
  assert.throws(() => createRelayClient({ key: 'k', channel: 'troy' }), /needs a url/);
  assert.throws(() => createRelayClient({ url: 'wss://x/', channel: 'troy' }), /needs a key/);
  assert.throws(() => createRelayClient({ url: 'wss://x/', key: 'k', channel: 'Bad Channel' }), /invalid channel/);
});
