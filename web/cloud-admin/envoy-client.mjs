const jsonHeaders = { 'content-type': 'application/json' };

async function requestJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, { credentials: 'same-origin', ...options });
  let body = null;
  try { body = await response.json(); } catch { /* bounded status-only error */ }
  if (!response.ok) throw new Error(body?.error || body?.code || `Envoy request failed (${response.status})`);
  return body ?? {};
}

export function createEnvoyClient({ fetchImpl = fetch } = {}) {
  return Object.freeze({
    async listChannels() {
      return requestJson(fetchImpl, '/api/admin/envoy/channels');
    },
    async listMessages(channelId) {
      const id = String(channelId ?? '').trim();
      if (!id) return { messages: [] };
      return requestJson(fetchImpl, `/api/admin/envoy/messages?channel_id=${encodeURIComponent(id)}`);
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

