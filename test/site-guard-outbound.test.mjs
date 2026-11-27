// Helmian Site Guard outbound redaction (src/cloud/site-guard-outbound.mjs):
// secret-shaped text in a seat reply is replaced before it is stored;
// ordinary text that only looks similar is left alone.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  redactOutbound,
  isPublicIpv4,
  siteGuardOutboundRecord,
  siteGuardOutboundFinding,
} from '../src/cloud/site-guard-outbound.mjs';
import { normalizeGuardFinding } from '../src/cloud/guard-findings.mjs';

// Fake values built at run time so no scanner mistakes this file for a leak.
const FAKE_OPENAI = ['sk', 'proj', 'abcdefghijklmnopqrstuvwx1234567890ABCD'].join('-');
const FAKE_GH = `ghp_${'abcdefghijklmnopqrstuvwxyz0123456789'}`;
const FAKE_PEM = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEAfakefakefake', '-----END RSA PRIVATE KEY-----'].join('\n');
const PUBLIC_IP = [93, 184, 216, 34].join('.');
const DASHED_HOST = `voice.${[93, 184, 216, 34].join('-')}.sslip.io`;
const FAKE_HEX_A = ['abc123', 'def456'].join('');
const FAKE_HEX_B = ['9f8e7d', '6c5b4a'].join('');

const MUST_REDACT = [
  [`Your key is ${FAKE_OPENAI}`, FAKE_OPENAI],
  [`Token ${FAKE_GH} works`, FAKE_GH],
  [FAKE_PEM, 'MIIEowIBAAKCAQEAfakefakefake'],
  ['password: hunter2!', 'hunter2!'],
  ['DB_PASSWORD=S3cretValue', 'S3cretValue'],
  [`The API_KEY="${FAKE_HEX_A}"`, FAKE_HEX_A],
  ['Your password is hunter2!', 'hunter2!'],
  [`client_secret = ${FAKE_HEX_B}`, FAKE_HEX_B],
  ['connect with postgres://admin:pa55w0rd@db.example.com:5432/app', 'pa55w0rd'],
  ['ftp://deploy:Tr0ub4dor@files.example.com/', 'Tr0ub4dor'],
  [`The server is at ${PUBLIC_IP}, port 22`, PUBLIC_IP],
  [`Use https://${DASHED_HOST}/tts`, DASHED_HOST],
];

const MUST_KEEP = [
  'The password is wrong, try again.',
  'Reset your password in Settings > Security.',
  'Set api_key to your own key from the dashboard.',
  'The token field must be at least 8 characters.',
  'The secret: keep practicing every day.',
  'token expired',
  'commit 18ed2b4e9f0c3a1b2c3d4e5f60718293a4b5c6d7 fixed it',
  'sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  'request id 3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  'Version 1.2.3.4 is out, also v10.0.0.1',
  'LAN printer at 192.168.1.20 and 10.0.0.5, router 172.16.0.1, localhost 127.0.0.1',
  'Use DNS 8.8.8.8 or 1.1.1.1',
  'Docs IP 203.0.113.5 and 198.51.100.7',
  'Load ID 2026.11.26.1 is on time',
  'Call 303.555.1234',
  'Visit https://helmian.com/pricing for details.',
  'The meeting is at 10:30, room 4.',
];

