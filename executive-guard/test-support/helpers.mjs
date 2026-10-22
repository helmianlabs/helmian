import { createHash, randomBytes } from 'node:crypto';
import { memoryAudit } from '../src/audit.mjs';
import { createExecutiveGuard } from '../src/server.mjs';
import { generateSigningKey, loadSigningKey } from '../src/signing.mjs';

export const DEVICE_TOKEN = 'device-token-aaaaaaaaaaaaaaaaaaaaaaaa';
export const OTHER_DEVICE_TOKEN = 'device-token-bbbbbbbbbbbbbbbbbbbbbbbb';
export const APPROVER_TOKEN = 'approver-token-cccccccccccccccccccccc';

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function nonce() {
  return randomBytes(18).toString('base64url');
}

export async function startGuard(options = {}) {
  const key = loadSigningKey(generateSigningKey());
  const audit = options.audit || memoryAudit({ now: options.now });
  const guard = createExecutiveGuard({
    key,
    audit,
    deviceTokens: { 'troy-laptop': DEVICE_TOKEN, 'other-device': OTHER_DEVICE_TOKEN },
    approverTokens: { troy: APPROVER_TOKEN },
    ...options,
  });
  await new Promise((resolve) => guard.server.listen(0, '127.0.0.1', resolve));
  const { port } = guard.server.address();
  const base = `http://127.0.0.1:${port}`;
  async function call(method, path, { token, body, headers = {} } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    let json = null;
    try { json = await response.json(); } catch { json = null; }
    return { status: response.status, body: json, headers: response.headers };
  }
  return { ...guard, key, audit, base, call, close: () => new Promise((r) => guard.server.close(r)) };
}

export function action(overrides = {}) {
  return {
    kind: 'prompt.send',
    site: 'chatgpt.com',
    contentHash: sha256('hello world'),
    riskSignals: [],
    summary: 'hello world',
    ...overrides,
  };
}
