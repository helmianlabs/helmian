// One-time Helmian account enrollment for a Desktop installation.
// The Desktop generates both the human code and a separate high-entropy proof.
// The code is confirmed by a signed-in web account; only the Desktop holding
// the proof can redeem the resulting revocable registration credential.

import { randomBytes as nodeRandomBytes } from 'node:crypto';

function enrollmentEndpoint(origin) {
  const url = new URL('/api/herald-enrollment', origin);
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('Helmian account enrollment requires HTTPS.');
  }
  return url;
}

export function createDesktopEnrollmentIntent({ randomBytes = nodeRandomBytes } = {}) {
  const requestRandom = Buffer.from(randomBytes(18));
  const proofRandom = Buffer.from(randomBytes(32));
  const codeRandom = Buffer.from(randomBytes(4));
  if (requestRandom.length !== 18 || proofRandom.length !== 32 || codeRandom.length !== 4) {
    throw new Error('Desktop enrollment randomness is unavailable.');
  }
  try {
    return Object.freeze({
      enrollmentId: `enroll_${requestRandom.toString('base64url')}`,
      proofSecret: proofRandom.toString('base64url'),
      confirmationCode: String(codeRandom.readUInt32BE() % 100_000_000).padStart(8, '0'),
    });
  } finally {
    requestRandom.fill(0); proofRandom.fill(0); codeRandom.fill(0);
  }
}

export async function requestDesktopAccountEnrollment({
  origin,
  displayName = 'Helmian Desktop',
  intent = createDesktopEnrollmentIntent(),
  fetchImpl = fetch,
} = {}) {
  validateIntent(intent);
  const result = await postJson(fetchImpl, enrollmentEndpoint(origin), {
    action: 'request',
    enrollmentId: intent.enrollmentId,
    proofSecret: intent.proofSecret,
    confirmationCode: intent.confirmationCode,
    displayName,
  });
  return Object.freeze({
    state: 'awaiting-account-confirmation',
    intent,
    confirmationCode: intent.confirmationCode,
    confirmationRequired: true,
    expiresAt: result.expiresAt,
  });
}

export async function redeemDesktopAccountEnrollment({
  origin,
  intent,
  fetchImpl = fetch,
} = {}) {
  validateIntent(intent);
  try {
    const result = await postJson(fetchImpl, enrollmentEndpoint(origin), {
      action: 'redeem',
      enrollmentId: intent.enrollmentId,
      proofSecret: intent.proofSecret,
    });
    if (result.enrolled !== true || !validDesktopId(result.desktopId)
      || !validToken(result.registrationToken)) {
      throw new Error('Helmian returned an invalid Desktop registration.');
    }
    return Object.freeze({
      state: 'enrolled',
      registration: Object.freeze({
        version: 1,
        origin: new URL(origin).origin,
        desktopId: result.desktopId,
        displayName: String(result.displayName ?? 'Helmian Desktop').slice(0, 60),
        registrationToken: result.registrationToken,
        credentialExpiresAt: new Date(result.credentialExpiresAt).toISOString(),
      }),
    });
  } catch (error) {
    if (error?.status === 409 && error?.code === 'enrollment_pending') {
      return Object.freeze({ state: 'awaiting-account-confirmation', registration: null });
    }
    throw error;
  }
}

async function postJson(fetchImpl, url, body) {
  if (typeof fetchImpl !== 'function') throw new TypeError('Desktop enrollment needs fetch.');
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(value.message ?? 'Desktop enrollment request failed.'), {
      status: response.status,
      code: value.error,
    });
  }
  return value;
}

function validateIntent(value) {
  if (!/^enroll_[A-Za-z0-9_-]{20,80}$/.test(String(value?.enrollmentId ?? ''))
    || !validToken(value?.proofSecret) || !/^\d{8}$/.test(String(value?.confirmationCode ?? ''))) {
    throw new Error('Desktop enrollment intent is invalid.');
  }
}

function validDesktopId(value) {
  return /^desktop_[A-Za-z0-9_-]{20,80}$/.test(String(value ?? ''));
}

function validToken(value) {
  return /^[A-Za-z0-9_-]{43,128}$/.test(String(value ?? ''));
}
