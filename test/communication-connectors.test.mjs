import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import {
  normalizeConnectorMessage,
  postConnectorMessage,
  readCommunicationConnectorStatus,
  verifyDiscordInteraction,
  verifySlackRequest,
} from '../src/cloud/communication-connectors.mjs';

const now = Date.UTC(2026, 7, 12, 12, 0, 0);

test('Slack signature accepts a fresh exact body and rejects a changed body', () => {
  const body = JSON.stringify({ type: 'event_callback' });
  const timestamp = Math.floor(now / 1000);
  const signature = `v0=${createHmac('sha256', 'secret').update(`v0:${timestamp}:${body}`).digest('hex')}`;
  assert.equal(verifySlackRequest({ rawBody: body, timestamp, signature, signingSecret: 'secret', now }).provider, 'slack');
  assert.throws(() => verifySlackRequest({ rawBody: `${body} `, timestamp, signature, signingSecret: 'secret', now }));
});

test('Slack rejects stale signatures', () => {
  assert.throws(() => verifySlackRequest({ rawBody: '{}', timestamp: 1, signature: 'v0=' + 'a'.repeat(64), signingSecret: 'secret', now }));
});

test('Discord verifies the signed interaction body', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const body = JSON.stringify({ type: 1 });
  const timestamp = String(Math.floor(now / 1000));
  const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString('hex');
  const discordPublicKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  assert.equal(verifyDiscordInteraction({ rawBody: body, timestamp, signature, publicKey: discordPublicKey, now }).provider, 'discord');
  assert.throws(() => verifyDiscordInteraction({ rawBody: '{}', timestamp, signature, publicKey: discordPublicKey, now }));
});

test('connector messages are normalized and bounded', () => {
  assert.deepEqual(normalizeConnectorMessage({ provider: 'Slack', eventId: 'e1', externalUserId: 'u1', channelId: 'c1', text: 'hello' }), {
    provider: 'slack', eventId: 'e1', externalUserId: 'u1', channelId: 'c1', text: 'hello',
  });
  assert.throws(() => normalizeConnectorMessage({ provider: 'slack', eventId: 'e1', externalUserId: 'u1', channelId: 'c1', text: 'x'.repeat(4001) }));
});

test('status never exposes connector secrets and reports the agent bridge honestly', () => {
  const status = readCommunicationConnectorStatus({
    HELMION_DISCORD_APPLICATION_PUBLIC_KEY: 'public',
    HELMION_DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/token',
    HELMION_SLACK_SIGNING_SECRET: 'secret',
  });
  assert.equal(status.discord.configured, true);
  assert.equal(status.slack.inboundVerification, true);
  assert.equal(status.agentBridge, 'not-connected');
  assert.doesNotMatch(JSON.stringify(status), /secret|token/u);
});

test('outbound delivery refuses non-allowlisted webhook hosts', async () => {
  await assert.rejects(() => postConnectorMessage({
    provider: 'slack', text: 'hello', env: { HELMION_SLACK_WEBHOOK_URL: 'https://example.com/hook' },
  }));
});
