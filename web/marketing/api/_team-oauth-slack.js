import {
  decryptAuthorizationCode,
  encryptAuthorizationCode,
  failJson,
  hashProof,
  parseProviderState,
  readJson,
  requireServiceAuthorization,
  sendCallbackPage,
  sendJson,
  validateProof,
  validateRequestId,
} from './_team-oauth-core.js';
import { completeHandoff, redeemHandoff, registerHandoff } from './_team-oauth-store.js';

export function createSlackHandoffHandlers({
  provider = 'slack',
  providerLabel = 'Slack',
  register = registerHandoff,
  complete = completeHandoff,
  redeem = redeemHandoff,
  encrypt = encryptAuthorizationCode,
  decrypt = decryptAuthorizationCode,
  authorize = requireServiceAuthorization,
} = {}) {
  return {
    start: async (request, response) => {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'method_not_allowed' }, { allow: 'POST' }); return;
      }
      try {
        authorize(request);
        const body = await readJson(request);
        const requestId = validateRequestId(body.requestId);
        const stateHash = validateProof(body.stateHash);
        const redemptionChallenge = validateProof(body.redemptionChallenge);
        const result = await register({ provider, requestId, stateHash, redemptionChallenge });
        sendJson(response, 201, {
          state: 'pending',
          expiresAtUtc: new Date(result.expiresAtUtc).toISOString(),
        });
      } catch (error) {
        failJson(response, error);
      }
    },

    callback: async (request, response) => {
      if (request.method !== 'GET') {
        sendCallbackPage(response, 405, false, providerLabel); return;
      }
      try {
        const stateValue = request.query?.state ?? new URL(request.url, 'https://callback.invalid').searchParams.get('state');
        const code = String(request.query?.code ?? new URL(request.url, 'https://callback.invalid').searchParams.get('code') ?? '');
        const providerError = String(request.query?.error ?? new URL(request.url, 'https://callback.invalid').searchParams.get('error') ?? '');
        const { requestId, state } = parseProviderState(stateValue);
        if ((code.length === 0) === (providerError.length === 0) || code.length > 4096 || providerError.length > 200) {
          throw new Error(`Invalid ${providerLabel} callback`);
        }
        await complete({
          provider, requestId,
          stateHash: hashProof(state),
          encryptedCode: code ? encrypt(code, requestId) : null,
          providerError: providerError ? 'declined' : null,
        });
        sendCallbackPage(response, 200, Boolean(code), providerLabel);
      } catch {
        sendCallbackPage(response, 400, false, providerLabel);
      }
    },

    redeem: async (request, response) => {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'method_not_allowed' }, { allow: 'POST' }); return;
      }
      try {
        authorize(request);
        const body = await readJson(request);
        const requestId = validateRequestId(body.requestId);
        const redemptionSecret = String(body.redemptionSecret ?? '');
        validateProof(redemptionSecret);
        const result = await redeem({ provider, requestId, redemptionSecret });
        if (result.state === 'pending') {
          sendJson(response, 202, { state: 'pending' }); return;
        }
        if (result.state === 'declined') {
          sendJson(response, 409, { error: 'provider_declined' }); return;
        }
        const code = decrypt(result.encryptedCode, requestId);
        if (code.length < 1 || code.length > 4096) throw new Error('Invalid decrypted code');
        sendJson(response, 200, { code });
      } catch (error) {
        failJson(response, error);
      }
    },
  };
}

export const slackHandoffHandlers = createSlackHandoffHandlers();
