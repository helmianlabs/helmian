// Ed25519-signed decisions. A decision is a small claims object; the signed
// envelope is { payload, signature, keyId } where payload is the base64url of
// the canonical JSON of the claims. Clients verify with the public key from
// GET /v1/keys, pinned at pairing time.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { canonicalJson, base64url, fromBase64url } from './canonical.mjs';

export const DECISION_AUDIENCE = 'helmian-executive-guard-decision-v1';
export const DECISION_TTL_SECONDS = 300;

export function generateSigningKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ type: 'pkcs8', format: 'pem' });
}

export function loadSigningKey(pem) {
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('signing key must be Ed25519');
  const publicKey = createPublicKey(privateKey);
  const jwk = publicKey.export({ format: 'jwk' });
  const keyId = createHash('sha256').update(jwk.x).digest('hex').slice(0, 16);
  return Object.freeze({ privateKey, publicKey, keyId, publicJwk: Object.freeze({ kty: 'OKP', crv: 'Ed25519', x: jwk.x }) });
}

export function signDecision(key, claims) {
  const payload = base64url(Buffer.from(canonicalJson({ aud: DECISION_AUDIENCE, ...claims }), 'utf8'));
  const signature = base64url(sign(null, Buffer.from(payload, 'utf8'), key.privateKey));
  return Object.freeze({ payload, signature, keyId: key.keyId });
}

export function verifyDecision(publicKey, envelope, { now = Date.now() } = {}) {
  if (!envelope || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') {
    return { ok: false, error: 'malformed envelope' };
  }
  const good = verify(null, Buffer.from(envelope.payload, 'utf8'), publicKey, fromBase64url(envelope.signature));
  if (!good) return { ok: false, error: 'bad signature' };
  const claims = JSON.parse(fromBase64url(envelope.payload).toString('utf8'));
  if (claims.aud !== DECISION_AUDIENCE) return { ok: false, error: 'wrong audience' };
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < now) return { ok: false, error: 'expired' };
  return { ok: true, claims };
}
