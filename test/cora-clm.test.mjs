// CORA CLM — proven without a Hume account, because there is not one.
//
// WHAT IS AND IS NOT PROVEN HERE, stated plainly so nobody reads a green run as
// more than it is:
//
//   PROVEN — the server's own behaviour. A real TCP socket, a real RFC 6455
//   handshake performed by Node's own WebSocket client (the same client
//   src/relay/client.mjs uses in production), real masked frames, and the exact
//   JSON shapes Hume's published example emits and consumes. Nothing here is a
//   hand-written stand-in for the socket; only the party at the other end is
//   simulated, and it is simulated against the verbatim contract quoted in
//   src/cora/clm-protocol.mjs.
//
//   PROVEN — that a spoken sentence reaches Helmion's REAL agent orchestration
//   and that a real tool runs on real disk. `AN END-TO-END VOICE TURN` below
//   calls the actual `runAgentTurn` from src/agent/loop.mjs against an actual
//   `createToolRuntime`, driven by a real HTTP OpenAI-compatible endpoint this
//   file stands up. The provider is local and scripted; the loop, the tool
//   gate, the tool, and the file it reads are all genuine.
//
//   NOT PROVEN — that a live Hume EVI config connects to this. That needs a
//   Hume API key and a reachable URL, neither of which exists in this session.
//   No test here claims otherwise.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ASSISTANT_END,
  ASSISTANT_INPUT,
  annotateWithProsody,
  applySpokenBudget,
  assistantEnd,
  assistantInput,
  parseHumePayload,
  prosodyReport,
  speakableText,
  splitForSpeech,
  topProsody,
} from '../src/cora/clm-protocol.mjs';
import {
  CLOSE,
  OPCODE,
  acceptKey,
  createFrameDecoder,
  encodeFrame,
} from '../src/cora/ws-server.mjs';
import {
  DEFAULT_CORA_PATH,
  createAgentTurnRunner,
  isHelmionSession,
  isLoopbackHost,
  resolveAccess,
  startCoraClm,
} from '../src/cora/clm-server.mjs';
import { activityEntry, readActivity, recordVoiceTurn } from '../src/cora/activity.mjs';

// ── helpers ────────────────────────────────────────────────────────────────

const settle = (ms = 25) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, { timeout = 8000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await settle(20);
  }
}

function tempWorkspace(tag) {
  const dir = mkdtempSync(join(tmpdir(), `cora-${tag}-`));
  return {
    dir,
    cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows lock */ } },
  };
}

/**
 * The envelope Hume sends, built to the shape quoted verbatim in
 * clm-protocol.mjs from HumeAI/hume-api-examples evi-python-clm-wss/main.py.
 */
function humeEnvelope(turns, customSessionId = null) {
  const payload = {
    messages: turns.map((turn, index) => ({
      type: turn.role === 'user' ? 'user_message' : 'assistant_message',
      message: { role: turn.role, content: turn.content },
      models: { prosody: { scores: turn.prosody ?? {} } },
      time: { begin: index * 1000, end: index * 1000 + 900 },
    })),
  };
  if (customSessionId !== null) payload.custom_session_id = customSessionId;
  return JSON.stringify(payload);
}

/**
 * A simulated Hume EVI client. Uses Node's GLOBAL WebSocket — the real client,
 * doing a real handshake and real client-side masking — so the only thing
 * pretended here is the identity of the peer, not the transport.
 */
function connectMockHume(url, { timeout = 5000 } = {}) {
  // Deliberately NOT `events.once(socket, 'open')`. A WebSocket is an
  // EventTarget, and `events.once` only auto-rejects on 'error' for an
  // EventEmitter — against an EventTarget a refused connection produces a
  // promise that never settles, which turns "the server correctly rejected me"
  // into a hung test. Every terminal outcome is wired explicitly here.
  return new Promise((resolve, reject) => {
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      reject(err);
      return;
    }
    const received = [];
    const raw = [];
    const closes = [];
    const timer = setTimeout(() => {
      try { socket.close(); } catch { /* already gone */ }
      reject(new Error(`timed out connecting to ${url}`));
    }, timeout);

    socket.addEventListener('message', (event) => {
      raw.push(event.data);
      try {
        received.push(JSON.parse(event.data));
      } catch {
        received.push({ type: '__unparseable__', data: event.data });
      }
    });
    socket.addEventListener('close', (event) => {
      closes.push({ code: event.code, reason: event.reason });
      clearTimeout(timer);
      // A no-op once the socket opened and this promise already resolved.
      reject(new Error(`socket closed before open (code ${event.code})`));
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`connection refused or failed: ${url}`));
    });
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve({
        socket,
        received,
        raw,
        closes,
        send: (text) => socket.send(text),
        sendTurn: (turns, customSessionId = null) => socket.send(humeEnvelope(turns, customSessionId)),
        inputs: () => received.filter((m) => m.type === ASSISTANT_INPUT),
        ends: () => received.filter((m) => m.type === ASSISTANT_END),
        spoken: () => received.filter((m) => m.type === ASSISTANT_INPUT).map((m) => m.text).join(' '),
        close: () => { try { socket.close(); } catch { /* already closed */ } },
      });
    });
  });
}

