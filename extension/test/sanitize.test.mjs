// The privacy detector the send-time check and the paste check use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadContentScript } from '../test-support/load-content-script.mjs';
import { redactSensitivePrompt, REDACTION_TYPES } from '../background/redact.js';

const { HelmionSanitize: S } = await loadContentScript('content/sanitize.js');

const SECRETS = {
  api_key: ['sk-proj-abcdefghijklmnop1234', 'ghp_abcdefghijklmnopqrstuvwx12', 'AKIAABCDEFGHIJKLMNOP', 'AIzaSyA1234567890abcdefghijklmno', 'sk_live_abcdefghijklmnop1234', 'xoxb-1234567890-abcdefghij'],
  private_key: ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----'],
  bearer_token: ['Authorization: Bearer abcdefghijklmnop.qrstuv'],
  secret_assignment: ['password: hunter2xyz', 'API_KEY="s3cr3tvalue99"', 'client_secret=abc123def456'],
  credit_card: ['4242 4242 4242 4242', '5555-5555-5555-4444', '378282246310005'],
};
const PII = {
  email: ['troy@gmail.com'],
  ssn: ['123-45-6789'],
  phone: ['720-867-5309', '(303) 449-1234'],
  ipv4: ['73.14.201.9'],
};

test('every secret type is found, classed as a secret, and removed from the redacted text', () => {
  for (const [type, samples] of Object.entries(SECRETS)) {
    for (const sample of samples) {
      const result = S.scan(`please use ${sample} for this`);
      assert.ok(result.hasSecrets, `${type} not found in: ${sample}`);
      assert.ok(result.counts[type] >= 1, `${sample} was not typed as ${type}: ${JSON.stringify(result.counts)}`);
      assert.ok(result.signals.includes(`secret:${type}`));
      const tail = sample.replace(/\s/g, '').slice(-6);
      assert.ok(!result.redacted.replace(/\s/g, '').includes(tail), `the redacted text still carries ${sample}`);
    }
  }
});

test('personal details are found and classed as pii, not secrets', () => {
  for (const [type, samples] of Object.entries(PII)) {
    for (const sample of samples) {
      const result = S.scan(`contact: ${sample}`);
      assert.ok(result.hasPii, `${type} not found in ${sample}`);
      assert.equal(result.hasSecrets, false, `${sample} was classed as a secret`);
      assert.ok(result.signals.includes(`pii:${type}`));
    }
  }
});

test('a number that fails the Luhn check is not a card', () => {
  assert.equal(S.scan('order 1234 5678 9012 3456').found, false);
  assert.equal(S.scan('tracking 1111111111111111').found, false);
});

test('placeholders and documentation examples are left alone', () => {
  for (const text of [
    'set OPENAI_API_KEY=YOUR_API_KEY',
    'export TOKEN=sk-xxxxxxxxxxxxxxxxxxxx',
    'email me at someone@example.com',
    'call 555-555-1234',
    'password: <your password>',
    'localhost is 127.0.0.1',
  ]) {
    assert.equal(S.scan(text).found, false, `flagged a placeholder: ${text}`);
  }
});

test('ordinary writing is clean', () => {
  for (const text of [
    'How do I reverse a linked list in Python?',
    'The meeting is at 3:30 on 10/22/2026 in room 204.',
    'Version 1.2.3 fixed the bug; see issue #4521.',
    'My password policy requires 12 characters.',
  ]) {
    assert.equal(S.scan(text).found, false, `flagged ordinary text: ${text}`);
  }
});

test('describe names what was found in plain words', () => {
  assert.equal(S.describe(S.scan('key sk-proj-abcdefghijklmnop1234')), 'an API key');
  assert.match(S.describe(S.scan('a@gmail.com b@gmail.com')), /2 × email address/);
});

test('PARITY: every type background/redact.js knows, the content-script twin knows too', () => {
  for (const type of REDACTION_TYPES) assert.ok(S.TYPES.includes(type), `sanitize.js is missing ${type}`);
});

test('PARITY: whatever the twin redacts as a secret, redact.js also redacts', () => {
  for (const samples of Object.values(SECRETS)) {
    for (const sample of samples) {
      const twin = S.scan(sample);
      const background = redactSensitivePrompt(sample);
      assert.ok(twin.hasSecrets);
      assert.ok(background.telemetry.redactedCount >= 1, `redact.js missed ${sample}`);
    }
  }
});

test('the redacted text keeps the assignment name so the message still reads', () => {
  assert.equal(S.scan('password: hunter2xyz').redacted, 'password: [REDACTED:secret_assignment]');
});
