// A WebSocket SERVER, RFC 6455, with no dependency.
//
// WHY THIS FILE EXISTS AT ALL
//
// Hume EVI's Custom Language Model transport is Hume DIALLING US: EVI opens a
// WebSocket to a URL configured on the EVI config and speaks JSON over it. Node
// ships a global WebSocket CLIENT (src/relay/client.mjs:249-253 already relies
// on it) and no server. `ws` is not installed — `node_modules/` on this machine
// holds `pg` and its transitive deps and nothing else, and package.json
// declares exactly one dependency. Adding one for this would mean a network
// install and a lockfile change on a tree several sessions are committing to.
//
// test/relay-live.test.mjs already proved a ~100-line handshake is enough to
// speak the protocol honestly, and said so for the same reason: "a test that
// has to be skipped is a test that proves nothing on the night it matters."
// This is that code promoted out of a test file and finished properly — because
// a decoder that is merely good enough for a fast loopback is the classic thing
// that passes locally and corrupts a real message.
//
// WHAT "FINISHED PROPERLY" MEANS HERE, AND WHY EACH PART IS NOT OPTIONAL
//
//   * FRAGMENTATION (FIN bit + opcode 0 continuation). A CLM payload carries the
//     whole conversation history plus a prosody score block per utterance; it
//     grows without bound as a chat runs. Any sender is free to split that
//     across frames, and a decoder that treats one frame as one message will
//     hand back a truncated JSON string that fails to parse — mid-conversation,
//     never on the first turn, i.e. exactly the bug you cannot reproduce.
//   * 16- AND 64-BIT LENGTHS. Same reason. A 7-bit length tops out at 125 bytes.
//   * UNMASKING. RFC 6455 §5.3 requires a client to mask. Read the bytes raw and
//     every frame is garbage that still looks like a successful read.
//   * TCP RE-FRAMING. A read is not a frame. Two frames can arrive in one chunk
//     and one frame can arrive in five, so the decoder accumulates and only
//     emits what it can complete.
//   * A HARD BYTE CAP. This socket reaches a coding agent. An unbounded
//     accumulator on an unauthenticated port is a memory-exhaustion primitive,
//     so an oversized message is refused with close 1009 rather than buffered.
//
// The decoder is a pure function of bytes -> events, which is what makes it
// testable without a socket at all.

import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

/** RFC 6455 §1.3 — the fixed GUID concatenated with the client key. */
export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODE = Object.freeze({
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
});

export const CLOSE = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED_DATA: 1003,
  POLICY_VIOLATION: 1008,
  MESSAGE_TOO_BIG: 1009,
  INTERNAL_ERROR: 1011,
});

/** 1 MiB. A CLM turn is JSON text; anything larger is not a conversation. */
export const DEFAULT_MAX_MESSAGE_BYTES = 1_048_576;

/** RFC 6455 §4.2.2 — base64(SHA-1(key + GUID)). */
export function acceptKey(key) {
  return createHash('sha1').update(`${String(key)}${WS_GUID}`).digest('base64');
}

function be16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }
function be64(n) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; }

/**
 * Server -> client frame. Always FIN=1 and NEVER masked: RFC 6455 §5.1 forbids
 * a server masking, and a masked server frame is a protocol error the peer is
 * entitled to close on.
 */
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const first = Buffer.from([0x80 | (opcode & 0x0f)]);
  let lengthPart;
  if (body.length < 126) lengthPart = Buffer.from([body.length]);
  else if (body.length < 65536) lengthPart = Buffer.concat([Buffer.from([126]), be16(body.length)]);
  else lengthPart = Buffer.concat([Buffer.from([127]), be64(body.length)]);
  return Buffer.concat([first, lengthPart, body]);
}

export function encodeText(text) {
  return encodeFrame(OPCODE.TEXT, Buffer.from(String(text), 'utf8'));
}

export function encodeClose(code = CLOSE.NORMAL, reason = '') {
  // A close frame's payload is a 2-byte code plus an optional UTF-8 reason, and
  // the whole thing is a control frame: 125 bytes maximum (RFC 6455 §5.5).
  const reasonBytes = Buffer.from(String(reason), 'utf8').subarray(0, 123);
  return encodeFrame(OPCODE.CLOSE, Buffer.concat([be16(code), reasonBytes]));
}

