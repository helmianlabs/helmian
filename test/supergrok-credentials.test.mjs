// SuperGrok credential-resolution tests: the resolver that turns the runner
// vault's Grok OAuth record into the credential a turn sends. Covers the
// fresh-token fast path, the 60 s refresh window with save-back, terminal
// refresh failure (session wiped, plain reason surfaced), transient failure
// (session kept, current token still handed out), the forced refresh behind
// the 401 hook, and the pc-bridge env injection. The vault is the real one
// (temp dir); the OAuth client is a stub — no network is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openVault } from '../src/runner/vault.mjs';
import { SuperGrokAuthError } from '../src/agent/supergrok-oauth.mjs';
import {
  createSuperGrokCredentialResolver,
  getFreshSuperGrokTokens,
  resolveGrokVaultInjection,
} from '../src/agent/supergrok-credentials.mjs';

const DEVICE_TOKEN = 'test-device-token-0123456789abcdef';
const T0 = Date.parse('2026-10-24T10:00:00.000Z');

async function freshVault() {
  const dir = await mkdtemp(join(tmpdir(), 'supergrok-cred-'));
  const vault = await openVault({ vaultPath: join(dir, 'vault.json'), deviceToken: DEVICE_TOKEN });
  return vault;
}

function bundle(overrides = {}) {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: new Date(T0 + 3_600_000).toISOString(), // one hour out: fresh
    email: 'troy@example.com',
    origin: 'device-flow',
    ...overrides,
  };
}

function stubClient(handler) {
  const calls = [];
  return {
    calls,
    async refresh(refreshToken) {
      calls.push(refreshToken);
      return handler(refreshToken);
    },
  };
}

const okClient = () => stubClient(async () => bundle({ accessToken: 'access-2', refreshToken: 'refresh-2' }));

test('no oauth record resolves to null (the env key stays in charge)', async () => {
  const vault = await freshVault();
  const resolver = createSuperGrokCredentialResolver({ vault, client: okClient(), now: () => T0 });
  assert.equal(await resolver({ providerId: 'xai' }), null);
  assert.equal(resolver.hasSessionSync(), false);
});

test('a fresh stored token is handed out as an oauth credential, no refresh', async () => {
  const vault = await freshVault();
  await vault.setOAuth('grok', bundle());
  const client = okClient();
  const resolver = createSuperGrokCredentialResolver({ vault, client, now: () => T0 });
  const resolved = await resolver({ providerId: 'xai' });
  assert.equal(resolved.credential, 'access-1');
  assert.equal(resolved.tokenType, 'oauth');
  assert.equal(client.calls.length, 0);
  assert.equal(resolver.hasSessionSync(), true);
});

test('other providers are not the grok resolver\u2019s business', async () => {
  const vault = await freshVault();
  await vault.setOAuth('grok', bundle());
  const resolver = createSuperGrokCredentialResolver({ vault, client: okClient(), now: () => T0 });
  assert.equal(await resolver({ providerId: 'gemini' }), null);
  assert.equal(await resolver({ providerId: 'openai' }), null);
});

test('a token inside the 60s window is refreshed once and saved back', async () => {
  const vault = await freshVault();
  await vault.setOAuth('grok', bundle({ expiresAt: new Date(T0 + 30_000).toISOString() }));
  const client = okClient();
  const resolver = createSuperGrokCredentialResolver({ vault, client, now: () => T0 });
  const resolved = await resolver({ providerId: 'grok' });
  assert.equal(resolved.credential, 'access-2');
  assert.deepEqual(client.calls, ['refresh-1']);
  const stored = await vault.getOAuth('grok');
  assert.equal(stored.accessToken, 'access-2');
  assert.equal(stored.refreshToken, 'refresh-2');
});

test('terminal refresh failure wipes the session and surfaces the plain reason', async () => {
  const vault = await freshVault();
  await vault.setOAuth('grok', bundle({ expiresAt: new Date(T0 + 10_000).toISOString() }));
  const client = stubClient(async () => {
    throw new SuperGrokAuthError('This SuperGrok session is no longer valid — it was revoked, or it expired. Sign in again, or use an API key.', 'invalid_grant');
  });
  const problems = [];
  const resolver = createSuperGrokCredentialResolver({
    vault, client, now: () => T0, onAuthProblem: (m) => problems.push(m),
  });
  assert.equal(await resolver({ providerId: 'xai' }), null);
  assert.equal(await vault.getOAuth('grok'), null);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no longer valid/);
  assert.equal(resolver.hasSessionSync(), false);
});

test('transient refresh failure keeps the session and hands out the current token', async () => {
  const vault = await freshVault();
  await vault.setOAuth('grok', bundle({ expiresAt: new Date(T0 + 10_000).toISOString() }));
  const client = stubClient(async () => { throw new Error('socket hang up'); });
  const problems = [];
  const resolver = createSuperGrokCredentialResolver({
    vault, client, now: () => T0, onAuthProblem: (m) => problems.push(m),
  });
  const resolved = await resolver({ providerId: 'xai' });
  assert.equal(resolved.credential, 'access-1');
  assert.ok(await vault.getOAuth('grok')); // session kept
  assert.equal(problems.length, 1);
});

test('a session with no refresh token is cleared with a plain reason', async () => {
  const vault = await freshVault();
  await vault.setOAuth('grok', bundle({ refreshToken: null, expiresAt: new Date(T0 + 10_000).toISOString() }));
  const problems = [];
  const tokens = await getFreshSuperGrokTokens({
    vault, client: okClient(), now: () => T0, onAuthProblem: (m) => problems.push(m),
  });
  assert.equal(tokens, null);
  assert.equal(await vault.getOAuth('grok'), null);
  assert.match(problems[0], /Sign in again/);
});

test('refreshCredential forces a refresh even for a fresh token (the 401 hook)', async () => {
  const vault = await freshVault();
  await vault.setOAuth('grok', bundle());
  const client = okClient();
  const resolver = createSuperGrokCredentialResolver({ vault, client, now: () => T0 });
  const resolved = await resolver.refreshCredential({ providerId: 'xai' });
  assert.equal(resolved.credential, 'access-2');
  assert.deepEqual(client.calls, ['refresh-1']);
});

test('bridge injection returns the fresh token plus the oauth marker env', async () => {
  const vault = await freshVault();
  await vault.setOAuth('grok', bundle());
  const injection = await resolveGrokVaultInjection({ vault, client: okClient(), now: () => T0 });
  assert.ok(injection);
  assert.equal(injection[Object.keys(injection).find((k) => k.endsWith('API_KEY'))], 'access-1');
  assert.equal(injection.HELMION_XAI_CREDENTIAL_TYPE, 'oauth');
  // The stored bundle itself (refresh token included) is never the injection.
  assert.ok(!JSON.stringify(injection).includes('refresh-1'));
});

test('bridge injection is null without a session', async () => {
  const vault = await freshVault();
  assert.equal(await resolveGrokVaultInjection({ vault, client: okClient(), now: () => T0 }), null);
});
