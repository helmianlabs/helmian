const jsonHeaders = { 'content-type': 'application/json' };

async function requestJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, { credentials: 'same-origin', ...options });
  let body = null;
  try { body = await response.json(); } catch { /* bounded status-only error */ }
  if (!response.ok) {
    const error = new Error(body?.error || body?.code || `Envoy request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return body ?? {};
}

export function createEnvoyClient({ fetchImpl = fetch } = {}) {
  return Object.freeze({
    async listChannels() {
      return requestJson(fetchImpl, '/api/admin/envoy/channels');
    },
    async listMessages(channelId, { afterId = null } = {}) {
      const id = String(channelId ?? '').trim();
      if (!id) return { messages: [] };
      const cursor = afterId ? `&after_id=${encodeURIComponent(afterId)}` : '';
      return requestJson(fetchImpl, `/api/admin/envoy/messages?channel_id=${encodeURIComponent(id)}${cursor}`);
    },
    async sendMessage({ channelId, body, idempotencyKey }) {
      return requestJson(fetchImpl, '/api/admin/envoy/messages', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ channelId, body, idempotencyKey }),
      });
    },
    openMessageStream(channelId, { afterId = null, EventSourceImpl = globalThis.EventSource, onOpen = () => {}, onMessage = () => {}, onStatus = () => {}, onError = () => {}, retryBaseMs = 500, retryMaxMs = 8000, maxRetries = 5, setTimeoutImpl = globalThis.setTimeout, clearTimeoutImpl = globalThis.clearTimeout } = {}) {
      const id = String(channelId ?? '').trim();
      if (!id) return null;
      if (typeof EventSourceImpl !== 'function') throw new Error('Envoy realtime is unavailable');
      let cursor = afterId ? String(afterId) : null;
      let source = null;
      let retryTimer = null;
      let retryCount = 0;
      let closed = false;
      const status = (value, detail = {}) => onStatus(value, Object.freeze({ ...detail, cursor }));
      const stopSource = () => { source?.close?.(); source = null; };
      const fatal = (error) => { if (closed) return; closed = true; if (retryTimer) clearTimeoutImpl?.(retryTimer); retryTimer = null; stopSource(); onError(error); };
      const reconnect = (reason) => {
        if (closed || retryTimer) return;
        if (retryCount >= Math.max(0, Number(maxRetries))) {
          fatal(Object.assign(new Error('Envoy realtime retry limit reached'), { status: 503, code: 'ENVOY_REALTIME_RETRY_EXHAUSTED', reason }));
          return;
        }
        const delay = Math.min(Math.max(0, Number(retryMaxMs)), Math.max(0, Number(retryBaseMs)) * (2 ** retryCount));
        retryCount += 1;
        stopSource();
        status('reconnecting', { delay, reason, attempt: retryCount });
        retryTimer = setTimeoutImpl(() => { retryTimer = null; connect(); }, delay);
      };
      const connect = () => {
        if (closed) return;
        const cursorQuery = cursor ? `&after_id=${encodeURIComponent(cursor)}` : '';
        source = new EventSourceImpl(`/api/admin/envoy/stream?channel_id=${encodeURIComponent(id)}${cursorQuery}`);
        source.onopen = () => { retryCount = 0; status('connected'); onOpen(); };
        source.addEventListener('message', (event) => {
          try {
            const message = JSON.parse(event.data);
            if (!message || typeof message !== 'object' || !message.id) throw new Error('message id missing');
            cursor = String(message.id);
            onMessage(message);
          } catch { status('stale', { reason: 'invalid_message' }); reconnect('invalid_message'); }
        });
        source.addEventListener('envoy_error', (event) => {
          let body = null; try { body = JSON.parse(event.data); } catch { /* bounded error event */ }
          const error = Object.assign(new Error(body?.code ?? 'Envoy realtime stream failed'), { status: body?.retryable === false ? 403 : 503, code: body?.code });
          if (body?.retryable === false || body?.code === 'ENVOY_MEMBERSHIP_REVOKED') { status('revoked', { reason: error.code }); fatal(error); return; }
          status('stale', { reason: error.code ?? 'stream_error' }); reconnect(error.code ?? 'stream_error');
        });
        source.onerror = () => { status('stale', { reason: 'connection' }); reconnect('connection'); };
      };
      connect();
      return Object.freeze({ close: () => { if (closed) return; closed = true; if (retryTimer) clearTimeoutImpl?.(retryTimer); retryTimer = null; stopSource(); } });
    },
  });
}
