import {
  clearDeviceCookie, deviceCookie, fail, hashPairingCode, hashSecret,
  randomToken, readJson, requiredSecret, sendJson,
} from './_herald-core.js';
import { pairDevice } from './_herald-store.js';

const DEVICE_SECONDS = 8 * 60 * 60;

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'method_not_allowed' }, { allow: 'POST' }); return;
  }
  try {
    const body = await readJson(request);
    const channel = String(body.channel ?? '');
    const code = String(body.code ?? '').replace(/\D/g, '');
    if (!/^herald_[A-Za-z0-9_-]{20,80}$/.test(channel) || !/^\d{8}$/.test(code)) {
      sendJson(response, 400, { error: 'invalid_pairing', message: 'Enter the 8-digit code shown by Helmian Desktop.' }); return;
    }
    const deviceId = `phone_${randomToken(12)}`;
    const token = randomToken();
    const displayName = String(body.displayName ?? 'Paired phone').trim().slice(0, 60) || 'Paired phone';
    const pepper = requiredSecret('HELMION_HERALD_PAIRING_PEPPER');
    const expiresAt = new Date(Date.now() + DEVICE_SECONDS * 1000);
    await pairDevice({
      channel, pairingCodeHash: hashPairingCode(channel, code, pepper), deviceId,
      tokenHash: hashSecret(token), displayName,
      scopes: ['status:read', 'session:read', 'session:instruct', 'approval:decide'], expiresAt,
    });
    sendJson(response, 201, { paired: true, deviceId, expiresAt: expiresAt.toISOString() }, {
      'set-cookie': deviceCookie(channel, deviceId, token, DEVICE_SECONDS),
    });
  } catch (error) {
    if (Number(error?.status) === 401) response.setHeader('set-cookie', clearDeviceCookie());
    fail(response, error);
  }
}
