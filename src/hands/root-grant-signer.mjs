// Executive Guard side of Helmian hands workspace root grants: the issuer.
//
// The PC spoke only VERIFIES grant envelopes (verifyRootGrant in
// hands-mcp/src/shared/protocol.mjs) against the Guard public key pinned on
// it. This module is the other half: given a spoke root-request record and a
// recorded human approval, it mints the envelope the spoke accepts — same
// canonical-JSON payload, same Ed25519 signature over the payload string,
// same root-grant audience. See docs/hands/ROOT_GRANTS.md.
//
// It lives apart from the spoke on purpose: the Guard PRIVATE key belongs
// wherever Guard decisions are signed, never on the PC and never in this
// repo. The key is loaded from a file path supplied at runtime; its contents
// are never logged, printed, or written anywhere by this module.
//
// Fail-closed rules, mirroring what the spoke enforces:
//   - no recorded human approval (approvalId + decidedBy), no grant;
//   - the request record must hash to its own actionHash (a request edited
//     after approval was recorded cannot be re-aimed at another folder);
//   - one absolute folder, read-only scope, one spoke device — nothing else
//     is issuable, whatever the caller passes;
//   - an expiry, when set, must be in the future.
// After signing, the envelope is verified against the key's own public half
// with the spoke's verifier, so a signer/verifier drift fails here, loudly,
// instead of on the PC.

import { createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  ROOT_GRANT_AUDIENCE,
  canonicalJson,
  isAbsoluteRootPath,
  rootGrantActionHash,
  verifyRootGrant,
} from '../../hands-mcp/src/shared/protocol.mjs';

function requiredText(value, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`${field} is required`);
  return text;
}

/**
 * Load the Guard Ed25519 private key from a file: a PKCS#8 PEM or a JWK
 * ({ kty: 'OKP', crv: 'Ed25519', d, x }). The path is the caller's; the file
 * contents never leave this function except as a KeyObject.
 */
export async function loadGuardPrivateKey(path) {
  if (!path || typeof path !== 'string') throw new Error('a Guard private key file path is required');
  const raw = await readFile(path, 'utf8');
  const text = raw.trim();
  let key;
  try {
    key = text.startsWith('{')
      ? createPrivateKey({ key: JSON.parse(text), format: 'jwk' })
      : createPrivateKey(text);
  } catch (e) {
    throw new Error(`could not load a private key from ${path}: ${e.message}`);
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`the key in ${path} is not Ed25519`);
  return key;
}

/** The base64url JWK x of a private key's public half — the value `pin-guard` pins on the PC. */
export function guardPublicKeyX(privateKey) {
  return createPublicKey(privateKey).export({ format: 'jwk' }).x;
}

/**
 * Mint a root-grant envelope from a spoke root-request record (the object
 * createRootRequest in src/hands/root-grants.mjs produces) plus the human
 * approval that decided it. `approval` is { approvalId, decidedBy } as
 * recorded by the approval surface (Executive Guard's /v1/approvals in the
 * hub flow, or the operator's own record in the manual flow).
 *
 * Options: privateKey (KeyObject from loadGuardPrivateKey), keyId (the id
 * the envelope carries for the signing key), grantId (defaults to a fresh
 * UUID), expiresAt (epoch seconds; null/omitted = until revoked),
 * now (ms epoch, injectable for tests).
 */
export function issueRootGrant({ request, approval, privateKey, keyId, grantId = randomUUID(), expiresAt = null, now = Date.now() } = {}) {
  // The approval binding: no recorded human decision, no issuance. This is
  // checked first so a key holder can never mint silently.
  const approvalId = requiredText(approval?.approvalId, 'approval.approvalId (a recorded human approval is required)');
  const decidedBy = requiredText(approval?.decidedBy, 'approval.decidedBy (a recorded human approval is required)');

  if (!request || typeof request !== 'object') throw new Error('a root-request record is required');
  if (request.kind !== 'root-request') throw new Error('request is not a root-request record');
  if (!isAbsoluteRootPath(request.rootPath)) throw new Error('request rootPath must be an absolute path');
  if (request.scope !== 'read-only') throw new Error('root grants are read-only; the request scope cannot be widened');
  const spokeDeviceId = requiredText(request.spokeDeviceId, 'request.spokeDeviceId');

  // The record must be the record that was approved: its actionHash is the
  // hash of its own claims, and an edited record no longer hashes to it.
  const expectedHash = rootGrantActionHash({ rootPath: request.rootPath, scope: 'read-only', spokeDeviceId, expiresAt: null });
  if (request.actionHash !== expectedHash) throw new Error('request record does not match its actionHash — it was changed after it was written; refusing to sign it');

  if (!privateKey || privateKey.asymmetricKeyType !== 'ed25519') throw new Error('an Ed25519 Guard private key is required');
  const cleanKeyId = requiredText(keyId, 'keyId');

  const iat = Math.floor(now / 1000);
  let exp;
  if (expiresAt != null) {
    if (!Number.isFinite(expiresAt) || expiresAt <= iat) throw new Error('expiresAt must be in the future');
    exp = Math.floor(expiresAt);
  }

  const claims = {
    aud: ROOT_GRANT_AUDIENCE,
    grantType: 'root',
    grantId: requiredText(grantId, 'grantId'),
    verdict: 'allow',
    approvalId,
    decidedBy,
    rootPath: request.rootPath,
    scope: 'read-only',
    spokeDeviceId,
    ...(request.requestId ? { requestId: request.requestId } : {}),
    actionHash: request.actionHash,
    iat,
    ...(exp != null ? { exp } : {}),
  };
  const payload = Buffer.from(canonicalJson(claims), 'utf8').toString('base64url');
  const signature = sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64url');
  const envelope = { payload, signature, keyId: cleanKeyId };

  // Self-check with the spoke's own verifier: if this envelope would not be
  // accepted on the PC, fail here instead of handing out a dead grant.
  const check = verifyRootGrant({ publicKeyX: guardPublicKeyX(privateKey), envelope, spokeDeviceId, now });
  if (!check.ok) throw new Error(`internal error: the signed grant does not verify (${check.error})`);
  return { envelope, claims: check.claims };
}
