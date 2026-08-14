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
  });
}
