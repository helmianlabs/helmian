// The relay client against a REAL WebSocket — real handshake, real framing,
// real close codes, real reconnect.
//
// relay.test.mjs drives the client with a hand-written socket stand-in, which
// proves the logic and nothing about the wire. That leaves the seam every
// "it works" claim hides in: my mock behaves, but does a genuine socket? So
// this file speaks RFC 6455 properly — the Sec-WebSocket-Accept handshake,
// masked client frames, unmasked server frames, close frames with codes — and
// Node's own global WebSocket connects to it exactly as it would to Vercel.
//
// The server here is ~100 lines rather than a dependency on purpose: `ws` is
// not installed on this machine, and a test that has to be skipped is a test
// that proves nothing on the night it matters.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';

import { createRelayClient, CLOSE_UNAUTHORIZED } from '../src/relay/client.mjs';
import { PROTOCOL_VERSION } from '../src/relay/protocol.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function accept(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/** Server → client. Text frames only, and never masked, per RFC 6455 §5.1. */
function encodeText(text) {
  const payload = Buffer.from(text, 'utf8');
  const header = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : payload.length < 65536
      ? Buffer.concat([Buffer.from([0x81, 126]), be16(payload.length)])
      : Buffer.concat([Buffer.from([0x81, 127]), be64(payload.length)]);
  return Buffer.concat([header, payload]);
}

function encodeClose(code, reason = '') {
  const body = Buffer.concat([be16(code), Buffer.from(reason, 'utf8')]);
  return Buffer.concat([Buffer.from([0x88, body.length]), body]);
}

function be16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }
function be64(n) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; }

/**
 * Pull whole frames out of an accumulating buffer. Returns the frames it could
 * complete and the bytes left over — TCP does not respect message boundaries,
 * and a decoder that assumes one read is one frame passes on a fast loopback
 * and fails on a real network.
 */
function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const opcode = buffer[offset] & 0x0f;
    const masked = (buffer[offset + 1] & 0x80) !== 0;
    let length = buffer[offset + 1] & 0x7f;
    let cursor = offset + 2;
    if (length === 126) { if (buffer.length < cursor + 2) break; length = buffer.readUInt16BE(cursor); cursor += 2; }
    else if (length === 127) { if (buffer.length < cursor + 8) break; length = Number(buffer.readBigUInt64BE(cursor)); cursor += 8; }
    let mask = null;
    if (masked) { if (buffer.length < cursor + 4) break; mask = buffer.subarray(cursor, cursor + 4); cursor += 4; }
    if (buffer.length < cursor + length) break;

    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    // A client MUST mask (RFC 6455 §5.3). Unmasking is not optional politeness;
    // read it raw and every frame is garbage.
    if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    frames.push({ opcode, text: payload.toString('utf8') });
    offset = cursor + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

/**
 * A WebSocket server that records what each connection asked for and hands the
 * test a handle to talk back through.
 */
async function wsServer(onConnection) {
  const connections = [];
  const server = createServer((_req, res) => { res.writeHead(426); res.end('upgrade required'); });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept(key)}\r\n\r\n`,
    );

    const received = [];
    let buffer = Buffer.alloc(0);
    const conn = {
      url: req.url,
      params: new URL(req.url, 'http://relay.test').searchParams,
      received,
      send: (obj) => socket.write(encodeText(JSON.stringify(obj))),
      closeWith: (code, reason = '') => { socket.write(encodeClose(code, reason)); socket.end(); },
      drop: () => socket.destroy(), // an abrupt death, like a function timing out
    };
    connections.push(conn);

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { frames, rest } = decodeFrames(buffer);
      buffer = rest;
      for (const f of frames) {
        if (f.opcode === 0x1) received.push(JSON.parse(f.text));
        if (f.opcode === 0x8) socket.end();
      }
    });
    socket.on('error', () => {});
    onConnection?.(conn);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    connections,
    port: server.address().port,
    close: () => new Promise((r) => server.close(r)),
  };
}

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, { timeout = 5000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await settle(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('A REAL HANDSHAKE, A REAL FRAME, IN BOTH DIRECTIONS', async () => {
  const server = await wsServer();
  const received = [];
  const client = createRelayClient({
    url: `ws://127.0.0.1:${server.port}/api/relay`,
    key: 'shared-secret',
    channel: 'troy',
    onMessage: (f) => received.push(f),
  });

  try {
    client.start();
    await waitFor(() => server.connections.length === 1, { label: 'the connection' });
    const conn = server.connections[0];

    // The dial carried who we are, on the wire, not just in a mock's memory.
    assert.equal(conn.params.get('channel'), 'troy');
    assert.equal(conn.params.get('role'), 'desktop');
    assert.equal(conn.params.get('key'), 'shared-secret');

    conn.send({ v: PROTOCOL_VERSION, kind: 'hello', from: 'desktop', cursor: 0, body: 'relay ready' });
    await waitFor(() => client.state === 'connected', { label: 'connected' });

    // Server -> client, through genuine unmasked framing.
    conn.send({ v: PROTOCOL_VERSION, kind: 'say', from: 'phone', body: 'start the nightly build', id: 3 });
    await waitFor(() => received.length === 1, { label: 'the delivered message' });
    assert.equal(received[0].body, 'start the nightly build');
    assert.equal(client.cursor, 3);

    // Client -> server, which means Node masked it and the decoder unmasked it.
    client.send('on it');
    await waitFor(() => conn.received.some((f) => f.kind === 'say'), { label: 'the reply' });
    const reply = conn.received.find((f) => f.kind === 'say');
    assert.equal(reply.body, 'on it');
    assert.equal(reply.from, 'desktop');
  } finally {
    client.stop();
    await server.close();
  }
});

