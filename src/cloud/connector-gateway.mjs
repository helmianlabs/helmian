import { verifyDiscordInteraction, verifySlackRequest, normalizeConnectorMessage } from './communication-connectors.mjs';
import { bindConnectorMessage } from './communication-identity.mjs';

function required(value, name, max = 256) {
  const text = String(value ?? '').trim();
  if (!text || text.length > max) throw new Error(`${name} is missing or too long`);
  return text;
}

function exactProvider(value) {
  const provider = required(value, 'connector provider', 16).toLowerCase();
  if (!['slack', 'discord'].includes(provider)) throw new Error('connector provider is unsupported');
  return provider;
}

/**
 * Run one inbound provider event through transport verification, server-side
 * identity binding, and an injected durable receipt sink. No provider payload
 * tenant claim is accepted, and this function never calls an agent or sends a
 * provider response.
 */
export async function receiveInboundConnectorEvent({
  provider: inputProvider,
  rawBody,
  payload,
  headers = {},
  signingSecret,
  publicKey,
  now = Date.now(),
  resolveUser,
  resolveChannel,
  persistReceipt,
} = {}) {
  const provider = exactProvider(inputProvider);
  if (payload?.tenantId !== undefined || payload?.tenant_id !== undefined) {
    throw new Error('provider tenant selectors are not accepted');
  }
  const verification = provider === 'slack'
    ? verifySlackRequest({ rawBody, timestamp: headers.timestamp, signature: headers.signature, signingSecret, now })
    : verifyDiscordInteraction({ rawBody, timestamp: headers.timestamp, signature: headers.signature, publicKey, now });
  if (verification.provider !== provider) throw new Error('connector provider verification mismatch');
  const message = normalizeConnectorMessage({
    provider,
    eventId: payload?.eventId ?? payload?.event_id,
    externalUserId: payload?.externalUserId ?? payload?.external_user_id ?? payload?.user_id,
    channelId: payload?.channelId ?? payload?.channel_id,
    text: payload?.text,
  });
  const binding = await bindConnectorMessage({ message, resolveUser, resolveChannel });
  if (typeof persistReceipt !== 'function') throw new Error('connector receipt sink is required');
  const persisted = await persistReceipt(Object.freeze({
    provider: binding.provider,
    eventId: binding.eventId,
    tenantId: binding.tenantId,
    subject: binding.subject,
    channelId: binding.channelId,
    text: binding.text,
  }));
  if (!persisted || persisted.durable !== true) throw new Error('connector receipt was not durable');
  return Object.freeze({
    format: 'helmion.connector-inbound-receipt.v1',
    provider,
    eventId: binding.eventId,
    tenantId: binding.tenantId,
    channelId: binding.channelId,
    subject: binding.subject,
    durable: true,
    replayed: persisted.replayed === true,
    agentInvocation: 'not_performed',
    outboundDelivery: 'not_performed',
  });
}
