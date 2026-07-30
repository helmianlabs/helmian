// The always-on half of the relay, and the one that is cheap enough to leave
// running.
//
// WHY POLLING IS THE DEFAULT AND THE SOCKET IS NOT. Vercel bills Fluid compute
// on Provisioned Memory for an instance's whole life, and only pauses CPU
// billing during I/O — "If the request is waiting on I/O, CPU billing pauses but
// memory billing continues" (vercel.com/docs/functions/usage-and-pricing). So a
// held-open WebSocket is nearly free on CPU and expensive on memory: at Standard
// (2 GB) in iad1, one socket open around the clock reserves 48 GB-hrs a day
// against a Hobby allowance of 360 GB-hrs a month — the entire month in about
// seven and a half days, on the same plan as Troy's live ThinkinBuddy app.
//
// A poll holds an instance for the length of one small query. At the cold
// interval that is a couple of percent of the monthly allowance, so this can
// simply stay on.
//
// IT GOES HOT WHEN THERE IS SOMETHING TO SAY. Thirty seconds is fine for "is
// anything waiting", and miserable mid-conversation. Any traffic in either
// direction drops the interval to a few seconds for two minutes, so a real
// back-and-forth feels live without holding anything open, and it settles back
// down by itself when the conversation stops.
//
// It carries TEXT, like the socket. Nothing here executes anything.

import { MAX_BODY_CHARS } from './protocol.mjs';

export const COLD_INTERVAL_MS = 30_000;
export const HOT_INTERVAL_MS = 3_000;
export const HOT_WINDOW_MS = 120_000;
export const ERROR_BACKOFF_CAP_MS = 120_000;
export const MAX_OUTBOX = 200;