/**
 * A real HTTP server speaking the OpenAI chat.completions shape, so the REAL
 * provider adapter (src/agent/providers.mjs openAiCompatibleTurn) and the REAL
 * agent loop can be exercised with no key and no network.
 */
async function fakeOpenAiEndpoint(scriptedReplies) {
  const requests = [];
  let index = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ url: req.url, body: JSON.parse(body) });
      const reply = scriptedReplies[Math.min(index, scriptedReplies.length - 1)];
      index += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: reply }] }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    requests,
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    close: () => new Promise((r) => server.close(r)),
  };
}

const finalMessage = (content) => ({ role: 'assistant', content, tool_calls: [] });
const toolCallMessage = (name, args, content = '') => ({
  role: 'assistant',
  content,
  tool_calls: [{ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

// ── the wire contract ──────────────────────────────────────────────────────

test('parseHumePayload reads the envelope Hume actually sends', () => {
  const parsed = parseHumePayload(humeEnvelope(
    [
      { role: 'user', content: 'first thing', prosody: { Calmness: 0.2 } },
      { role: 'assistant', content: 'I heard you' },
      { role: 'user', content: 'list the sql files', prosody: { Determination: 0.81, Interest: 0.44, Boredom: 0.02 } },
    ],
    'helmion:desk-1',
  ));

  assert.equal(parsed.ok, true);
  assert.equal(parsed.error, null);
  assert.equal(parsed.customSessionId, 'helmion:desk-1');
  assert.equal(parsed.messageCount, 3);
  assert.equal(parsed.lastUser.content, 'list the sql files');
  assert.deepEqual(topProsody(parsed.lastUser.prosody, 2), { Determination: 0.81, Interest: 0.44 });
});

test('THE LAST USER TURN IS THE QUESTION, not the last array element', () => {
  // Hume's own example takes messages[-1] unconditionally. A trailing assistant
  // entry would make that answer our own last sentence, so this deviates on
  // purpose and the deviation is pinned here.
  const parsed = parseHumePayload(humeEnvelope([
    { role: 'user', content: 'what is in sql/' },
    { role: 'assistant', content: 'three migrations' },
  ], 'helmion:x'));
  assert.equal(parsed.lastUser.content, 'what is in sql/');
});

test('a malformed frame never throws — it reports', () => {
  const bad = parseHumePayload('{not json');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /not JSON/);

  const notObject = parseHumePayload('[1,2,3]');
  assert.equal(notObject.ok, false);

  const empty = parseHumePayload(JSON.stringify({ messages: [], custom_session_id: 'helmion:a' }));
  assert.equal(empty.ok, true);
  assert.equal(empty.lastUser, null, 'nothing was asked, so there is nothing to answer');
});

test('outgoing shapes match Hume\'s example byte for byte', () => {
  assert.deepEqual(
    assistantInput('hello', 'helmion:1'),
    { type: 'assistant_input', text: 'hello', custom_session_id: 'helmion:1' },
  );
  assert.deepEqual(assistantInput('hello', null), { type: 'assistant_input', text: 'hello' });
  // The example's assistant_end carries NOTHING. Adding a field here would be
  // an unverified guess about a message Hume parses.
  assert.equal(JSON.stringify(assistantEnd()), '{"type":"assistant_end"}');
});

test('prosody is folded into the prompt the way the example does it', () => {
  const scores = { Determination: 0.9, Interest: 0.5, Boredom: 0.01 };
  assert.equal(prosodyReport(scores), 'a lot of Determination and Interest');
  assert.equal(
    annotateWithProsody('ship it', scores),
    'ship it [Prosody: a lot of Determination and Interest]',
  );
  assert.equal(annotateWithProsody('ship it', {}), 'ship it', 'no scores means no bracket');
});

test('markdown is made speakable instead of read aloud as punctuation', () => {
  const answer = [
    '## Result',
    '',
    'I updated `src/agent/loop.mjs` and **verified** it:',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    '- one thing',
    '- another thing',
    'See [the docs](https://example.com/x).',
  ].join('\n');

  const spoken = speakableText(answer);
  assert.ok(!spoken.includes('```'), 'no fences survive');
  assert.ok(!spoken.includes('`'), 'no backticks survive');
  assert.ok(!spoken.includes('**'), 'no emphasis marks survive');
  assert.ok(!spoken.includes('https://'), 'a URL is not read aloud');
  assert.ok(spoken.includes('src/agent/loop.mjs'), 'the path itself is kept');
  assert.ok(spoken.includes('code omitted'), 'the listener is TOLD code was skipped');
  assert.ok(spoken.includes('the docs'), 'the link label survives');
});

test('speech is chunked on sentences, and a long sentence on words', () => {
  const chunks = splitForSpeech('One. Two. Three.', { maxChars: 40 });
  assert.deepEqual(chunks, ['One. Two. Three.']);

  const many = splitForSpeech('One. Two. Three. Four. Five.', { maxChars: 12 });
  assert.ok(many.every((c) => c.length <= 12), `every chunk within the cap: ${JSON.stringify(many)}`);
  assert.equal(many.join(' '), 'One. Two. Three. Four. Five.', 'nothing is lost or reordered');

  const long = splitForSpeech(`${'word '.repeat(60)}end.`, { maxChars: 50 });
  assert.ok(long.every((c) => c.length <= 50));
  assert.ok(!long.some((c) => /\bwor$|\bord\b/.test(c)), 'never split mid-word');
});

test('the spoken budget cuts at a word boundary and reports the cut', () => {
  const { text, truncated } = applySpokenBudget('alpha beta gamma delta', 12);
  assert.equal(truncated, true);
  assert.ok(text.length <= 12);
  assert.ok(!text.endsWith('bet'), `cut on a boundary, got ${JSON.stringify(text)}`);
  assert.deepEqual(applySpokenBudget('short', 100), { text: 'short', truncated: false, used: 5 });
});

// ── the framing layer ──────────────────────────────────────────────────────

test('acceptKey matches the RFC 6455 §1.3 worked example', () => {
  // The example key/accept pair printed in the RFC itself.
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

/** Client -> server frame: masked, as RFC 6455 §5.3 requires. */
function maskedFrame(opcode, payload, { fin = true } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const mask = Buffer.from([0x1a, 0x2b, 0x3c, 0x4d]);
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  const first = Buffer.from([(fin ? 0x80 : 0x00) | (opcode & 0x0f)]);
  let lengthPart;
  if (body.length < 126) lengthPart = Buffer.from([0x80 | body.length]);
  else if (body.length < 65536) {
    lengthPart = Buffer.alloc(3);
    lengthPart[0] = 0x80 | 126;
    lengthPart.writeUInt16BE(body.length, 1);
  } else {
    lengthPart = Buffer.alloc(9);
    lengthPart[0] = 0x80 | 127;
    lengthPart.writeBigUInt64BE(BigInt(body.length), 1);
  }
  return Buffer.concat([first, lengthPart, mask, masked]);
}

test('A FRAGMENTED MESSAGE IS REASSEMBLED — the bug that only shows up mid-conversation', () => {
  const decoder = createFrameDecoder();
  const events = [
    ...decoder.push(maskedFrame(OPCODE.TEXT, '{"messages":', { fin: false })),
    ...decoder.push(maskedFrame(OPCODE.CONTINUATION, '[1,2', { fin: false })),
    ...decoder.push(maskedFrame(OPCODE.CONTINUATION, ']}', { fin: true })),
  ];
  assert.deepEqual(events, [{ type: 'text', text: '{"messages":[1,2]}' }]);
});

test('TCP RE-FRAMING — one frame split across five reads, two frames in one read', () => {
  const decoder = createFrameDecoder();
  const frame = maskedFrame(OPCODE.TEXT, 'hello world');
  const collected = [];
  for (let i = 0; i < frame.length; i += 3) collected.push(...decoder.push(frame.subarray(i, i + 3)));
  assert.deepEqual(collected, [{ type: 'text', text: 'hello world' }]);

  const two = Buffer.concat([maskedFrame(OPCODE.TEXT, 'a'), maskedFrame(OPCODE.TEXT, 'b')]);
  assert.deepEqual(decoder.push(two), [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]);
});

test('a 16-bit and a 64-bit length both decode', () => {
  const medium = 'x'.repeat(5_000);
  assert.deepEqual(createFrameDecoder().push(maskedFrame(OPCODE.TEXT, medium)), [{ type: 'text', text: medium }]);

  const large = 'y'.repeat(70_000);
  assert.deepEqual(createFrameDecoder().push(maskedFrame(OPCODE.TEXT, large)), [{ type: 'text', text: large }]);
});

test('an UNMASKED client frame is a protocol error, not something to be lenient about', () => {
  const decoder = createFrameDecoder();
  // encodeFrame is the SERVER encoder — unmasked by definition — so feeding it
  // in is exactly the non-conforming client case.
  const [event] = decoder.push(encodeFrame(OPCODE.TEXT, Buffer.from('hi')));
  assert.equal(event.type, 'error');
  assert.equal(event.code, CLOSE.PROTOCOL_ERROR);
  assert.equal(decoder.poisoned, true);
  assert.deepEqual(decoder.push(maskedFrame(OPCODE.TEXT, 'hi')), [], 'a poisoned stream decodes nothing more');
});

test('THE SIZE CAP COUNTS THE ASSEMBLED MESSAGE, not one frame', () => {
  // A run of individually-legal continuation frames is exactly how you walk
  // past a per-frame cap, so the accumulator is what has to be checked.
  const decoder = createFrameDecoder({ maxMessageBytes: 100 });
  assert.deepEqual(
    decoder.push(maskedFrame(OPCODE.TEXT, 'z'.repeat(60), { fin: false })),
    [],
    '60 bytes is under the cap on its own',
  );
  const [tooBig] = decoder.push(maskedFrame(OPCODE.CONTINUATION, 'z'.repeat(60), { fin: false }));
  assert.equal(tooBig.type, 'error');
  assert.equal(tooBig.code, CLOSE.MESSAGE_TOO_BIG, '120 assembled bytes exceeded the 100-byte cap');
  assert.equal(decoder.poisoned, true);
});

test('a continuation with no opening frame is refused', () => {
  const [event] = createFrameDecoder().push(maskedFrame(OPCODE.CONTINUATION, 'orphan', { fin: true }));
  assert.equal(event.type, 'error');
  assert.equal(event.code, CLOSE.PROTOCOL_ERROR);
});

test('control frames follow §5.5 — never fragmented, never over 125 bytes', () => {
  const fragmented = createFrameDecoder().push(maskedFrame(OPCODE.PING, 'x', { fin: false }));
  assert.equal(fragmented[0].code, CLOSE.PROTOCOL_ERROR);

  const oversized = createFrameDecoder().push(maskedFrame(OPCODE.PING, 'x'.repeat(200)));
  assert.equal(oversized[0].code, CLOSE.PROTOCOL_ERROR);

  const ok = createFrameDecoder().push(maskedFrame(OPCODE.PING, 'ping'));
  assert.equal(ok[0].type, 'ping');
});

// ── access control ─────────────────────────────────────────────────────────

test('a tool-capable socket is REFUSED on a non-loopback bind without a token', () => {
  assert.deepEqual(resolveAccess({ host: '127.0.0.1', token: null }), { requiresToken: false });
  assert.deepEqual(resolveAccess({ host: 'localhost', token: null }), { requiresToken: false });
  assert.deepEqual(resolveAccess({ host: '::1', token: null }), { requiresToken: false });
  assert.deepEqual(resolveAccess({ host: '0.0.0.0', token: 'secret' }), { requiresToken: true });

  assert.throws(
    () => resolveAccess({ host: '0.0.0.0', token: null }),
    /Refusing to bind/,
    'binding an unauthenticated agent to the network must fail at startup',
  );
  assert.throws(() => resolveAccess({ host: '192.168.1.40', token: '   ' }), /Refusing to bind/);
});

test('isLoopbackHost does not confuse a LAN address for loopback', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('127.9.9.9'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('192.168.1.40'), false);
  assert.equal(isLoopbackHost('10.0.0.1'), false);
  assert.equal(isLoopbackHost(''), false);
});

test('HELMION MODE IS MARKED ON custom_session_id, and fails closed', () => {
  assert.equal(isHelmionSession('helmion'), true);
  assert.equal(isHelmionSession('helmion:desk-1'), true);
  assert.equal(isHelmionSession('HELMION:DESK-1'), true);
  assert.equal(isHelmionSession('helmion-desk-1'), true);
  // The cases that must NOT get tools: nobody stated an intent.
  assert.equal(isHelmionSession(null), false);
  assert.equal(isHelmionSession(''), false);
  assert.equal(isHelmionSession('some-other-app'), false);
  assert.equal(isHelmionSession('nothelmion:x'), false, 'a prefix match must be on a boundary');
});

// ── the server, over a real socket ─────────────────────────────────────────

test('A REAL SOCKET, A REAL TURN: assistant_input then exactly one assistant_end', async () => {
  const ws = tempWorkspace('turn');
  const seen = [];
  const server = await startCoraClm({
    workspace: ws.dir,
    port: 0,
    activitySink: () => ({ logged: true }),
    runTurn: async ({ text, session, onEvent }) => {
      seen.push({ text, helmionMode: session.helmionMode, id: session.id });
      onEvent({ type: 'assistant', text: 'Three migrations under sql.' });
      return { text: 'Three migrations under sql.' };
    },
  });
  const hume = await connectMockHume(server.url);

  try {
    hume.sendTurn([{ role: 'user', content: 'what is in sql', prosody: { Interest: 0.7 } }], 'helmion:desk-1');
    await waitFor(() => hume.ends().length === 1, { label: 'assistant_end' });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].text, 'what is in sql [Prosody: a lot of Interest]', 'prosody reached the model');
    assert.equal(seen[0].helmionMode, true);
    assert.equal(seen[0].id, 'helmion:desk-1');

    assert.ok(hume.inputs().length >= 1, 'something was spoken');
    assert.equal(hume.spoken().includes('Three migrations under sql.'), true);
    assert.equal(hume.inputs()[0].custom_session_id, 'helmion:desk-1');
    // The exact bytes on the wire, not a re-serialization of a parsed object.
    assert.equal(hume.raw.at(-1), '{"type":"assistant_end"}');

    // The order matters: every assistant_input precedes the single end.
    const order = hume.received.map((m) => m.type);
    assert.equal(order.filter((t) => t === ASSISTANT_END).length, 1);
    assert.equal(order.at(-1), ASSISTANT_END);
  } finally {
    hume.close();
    await server.close();
    ws.cleanup();
  }
});

test('A THROWN TURN STILL YIELDS THE MICROPHONE — one assistant_end, and it says so out loud', async () => {
  // Miss this and the user's mic is dead for the rest of the chat with no error
  // anywhere. It is the single worst failure this server can have.
  const ws = tempWorkspace('throw');
  const server = await startCoraClm({
    workspace: ws.dir,
    port: 0,
    activitySink: () => ({ logged: true }),
    runTurn: async () => { throw new Error('provider exploded'); },
  });
  const hume = await connectMockHume(server.url);

  try {
    hume.sendTurn([{ role: 'user', content: 'do the thing' }], 'helmion:boom');
    await waitFor(() => hume.ends().length === 1, { label: 'assistant_end after a throw' });
    await settle(150);

    assert.equal(hume.ends().length, 1, 'exactly one, not zero and not two');
    assert.match(hume.spoken(), /went wrong/i, 'the listener is TOLD it failed');
    assert.match(hume.spoken(), /provider exploded/);
  } finally {
    hume.close();
    await server.close();
    ws.cleanup();
  }
});

test('an unreadable frame yields the turn back instead of hanging the chat', async () => {
  const ws = tempWorkspace('garbage');
  let called = 0;
  const server = await startCoraClm({
    workspace: ws.dir,
    port: 0,
    activitySink: () => ({ logged: true }),
    runTurn: async () => { called += 1; return { text: '' }; },
  });
  const hume = await connectMockHume(server.url);

  try {
    hume.send('{not json at all');
    await waitFor(() => hume.ends().length === 1, { label: 'assistant_end after garbage' });
    assert.equal(called, 0, 'no model was billed for a frame we could not read');
    assert.match(hume.spoken(), /could not read/i);
  } finally {
    hume.close();
    await server.close();
    ws.cleanup();
  }
});

test('a payload with nothing asked yields the turn and calls NO model', async () => {
  const ws = tempWorkspace('silent');
  let called = 0;
  const server = await startCoraClm({
    workspace: ws.dir,
    port: 0,
    activitySink: () => ({ logged: true }),
    runTurn: async () => { called += 1; return { text: 'should not happen' }; },
  });
  const hume = await connectMockHume(server.url);

  try {
    hume.sendTurn([{ role: 'assistant', content: 'I already answered' }], 'helmion:quiet');
    await waitFor(() => hume.ends().length === 1, { label: 'the immediate yield' });
    await settle(120);
    assert.equal(called, 0);
    assert.equal(hume.inputs().length, 0, 'silence, not filler');
  } finally {
    hume.close();
    await server.close();
    ws.cleanup();
  }
});

test('AN UNMARKED SESSION GETS NO TOOLS — the fail-closed default, observed end to end', async () => {
  const ws = tempWorkspace('unmarked');
  const modes = [];
  const server = await startCoraClm({
    workspace: ws.dir,
    port: 0,
    activitySink: () => ({ logged: true }),
    runTurn: async ({ session, onEvent }) => {
      modes.push({ id: session.id, helmionMode: session.helmionMode });
      onEvent({ type: 'assistant', text: 'ok' });
      return { text: 'ok' };
    },
  });
  const hume = await connectMockHume(server.url);

  try {
    hume.sendTurn([{ role: 'user', content: 'hello' }], 'some-other-product');
    await waitFor(() => hume.ends().length === 1, { label: 'first turn' });
    hume.sendTurn([{ role: 'user', content: 'hello' }], null);
    await waitFor(() => hume.ends().length === 2, { label: 'second turn' });
    hume.sendTurn([{ role: 'user', content: 'hello' }], 'helmion:yes');
    await waitFor(() => hume.ends().length === 3, { label: 'third turn' });

    assert.deepEqual(modes.map((m) => m.helmionMode), [false, false, true]);
  } finally {
    hume.close();
    await server.close();
    ws.cleanup();
  }
});

test('two turns on one session are SERIALIZED, never interleaved', async () => {
  const ws = tempWorkspace('serial');
  const order = [];
  let resolveFirst;
  const firstGate = new Promise((r) => { resolveFirst = r; });
  const server = await startCoraClm({
    workspace: ws.dir,
    port: 0,
    activitySink: () => ({ logged: true }),
    runTurn: async ({ text, onEvent }) => {
      order.push(`start:${text}`);
      if (text.startsWith('one')) await firstGate;
      order.push(`end:${text}`);
      onEvent({ type: 'assistant', text: `did ${text}` });
      return { text: `did ${text}` };
    },
  });
  const hume = await connectMockHume(server.url);

  try {
    hume.sendTurn([{ role: 'user', content: 'one' }], 'helmion:s');
    await waitFor(() => order.length === 1, { label: 'the first turn to start' });
    hume.sendTurn([{ role: 'user', content: 'two' }], 'helmion:s');
    await settle(150);
    assert.deepEqual(order, ['start:one'], 'the second turn has NOT started');

    resolveFirst();
    await waitFor(() => hume.ends().length === 2, { label: 'both turns to finish' });
    assert.deepEqual(order, ['start:one', 'end:one', 'start:two', 'end:two']);
  } finally {
    resolveFirst();
    hume.close();
    await server.close();
    ws.cleanup();
  }
});

test('a long answer is capped and the listener is told it was capped, once', async () => {
  const ws = tempWorkspace('budget');
  const server = await startCoraClm({
    workspace: ws.dir,
    port: 0,
    maxSpokenChars: 120,
    activitySink: () => ({ logged: true }),
    runTurn: async ({ onEvent }) => {
      onEvent({ type: 'assistant', text: 'sentence. '.repeat(120) });
      onEvent({ type: 'assistant', text: 'more that will not fit either' });
      return { text: 'x' };
    },
  });
  const hume = await connectMockHume(server.url);

  try {
    hume.sendTurn([{ role: 'user', content: 'explain everything' }], 'helmion:long');
    await waitFor(() => hume.ends().length === 1, { label: 'assistant_end' });
    const apologies = hume.inputs().filter((m) => /more detail than I should read out/.test(m.text));
    assert.equal(apologies.length, 1, 'said once, not once per chunk');
    const spokenChars = hume.inputs()
      .filter((m) => !/more detail than I should read out/.test(m.text))
      .reduce((n, m) => n + m.text.length, 0);
    assert.ok(spokenChars <= 200, `stayed near the budget, spoke ${spokenChars} chars`);
  } finally {
    hume.close();
    await server.close();
    ws.cleanup();
  }
});

test('the path is enforced and a wrong token is refused before the protocol starts', async () => {
  const ws = tempWorkspace('auth');
  const server = await startCoraClm({
    workspace: ws.dir,
    host: '127.0.0.1',
    port: 0,
    token: 'the-right-secret',
    activitySink: () => ({ logged: true }),
    runTurn: async () => ({ text: 'ok' }),
  });

  try {
    assert.equal(server.requiresToken, true);

    await assert.rejects(
      connectMockHume(`ws://127.0.0.1:${server.port}${DEFAULT_CORA_PATH}?token=wrong`),
      'a bad token never reaches the decoder',
    );
    await assert.rejects(
      connectMockHume(`ws://127.0.0.1:${server.port}/not-the-path?token=the-right-secret`),
      'a wrong path is a 404, not a socket',
    );

    const good = await connectMockHume(`ws://127.0.0.1:${server.port}${DEFAULT_CORA_PATH}?token=the-right-secret`);
    good.close();
  } finally {
    await server.close();
    ws.cleanup();
  }
});

test('plain HTTP to the port explains itself instead of 404-ing', async () => {
  const ws = tempWorkspace('http');
  const server = await startCoraClm({
    workspace: ws.dir, port: 0, activitySink: () => ({ logged: true }), runTurn: async () => ({ text: '' }),
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    assert.equal(res.status, 426);
    assert.match(await res.text(), /WebSocket only/);
  } finally {
    await server.close();
    ws.cleanup();
  }
});

test('startCoraClm refuses to start with no provider key rather than failing on the first word', async () => {
  const ws = tempWorkspace('nokey');
  try {
    await assert.rejects(
      startCoraClm({
        workspace: ws.dir,
        port: 0,
        provider: { id: 'anthropic', key: '', label: 'Claude' },
      }),
      /No API key for Claude/,
    );
  } finally {
    ws.cleanup();
  }
});

// ── the activity ledger ────────────────────────────────────────────────────

test('a voice turn writes a row the DESKTOP reader accepts', () => {
  const ws = tempWorkspace('ledger');
  try {
    const result = recordVoiceTurn(ws.dir, {
      heard: 'list the sql files',
      spoken: 'There are three migrations.',
      status: 'completed',
      tools: ['list_dir'],
      model: 'claude-sonnet-5',
      sessionId: 'helmion:desk-1',
      helmionMode: true,
    });
    assert.equal(result.logged, true, result.reason);

    const rows = readActivity(ws.dir);
    assert.equal(rows.length, 1);
    const row = rows[0];
    // ProjectWorkbenchStore.ReadActivity keeps a row only when Id and Kind are
    // non-empty, and its record is (Id, AtUtc, Kind, Title, Detail, Status,
    // Source, EvidenceHash?) under a camelCase policy.
    for (const key of ['id', 'atUtc', 'kind', 'title', 'detail', 'status', 'source']) {
      assert.ok(row[key], `${key} present and non-empty`);
    }
    assert.equal(row.kind, 'agent', 'the same kind a typed agent turn uses, so it renders identically');
    assert.equal(row.source, 'Helmian Cora (voice)', 'but distinguishable as voice');
    assert.equal(row.kindLabel, 'AGENT');
    assert.match(row.id, /^\d{17}-[0-9a-f]{32}$/, 'matches the C# NewEntry id shape');
    assert.ok(Number.isFinite(Date.parse(row.atUtc)), 'atUtc parses as a date');
    assert.match(row.detail, /Heard: "list the sql files"/);
    assert.match(row.detail, /Said: "There are three migrations\."/);
    assert.match(row.detail, /Tools run: list_dir/);
    assert.match(row.detail, /Answered by: claude-sonnet-5/);
  } finally {
    ws.cleanup();
  }
});

test('an over-long detail is truncated rather than written at a size the C# writer would reject', () => {
  const entry = activityEntry({ title: 't', status: 'completed', detail: 'x'.repeat(20_000) });
  assert.ok(entry.detail.length <= 8_000);
  assert.match(entry.detail, /truncated to the ledger limit/);
});

test('a ledger write that cannot happen is REPORTED, never silent', () => {
  const bad = recordVoiceTurn(join(tmpdir(), 'cora-no-such-dir'), { heard: 'x', spoken: 'y', status: '' });
  assert.equal(bad.logged, false);
  assert.ok(bad.reason, 'the reason travels back to the caller');
});

// ── end to end, through the REAL agent loop ────────────────────────────────

test('AN END-TO-END VOICE TURN RUNS A REAL TOOL ON REAL DISK', async () => {
  // Everything below the fake provider is production code: startCoraClm ->
  // createAgentTurnRunner -> createSessionState -> runAgentTurn ->
  // chatWithTools -> openAiCompatibleTurn, and a real createToolRuntime
  // executing list_dir against a real directory.
  const ws = tempWorkspace('e2e');
  mkdirSync(join(ws.dir, 'sql'), { recursive: true });
  writeFileSync(join(ws.dir, 'sql', '001_init.sql'), '-- init\n', 'utf8');
  writeFileSync(join(ws.dir, 'sql', '002_more.sql'), '-- more\n', 'utf8');

  const endpoint = await fakeOpenAiEndpoint([
    toolCallMessage('list_dir', { path: 'sql' }, 'Let me look.'),
    finalMessage('There are two migrations in sql: `001_init.sql` and `002_more.sql`.'),
  ]);

  const server = await startCoraClm({
    workspace: ws.dir,
    port: 0,
    runTurn: createAgentTurnRunner({
      workspace: ws.dir,
      // The REAL provider adapter path for an OpenAI-compatible endpoint.
      provider: {
        id: 'custom', key: 'no-key-required', label: 'scripted-endpoint',
        url: endpoint.url, model: 'scripted-model', models: null,
      },
      permissionMode: 'read-tools',
      tier: 'standard',
      safeWorkspaceTools: true,
    }),
  });
  const hume = await connectMockHume(server.url);

  try {
    hume.sendTurn(
      [{ role: 'user', content: 'what migrations are in sql', prosody: { Interest: 0.6 } }],
      'helmion:e2e',
    );
    await waitFor(() => hume.ends().length === 1, { timeout: 20_000, label: 'the end-to-end turn' });

    // 1. The real loop made two real HTTP calls to the provider.
    assert.equal(endpoint.requests.length, 2, 'a tool round then a wrap-up round');

    // 2. The real tool catalog was advertised, gated to read-tools.
    const advertised = (endpoint.requests[0].body.tools ?? []).map((t) => t.function.name).sort();
    assert.deepEqual(advertised, ['list_dir', 'read_file', 'search_text', 'workspace_context'],
      'exactly the read-tools set — no create_file, no run_project_task');

    // 3. THE TOOL ACTUALLY RAN, and its output is the REAL directory listing.
    //    This is the difference between "wired" and "spoke a sentence".
    const secondCall = endpoint.requests[1].body.messages;
    const toolResult = secondCall.find((m) => m.role === 'tool');
    assert.ok(toolResult, 'the tool result was fed back to the model');
    assert.match(toolResult.content, /001_init\.sql/);
    assert.match(toolResult.content, /002_more\.sql/);

    // 4. Prosody survived the whole way to the provider request body.
    const userMessage = endpoint.requests[0].body.messages.find((m) => m.role === 'user');
    assert.match(userMessage.content, /\[Prosody: a lot of Interest\]/);

    // 5. The answer came back as speech, with the backticks removed.
    const spoken = hume.spoken();
    assert.match(spoken, /two migrations in sql/);
    assert.ok(!spoken.includes('`'), 'no backticks were read aloud');
    assert.match(spoken, /Working on that now/, 'one progress line while the tool ran');

    // 6. The turn is in the ledger, naming the tool that ran and the model.
    const rows = readActivity(ws.dir);
    const voiceRow = rows.find((r) => r.source === 'Helmian Cora (voice)');
    assert.ok(voiceRow, 'the voice turn is in the activity ledger');
    assert.equal(voiceRow.status, 'completed');
    assert.match(voiceRow.detail, /Tools run: list_dir/);
    assert.match(voiceRow.detail, /Answered by: scripted-model/);
    assert.match(voiceRow.detail, /Heard: "what migrations are in sql"/);
  } finally {
    hume.close();
    await server.close();
    await endpoint.close();
    ws.cleanup();
  }
});

test('AN UNMARKED SESSION CANNOT REACH A TOOL EVEN IF THE MODEL ASKS FOR ONE', async () => {
  // The positive control for the fail-closed default: the same scripted model
  // that successfully listed a directory above is given a session id that is
  // not marked helmion, and must be handed no tools at all.
  const ws = tempWorkspace('e2e-denied');
  mkdirSync(join(ws.dir, 'sql'), { recursive: true });
  writeFileSync(join(ws.dir, 'sql', '001_init.sql'), '-- init\n', 'utf8');

  const endpoint = await fakeOpenAiEndpoint([finalMessage('I cannot look at files here.')]);
  const server = await startCoraClm({
    workspace: ws.dir,
    port: 0,
    runTurn: createAgentTurnRunner({
      workspace: ws.dir,
      provider: {
        id: 'custom', key: 'no-key-required', label: 'scripted-endpoint',
        url: endpoint.url, model: 'scripted-model', models: null,
      },
      permissionMode: 'full', // even at the most permissive configured mode…
      tier: 'standard',
      safeWorkspaceTools: true,
    }),
  });
  const hume = await connectMockHume(server.url);

  try {
    hume.sendTurn([{ role: 'user', content: 'delete everything' }], 'not-helmion');
    await waitFor(() => hume.ends().length === 1, { timeout: 20_000, label: 'the refused turn' });

    // …an unmarked session is built read-only, so NO tools are advertised.
    assert.equal(endpoint.requests.length, 1);
    assert.equal(endpoint.requests[0].body.tools, undefined,
      'no tools array at all — read-only produces an empty catalog and the adapter omits it');
  } finally {
    hume.close();
    await server.close();
    await endpoint.close();
    ws.cleanup();
  }
});
