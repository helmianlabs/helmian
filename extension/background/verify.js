// Verifies Executive Guard decisions inside the extension with WebCrypto.
//
// A decision is trusted only if ALL of these hold:
//   - the Ed25519 signature verifies against the key pinned at pairing time,
//   - the key id matches the pinned key id,
//   - the audience is the Executive Guard decision audience,
//   - it has not expired (60 s clock-skew allowance),
//   - its actionHash equals the hash of the action THIS extension asked about,
//   - its nonce equals the nonce THIS extension sent.
// Anything else is treated as no decision at all.
//
// canonicalJson and actionHash here must produce the same bytes as
// executive-guard/src/canonical.mjs and action.mjs; test/verify.test.mjs pins
// that against the real server modules.

export const DECISION_AUDIENCE = 'helmian-executive-guard-decision-v1';
const CLOCK_SKEW_SECONDS = 60;

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (value === undefined) return 'null';
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function bytesToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64urlToBytes(text) {
  const b64 = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function sha256Hex(text) {
  const data = new TextEncoder().encode(String(text));
  return bytesToHex(await crypto.subtle.digest('SHA-256', data));
}

/** Same as executive-guard actionHash(normalizeAction(action)) for a well-formed action. */
export async function actionHash(action) {
  const riskSignals = [...new Set((action.riskSignals || []).map((s) => String(s).toLowerCase()))].sort();
  return sha256Hex(canonicalJson({
    kind: action.kind,
    site: String(action.site).toLowerCase(),
    contentHash: String(action.contentHash).toLowerCase(),
    riskSignals,
    target: action.target == null ? undefined : String(action.target).toLowerCase(),
  }));
}

export function randomNonce() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function verifyDecisionEnvelope(envelope, pinned, expect, { now = Date.now() } = {}) {
  try {
    if (!envelope || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') {
      return { ok: false, error: 'malformed decision' };
    }
    if (!pinned || !pinned.publicKeyJwk || !pinned.keyId) return { ok: false, error: 'no pinned key' };
    if (envelope.keyId !== pinned.keyId) return { ok: false, error: 'decision signed by an unpinned key' };
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'OKP', crv: 'Ed25519', x: pinned.publicKeyJwk.x },
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const good = await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      base64urlToBytes(envelope.signature),
      new TextEncoder().encode(envelope.payload),
    );
    if (!good) return { ok: false, error: 'bad signature' };
    const claims = JSON.parse(new TextDecoder().decode(base64urlToBytes(envelope.payload)));
    if (claims.aud !== DECISION_AUDIENCE) return { ok: false, error: 'wrong audience' };
    if (typeof claims.exp !== 'number' || (claims.exp + CLOCK_SKEW_SECONDS) * 1000 < now) return { ok: false, error: 'expired' };
    if (expect && expect.actionHash && claims.actionHash !== expect.actionHash) return { ok: false, error: 'decision is for a different action' };
    if (expect && expect.nonce && claims.nonce !== expect.nonce) return { ok: false, error: 'decision is for a different request' };
    if (!['allow', 'deny', 'ask'].includes(claims.verdict)) return { ok: false, error: 'unknown verdict' };
    return { ok: true, claims };
  } catch (error) {
    return { ok: false, error: `verification failed: ${error && error.message ? error.message : String(error)}` };
  }
}
