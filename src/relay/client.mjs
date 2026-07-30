// The desktop end of the relay.
//
// It dials OUT. Nothing listens on this machine, no port is opened, no firewall
// rule is needed, and it works the same from his house, a truck stop or a hotel
// because the connection is established from the inside. That is the whole
// reason the relay exists rather than exposing Helmion directly.
//
// Vercel documents that a WebSocket held by a Function ENDS when the Function
// reaches its maximum duration, and prescribes reconnecting with exponential
// backoff. So a dropped socket here is NORMAL OPERATION, not an incident. The
// two properties that make that survivable are:
//
//   THE CURSOR — every stored message has a monotonic id, and reconnecting
//   sends the highest id already seen. The server replays what was missed. A
//   drop costs latency, never a message.
//
//   THE OUTBOX — a line handed to send() while the socket is down is held, not
//   dropped, and flushed on reconnect. Bounded, because "hold everything
//   forever" is how a background process quietly eats a machine.
//
// It carries TEXT. It does not execute, and there is deliberately no branch here
// that could — see the note at the top of protocol.mjs.

import {
  MAX_BODY_CHARS,
  deliverTo,
  encode,
  frame,
  isValidChannel,
  parseFrame,
} from './protocol.mjs';

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 30_000;
export const MAX_OUTBOX = 200;

// Close codes we choose to treat as terminal. Retrying a rejected key is not
// persistence, it is knocking on a locked door until someone notices.
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_BAD_REQUEST = 4400;

export const STATES = ['idle', 'connecting', 'connected', 'backoff', 'stopped'];

/**
 * @param {object} options
 * @param {string} options.url        wss:// base, e.g. wss://jarvis-troy.vercel.app/api/relay
 * @param {string} options.key        shared secret (MCP_SECRET on the Vercel side)
 * @param {string} options.channel    pairing id
 * @param {'desktop'|'phone'} [options.role]
 * @param {(frame: object) => void} [options.onMessage]  called for each delivered 'say'
 * @param {(status: object) => void} [options.onStatus]  state changes, for the CLI to print
 * @param {(url: string) => object} [options.connect]    socket factory — injected in tests
 */
