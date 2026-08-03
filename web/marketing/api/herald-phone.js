import {
  clearDeviceCookie, fail, parseDeviceCookie, readJson, sendJson,
  validateNonce, validatePhoneAction,
} from './_herald-core.js';
import {
  publicDeviceIdentity, publicTransportStatus,
} from './_herald-identity.js';
import { isAblyConfigured } from './_herald-realtime.js';
import { addMessage, authorizeDevice, messagesAfter } from './_herald-store.js';

const ACTION_SCOPE = Object.freeze({
  'session.read': 'session:read',
  'instruction.submit': 'session:instruct',
  'approval.decide': 'approval:decide',
});

const LEGACY_PAIRING_IDENTITY = Object.freeze({
  state: 'unconfigured', provider: null, subject: null, displayName: null,
});

export default async function handler(request, response) {
  try {
    const identity = parseDeviceCookie(request);
    if (!identity) {
      sendJson(response, 401, { error: 'device_denied', message: 'Pair this phone from Helmian Desktop.' }, { 'set-cookie': clearDeviceCookie() });
      return;
    }
    const nonce = validateNonce(request.headers['x-helmian-nonce']);
    if (request.method === 'GET') {
      const device = await authorizeDevice({ ...identity, scope: 'session:read', nonce });
      const url = new URL(request.url, `https://${request.headers.host}`);
      const after = Math.max(0, Number(url.searchParams.get('after') ?? 0) || 0);
      const messages = await messagesAfter(identity.channel, 'desktop', after);
      sendJson(response, 200, {
        messages,
        cursor: messages.at(-1)?.id ?? after,
        // This route is retained only for legacy pairing. It never infers or
        // claims Clerk ownership; account Remote Control uses /herald-desktops.
        identity: { account: LEGACY_PAIRING_IDENTITY, device: publicDeviceIdentity(device) },
        transport: publicTransportStatus(device, { realtimeConfigured: isAblyConfigured() }),
      }); return;
    }
    if (request.method === 'POST') {
      const body = await readJson(request);
      const action = String(body?.action ?? '');
      const scope = ACTION_SCOPE[action];
      if (!scope) { sendJson(response, 404, { error: 'action_not_available', message: 'That action is not available from Herald.' }); return; }
      await authorizeDevice({ ...identity, scope, nonce });
      const envelope = validatePhoneAction(body, identity.deviceId);
      await addMessage(identity.channel, 'phone', envelope.requestId, envelope);
      sendJson(response, 202, { accepted: true, requestId: envelope.requestId }); return;
    }
    sendJson(response, 405, { error: 'method_not_allowed' }, { allow: 'GET, POST' });
  } catch (error) {
    if (Number(error?.status) === 401) response.setHeader('set-cookie', clearDeviceCookie());
    fail(response, error);
  }
}
