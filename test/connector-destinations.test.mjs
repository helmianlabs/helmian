// Tenant outbound destinations (Bite F): the resolver, the store, and
// the state read, against a fake credential client in the
// connector-tenant-pair precedent's shape. The vault itself is covered
// by credential-vault-v2.test.mjs; what is pinned here is the routing
// contract: a tenant's stored webhook wins, the operator tenant alone
// falls back to the server env, everyone else has no destination, and
// no surface ever returns the URL.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  outboundDestinationProviderId,
  outboundDestinationReference,
  readOutboundDestinationState,
  resolveOutboundDestination,
  storeOutboundDestination,
} from '../src/cloud/connector-destinations.mjs';

const ACTOR = { actorSubject: 'user-1', actorRole: 'owner', sessionId: 'sess-1', requestId: 'req-1' };
const TENANT_URL = 'https://discord.com/api/webhooks/tenant-secret';
const ENV_URL = 'https://discord.com/api/webhooks/env-secret';
const ENV = { HELMION_OPERATOR_TENANT_ID: 't-op', HELMION_DISCORD_WEBHOOK_URL: ENV_URL, HELMION_SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/env' };

function fakeCredentials({ records = {}, storeAnswer = { accepted: true, status: 'stored_in_credential_vault' }, resolveError = null } = {}) {
  const resolves = [];
  const stores = [];
  return {
    resolves,
    stores,
    async resolveVaultCredential(input) {
      resolves.push(input);
      if (resolveError) throw resolveError;
      const url = records[input.providerId];
      if (!url) return { accepted: false, status: 'credential_not_available', secretMaterial: 'not_returned', providerInvocation: 'not_performed' };
      return { accepted: true, status: 'credential_resolved', credential: url, secretMaterial: 'adapter_only', providerInvocation: 'not_performed' };
    },
    async storeCredential(input) { stores.push(input); return storeAnswer; },
  };
}

test('destination addresses follow the tenant pair shape', () => {
  assert.equal(outboundDestinationProviderId('discord'), 'discord-outbound');
  assert.equal(outboundDestinationProviderId('Slack'), 'slack-outbound');
  assert.equal(outboundDestinationReference('T-1', 'discord'), 'vault://tenant/t-1/discord-outbound/webhook');
  assert.equal(outboundDestinationReference('t-1', 'slack'), 'vault://tenant/t-1/slack-outbound/webhook');
});

test('resolve returns the tenant stored webhook, addressed per tenant and provider', async () => {
  const credentials = fakeCredentials({ records: { 'discord-outbound': TENANT_URL } });
  const destination = await resolveOutboundDestination({ credentials, tenantId: 't-1', provider: 'discord', env: ENV, actorContext: ACTOR });
  assert.deepEqual(destination, { kind: 'tenant', webhookUrl: TENANT_URL });
  assert.equal(credentials.resolves.length, 1);
  const input = credentials.resolves[0];
  assert.equal(input.tenantId, 't-1');
  assert.equal(input.providerId, 'discord-outbound');
  assert.equal(input.credentialReference, 'vault://tenant/t-1/discord-outbound/webhook');
  assert.equal(input.reasonClass, 'provider_call');
  assert.equal(input.actorSubject, 'user-1');
  assert.equal(input.actorRole, 'owner');
});

test('resolve falls back to the env webhook for the operator tenant only', async () => {
  const credentials = fakeCredentials();
  const operator = await resolveOutboundDestination({ credentials, tenantId: 't-op', provider: 'discord', env: ENV, actorContext: ACTOR });
  assert.deepEqual(operator, { kind: 'operator-env', webhookUrl: ENV_URL });
  const other = await resolveOutboundDestination({ credentials, tenantId: 't-2', provider: 'discord', env: ENV, actorContext: ACTOR });
  assert.deepEqual(other, { kind: 'none' }, 'a non-operator tenant never falls back to the env webhook');
});

test('resolve: a stored destination wins over the env fallback even for the operator tenant', async () => {
  const credentials = fakeCredentials({ records: { 'discord-outbound': TENANT_URL } });
  const destination = await resolveOutboundDestination({ credentials, tenantId: 't-op', provider: 'discord', env: ENV, actorContext: ACTOR });
  assert.deepEqual(destination, { kind: 'tenant', webhookUrl: TENANT_URL });
});

test('resolve: operator tenant with no env URL has no destination', async () => {
  const credentials = fakeCredentials();
  const destination = await resolveOutboundDestination({ credentials, tenantId: 't-op', provider: 'discord', env: { HELMION_OPERATOR_TENANT_ID: 't-op' }, actorContext: ACTOR });
  assert.deepEqual(destination, { kind: 'none' });
});

test('resolve works with no credential service: operator fallback only', async () => {
  const operator = await resolveOutboundDestination({ credentials: null, tenantId: 't-op', provider: 'slack', env: ENV, actorContext: ACTOR });
  assert.deepEqual(operator, { kind: 'operator-env', webhookUrl: 'https://hooks.slack.com/services/env' });
  const other = await resolveOutboundDestination({ credentials: null, tenantId: 't-2', provider: 'slack', env: ENV, actorContext: ACTOR });
  assert.deepEqual(other, { kind: 'none' });
});

test('resolve treats a refused or failed vault read as no record, never an error', async () => {
  const refusing = fakeCredentials({ resolveError: new Error('not an active member') });
  const destination = await resolveOutboundDestination({ credentials: refusing, tenantId: 't-2', provider: 'discord', env: ENV, actorContext: ACTOR });
  assert.deepEqual(destination, { kind: 'none' });
  const unsupported = await resolveOutboundDestination({ credentials: refusing, tenantId: 't-2', provider: 'sms', env: ENV, actorContext: ACTOR });
  assert.deepEqual(unsupported, { kind: 'none' });
});

test('store validates the host allowlist before storing, and stores the exact URL as an api_key record', async () => {
  const credentials = fakeCredentials();
  const answer = await storeOutboundDestination({ credentials, tenantId: 't-1', actorContext: ACTOR, provider: 'discord', webhookUrl: TENANT_URL });
  assert.equal(answer.accepted, true, 'the credential service answer is returned untouched');
  assert.equal(credentials.stores.length, 1);
  const input = credentials.stores[0];
  assert.equal(input.credentialKind, 'api_key');
  assert.equal(input.providerId, 'discord-outbound');
  assert.equal(input.credentialReference, 'vault://tenant/t-1/discord-outbound/webhook');
  assert.equal(input.apiKey, TENANT_URL);
  assert.equal(input.actorSubject, 'user-1');

  await assert.rejects(
    () => storeOutboundDestination({ credentials, tenantId: 't-1', actorContext: ACTOR, provider: 'discord', webhookUrl: 'https://example.com/api/webhooks/x' }),
    /not allowlisted/,
  );
  await assert.rejects(
    () => storeOutboundDestination({ credentials, tenantId: 't-1', actorContext: ACTOR, provider: 'slack', webhookUrl: TENANT_URL }),
    /not allowlisted/,
    'a Discord URL is not a Slack destination',
  );
  assert.equal(credentials.stores.length, 1, 'an off-allowlist URL is never stored');
});

test('store returns null when the credential service is not switched on', async () => {
  assert.equal(await storeOutboundDestination({ credentials: null, tenantId: 't-1', actorContext: ACTOR, provider: 'discord', webhookUrl: TENANT_URL }), null);
  assert.equal(await readOutboundDestinationState({ credentials: null, tenantId: 't-1', actorContext: ACTOR }), null);
});

test('state reports configured per provider and never carries the URL', async () => {
  const credentials = fakeCredentials({ records: { 'discord-outbound': TENANT_URL } });
  const state = await readOutboundDestinationState({ credentials, tenantId: 't-1', actorContext: ACTOR });
  assert.deepEqual(state, { discord: { configured: true }, slack: { configured: false } });
  assert.doesNotMatch(JSON.stringify(state), /discord\.com|hooks\.slack/);
  assert.ok(credentials.resolves.every((input) => input.reasonClass === 'probe'), 'the state read resolves under the probe reason class');
});
