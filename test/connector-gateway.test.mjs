import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { receiveInboundConnectorEvent } from '../src/cloud/connector-gateway.mjs';

const NOW = Date.parse('2026-08-14T12:00:00Z');
const SECRET = 'slack-test-secret';
const body = JSON.stringify({ event_id: 'evt-1', user_id: 'slack-user', channel_id: 'slack-channel', text: 'hello' });
const headers = {
  timestamp: Math.floor(NOW / 1000),
  signature: `v0=${createHmac('sha256', SECRET).update(`v0:${Math.floor(NOW / 1000)}:${body}`).digest('hex')}`,
};

function receiptStore() {
  const seen = new Set();
  const messages = [];
  const persist = async (row) => {
    const replayed = seen.has(row.eventId);
    if (!replayed) { seen.add(row.eventId); messages.push({ tenantId: row.tenantId, channelId: row.channelId, body: row.text, eventId: row.eventId }); }
    return { durable: true, replayed, message: messages.at(-1) };
  };
  persist.messages = messages;
  return persist;
}

const resolveUser = async ({ provider, externalUserId }) => provider === 'slack' && externalUserId === 'slack-user'
  ? [{ active: true, subject: 'user-1', tenantId: 'org-a', role: 'member' }] : [];
const resolveChannel = async ({ provider, channelId, tenantId }) => provider === 'slack' && channelId === 'slack-channel' && tenantId === 'org-a'
  ? [{ active: true, tenantId }] : [];

test('fake Slack inbound event verifies, binds to organization membership, and replays durably', async () => {
  const persistReceipt = receiptStore();
  const first = await receiveInboundConnectorEvent({ provider: 'slack', rawBody: body, payload: JSON.parse(body), headers, signingSecret: SECRET, now: NOW, resolveUser, resolveChannel, persistReceipt });
  const replay = await receiveInboundConnectorEvent({ provider: 'slack', rawBody: body, payload: JSON.parse(body), headers, signingSecret: SECRET, now: NOW, resolveUser, resolveChannel, persistReceipt });
  assert.deepEqual({ provider: first.provider, eventId: first.eventId, tenantId: first.tenantId, durable: first.durable, replayed: first.replayed }, { provider: 'slack', eventId: 'evt-1', tenantId: 'org-a', durable: true, replayed: false });
  assert.equal(replay.replayed, true);
  assert.deepEqual(persistReceipt.messages, [{ tenantId: 'org-a', channelId: 'slack-channel', body: 'hello', eventId: 'evt-1' }]);
  assert.equal(first.agentInvocation, 'not_performed');
  assert.equal(first.outboundDelivery, 'not_performed');
});

test('provider tenant injection and cross-provider identity are rejected', async () => {
  await assert.rejects(
    receiveInboundConnectorEvent({ provider: 'slack', rawBody: body, payload: { ...JSON.parse(body), tenant_id: 'org-b' }, headers, signingSecret: SECRET, now: NOW, resolveUser, resolveChannel, persistReceipt: receiptStore() }),
    /tenant selectors/,
  );
  await assert.rejects(
    receiveInboundConnectorEvent({ provider: 'discord', rawBody: body, payload: JSON.parse(body), headers, signingSecret: SECRET, now: NOW, resolveUser, resolveChannel, persistReceipt: receiptStore() }),
    /Discord signature/,
  );
});