/**
 * Accumulating frame decoder. `push(chunk)` returns the events it could
 * complete from everything seen so far; the remainder is held for the next
 * chunk.
 *
 * Events: {type:'text',text} | {type:'binary',data} | {type:'ping',data}
 *       | {type:'pong',data} | {type:'close',code,reason}
 *       | {type:'error',code,message}   <- caller should close with `code`
 *
 * After an 'error' the stream is poisoned and every later push returns nothing:
 * once framing is lost there is no way to resynchronise, and continuing to
 * "decode" would be inventing messages.
 */
export function createFrameDecoder({ maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES } = {}) {
  let buffer = Buffer.alloc(0);
  let poisoned = false;
  // The message currently being assembled across continuation frames.
  let fragmentOpcode = null;
  let fragments = [];
  let fragmentBytes = 0;

  const fail = (code, message) => {
    poisoned = true;
    buffer = Buffer.alloc(0);
    fragments = [];
    fragmentOpcode = null;
    fragmentBytes = 0;
    return { type: 'error', code, message };
  };

  return {
    get poisoned() { return poisoned; },
    /** @returns {Array<object>} events completed by this chunk */
    push(chunk) {
      if (poisoned) return [];
      buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
      const events = [];

      while (!poisoned) {
        if (buffer.length < 2) break;
        const b0 = buffer[0];
        const b1 = buffer[1];
        const fin = (b0 & 0x80) !== 0;
        const rsv = b0 & 0x70;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let length = b1 & 0x7f;
        let cursor = 2;

        // No extension was negotiated, so a reserved bit set means the peer is
        // speaking something we did not agree to (RFC 6455 §5.2).
        if (rsv !== 0) { events.push(fail(CLOSE.PROTOCOL_ERROR, 'reserved bits set')); break; }

        if (length === 126) {
          if (buffer.length < cursor + 2) break;
          length = buffer.readUInt16BE(cursor);
          cursor += 2;
        } else if (length === 127) {
          if (buffer.length < cursor + 8) break;
          const big = buffer.readBigUInt64BE(cursor);
          if (big > BigInt(maxMessageBytes)) {
            events.push(fail(CLOSE.MESSAGE_TOO_BIG, `frame declares ${big} bytes`));
            break;
          }
          length = Number(big);
          cursor += 8;
        }

        // A client MUST mask (§5.3). An unmasked client frame is a protocol
        // error, not something to be lenient about.
        if (!masked) { events.push(fail(CLOSE.PROTOCOL_ERROR, 'client frame was not masked')); break; }
        if (buffer.length < cursor + 4) break;
        const mask = buffer.subarray(cursor, cursor + 4);
        cursor += 4;

        if (length > maxMessageBytes) {
          events.push(fail(CLOSE.MESSAGE_TOO_BIG, `frame is ${length} bytes`));
          break;
        }
        if (buffer.length < cursor + length) break;

        const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
        buffer = buffer.subarray(cursor + length);

        const isControl = (opcode & 0x08) !== 0;
        if (isControl) {
          // §5.5: control frames are never fragmented and never exceed 125 bytes.
          if (!fin || length > 125) {
            events.push(fail(CLOSE.PROTOCOL_ERROR, 'malformed control frame'));
            break;
          }
          if (opcode === OPCODE.CLOSE) {
            const code = payload.length >= 2 ? payload.readUInt16BE(0) : CLOSE.NORMAL;
            events.push({ type: 'close', code, reason: payload.subarray(2).toString('utf8') });
          } else if (opcode === OPCODE.PING) {
            events.push({ type: 'ping', data: payload });
          } else if (opcode === OPCODE.PONG) {
            events.push({ type: 'pong', data: payload });
          } else {
            events.push(fail(CLOSE.PROTOCOL_ERROR, `unknown control opcode ${opcode}`));
            break;
          }
          continue;
        }

        if (opcode === OPCODE.CONTINUATION) {
          if (fragmentOpcode === null) {
            events.push(fail(CLOSE.PROTOCOL_ERROR, 'continuation without an opening frame'));
            break;
          }
        } else if (opcode === OPCODE.TEXT || opcode === OPCODE.BINARY) {
          if (fragmentOpcode !== null) {
            events.push(fail(CLOSE.PROTOCOL_ERROR, 'new data frame inside a fragmented message'));
            break;
          }
          fragmentOpcode = opcode;
        } else {
          events.push(fail(CLOSE.PROTOCOL_ERROR, `unknown opcode ${opcode}`));
          break;
        }

        fragmentBytes += payload.length;
        // The cap applies to the ASSEMBLED message, not to one frame: otherwise
        // an unbounded run of small continuation frames walks straight past it.
        if (fragmentBytes > maxMessageBytes) {
          events.push(fail(CLOSE.MESSAGE_TOO_BIG, `message exceeded ${maxMessageBytes} bytes`));
          break;
        }
        fragments.push(payload);
        if (!fin) continue;

        const complete = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments);
        const completedOpcode = fragmentOpcode;
        fragments = [];
        fragmentOpcode = null;
        fragmentBytes = 0;
        events.push(completedOpcode === OPCODE.TEXT
          ? { type: 'text', text: complete.toString('utf8') }
          : { type: 'binary', data: complete });
      }

      return events;
    },
  };
}

