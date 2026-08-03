import {
  bearer, fail, hashPairingCode, hashSecret, randomChannel, randomPairingCode,
  randomToken, readJson, requiredSecret, safeEqualHash, sendJson, validId,
} from './_herald-core.js';
import {
  addMessage, cleanupExpired, createSession, listDevices, messagesAfter,
  revokeDevice, sessionForDesktop, stopSession,
} from './_herald-store.js';

const SESSION_SECONDS = 8 * 60 * 60;
const PAIRING_SECONDS = 10 * 60;

export default async function handler(request, response) {
  try {
    const body = request.method === 'GET' ? {} : await readJson(request);
    const ownerSecret = requiredSecret('HELMION_HERALD_OWNER_SECRET');
    const pepper = requiredSecret('HELMION_HERALD_PAIRING_PEPPER');

    if (request.method === 'POST' && body.action === 'start') {
      if (!safeEqualHash(hashSecret(bearer(request)), hashSecret(ownerSecret))) {
        sendJson(response, 401, { error: 'owner_denied', message: 'Desktop enrollment was refused.' });
        return;
      }
      const channel = randomChannel();
      const desktopToken = randomToken();
      const pairingCode = randomPairingCode();
      const now = Date.now();
      await createSession({
        channel, desktopTokenHash: hashSecret(desktopToken),
        pairingCodeHash: hashPairingCode(channel, pairingCode, pepper),
        pairingExpiresAt: new Date(now + PAIRING_SECONDS * 1000),
        expiresAt: new Date(now + SESSION_SECONDS * 1000),
      });
      void cleanupExpired().catch(() => {});
      sendJson(response, 201, {
        channel, desktopToken, pairingCode,
        pairingExpiresAt: new Date(now + PAIRING_SECONDS * 1000).toISOString(),
        expiresAt: new Date(now + SESSION_SECONDS * 1000).toISOString(),
        phoneUrl: `https://${request.headers.host}/herald/?channel=${encodeURIComponent(channel)}`,
      });
      return;
    }

    const url = new URL(request.url, `https://${request.headers.host}`);
    const channel = String(body.channel ?? url.searchParams.get('channel') ?? '');
    if (!/^herald_[A-Za-z0-9_-]{20,80}$/.test(channel)) {
      sendJson(response, 400, { error: 'invalid_channel', message: 'Herald channel is invalid.' }); return;
    }
    const desktopToken = bearer(request);

    if (request.method === 'GET') {
      await sessionForDesktop(channel, desktopToken);
      const after = Math.max(0, Number(url.searchParams.get('after') ?? 0) || 0);
      const [messages, devices] = await Promise.all([
        messagesAfter(channel, 'phone', after), listDevices(channel, desktopToken),
      ]);
      sendJson(response, 200, { messages, cursor: messages.at(-1)?.id ?? after, devices }); return;
    }
    if (request.method === 'POST' && body.action === 'result') {
      await sessionForDesktop(channel, desktopToken);
      const { validateDesktopResult } = await import('./_herald-core.js');
      const result = validateDesktopResult(body.result);
      await addMessage(channel, 'desktop', result.requestId, result);
      sendJson(response, 202, { accepted: true }); return;
    }
    if (request.method === 'POST' && body.action === 'revoke' && validId(body.deviceId)) {
      await revokeDevice(channel, desktopToken, body.deviceId);
      sendJson(response, 200, { revoked: true, deviceId: body.deviceId }); return;
    }
    if (request.method === 'DELETE' || (request.method === 'POST' && body.action === 'stop')) {
      await stopSession(channel, desktopToken);
      sendJson(response, 200, { stopped: true }); return;
    }
    sendJson(response, 405, { error: 'method_not_allowed' }, { allow: 'GET, POST, DELETE' });
  } catch (error) { fail(response, error); }
}
