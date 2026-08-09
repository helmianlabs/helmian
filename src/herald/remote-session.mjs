// Desktop-owned, outbound-only Herald session over the first-party Helmian relay.
// No listener is opened on the computer. The relay can request only the closed
// actions below, and the local Desktop gateway rechecks current project/session.

import { sanitizeSessionSnapshot } from './relay-bridge.mjs';

const ALLOWED_ACTIONS = new Set(['session.read', 'instruction.submit', 'approval.decide']);

function endpoint(origin) {
  const url = new URL('/api/herald-session', origin);
  if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new Error('Remote Herald requires HTTPS.');
  }
  return url;
}

async function jsonRequest(fetchImpl, url, { method = 'GET', token, body } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(value.message ?? 'Remote Herald request failed.'), { status: response.status });
  return value;
}

export async function dispatchRemoteRequest(request, desktopBridge) {
  if (request?.v !== 1 || request?.product !== 'helmian-herald' || request?.kind !== 'request'
    || !ALLOWED_ACTIONS.has(request?.action) || typeof request?.requestId !== 'string'
    || typeof request?.deviceId !== 'string') {
    return { state: 'refused', payload: { message: 'The remote request envelope was invalid.' } };
  }
  if (!await desktopBridge.isAvailable()) {
    return { state: 'refused', payload: { message: 'Helmian Desktop is unavailable.' } };
  }
  try {
    if (request.action === 'session.read') {
      const snapshot = sanitizeSessionSnapshot(await desktopBridge.getSessionContext({ deviceId: request.deviceId }));
      return { state: 'ok', payload: { ...snapshot, capturedAt: new Date().toISOString() } };
    }
    if (request.action === 'instruction.submit') {
      const input = request.payload ?? {};
      if (input.confirmed !== true) return { state: 'refused', payload: { message: 'Explicit confirmation is required.' } };
      const result = await desktopBridge.submitInstruction({
        id: request.requestId, kind: 'user_instruction', deviceId: request.deviceId,
        projectId: input.projectId, sessionId: input.sessionId, text: input.text,
        confirmed: true, submittedAt: new Date().toISOString(),
      });
      return { state: result?.accepted === true ? 'ok' : 'refused', payload: result ?? { message: 'Desktop refused the instruction.' } };
    }
    const input = request.payload ?? {};
    if (input.confirmed !== true) return { state: 'refused', payload: { message: 'Explicit confirmation is required.' } };
    const result = await desktopBridge.decideApproval({
      id: request.requestId, deviceId: request.deviceId,
      projectId: input.projectId, sessionId: input.sessionId,
      approvalId: input.approvalId, decision: input.decision,
      confirmed: true, decidedAt: new Date().toISOString(),
    });
    return { state: result?.accepted === true ? 'ok' : 'refused', payload: result ?? { message: 'Desktop refused the decision.' } };
  } catch {
    return { state: 'error', payload: { message: 'Helmian Desktop could not complete the request.' } };
  }
}

export async function startRemoteHeraldSession({
  origin, ownerSecret, desktopBridge, fetchImpl = fetch,
  pollIntervalMs = 2_500, setTimer = setTimeout, clearTimer = clearTimeout,
  onStatus = () => {}, onRequest = () => {},
} = {}) {
  if (!desktopBridge) throw new TypeError('Remote Herald needs the desktop gateway.');
  if (String(ownerSecret ?? '').length < 32) throw new Error('Remote Herald owner enrollment is not configured.');
  const api = endpoint(origin);
  const started = await jsonRequest(fetchImpl, api, { method: 'POST', token: ownerSecret, body: { action: 'start' } });
  let cursor = 0, stopped = false, timer = null, polling = false;

  async function sendResult(request, outcome) {
    await jsonRequest(fetchImpl, api, {
      method: 'POST', token: started.desktopToken,
      body: { action: 'result', channel: started.channel, result: {
        v: 1, product: 'helmian-herald', kind: 'result', requestId: request.requestId,
        state: outcome.state, payload: outcome.payload,
      } },
    });
  }
  async function pollOnce() {
    if (stopped || polling) return;
    polling = true;
    try {
      const url = new URL(api); url.searchParams.set('channel', started.channel); url.searchParams.set('after', String(cursor));
      const page = await jsonRequest(fetchImpl, url, { token: started.desktopToken });
      for (const message of page.messages ?? []) {
        const outcome = await dispatchRemoteRequest(message.body, desktopBridge);
        await sendResult(message.body, outcome);
        onRequest({ action: message.body?.action, state: outcome.state });
      }
      cursor = Number(page.cursor ?? cursor);
      onStatus({ state: 'connected', devices: page.devices ?? [], cursor });
    } catch (error) { onStatus({ state: error.status === 401 ? 'stopped' : 'offline', message: error.message }); }
    finally {
      polling = false;
      if (!stopped) timer = setTimer(pollOnce, pollIntervalMs);
    }
  }
  timer = setTimer(pollOnce, 0);
  return {
    channel: started.channel, phoneUrl: started.phoneUrl, pairingCode: started.pairingCode,
    pairingExpiresAt: started.pairingExpiresAt, expiresAt: started.expiresAt,
    pollNow: pollOnce,
    async stop() {
      if (stopped) return;
      stopped = true; clearTimer(timer);
      await jsonRequest(fetchImpl, api, { method: 'DELETE', token: started.desktopToken, body: { channel: started.channel } }).catch(() => {});
      onStatus({ state: 'stopped' });
    },
  };
}
