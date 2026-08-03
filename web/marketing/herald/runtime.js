export const ACCOUNT_IDENTITY_STATES = Object.freeze({
  UNCONFIGURED: 'unconfigured',
  SIGNED_OUT: 'signed-out',
  VERIFIED: 'verified',
  UNAVAILABLE: 'unavailable',
});

export const CONNECTION_STATES = Object.freeze({
  NOT_PAIRED: 'not-paired',
  CONNECTING: 'connecting',
  PAIRED: 'paired',
  SYNCING: 'syncing',
  LIVE: 'live',
  RECONNECTING: 'reconnecting',
  NETWORK_OFFLINE: 'network-offline',
  RELAY_UNAVAILABLE: 'relay-unavailable',
  DESKTOP_OFFLINE: 'desktop-offline',
  DENIED: 'denied',
});

export const DELIVERY_STATES = Object.freeze({
  QUEUED: 'queued',
  DELAYED: 'delayed',
  DELIVERED: 'delivered',
  REFUSED: 'refused',
  FAILED: 'failed',
});

const ACCOUNT_STATE = new Set(Object.values(ACCOUNT_IDENTITY_STATES));
const TERMINAL_DELIVERY = new Set([
  DELIVERY_STATES.DELIVERED,
  DELIVERY_STATES.REFUSED,
  DELIVERY_STATES.FAILED,
]);

export function normalizeAccountIdentity(value) {
  const state = ACCOUNT_STATE.has(value?.state)
    ? value.state
    : ACCOUNT_IDENTITY_STATES.UNAVAILABLE;
  return Object.freeze({
    state,
    provider: state === ACCOUNT_IDENTITY_STATES.VERIFIED ? cleanText(value?.provider, 48) : null,
    subject: state === ACCOUNT_IDENTITY_STATES.VERIFIED ? cleanText(value?.subject, 128) : null,
    displayName: state === ACCOUNT_IDENTITY_STATES.VERIFIED ? cleanText(value?.displayName, 80) : null,
  });
}

export function describeAccountIdentity(identity) {
  const safe = normalizeAccountIdentity(identity);
  if (safe.state === ACCOUNT_IDENTITY_STATES.VERIFIED) {
    return safe.displayName ? `Signed in as ${safe.displayName}` : 'Account identity verified';
  }
  if (safe.state === ACCOUNT_IDENTITY_STATES.SIGNED_OUT) return 'Account sign-in required';
  if (safe.state === ACCOUNT_IDENTITY_STATES.UNCONFIGURED) {
    return 'Account sign-in is not configured; access is desktop-pairing only.';
  }
  return 'Account identity is unavailable.';
}