test('THE CURSOR SURVIVES A REAL DROP — the socket dies mid-conversation and nothing is lost', async () => {
  // This is the failure Vercel guarantees will happen: the Function reaches its
  // maximum duration and the socket ends. Simulated here by destroying it
  // outright, which is the least graceful version of the same event.
  const server = await wsServer();
  const received = [];
  const client = createRelayClient({
    url: `ws://127.0.0.1:${server.port}/api/relay`,
    key: 'shared-secret',
    channel: 'troy',
    onMessage: (f) => received.push(f),
  });

  try {
    client.start();
    await waitFor(() => server.connections.length === 1, { label: 'the first connection' });
    const first = server.connections[0];
    first.send({ v: PROTOCOL_VERSION, kind: 'hello', from: 'desktop', cursor: 0 });
    await waitFor(() => client.state === 'connected', { label: 'connected' });

    first.send({ v: PROTOCOL_VERSION, kind: 'say', from: 'phone', body: 'first thing', id: 11 });
    await waitFor(() => received.length === 1, { label: 'the first message' });

    // A line typed at the exact moment the socket dies must not evaporate.
    first.drop();
    await waitFor(() => client.state === 'backoff', { label: 'the client to notice' });
    client.send('typed while it was down');
    assert.equal(client.pending, 1, 'held, not dropped');

    await waitFor(() => server.connections.length === 2, { timeout: 8000, label: 'the reconnect' });
    const second = server.connections[1];
    assert.equal(second.params.get('since'), '11',
      'the reconnect resumed from the last id actually seen');

    second.send({ v: PROTOCOL_VERSION, kind: 'hello', from: 'desktop', cursor: 11 });
    await waitFor(() => client.state === 'connected', { label: 'reconnected' });

    // The held line went out on the new socket, unprompted.
    await waitFor(() => second.received.some((f) => f.kind === 'say'), { label: 'the flushed line' });
    assert.equal(second.received.find((f) => f.kind === 'say').body, 'typed while it was down');
    assert.equal(client.pending, 0);

    // And the gap the server replays arrives normally.
    second.send({ v: PROTOCOL_VERSION, kind: 'say', from: 'phone', body: 'the one sent during the outage', id: 12 });
    await waitFor(() => received.length === 2, { label: 'the replayed message' });
    assert.equal(received[1].body, 'the one sent during the outage');
  } finally {
    client.stop();
    await server.close();
  }
});

test('A REAL 4401 CLOSE FRAME STOPS IT DEAD — no reconnect storm against a bad key', async () => {
  const server = await wsServer((conn) => conn.closeWith(CLOSE_UNAUTHORIZED, 'unauthorized'));
  const client = createRelayClient({
    url: `ws://127.0.0.1:${server.port}/api/relay`,
    key: 'the-wrong-secret',
    channel: 'troy',
  });

  try {
    client.start();
    await waitFor(() => client.state === 'stopped', { label: 'the terminal state' });
    // Long enough that a retry would have shown up if one had been scheduled.
    await settle(1500);
    assert.equal(server.connections.length, 1, 'it dialled exactly once and gave up');
  } finally {
    client.stop();
    await server.close();
  }
});

test('it answers a real ping over the wire', async () => {
  const server = await wsServer();
  const client = createRelayClient({
    url: `ws://127.0.0.1:${server.port}/api/relay`,
    key: 'shared-secret',
    channel: 'troy',
  });

  try {
    client.start();
    await waitFor(() => server.connections.length === 1, { label: 'the connection' });
    const conn = server.connections[0];
    conn.send({ v: PROTOCOL_VERSION, kind: 'hello', from: 'desktop', cursor: 0 });
    await waitFor(() => client.state === 'connected', { label: 'connected' });

    conn.send({ v: PROTOCOL_VERSION, kind: 'ping', from: 'phone', body: '' });
    await waitFor(() => conn.received.some((f) => f.kind === 'pong'), { label: 'the pong' });
  } finally {
    client.stop();
    await server.close();
  }
});
