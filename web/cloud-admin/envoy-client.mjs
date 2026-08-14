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
    openMessageStream(channelId, { afterId = null, EventSourceImpl = globalThis.EventSource, onOpen = () => {}, onMessage = () => {}, onError = () => {} } = {}) {
      const id = String(channelId ?? '').trim();
      if (!id) return null;
      if (typeof EventSourceImpl !== 'function') throw new Error('Envoy realtime is unavailable');
      const cursor = afterId ? `&after_id=${encodeURIComponent(afterId)}` : '';
      const source = new EventSourceImpl(`/api/admin/envoy/stream?channel_id=${encodeURIComponent(id)}${cursor}`);
      source.onopen = () => onOpen();
      source.addEventListener('message', (event) => {
        try { onMessage(JSON.parse(event.data)); } catch { onError(Object.assign(new Error('Envoy realtime message was invalid'), { status: 502 })); }
      });
      source.addEventListener('envoy_error', (event) => {
        let body = null; try { body = JSON.parse(event.data); } catch { /* bounded error event */ }
        onError(Object.assign(new Error(body?.code ?? 'Envoy realtime stream failed'), { status: body?.retryable === false ? 403 : 503, code: body?.code }));
      });
      source.onerror = () => onError(Object.assign(new Error('Envoy realtime connection failed'), { status: 503 }));
      return Object.freeze({ close: () => source.close?.() });
    },
  });
}
