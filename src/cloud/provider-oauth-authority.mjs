const GEMINI_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GEMINI_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GEMINI_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/generative-language.retriever',
]);

// Authority reviewed 2026-08-15. A descriptor is not a live registration:
// Helmian still needs an operator-owned client ID and an encrypted vault.
const AUTHORITIES = Object.freeze({
  openai_codex: Object.freeze({
    provider_id: 'openai_codex',
    status: 'blocked_no_public_cloud_oauth_contract',
    authorization_endpoint: null,
    token_endpoint: null,
    scopes: Object.freeze([]),
    blocker: 'OpenAI API authentication is documented as API-key based; no public Codex subscription OAuth authorization and token endpoint is available for this cloud connection.',
  }),
  claude: Object.freeze({
    provider_id: 'claude',
    status: 'blocked_no_public_cloud_oauth_contract',
    authorization_endpoint: null,
    token_endpoint: null,
    scopes: Object.freeze([]),
    blocker: 'No public Anthropic cloud OAuth authorization and token endpoint for a third-party provider connection was found in the reviewed API authentication documentation.',
  }),
  gemini: Object.freeze({
    provider_id: 'gemini',
    status: 'documented_google_oauth',
    authorization_endpoint: GEMINI_AUTHORIZATION_ENDPOINT,
    token_endpoint: GEMINI_TOKEN_ENDPOINT,
    scopes: GEMINI_SCOPES,
    blocker: null,
  }),
  grok: Object.freeze({
    provider_id: 'grok',
    status: 'blocked_first_party_oauth_only',
    authorization_endpoint: null,
    token_endpoint: null,
    scopes: Object.freeze([]),
    blocker: 'xAI documents OAuth2/OIDC for its first-party Grok Build enterprise path, while the direct xAI API path requires XAI_API_KEY; the reviewed public docs do not publish a third-party cloud token endpoint for this adapter.',
  }),
});

export const CLOUD_PROVIDER_OAUTH_AUTHORITIES = Object.freeze(Object.values(AUTHORITIES));

export function getCloudProviderOAuthAuthority(providerId) {
  return AUTHORITIES[String(providerId ?? '')] ?? null;
}

export function isSupportedCloudOAuthProvider(providerId) {
  return getCloudProviderOAuthAuthority(providerId)?.token_endpoint != null;
}

export function buildCloudOAuthAuthorizationUrl({ authority, clientId, redirectUri, state, codeChallenge, scopes } = {}) {
  if (!authority?.authorization_endpoint || !clientId || !redirectUri || !state || !codeChallenge || !Array.isArray(scopes) || scopes.length === 0) throw new TypeError('OAuth authorization URL input');
  const url = new URL(authority.authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    scope: [...new Set(scopes)].sort().join(' '),
  }).toString();
  return url.toString();
}
