import assert from 'node:assert/strict';
import test from 'node:test';
import { REDACTION_TYPES, redactSensitivePrompt } from '../background/redact.js';

test('redaction removes PII and secret values while returning type/count telemetry only', () => {
  const input = 'Email jane.doe@example.com, SSN 123-45-6789, card 4111 1111 1111 1111, token=super-secret-value';
  const result = redactSensitivePrompt(input);
  assert.match(result.text, /\[REDACTED:email\]/u);
  assert.match(result.text, /\[REDACTED:ssn\]/u);
  assert.match(result.text, /\[REDACTED:credit_card\]/u);
  assert.match(result.text, /token=\[REDACTED:secret_assignment\]/u);
  assert.doesNotMatch(result.text, /jane\.doe|123-45-6789|4111|super-secret/u);
  assert.deepEqual(result.telemetry.redactedTypes, ['credit_card', 'email', 'secret_assignment', 'ssn']);
  assert.equal(result.telemetry.redactedCount, 4);
  assert.doesNotMatch(JSON.stringify(result.telemetry), /jane|123|4111|secret-value/u);
});

test('redaction catches provider-shaped credentials and private keys', () => {
  const result = redactSensitivePrompt('sk-test_123456789012 ghp_12345678901234567890\n-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----');
  assert.match(result.text, /\[REDACTED:api_key\]/gu);
  assert.match(result.text, /\[REDACTED:private_key\]/u);
  assert.deepEqual(result.telemetry.redactedTypes, ['api_key', 'private_key']);
});

test('clean prompts are unchanged and produce zero-data telemetry', () => {
  const result = redactSensitivePrompt('Explain how to review a pull request.');
  assert.equal(result.text, 'Explain how to review a pull request.');
  assert.deepEqual(result.telemetry, { redactedCount: 0, redactedTypes: [] });
  assert.ok(REDACTION_TYPES.includes('email'));
});
