// GitHub connection for the desktop app through helmian.cloud.
// Unlike Slack/Discord, the GitHub client secret lives only in this cloud
// function: the callback exchanges the authorization code for an access token,
// encrypts it (AES-256-GCM, bound to the request id) into the one-time handoff,
// and the desktop that started the flow redeems it once with its proof. The
// ciphertext is erased on redemption and the row expires within minutes.
import {
  decryptAuthorizationCode, encryptAuthorizationCode, failJson, hashProof, httpError,
  parseProviderState, readJson, requireServiceAuthorization, sendCallbackPage, sendJson,
  validateProof, validateRequestId,
} from './_team-oauth-core.js';
import { completeHandoff, redeemHandoff, registerHandoff } from './_team-oauth-store.js';

export const GITHUB_SCOPES = 'read:user read:org repo';
export const DEFAULT_GITHUB_REDIRECT = 'https://helmian.cloud/api/team-oauth/github/callback';

export function githubConfig(environment = process.env) {
  const clientId = String(environment.HELMION_GITHUB_CLIENT_ID ?? '').trim();
  const clientSecret = String(environment.HELMION_GITHUB_CLIENT_SECRET ?? '').trim();
  const redirectUri = String(environment.HELMION_GITHUB_REDIRECT_URI ?? DEFAULT_GITHUB_REDIRECT).trim();
  if (!clientId || !clientSecret) throw httpError(503, 'github_not_configured', 'GitHub connection is not configured yet.');
  return { clientId, clientSecret, redirectUri };
}

export async function exchangeGitHubCode(code, config, fetchImpl = fetch) {
  const res = await fetchImpl('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'Helmian-Cloud' },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: config.redirectUri }),
  });
  const body = await res.json().catch(() => ({}));
  const token = String(body.access_token ?? '');
  if (!res.ok || !token || token.length > 4096) throw httpError(502, 'github_exchange_failed', 'GitHub did not issue a token.');
  return token;
}

const query = (request, name) => request.query?.[name] ?? new URL(request.url, 'https://callback.invalid').searchParams.get(name);

export function createGitHubHandoffHandlers({
  register = registerHandoff, complete = completeHandoff, redeem = redeemHandoff,
  encrypt = encryptAuthorizationCode, decrypt = decryptAuthorizationCode,
  authorize = requireServiceAuthorization, config = githubConfig, exchange = exchangeGitHubCode,
} = {}) {
  const provider = 'github';
  return {
    start: async (request, response) => {
      if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }, { allow: 'POST' }); return; }
      try {
        authorize(request);
        const body = await readJson(request);
        const requestId = validateRequestId(body.requestId);
        const result = await register({ provider, requestId, stateHash: validateProof(body.stateHash), redemptionChallenge: validateProof(body.redemptionChallenge) });
        sendJson(response, 201, { state: 'pending', expiresAtUtc: new Date(result.expiresAtUtc).toISOString(), authorizeUrl: '/api/team-oauth/github/authorize' });
      } catch (error) { failJson(response, error); }
    },

    // Browser entry point opened by the desktop: sends the user to GitHub with the cloud's client id.
    authorize: async (request, response) => {
      try {
        const stateValue = String(query(request, 'state') ?? '');
        parseProviderState(stateValue);
        const { clientId, redirectUri } = config();
        const url = new URL('https://github.com/login/oauth/authorize');
        url.searchParams.set('client_id', clientId);
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('scope', GITHUB_SCOPES);
        url.searchParams.set('state', stateValue);
        url.searchParams.set('allow_signup', 'true');
        response.statusCode = 302; response.setHeader('location', url.toString()); response.setHeader('cache-control', 'no-store'); response.end();
      } catch { sendCallbackPage(response, 400, false, 'GitHub'); }
    },

    callback: async (request, response) => {
      if (request.method !== 'GET') { sendCallbackPage(response, 405, false, 'GitHub'); return; }
      try {
        const { requestId, state } = parseProviderState(query(request, 'state'));
        const code = String(query(request, 'code') ?? '');
        const providerError = String(query(request, 'error') ?? '');
        if ((code.length === 0) === (providerError.length === 0) || code.length > 4096 || providerError.length > 200) throw new Error('Invalid GitHub callback');
        const token = code ? await exchange(code, config()) : null;
        await complete({ provider, requestId, stateHash: hashProof(state), encryptedCode: token ? encrypt(token, requestId) : null, providerError: providerError ? 'declined' : null });
        sendCallbackPage(response, 200, Boolean(token), 'GitHub');
      } catch { sendCallbackPage(response, 400, false, 'GitHub'); }
    },

    redeem: async (request, response) => {
      if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }, { allow: 'POST' }); return; }
      try {
        authorize(request);
        const body = await readJson(request);
        const requestId = validateRequestId(body.requestId);
        const redemptionSecret = validateProof(String(body.redemptionSecret ?? ''));
        const result = await redeem({ provider, requestId, redemptionSecret });
        if (result.state === 'pending') { sendJson(response, 202, { state: 'pending' }); return; }
        if (result.state === 'declined') { sendJson(response, 409, { error: 'provider_declined' }); return; }
        const accessToken = decrypt(result.encryptedCode, requestId);
        sendJson(response, 200, { accessToken, tokenType: 'bearer', scope: GITHUB_SCOPES });
      } catch (error) { failJson(response, error); }
    },
  };
}

export const githubHandoffHandlers = createGitHubHandoffHandlers();
