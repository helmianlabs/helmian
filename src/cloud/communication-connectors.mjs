import {
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';

export const CONNECTOR_MAX_BODY_BYTES = 64 * 1024;
export const CONNECTOR_MAX_MESSAGE_CHARS = 4_000;
export const CONNECTOR_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

const DISCORD_WEBHOOK_HOSTS = new Set(['discord.com', 'discordapp.com']);
const SLACK_WEBHOOK_HOSTS = new Set(['hooks.slack.com']);

function boundedString(value, name, max = CONNECTOR_MAX_MESSAGE_CHARS) {
  const text = String(value ?? '').trim();
  if (!text || text.length > max) throw new Error(`${name} is missing or too long`);
  return text;
}

function timingSafeHexEqual(left, right) {
  const a = Buffer.from(String(left ?? ''), 'hex');
  const b = Buffer.from(String(right ?? ''), 'hex');
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function assertFreshTimestamp(timestamp, now = Date.now()) {
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds)) throw new Error('connector timestamp is invalid');
  if (Math.abs(now - seconds * 1000) > CONNECTOR_SIGNATURE_MAX_AGE_MS) {
    throw new Error('connector timestamp is too old or too far in the future');
  }
  return seconds;
}

export function verifySlackRequest({ rawBody, timestamp, signature, signingSecret, now = Date.now() }) {
  const body = String(rawBody ?? '');
  const secret = boundedString(signingSecret, 'Slack signing secret', 512);
  const ts = assertFreshTimestamp(timestamp, now);
  const presented = String(signature ?? '');
  if (!/^v0=[0-9a-f]{64}$/iu.test(presented)) throw new Error('Slack signature is invalid');
  const expected = `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;
  if (!timingSafeHexEqual(presented.slice(3), expected.slice(3))) throw new Error('Slack signature mismatch');
  return { provider: 'slack', timestamp: ts };
}

export function verifyDiscordInteraction({ rawBody, timestamp, signature, publicKey, now = Date.now() }) {
  const body = String(rawBody ?? '');
  const ts = assertFreshTimestamp(timestamp, now);
  const sig = Buffer.from(String(signature ?? ''), 'hex');
  if (sig.length !== 64) throw new Error('Discord signature is invalid');
  const keyText = String(publicKey ?? '').trim();
  // Discord publishes the Ed25519 public key as 32 raw bytes in hex. Accept
  // that wire format, plus PEM/DER for local tests and controlled adapters.
  const key = /^[0-9a-f]{64}$/iu.test(keyText)
    ? createPublicKey({
        key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(keyText, 'hex')]),
        format: 'der',
        type: 'spki',
      })
    : createPublicKey(keyText);
  if (!verifySignature(null, Buffer.from(`${ts}${body}`), key, sig)) throw new Error('Discord signature mismatch');
  return { provider: 'discord', timestamp: ts };
}

export function normalizeConnectorMessage({ provider, eventId, externalUserId, channelId, text }) {
  const normalizedProvider = String(provider ?? '').toLowerCase();
  if (!['discord', 'slack'].includes(normalizedProvider)) throw new Error('connector provider is unsupported');
  return Object.freeze({
    provider: normalizedProvider,
    eventId: boundedString(eventId, 'connector event id', 256),
    externalUserId: boundedString(externalUserId, 'connector user id', 256),
    channelId: boundedString(channelId, 'connector channel id', 256),
    text: boundedString(text, 'connector message'),
  });
}

export function readCommunicationConnectorStatus(env = process.env) {
  return Object.freeze({
    discord: Object.freeze({
      configured: Boolean(String(env.HELMION_DISCORD_APPLICATION_PUBLIC_KEY ?? '').trim()
        && String(env.HELMION_DISCORD_WEBHOOK_URL ?? '').trim()),
      inboundVerification: Boolean(String(env.HELMION_DISCORD_APPLICATION_PUBLIC_KEY ?? '').trim()),
      outboundDelivery: Boolean(String(env.HELMION_DISCORD_WEBHOOK_URL ?? '').trim()),
    }),
    slack: Object.freeze({
      configured: Boolean(String(env.HELMION_SLACK_SIGNING_SECRET ?? '').trim()
        && String(env.HELMION_SLACK_WEBHOOK_URL ?? '').trim()),
      inboundVerification: Boolean(String(env.HELMION_SLACK_SIGNING_SECRET ?? '').trim()),
      outboundDelivery: Boolean(String(env.HELMION_SLACK_WEBHOOK_URL ?? '').trim()),
    }),
    agentBridge: 'not-connected',
  });
}

function allowedWebhookUrl(value, provider) {
  let url;
  try { url = new URL(String(value ?? '')); } catch { throw new Error(`${provider} webhook URL is invalid`); }
  const allowed = provider === 'discord' ? DISCORD_WEBHOOK_HOSTS : SLACK_WEBHOOK_HOSTS;
  if (url.protocol !== 'https:' || !allowed.has(url.hostname) || url.username || url.password) {
    throw new Error(`${provider} webhook URL host is not allowlisted`);
  }
  return url;
}

export async function postConnectorMessage({ provider, text, env = process.env, fetchImpl = fetch, signal }) {
  const normalizedProvider = String(provider ?? '').toLowerCase();
  const bodyText = boundedString(text, 'connector message');
  const url = normalizedProvider === 'discord'
    ? allowedWebhookUrl(env.HELMION_DISCORD_WEBHOOK_URL, 'Discord')
    : normalizedProvider === 'slack'
      ? allowedWebhookUrl(env.HELMION_SLACK_WEBHOOK_URL, 'Slack')
      : (() => { throw new Error('connector provider is unsupported'); })();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(normalizedProvider === 'discord' ? { content: bodyText } : { text: bodyText }),
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`${normalizedProvider} webhook returned ${response.status}`);
    return { provider: normalizedProvider, delivered: true, status: response.status };
  } finally {
    clearTimeout(timeout);
  }
}
