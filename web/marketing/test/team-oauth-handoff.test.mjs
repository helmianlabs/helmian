import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  decryptAuthorizationCode,
  encryptAuthorizationCode,
  hashProof,
  parseProviderState,
  requireServiceAuthorization,
} from '../api/_team-oauth-core.js';
import { createSlackHandoffHandlers } from '../api/_team-oauth-slack.js';

const requestId = `team_${'r'.repeat(24)}`;
const stateSecret = 's'.repeat(43);
const state = `${requestId}.${stateSecret}`;
const redemptionSecret = 'd'.repeat(43);
const serviceToken = 'h'.repeat(43);
const key = crypto.randomBytes(32);
const environment = { HELMION_TEAM_OAUTH_HANDOFF_TOKEN_HASH: hashProof(serviceToken) };

function request(method, { body, query, authorization = `Bearer ${serviceToken}` } = {}) {
  return {
    method,
    body,
    query,
    url: '/api/team-oauth/slack/callback',
    headers: authorization ? { authorization } : {},
  };
}

function response() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value = '') { this.body += value; },
  };
}

function memoryHandlers() {
  let row;
  let redeemed = false;
  const calls = { register: 0, complete: 0, redeem: 0 };
  const handlers = createSlackHandoffHandlers({
    authorize: (incoming) => requireServiceAuthorization(incoming, environment),
    encrypt: (code, id) => encryptAuthorizationCode(code, id, key),
    decrypt: (encrypted, id) => decryptAuthorizationCode(encrypted, id, key),
    register: async (input) => {
      calls.register += 1;
      row = { ...input, expiresAtUtc: new Date('2026-08-01T00:10:00Z') };
      return row;
    },
    complete: async (input) => {
      calls.complete += 1;
      assert.equal(input.requestId, row.requestId);
      assert.equal(input.stateHash, row.stateHash);
      row = { ...row, ...input, completed: true };
    },
    redeem: async (input) => {
      calls.redeem += 1;
      assert.equal(input.requestId, row.requestId);
      assert.equal(hashProof(input.redemptionSecret), row.redemptionChallenge);
      if (!row.completed) return { state: 'pending' };
      if (redeemed) {
        const error = new Error('The one-time handoff is expired or already used.');
        error.status = 410;
        error.code = 'handoff_expired';
        throw error;
      }
      redeemed = true;
      return row.providerError
        ? { state: 'declined' }
        : { state: 'complete', encryptedCode: row.encryptedCode };
    },
  });
  return { handlers, calls, current: () => row };
}

test('Discord hosted handoff is provider-bound and cannot be treated as a Slack grant', async () => {
  let registered;
  const handlers = createSlackHandoffHandlers({
    provider: 'discord',
    providerLabel: 'Discord',
    authorize: (incoming) => requireServiceAuthorization(incoming, environment),
    encrypt: (code, id) => encryptAuthorizationCode(code, id, key),
    decrypt: (encrypted, id) => decryptAuthorizationCode(encrypted, id, key),
    register: async (input) => {
      registered = { ...input, expiresAtUtc: new Date('2026-08-01T00:10:00Z') };
      return registered;
    },
    complete: async (input) => {
      assert.equal(input.provider, 'discord');
      assert.equal(input.requestId, registered.requestId);
    },
    redeem: async (input) => {
      assert.equal(input.provider, 'discord');
      return { state: 'pending' };
    },
  });

  const startResponse = response();
  await handlers.start(request('POST', {
    body: { requestId, stateHash: hashProof(state), redemptionChallenge: hashProof(redemptionSecret) },
  }), startResponse);
  assert.equal(startResponse.statusCode, 201);
  assert.equal(registered.provider, 'discord');

  const callbackResponse = response();
  await handlers.callback(request('GET', {
    query: { state, code: 'short-lived-discord-code' }, authorization: '',
  }), callbackResponse);
  assert.equal(callbackResponse.statusCode, 200);
  assert.match(callbackResponse.body, /Discord returned to Helmian/);
});