test('outbound: secret-shaped text is redacted, and the original never survives', () => {
  for (const [text, secret] of MUST_REDACT) {
    const result = redactOutbound(text);
    assert.equal(result.redacted, true, text);
    assert.ok(!result.text.includes(secret), `${text} -> ${result.text}`);
    assert.match(result.text, /\[REDACTED/);
  }
});

test('outbound: look-alikes are left untouched', () => {
  for (const text of MUST_KEEP) {
    const result = redactOutbound(text);
    assert.equal(result.redacted, false, `${text} -> ${result.text}`);
    assert.equal(result.text, text);
  }
});

test('outbound: kinds and counts, never the value', () => {
  const result = redactOutbound(`a ${FAKE_GH} b password: hunter2! c ${PUBLIC_IP}`);
  const kinds = Object.fromEntries(result.redactions.map((r) => [r.kind, r.count]));
  assert.deepEqual(kinds, { 'known-token': 1, 'labeled-secret': 1, 'server-address': 1 });
  const record = siteGuardOutboundRecord(result);
  assert.equal(record.kind, 'helmian-site-guard-outbound-redaction');
  assert.ok(!JSON.stringify(record).includes('hunter2'));
  // A URL password is counted once, not twice.
  assert.equal(redactOutbound('postgres://u:pa55w0rd@h/db').redactions.reduce((n, r) => n + r.count, 0), 1);
});

test('outbound: the finding passes the store normalizer and carries no text', () => {
  const result = redactOutbound('password: hunter2!');
  const input = siteGuardOutboundFinding(result, { channelId: 'c1', channelSlug: 'support', messageId: 'm1', provider: 'claude', at: '2026-11-26T20:00:00.000Z' });
  const normalized = normalizeGuardFinding(input);
  assert.equal(normalized.source, 'site-guard');
  assert.equal(normalized.severity, 'warning');
  assert.equal(input.fingerprint, 'helmian-site-guard:outbound-secret:m1');
  assert.match(input.title, /redacted secret-looking text from a seat reply in #support/);
  assert.ok(!JSON.stringify(input).includes('hunter2'));
  assert.equal(siteGuardOutboundFinding(redactOutbound('hello'), { channelId: 'c', messageId: 'm', at: 'x' }), null);
});

test('outbound: public vs private IPv4 ranges', () => {
  for (const ip of ['10.1.2.3', '172.31.0.1', '192.168.0.1', '127.0.0.1', '169.254.1.1', '100.64.0.1', '0.1.2.3', '224.0.0.1', '192.0.2.1', '198.18.0.1', '203.0.113.9']) {
    assert.equal(isPublicIpv4(ip), false, ip);
  }
  for (const ip of [PUBLIC_IP, '172.32.0.1', '100.128.0.1', '11.0.0.1']) assert.equal(isPublicIpv4(ip), true, ip);
  assert.equal(isPublicIpv4('256.1.1.1'), false);
});

test('outbound: non-strings and empty text pass through', () => {
  assert.equal(redactOutbound('').redacted, false);
  assert.equal(redactOutbound(null).redacted, false);
});

const url = process.env.HELMIAN_TEST_PG_URL;
const skip = !url && 'HELMIAN_TEST_PG_URL not set';

test('mesh: a seat reply carrying a secret is stored redacted and witnessed; a clean reply is untouched', { skip }, async () => {
  const { randomUUID } = await import('node:crypto');
  const pg = (await import('pg')).default;
  const { createEnvoyMesh } = await import('../src/cloud/envoy-mesh.mjs');
  const { createEnvoyStore } = await import('../src/cloud/envoy-chat.mjs');
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const tenantId = `t-${randomUUID().slice(0, 8)}`;
  const owner = { tenantId, subject: `user_${randomUUID().replaceAll('-', '').slice(0, 20)}`, role: 'owner', get sessionId() { return randomUUID(); }, get requestId() { return randomUUID(); } };
  const device = { tenantId, subject: owner.subject, role: 'owner', viaDeviceToken: true };
  await pool.query('insert into helmion.tenants(tenant_id, display_name) values ($1,$2)', [tenantId, 'Site Guard outbound test']);
  await pool.query('insert into helmion.tenant_memberships(tenant_id, subject, role) values ($1,$2,$3)', [tenantId, owner.subject, 'owner']);
  const calls = [];
  const guardStore = { async ingestFinding(actor, input) { calls.push({ actor, input }); return { durability: 'committed', inserted: true }; } };
  const mesh = createEnvoyMesh({ pool, guardStoreImpl: guardStore, publishImpl: async () => {}, nameLookup: async () => 'Troy' });
  const chat = createEnvoyStore(pool);
  try {
    const { channel } = await chat.createChannel(owner, { slug: 'support', title: 'support', kind: 'team' });
    await mesh.changeConfig(owner, { action: 'add-agent', channelId: channel.id, provider: 'claude' });
    const ask = (await chat.appendMessage(owner, { channelId: channel.id, body: 'How do I connect to the reporting database?', idempotencyKey: randomUUID() })).receipt.message;
    const clean = (await chat.appendMessage(owner, { channelId: channel.id, body: 'Morning, status of the Henderson load?', idempotencyKey: randomUUID() })).receipt.message;
    const leaky = `Use postgres://report:pa55w0rd@db.example.com/app and the key ${FAKE_GH}.`;
    await mesh.postAsAgent(device, { channelId: channel.id, provider: 'claude', replyTo: ask.id, body: leaky });
    await mesh.postAsAgent(device, { channelId: channel.id, provider: 'claude', replyTo: clean.id, body: 'On time, arriving 3 PM.' });
    const listed = await chat.listMessages(owner, channel.id);
    const replies = listed.messages.filter((m) => m.authorKind === 'agent');
    const redacted = replies.find((m) => m.body.startsWith('Use postgres://'));
    assert.ok(redacted, 'the reply was stored');
    assert.ok(!redacted.body.includes('pa55w0rd') && !redacted.body.includes(FAKE_GH), redacted.body);
    const { rows } = await pool.query("select body, metadata from helmion.envoy_messages where tenant_id=$1 and author_kind='agent'", [tenantId]);
    assert.ok(rows.every((r) => !r.body.includes('pa55w0rd')), 'no raw secret anywhere in the table');
    const meta = rows.find((r) => r.body.startsWith('Use postgres://')).metadata;
    assert.equal(meta.siteGuardOutbound.kind, 'helmian-site-guard-outbound-redaction');
    assert.ok(!('guard' in meta), 'not marked as a refusal record');
    assert.ok(replies.some((m) => m.body === 'On time, arriving 3 PM.'), 'clean reply untouched');
    const findings = calls.filter((c) => c.input.detail.class === 'outbound-secret');
    assert.equal(findings.length, 1);
    assert.ok(!JSON.stringify(findings[0].input).includes('pa55w0rd'));
  } finally {
    await pool.end();
  }
});