export function createRelayClient({
  url,
  key,
  channel,
  role = 'desktop',
  onMessage = () => {},
  onStatus = () => {},
  connect = defaultConnect,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  random = Math.random,
} = {}) {
  if (!url) throw new TypeError('relay client needs a url');
  if (!key) throw new TypeError('relay client needs a key');
  if (!isValidChannel(channel)) throw new TypeError(`invalid channel: ${JSON.stringify(channel)}`);

  let state = 'idle';
  let socket = null;
  let timer = null;
  let cursor = 0;
  let delay = BACKOFF_BASE_MS;
  let attempts = 0;
  let dropped = 0;
  const outbox = [];

  function setState(next, detail = {}) {
    state = next;
    onStatus({ state: next, cursor, attempts, ...detail });
  }

  function dialUrl() {
    const u = new URL(url);
    u.searchParams.set('key', key);
    u.searchParams.set('channel', channel);
    u.searchParams.set('role', role);
    u.searchParams.set('since', String(cursor));
    return u.toString();
  }

  function open() {
    if (state === 'stopped') return;
    setState('connecting');
    attempts += 1;
    let ws;
    try {
      ws = connect(dialUrl());
    } catch (err) {
      // A factory that throws must not kill the process — that is exactly the
      // transient case backoff exists for.
      scheduleRetry(`could not open a socket: ${err.message}`);
      return;
    }
    socket = ws;

    ws.onopen = () => {
      // NOT connected yet, and the delay is NOT reset here. A server that
      // accepts the TCP connection and immediately closes it would otherwise
      // reset the backoff on every attempt and produce a one-second hammer
      // loop forever. The reset happens on `hello`, which only a server that
      // actually accepted us can send.
      setState('connecting', { note: 'socket open, waiting for hello' });
    };

    ws.onmessage = (event) => {
      const result = parseFrame(event?.data);
      if (!result.ok) {
        onStatus({ state, cursor, attempts, dropped: (dropped += 1), refused: result.reason });
        return;
      }
      handle(result.frame);
    };

    ws.onerror = () => {
      // Deliberately quiet. 'error' is always followed by 'close', and reacting
      // to both schedules two retries for one failure.
    };

    ws.onclose = (event) => {
      socket = null;
      const code = event?.code;
      if (state === 'stopped') return;
      if (code === CLOSE_UNAUTHORIZED || code === CLOSE_BAD_REQUEST) {
        setState('stopped', {
          terminal: true,
          reason: code === CLOSE_UNAUTHORIZED
            ? 'the relay refused the key — nothing will be retried'
            : 'the relay refused the request — nothing will be retried',
        });
        return;
      }
      scheduleRetry(`socket closed${code ? ` (${code})` : ''}`);
    };
  }

  function handle(f) {
    // The id advances the cursor regardless of kind, so a frame this build does
    // not act on still cannot be replayed forever.
    if (typeof f.id === 'number' && f.id > cursor) cursor = f.id;

    if (f.kind === 'hello') {
      if (typeof f.cursor === 'number' && f.cursor > cursor) cursor = f.cursor;
      delay = BACKOFF_BASE_MS; // proven-good connection — only now
      setState('connected', { note: 'relay accepted the connection' });
      flush();
      return;
    }
    if (f.kind === 'ping') {
      write(frame({ kind: 'pong', from: role }));
      return;
    }
    if (f.kind === 'say') {
      // A frame stamped with our own role is not delivered to us. If it ever
      // arrives, the server routed it wrong, and echoing it into the transcript
      // would read as the other end having said it.
      if (f.from === role) {
        onStatus({ state, cursor, attempts, dropped: (dropped += 1), refused: 'a frame came back stamped as our own' });
        return;
      }
      onMessage(f);
      return;
    }
    if (f.kind === 'error') {
      onStatus({ state, cursor, attempts, relayError: f.body });
    }
  }

  function write(obj) {
    if (!socket || state !== 'connected') return false;
    try {
      socket.send(encode(obj));
      return true;
    } catch {
      return false;
    }
  }

  function flush() {
    while (outbox.length) {
      const next = outbox[0];
      if (!write(next)) return;
      outbox.shift();
    }
  }

  function scheduleRetry(reason) {
    if (state === 'stopped') return;
    // Full jitter. Without it, a phone and a desktop knocked off by the same
    // function timeout retry in lockstep forever.
    const wait = Math.round(delay * (0.5 + random() * 0.5));
    setState('backoff', { reason, retryInMs: wait });
    timer = setTimer(open, wait);
    delay = Math.min(delay * 2, BACKOFF_CAP_MS);
  }

  return {
    get state() { return state; },
    get cursor() { return cursor; },
    get pending() { return outbox.length; },
    get droppedFrames() { return dropped; },

    start() {
      if (state === 'connecting' || state === 'connected') return;
      state = 'idle';
      open();
    },

    /** Queue a line for the other end. Held if the socket is down. */
    send(text) {
      const body = String(text ?? '');
      if (!body.trim()) return { sent: false, reason: 'nothing to send' };
      if (body.length > MAX_BODY_CHARS) {
        return { sent: false, reason: `too long: ${body.length} of ${MAX_BODY_CHARS} chars` };
      }
      const f = frame({ kind: 'say', from: role, body });
      if (write(f)) return { sent: true, queued: false, to: deliverTo(role) };
      if (outbox.length >= MAX_OUTBOX) {
        return { sent: false, reason: `outbox is full (${MAX_OUTBOX}) — the relay has been down too long` };
      }
      outbox.push(f);
      return { sent: false, queued: true, pending: outbox.length };
    },

    stop() {
      setState('stopped', { note: 'stopped locally' });
      if (timer) clearTimer(timer);
      timer = null;
      if (socket) {
        try { socket.close(1000, 'client stopping'); } catch { /* already gone */ }
      }
      socket = null;
    },
  };
}

function defaultConnect(dialUrl) {
  // Node 24 ships a global WebSocket, so the desktop end needs no dependency.
  if (typeof WebSocket !== 'function') {
    throw new Error('this Node build has no global WebSocket (Node 22+ required)');
  }
  return new WebSocket(dialUrl);
}