test('Slack hosted handoff carries only hashes at registration and an encrypted code at callback', async () => {
  const memory = memoryHandlers();
  const startResponse = response();
  await memory.handlers.start(request('POST', {
    body: {
      requestId,
      stateHash: hashProof(state),
      redemptionChallenge: hashProof(redemptionSecret),
    },
  }), startResponse);
  assert.equal(startResponse.statusCode, 201);
  assert.equal(memory.calls.register, 1);
  assert.equal(JSON.stringify(memory.current()).includes(state), false);
  assert.equal(JSON.stringify(memory.current()).includes(redemptionSecret), false);

  const pendingResponse = response();
  await memory.handlers.redeem(request('POST', {
    body: { requestId, redemptionSecret },
  }), pendingResponse);
  assert.equal(pendingResponse.statusCode, 202);

  const callbackResponse = response();
  await memory.handlers.callback(request('GET', {
    query: { state, code: 'short-lived-slack-code' },
    authorization: '',
  }), callbackResponse);
  assert.equal(callbackResponse.statusCode, 200);
  assert.equal(callbackResponse.headers['cache-control'], 'no-store, max-age=0');
  assert.equal(JSON.stringify(memory.current()).includes('short-lived-slack-code'), false);
  assert.equal(memory.current().encryptedCode.ciphertext.length > 0, true);

  const redeemResponse = response();
  await memory.handlers.redeem(request('POST', {
    body: { requestId, redemptionSecret },
  }), redeemResponse);
  assert.equal(redeemResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(redeemResponse.body), { code: 'short-lived-slack-code' });
  assert.equal(redeemResponse.headers['cache-control'], 'no-store, max-age=0');

  const replayResponse = response();
  await memory.handlers.redeem(request('POST', {
    body: { requestId, redemptionSecret },
  }), replayResponse);
  assert.equal(replayResponse.statusCode, 410);
});

test('hosted callback rejects a tampered state without completing the handoff', async () => {
  const memory = memoryHandlers();
  await memory.handlers.start(request('POST', {
    body: { requestId, stateHash: hashProof(state), redemptionChallenge: hashProof(redemptionSecret) },
  }), response());
  const callbackResponse = response();
  await memory.handlers.callback(request('GET', {
    query: { state: `${requestId}.${'x'.repeat(43)}`, code: 'attacker-code' },
    authorization: '',
  }), callbackResponse);
  assert.equal(callbackResponse.statusCode, 400);
  assert.equal(memory.calls.complete, 1, 'the store is the authoritative constant-time state-hash check');
  assert.equal(memory.current().completed, undefined);
});

test('start and redeem require the configured service bearer token', async () => {
  const memory = memoryHandlers();
  const denied = response();
  await memory.handlers.start(request('POST', {
    body: { requestId, stateHash: hashProof(state), redemptionChallenge: hashProof(redemptionSecret) },
    authorization: 'Bearer wrong',
  }), denied);
  assert.equal(denied.statusCode, 401);
  assert.equal(memory.calls.register, 0);

  const redeemDenied = response();
  await memory.handlers.redeem(request('POST', {
    body: { requestId, redemptionSecret },
    authorization: '',
  }), redeemDenied);
  assert.equal(redeemDenied.statusCode, 401);
  assert.equal(memory.calls.redeem, 0);
});

test('state and AES-GCM code envelopes are bound to one request id', () => {
  assert.deepEqual(parseProviderState(state), { requestId, state });
  const encrypted = encryptAuthorizationCode('code', requestId, key);
  assert.equal(decryptAuthorizationCode(encrypted, requestId, key), 'code');
  assert.throws(
    () => decryptAuthorizationCode(encrypted, `team_${'z'.repeat(24)}`, key),
    /could not be decrypted/,
  );
});
