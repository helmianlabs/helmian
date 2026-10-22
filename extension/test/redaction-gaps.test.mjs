// The local rules now also catch what Paul's Flags scanner
// (server.src/app/src/flags/scanner.ts) catches and Guard used to miss.
// Both twins (content/sanitize.js and background/redact.js) must agree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadContentScript } from '../test-support/load-content-script.mjs';
import { redactSensitivePrompt } from '../background/redact.js';
import { evaluateLocal } from '../background/local-policy.js';
import { FAKE } from '../test-support/fake-secrets.mjs';
import { evaluatePolicy } from '../../executive-guard/src/policy.mjs';

const { HelmionSanitize: S } = await loadContentScript('content/sanitize.js');

const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

// [sample, expected type, the secret part that must disappear]
const CATCH = [
  [FAKE.whsec, 'api_key', 'CCCCCC'],
  [FAKE.resend, 'api_key', 'ResendKey0000'],
  [FAKE.stripeTest, 'api_key', 'RealKey0000000'],
  [FAKE.stripeRestrictedTest, 'api_key', 'RealKey0000000'],
  [FAKE.awsTemp, 'api_key', 'NOTREAL0'],
  [FAKE.slackRefresh, 'api_key', 'notreal0000000'],
  [JWT, 'jwt', 'Qssw5c'],
  ['postgres://app:Sup3rS3cret@db.internal:5432/main', 'connection_string', 'Sup3rS3cret'],
  ['mongodb+srv://admin:hunter2pw@cluster0.mongodb.net/x', 'connection_string', 'hunter2pw'],
  ['redis://default:Zq8tYp1x@cache:6379', 'connection_string', 'Zq8tYp1x'],
  ['my password is hunter2!', 'secret_assignment', 'hunter2'],
  ['The API key is: abc123def456.', 'secret_assignment', 'abc123def456'],
  ['passphrase was Tr0ub4dor&3', 'secret_assignment', 'Tr0ub4dor'],
  ['passphrase: Tr0ub4dor&3', 'secret_assignment', 'Tr0ub4dor'],
  [`AWS_SECRET_ACCESS_KEY="${FAKE.awsSecret}"`, 'api_key', 'SecretAccessKey00'],
];

test('a labelled SSN without dashes is found as pii (the label is kept)', () => {
  for (const text of ['SSN 123 45 6789', 'ssn#123456789', 'Social Security number: 123456789']) {
    const twin = S.scan(text);
    assert.ok(twin.signals.includes('pii:ssn'), `missed ${text}: ${JSON.stringify(twin.counts)}`);
    assert.equal(twin.hasSecrets, false);
    assert.doesNotMatch(twin.redacted, /6789/);
    assert.doesNotMatch(redactSensitivePrompt(text).text, /6789/);
  }
  assert.equal(S.scan('SSN 123 45 6789').redacted, 'SSN [REDACTED:ssn]');
  assert.equal(S.scan('order 123456789 shipped').found, false, 'bare 9 digits are not an SSN');
});

test('each new pattern is found, classed as a secret, typed, and removed by both twins', () => {
  for (const [sample, type, secret] of CATCH) {
    const text = `please use ${sample} for this`;
    const twin = S.scan(text);
    assert.ok(twin.hasSecrets, `sanitize.js missed: ${sample}`);
    assert.ok(twin.counts[type] >= 1, `${sample} typed ${JSON.stringify(twin.counts)}, wanted ${type}`);
    assert.ok(twin.signals.includes(`secret:${type}`));
    assert.ok(!twin.redacted.includes(secret), `sanitize.js left ${secret} in: ${twin.redacted}`);
    const bg = redactSensitivePrompt(text);
    assert.ok(bg.telemetry.redactedTypes.includes(type), `redact.js typed ${bg.telemetry.redactedTypes} for ${sample}`);
    assert.ok(!bg.text.includes(secret), `redact.js left ${secret} in: ${bg.text}`);
  }
});

test('a connection string keeps everything but the password, so the message still reads', () => {
  const url = 'postgres://app:Sup3rS3cret@db.internal:5432/main';
  assert.equal(S.scan(url).redacted, 'postgres://app:[REDACTED:connection_string]@db.internal:5432/main');
  assert.equal(redactSensitivePrompt(url).text, 'postgres://app:[REDACTED:connection_string]@db.internal:5432/main');
  assert.equal(S.scan('my password is hunter2!').redacted, 'my password is [REDACTED:secret_assignment]!');
});

test('false positives: ordinary prose, code and doc templates stay clean', () => {
  for (const text of [
    'My password is required to be 12 characters.',
    'The password is incorrect, try again.',
    'Your password was changed yesterday.',
    'the access token is expired',
    'password is at least 8 characters',
    'An API key is a secret string you keep private.',
    'postgres://user:password@localhost:5432/app',
    'postgres://user:${DB_PASSWORD}@db:5432/app',
    'mysql://root:$MYSQL_PWD@127.0.0.1/db',
    'redis://default:****@cache:6379',
    'postgres://localhost/app and https://user@host.example',
    'call re_validate_email_address_formatter(x)',
    'a regex re_compile_pattern_object_cache',
    'whsec_ is the prefix Stripe uses for webhook secrets',
    'pk_test_51Habcdefghijklmnop0123 is a publishable key',
    'ASIA is a continent; AKIA is not a word',
    'eyJ is how base64 JSON starts',
    'sk_test_ keys start like this',
    'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'set aws_secret_access_key in ~/.aws/credentials',
    'the passphrase is long',
  ]) {
    const twin = S.scan(text);
    assert.equal(twin.hasSecrets, false, `sanitize.js flagged: ${text} -> ${JSON.stringify(twin.counts)}`);
  }
});

test('background redaction does not mangle ordinary prose either', () => {
  for (const text of [
    'My password is required to be 12 characters.',
    'The password is incorrect, try again.',
    'call re_validate_email_address_formatter(x)',
    'ASIA is a continent',
  ]) assert.equal(redactSensitivePrompt(text).text, text);
});

test('policy: the new secret types are blocked offline and by Executive Guard alike', () => {
  for (const signal of ['secret:jwt', 'secret:connection_string']) {
    const action = { kind: 'prompt.send', riskSignals: [signal] };
    assert.equal(evaluateLocal(action).verdict, 'deny');
    assert.equal(evaluateLocal(action).ruleId, 'secrets-never-leave');
    assert.equal(evaluatePolicy(action).verdict, 'deny');
  }
});

test('describe names the new types in plain words', () => {
  assert.equal(S.describe(S.scan(JWT)), 'a signed token (JWT)');
  assert.equal(S.describe(S.scan('postgres://a:Pw0rd123@h/db')), 'a password in a connection string');
});