/**
 * One live connection. An EventEmitter so a caller can attach handlers after
 * onConnection returns without racing the first frame — 'text' and 'close' are
 * emitted from socket callbacks, which cannot run before the current tick ends.
 *
 * Events: 'text' (string), 'close' ({code, reason}), 'error' (Error).
 */
class CoraSocket extends EventEmitter {
  constructor(socket, { url, maxMessageBytes }) {
    super();
    this.id = randomBytes(8).toString('hex');
    this.url = url;
    this.params = url.searchParams;
    this.remoteAddress = socket.remoteAddress ?? null;
    this.closed = false;
    this._socket = socket;
    this._decoder = createFrameDecoder({ maxMessageBytes });

    socket.on('data', (chunk) => {
      for (const event of this._decoder.push(chunk)) {
        if (event.type === 'text') this.emit('text', event.text);
        else if (event.type === 'ping') this._write(encodeFrame(OPCODE.PONG, event.data));
        else if (event.type === 'close') this.close(CLOSE.NORMAL, '');
        else if (event.type === 'error') this.close(event.code, event.message);
        // 'binary' and 'pong' are accepted and ignored: the CLM protocol is text.
      }
    });
    socket.on('close', () => this._finish(CLOSE.GOING_AWAY, 'socket closed'));
    socket.on('error', (err) => {
      this.emit('error', err);
      this._finish(CLOSE.INTERNAL_ERROR, err?.message ?? 'socket error');
    });
  }

  _write(buffer) {
    if (this.closed || this._socket.destroyed) return false;
    try {
      this._socket.write(buffer);
      return true;
    } catch {
      // A write to a socket the peer already dropped must never throw into a
      // turn that is mid-flight; the 'close' event will clean up.
      return false;
    }
  }

  /** @returns {boolean} whether the bytes were handed to the socket. */
  send(text) {
    return this._write(encodeText(text));
  }

  sendJson(value) {
    return this.send(JSON.stringify(value));
  }

  close(code = CLOSE.NORMAL, reason = '') {
    if (this.closed) return;
    this._write(encodeClose(code, reason));
    try { this._socket.end(); } catch { /* already gone */ }
    this._finish(code, reason);
  }

  _finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', { code, reason });
  }
}

/**
 * Origins permitted to open this socket from a BROWSER. Empty by default:
 * nothing web-hosted has any business driving a local coding agent.
 */
export const DEFAULT_ALLOWED_ORIGINS = Object.freeze([]);

/**
 * THE THREAT THIS STOPS, AND THE ONE IT DOES NOT — because the difference
 * decides why "no Origin header" is a PASS rather than a failure.
 *
 * Cross-Site WebSocket Hijacking: any page Troy has open can execute
 * `new WebSocket('ws://127.0.0.1:7421/llm')`. The same-origin policy does NOT
 * apply to WebSockets and no CORS preflight happens, so without this check a
 * random tab can open a socket that reaches `run_command`. Loopback binding
 * does not help — the browser IS on loopback. That attack is browser-only, and
 * every browser is REQUIRED to send Origin on a WebSocket handshake, so
 * rejecting unknown origins stops all of it.
 *
 * A non-browser attacker forges the header trivially, so this is worth exactly
 * nothing against one. That is what the token is for; the two are different
 * controls against different attackers and neither substitutes for the other.
 *
 * Hence: a MISSING Origin means the peer is not a browser and is judged on its
 * token instead. Hume's cloud dials this socket from a server, and server-side
 * WebSocket clients do not send Origin.
 * 🔴 UNVERIFIED against a live Hume connection — no Hume key exists on this
 * machine (docs/CORA_CLM_LOCAL_PHASE1.md records the same gap). If a real Hume
 * dial-in ever IS refused here, the refusal log line below names the exact
 * origin to add, which is why it logs the value rather than just "denied".
 *
 * `Origin: null` — what a sandboxed iframe or a `file://` page sends — is a
 * PRESENT header and is therefore refused unless explicitly allowlisted.
 *
 * @returns {{ok: boolean, reason: string}}
 */
