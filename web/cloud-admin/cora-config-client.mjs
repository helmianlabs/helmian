async function requestJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, { credentials: 'same-origin', ...options });
  let body = {};
  try { body = await response.json(); } catch { /* bounded error response */ }
  if (!response.ok) {
    const error = new Error(body.code || `Cora settings request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return body;
}

export function createCoraConfigClient({ fetchImpl = fetch } = {}) {
  return Object.freeze({
    readConfig() { return requestJson(fetchImpl, '/api/admin/cora/config'); },
    readKnowledgeSources() { return requestJson(fetchImpl, '/api/admin/cora/knowledge-sources'); },
    createDraft({ reason }) {
      return requestJson(fetchImpl, '/api/admin/cora/configs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          config: { style: 'professional_brief', maxSpokenChars: 900, interruptMode: 'barge_in', turnMode: 'concise' },
          reason, provenance: { source: 'cloud-admin-ui', providerCall: 'not_performed' },
        }),
      });
    },
    transition({ id, lifecycle, reason }) {
      return requestJson(fetchImpl, '/api/admin/cora/configs/transition', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, lifecycle, reason }),
      });
    },
  });
}