export function createSameOriginPollingAdapter({
  fetchImpl = globalThis.fetch,
  endpoint = '/api/herald-phone',
  nonceFactory = defaultNonce,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');

  async function request(path, options = {}) {
    const response = await fetchImpl(path, {
      ...options,
      credentials: 'same-origin',
      headers: {
        'x-helmian-nonce': nonceFactory(),
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(body.message || 'Herald request failed.'), {
        status: response.status,
        code: body.error,
        body,
      });
    }
    return body;
  }

  return Object.freeze({
    id: 'same-origin-secure-polling',
    realtime: false,
    credentialMode: 'http-only-cookie',
    async poll(after = 0) {
      const cursor = Math.max(0, Number(after) || 0);
      return request(`${endpoint}?after=${encodeURIComponent(cursor)}`);
    },
    async send(envelope) {
      return request(endpoint, { method: 'POST', body: JSON.stringify(envelope) });
    },
  });
}

export function createHeraldTransport({
  adapter,
  pollIntervalMs = 2500,
  schedule = globalThis.setTimeout,
  cancelSchedule = globalThis.clearTimeout,
  isNetworkOnline = () => globalThis.navigator?.onLine !== false,
  onBatch = () => {},
  onState = () => {},
} = {}) {
  if (!adapter || typeof adapter.poll !== 'function' || typeof adapter.send !== 'function') {
    throw new TypeError('Herald transport needs a poll/send adapter.');
  }

  let cursor = 0;
  let timer = null;
  let stopped = true;
  let hasConnected = false;
  let state = CONNECTION_STATES.NOT_PAIRED;

  function setState(next, detail = null) {
    state = next;
    onState(Object.freeze({
      state: next,
      detail,
      adapter: adapter.id ?? 'custom',
      realtime: adapter.realtime === true,
      credentialMode: adapter.credentialMode ?? 'unspecified',
    }));
  }

  function classifyError(error) {
    if (error?.status === 401) return CONNECTION_STATES.DENIED;
    if (!isNetworkOnline()) return CONNECTION_STATES.NETWORK_OFFLINE;
    if (error?.status === 503 || error?.code === 'desktop_offline') {
      return CONNECTION_STATES.DESKTOP_OFFLINE;
    }
    return hasConnected ? CONNECTION_STATES.RECONNECTING : CONNECTION_STATES.RELAY_UNAVAILABLE;
  }

  async function pollOnce({ requestSession = false } = {}) {
    if (requestSession) {
      await send('session.read');
      setState(CONNECTION_STATES.SYNCING);
    }
    try {
      const batch = await adapter.poll(cursor);
      cursor = Math.max(cursor, Number(batch?.cursor) || cursor);
      hasConnected = true;
      setState(CONNECTION_STATES.PAIRED);
      const outcome = await onBatch(batch ?? { messages: [], cursor });
      if (outcome?.live === true) setState(CONNECTION_STATES.LIVE);
      return batch;
    } catch (error) {
      setState(classifyError(error), error?.message ?? null);
      throw error;
    }
  }

  async function loop() {
    if (stopped) return;
    try { await pollOnce(); } catch { /* State is emitted above; retry remains bounded. */ }
    if (!stopped) timer = schedule(loop, pollIntervalMs);
  }

  async function start({ requestSession = true } = {}) {
    stopped = false;
    setState(CONNECTION_STATES.CONNECTING);
    try { await pollOnce({ requestSession }); }
    finally {
      if (!stopped && state !== CONNECTION_STATES.DENIED) {
        cancelSchedule(timer);
        timer = schedule(loop, pollIntervalMs);
      }
    }
  }

  async function send(action, payload = {}) {
    const requestId = globalThis.crypto?.randomUUID?.() ?? defaultNonce();
    try {
      const accepted = await adapter.send({ requestId, action, payload });
      hasConnected = true;
      return Object.freeze({ requestId, action, accepted: accepted?.accepted === true });
    } catch (error) {
      setState(classifyError(error), error?.message ?? null);
      throw error;
    }
  }

  function stop() {
    stopped = true;
    cancelSchedule(timer);
    timer = null;
    setState(CONNECTION_STATES.NOT_PAIRED);
  }

  function setNetworkAvailable(available) {
    if (!available) {
      setState(CONNECTION_STATES.NETWORK_OFFLINE);
      return;
    }
    if (state === CONNECTION_STATES.NETWORK_OFFLINE) {
      setState(CONNECTION_STATES.CONNECTING);
      if (!stopped) void pollOnce().catch(() => {});
    }
  }

  return Object.freeze({
    adapter: Object.freeze({
      id: adapter.id ?? 'custom',
      realtime: adapter.realtime === true,
      credentialMode: adapter.credentialMode ?? 'unspecified',
    }),
    get state() { return state; },
    get cursor() { return cursor; },
    start,
    stop,
    pollOnce,
    send,
    setNetworkAvailable,
  });
}

export function createDeliveryTracker({ now = Date.now, delayedAfterMs = 30_000, initial = [] } = {}) {
  const deliveries = new Map();

  for (const value of Array.isArray(initial) ? initial : []) {
    const requestId = cleanRequestId(value?.requestId);
    const action = ['instruction.submit', 'approval.decide'].includes(value?.action) ? value.action : null;
    const state = [DELIVERY_STATES.QUEUED, DELIVERY_STATES.DELAYED].includes(value?.state)
      ? value.state
      : null;
    const queuedAt = Number(value?.queuedAt);
    if (!requestId || !action || !state || !Number.isFinite(queuedAt) || queuedAt < 0) continue;
    deliveries.set(requestId, Object.freeze({
      requestId,
      action,
      state,
      queuedAt,
      updatedAt: Number.isFinite(Number(value?.updatedAt)) ? Number(value.updatedAt) : queuedAt,
      message: state === DELIVERY_STATES.DELAYED
        ? 'Still waiting for Helmian Desktop; delivery is not confirmed.'
        : 'Accepted by the secure relay; waiting for Helmian Desktop.',
    }));
  }

  function queued(requestId, action) {
    const item = Object.freeze({
      requestId,
      action,
      state: DELIVERY_STATES.QUEUED,
      queuedAt: now(),
      updatedAt: now(),
      message: 'Accepted by the secure relay; waiting for Helmian Desktop.',
    });
    deliveries.set(requestId, item);
    return item;
  }

  function settle(result) {
    const existing = deliveries.get(result?.requestId);
    if (!existing || TERMINAL_DELIVERY.has(existing.state)) return existing ?? null;
    const state = result?.state === 'ok'
      ? DELIVERY_STATES.DELIVERED
      : result?.state === 'refused'
        ? DELIVERY_STATES.REFUSED
        : DELIVERY_STATES.FAILED;
    const fallback = state === DELIVERY_STATES.DELIVERED
      ? 'Acknowledged by Helmian Desktop.'
      : state === DELIVERY_STATES.REFUSED
        ? 'Refused by Helmian Desktop.'
        : 'Helmian Desktop reported a delivery error.';
    const item = Object.freeze({
      ...existing,
      state,
      updatedAt: now(),
      message: cleanText(
        result?.payload?.message ?? result?.payload?.Message ?? result?.Payload?.message ?? result?.Payload?.Message,
        240,
      ) || fallback,
    });
    deliveries.set(existing.requestId, item);
    return item;
  }

  function list() {
    const current = now();
    return [...deliveries.values()].map((item) => {
      if (item.state !== DELIVERY_STATES.QUEUED || current - item.queuedAt < delayedAfterMs) return item;
      const delayed = Object.freeze({
        ...item,
        state: DELIVERY_STATES.DELAYED,
        updatedAt: current,
        message: 'Still waiting for Helmian Desktop; delivery is not confirmed.',
      });
      deliveries.set(item.requestId, delayed);
      return delayed;
    }).sort((a, b) => b.queuedAt - a.queuedAt);
  }

  function exportPending() {
    return [...deliveries.values()]
      .filter((item) => !TERMINAL_DELIVERY.has(item.state))
      .map(({ requestId, action, state, queuedAt, updatedAt }) => ({
        requestId, action, state, queuedAt, updatedAt,
      }));
  }

  function clear() {
    deliveries.clear();
  }

  return Object.freeze({ queued, settle, list, exportPending, clear });
}

function cleanText(value, maxLength) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, maxLength) : null;
}

function defaultNonce() {
  const id = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${id}-${Date.now()}`;
}

function cleanRequestId(value) {
  const text = typeof value === 'string' ? value : '';
  return /^[A-Za-z0-9._:-]{1,128}$/.test(text) ? text : null;
}