export function isOriginAllowed(origin, allowedOrigins = DEFAULT_ALLOWED_ORIGINS) {
  const raw = typeof origin === 'string' ? origin.trim() : '';
  if (!raw) return { ok: true, reason: 'no Origin header — the peer is not a browser' };

  const list = Array.isArray(allowedOrigins) ? allowedOrigins : [];
  const normalize = (value) => String(value).trim().toLowerCase().replace(/\/+$/, '');
  // An explicit opt-out has to be spelled out by a caller; it is never a default.
  if (list.some((entry) => typeof entry === 'string' && entry.trim() === '*')) {
    return { ok: true, reason: 'wildcard origin allowlist' };
  }
  const presented = normalize(raw);
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    if (normalize(entry) === presented) return { ok: true, reason: 'allowlisted origin' };
  }
  return { ok: false, reason: `Origin ${raw} is not on the allowlist` };
}

/**
 * Attach a WebSocket upgrade handler to an existing node:http server.
 *
 * `verifyClient({ request, url })` runs BEFORE the 101 and may refuse with
 * `{ ok:false, status, message }`. It is deliberately synchronous-or-async and
 * deliberately runs before any byte of the protocol is spoken, so an
 * unauthorised peer never reaches the decoder.
 *
 * @returns {{ connections: Set<CoraSocket>, closeAll: (code?:number, reason?:string) => void }}
 */
export function attachWebSocketServer(httpServer, {
  path = '/',
  onConnection,
  verifyClient = null,
  allowedOrigins = DEFAULT_ALLOWED_ORIGINS,
  onRefused = null,
  maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
} = {}) {
  const connections = new Set();

  const STATUS_TEXT = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error' };

  const refuse = (socket, status, message) => {
    const body = `${message}\n`;
    socket.write(
      `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Bad Request'}\r\n`
      + 'content-type: text/plain; charset=utf-8\r\n'
      + `content-length: ${Buffer.byteLength(body)}\r\n`
      + 'connection: close\r\n\r\n'
      + body,
    );
    socket.destroy();
  };

  httpServer.on('upgrade', async (request, socket) => {
    socket.on('error', () => {});
    let url;
    try {
      url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    } catch {
      refuse(socket, 400, 'Malformed request target.');
      return;
    }

    if (String(request.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      refuse(socket, 400, 'This endpoint speaks WebSocket only.');
      return;
    }
    if (String(request.headers['sec-websocket-version'] ?? '') !== '13') {
      refuse(socket, 400, 'Only WebSocket version 13 is supported.');
      return;
    }
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string' || !key.trim()) {
      refuse(socket, 400, 'Missing Sec-WebSocket-Key.');
      return;
    }
    if (path && url.pathname !== path) {
      refuse(socket, 404, `No WebSocket endpoint at ${url.pathname}.`);
      return;
    }

    // BEFORE the token check on purpose. A cross-site handshake from a page in
    // Troy's browser would carry his cookies and anything else the browser
    // attaches automatically; the question "is this peer allowed to be a
    // browser at all" is therefore settled first, and the answer is logged with
    // the actual origin so a legitimate refusal can be fixed in one look
    // instead of being guessed at.
    const originVerdict = isOriginAllowed(request.headers.origin, allowedOrigins);
    if (!originVerdict.ok) {
      onRefused?.({
        reason: 'origin',
        origin: request.headers.origin ?? null,
        detail: originVerdict.reason,
        remoteAddress: socket.remoteAddress ?? null,
      });
      refuse(socket, 403, `${originVerdict.reason}.`);
      return;
    }

    if (verifyClient) {
      let verdict;
      try {
        verdict = await verifyClient({ request, url });
      } catch (err) {
        // A verifier that throws FAILS CLOSED. The alternative — treating an
        // exception as a pass — is how an auth check becomes decoration.
        refuse(socket, 500, `Authorization check failed: ${err?.message ?? 'error'}`);
        return;
      }
      if (!verdict || verdict.ok !== true) {
        refuse(socket, verdict?.status ?? 401, verdict?.message ?? 'Unauthorized.');
        return;
      }
    }

    socket.setNoDelay(true);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );

    const connection = new CoraSocket(socket, { url, maxMessageBytes });
    connections.add(connection);
    connection.on('close', () => connections.delete(connection));
    try {
      onConnection?.(connection);
    } catch (err) {
      connection.close(CLOSE.INTERNAL_ERROR, err?.message ?? 'handler failed');
    }
  });

  return {
    connections,
    closeAll(code = CLOSE.GOING_AWAY, reason = 'server shutting down') {
      for (const connection of [...connections]) connection.close(code, reason);
    },
  };
}
