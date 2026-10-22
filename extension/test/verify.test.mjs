// The extension verifies Executive Guard decisions with WebCrypto. These tests
// sign with the REAL server module and verify with the extension module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSigningKey, loadSigningKey, signDecision } from '../../executive-guard/src/signing.mjs';
import { canonicalJson as serverCanonical } from '../../executive-guard/src/canonical.mjs';
import { actionHash as serverActionHash, normalizeAction } from '../../executive-guard/src/action.mjs';
import { actionHash, canonicalJson, randomNonce, verifyDecisionEnvelope } from '../background/verify.js';

const key = loadSigningKey(generateSigningKey());
const pinned = { keyId: key.keyId, publicKeyJwk: key.publicJwk };
const ACTION = { kind: 'prompt.send', site: 'Claude.AI', contentHash: 'a'.repeat(64), riskSignals: ['pii:ssn', 'pii:email'], summary: 'x' };

function claims(overrides = {}) {
  const iat = Math.floor(Date.now() / 1000);
  return { decisionId: 'd1', verdict: 'allow', ruleId: 'r', actionHash: 'h'.repeat(64), deviceId: 'dev', nonce: 'nonce-aaaaaaaaaaaaaaaa', iat, exp: iat + 300, ...overrides };
}

test('canonical JSON is byte-identical to the server\'s', () => {
  const value = { b: [3, { z: 1, a: null }], a: 'é', c: true, d: undefined };
  assert.equal(canonicalJson(value), serverCanonical(value));
});

test('the action hash is identical to the server\'s for the same action', async () => {
  assert.equal(await actionHash(ACTION), serverActionHash(normalizeAction(ACTION)));
  assert.equal(await actionHash({ ...ACTION, target: 'API.example.com', kind: 'network.request' }),
    serverActionHash(normalizeAction({ ...ACTION, target: 'API.example.com', kind: 'network.request' })));
});

test('a genuine decision verifies and returns its claims', async () => {
  const envelope = signDecision(key, claims());
  const result = await verifyDecisionEnvelope(envelope, pinned, { actionHash: 'h'.repeat(64), nonce: 'nonce-aaaaaaaaaaaaaaaa' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.claims.verdict, 'allow');
});

test('REFUSED: signed by another key', async () => {
  const other = loadSigningKey(generateSigningKey());
  const envelope = { ...signDecision(other, claims()), keyId: key.keyId };
  assert.deepEqual(await verifyDecisionEnvelope(envelope, pinned, {}), { ok: false, error: 'bad signature' });
});

test('REFUSED: key id not the pinned one', async () => {
  const other = loadSigningKey(generateSigningKey());
  const result = await verifyDecisionEnvelope(signDecision(other, claims()), pinned, {});
  assert.equal(result.error, 'decision signed by an unpinned key');
});

test('REFUSED: payload edited after signing (deny turned into allow)', async () => {
  const envelope = signDecision(key, claims({ verdict: 'deny' }));
  const forged = Buffer.from(Buffer.from(envelope.payload, 'base64url').toString().replace('"deny"', '"allow"')).toString('base64url');
  const result = await verifyDecisionEnvelope({ ...envelope, payload: forged }, pinned, {});
  assert.equal(result.ok, false);
});

test('REFUSED: expired, wrong action, wrong nonce, wrong audience', async () => {
  const past = Math.floor(Date.now() / 1000) - 3600;
  assert.equal((await verifyDecisionEnvelope(signDecision(key, claims({ iat: past, exp: past + 300 })), pinned, {})).error, 'expired');
  assert.equal((await verifyDecisionEnvelope(signDecision(key, claims()), pinned, { actionHash: 'f'.repeat(64) })).error, 'decision is for a different action');
  assert.equal((await verifyDecisionEnvelope(signDecision(key, claims()), pinned, { nonce: 'other-nonce-aaaaaaaa' })).error, 'decision is for a different request');
  assert.equal((await verifyDecisionEnvelope(signDecision(key, { ...claims(), aud: 'something-else' }), pinned, {})).error, 'wrong audience');
});

test('REFUSED: malformed envelopes and a missing pin', async () => {
  assert.equal((await verifyDecisionEnvelope(null, pinned, {})).ok, false);
  assert.equal((await verifyDecisionEnvelope({ payload: 'x' }, pinned, {})).ok, false);
  assert.equal((await verifyDecisionEnvelope(signDecision(key, claims()), null, {})).error, 'no pinned key');
});

test('nonces are url-safe, long enough for the server, and unique', () => {
  const a = randomNonce();
  assert.match(a, /^[A-Za-z0-9_-]{16,128}$/);
  assert.notEqual(a, randomNonce());
});