export function createRelayPoller({
  baseUrl,
  key,
  channel,
  role = 'desktop',
  onMessage = () => {},
  onStatus = () => {},
  fetchImpl = globalThis.fetch,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = () => Date.now(),
} = {}) {
  if (!baseUrl) throw new TypeError('relay poller needs a baseUrl');
  if (!key) throw new TypeError('relay poller needs a key');
  if (typeof fetchImpl !== 'function') throw new TypeError('no fetch available');

  let state = 'idle'; // idle | polling | stopped
  let cursor = 0;
  let timer = null;
  let hotUntil = 0;
  let errorDelay = 0;
  let presence = {};
  let polls = 0;
  const outbox = [];

  const headers = () => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' });
  const endpoint = (extra = {}) => {
    const u = new URL(baseUrl);
    u.searchParams.set('channel', channel);
    u.searchParams.set('role', role);
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, String(v));
    return u.toString();
  };

  function goHot() { hotUntil = now() + HOT_WINDOW_MS; }
  function interval() {
    if (errorDelay > 0) return errorDelay;
    return now() < hotUntil ? HOT_INTERVAL_MS : COLD_INTERVAL_MS;
  }

  function schedule(ms = interval()) {
    if (state === 'stopped') return;
    timer = setTimer(tick, ms);
  }

  async function tick() {
    if (state === 'stopped') return;
    polls += 1;

    // SEND FIRST. A line typed while the relay was unreachable should leave on
    // the next opportunity, not after one more poll interval of silence.
    await flush();
    if (state === 'stopped') return;

    let response;
    try {
      response = await fetchImpl(endpoint({ since: cursor }), { method: 'GET', headers: headers() });
    } catch (err) {
      failed(`could not reach the relay: ${err.message}`);
      return;
    }

    if (response.status === 401) {
      // Retrying a refused secret is not persistence, it is knocking on a
      // locked door until someone notices.
      state = 'stopped';
      onStatus({ state, terminal: true, reason: 'the relay refused the key — nothing will be retried' });
      return;
    }
    if (!response.ok) {
      failed(`relay answered ${response.status}${await reasonFrom(response)}`);
      return;
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      failed('the relay answered with something that was not JSON');
      return;
    }

    // A 200 that does not carry a usable cursor is not a successful poll.
    // Treating it as one would advance nothing and hide a broken deploy behind
    // a green status line.
    if (!payload || typeof payload !== 'object' || !Number.isSafeInteger(payload.cursor)) {
      failed('the relay answered without a cursor');
      return;
    }

    errorDelay = 0;
    state = 'polling';
    presence = payload.presence && typeof payload.presence === 'object' ? payload.presence : {};

    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    for (const m of messages) {
      // Validated here, not trusted. This came off the open internet.
      if (!m || typeof m.body !== 'string' || !Number.isSafeInteger(m.id)) continue;
      if (m.from === role) continue; // never show our own words as the other end's
      if (m.id > cursor) cursor = m.id;
      goHot();
      onMessage({ id: m.id, from: m.from, body: m.body, at: m.at });
    }
    // The server's cursor may be ahead of ours on a fresh start, and must never
    // move us backwards into replaying what we already showed.
    if (payload.cursor > cursor) cursor = payload.cursor;

    onStatus({ state, cursor, presence, polls, delivered: messages.length });

    // A TRUNCATED PAGE IS NOT AN EMPTY ONE. If the relay says there is more,
    // go straight back rather than sitting out the interval and trickling a
    // burst one page per poll.
    schedule(payload.more ? 0 : interval());
  }

  function failed(reason) {
    // The cursor is NOT advanced on a failure, which is what makes a retry
    // free: worst case the same rows come back and are shown once, because the
    // cursor only moves after they were handed over.
    errorDelay = errorDelay === 0 ? COLD_INTERVAL_MS : Math.min(errorDelay * 2, ERROR_BACKOFF_CAP_MS);
    onStatus({ state, cursor, presence, polls, error: reason, retryInMs: errorDelay });
    schedule(errorDelay);
  }

  async function flush() {
    while (outbox.length) {
      const text = outbox[0];
      let response;
      try {
        response = await fetchImpl(endpoint(), {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ body: text }),
        });
      } catch {
        return; // still unreachable — keep it and try on the next tick
      }
      if (response.status === 401) { state = 'stopped'; onStatus({ state, terminal: true, reason: 'the relay refused the key' }); return; }
      if (!response.ok) {
        // A 4xx that is not auth means this particular line will never be
        // accepted. Dropping it with a stated reason beats blocking the queue
        // behind it forever.
        if (response.status >= 400 && response.status < 500) {
          outbox.shift();
          onStatus({ state, cursor, presence, polls, rejected: `the relay refused a line (${response.status})` });
          continue;
        }
        return; // 5xx — server-side and probably temporary
      }
      outbox.shift();
      goHot();
    }
  }

  return {
    get state() { return state; },
    get cursor() { return cursor; },
    get pending() { return outbox.length; },
    get presence() { return presence; },
    get pollCount() { return polls; },
    get intervalMs() { return interval(); },

    start() {
      if (state === 'polling') return;
      state = 'idle';
      return tick();
    },

    send(text) {
      const body = String(text ?? '');
      if (!body.trim()) return { sent: false, reason: 'nothing to send' };
      if (body.length > MAX_BODY_CHARS) {
        return { sent: false, reason: `too long: ${body.length} of ${MAX_BODY_CHARS} chars` };
      }
      if (outbox.length >= MAX_OUTBOX) {
        return { sent: false, reason: `outbox is full (${MAX_OUTBOX}) — the relay has been unreachable too long` };
      }
      outbox.push(body);
      goHot();
      return { sent: false, queued: true, pending: outbox.length };
    },

    /** Send on the next tick rather than waiting out a cold interval. */
    wake() {
      if (state === 'stopped') return;
      goHot();
      if (timer) clearTimer(timer);
      schedule(0);
    },

    stop() {
      state = 'stopped';
      if (timer) clearTimer(timer);
      timer = null;
      onStatus({ state, cursor, polls, note: 'stopped locally' });
    },
  };
}

async function reasonFrom(response) {
  try {
    const text = await response.text();
    const parsed = JSON.parse(text);
    return parsed?.error ? ` — ${parsed.error}` : '';
  } catch {
    return '';
  }
}
