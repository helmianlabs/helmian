import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../src/agent/redact.mjs';

/**
 * An audit on 2026-07-28 measured the redaction set against 18 inputs and found
 * live credential shapes passing through untouched. The worst was the connection
 * string pattern: it read `postgresql?:` — the `?` binds to the `l`, so it matched
 * "postgresql://" and "postgresq://" but NEVER the far more common "postgres://".
 * These tests pin each gap so it cannot silently reopen.
 */

const MUST_REDACT = [
  ['postgres:// (the bug)', 'postgres://user:sup3rs3cret@db.example.com/app', 'sup3rs3cret'],
  ['postgresql://', 'postgresql://user:hunter2pass@db.example.com/app', 'hunter2pass'],
  ['mysql://', 'mysql://root:mysqlpassword1@127.0.0.1:3306/db', 'mysqlpassword1'],
  ['mongodb+srv://', 'mongodb+srv://admin:mongopass99@cluster.mongodb.net', 'mongopass99'],
  ['redis://', 'redis://default:redissecret42@cache.example.com:6379', 'redissecret42'],
  ['stripe live', 'STRIPE=sk_live_51H8xKmABCDEfghIJKLmnop12', 'sk_live_51H8xKmABCDEfghIJKLmnop12'],
  ['stripe restricted', 'rk_live_51H8xKmABCDEfghIJKLmnop12', 'rk_live_51H8xKmABCDEfghIJKLmnop12'],
  ['aws akia', 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
  ['aws asia', 'ASIAY34FZKBOKMUTVV7A', 'ASIAY34FZKBOKMUTVV7A'],
  ['slack bot', 'xoxb-123456789012-abcdefghijklmnop', 'xoxb-123456789012-abcdefghijklmnop'],
  ['huggingface', 'HF_TOKEN=hf_AbCdEfGhIjKlMnOpQrStUvWxYz', 'hf_AbCdEfGhIjKlMnOpQrStUvWxYz'],
  ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N', 'dozjgNryP4J3jVmNHl0w5N'],
  ['neon npg_', 'npg_kAJDnzPv7K4Eexample', 'npg_kAJDnzPv7K4Eexample'],
  ['openai proj', 'sk-proj-AbCdEfGhIjKlMnOpQrStUv', 'sk-proj-AbCdEfGhIjKlMnOpQrStUv'],
  ['xai', 'xai-6OIu5CJWkS3pYBCVNNMKEV', 'xai-6OIu5CJWkS3pYBCVNNMKEV'],
];

for (const [label, input, secret] of MUST_REDACT) {
  test(`redacts ${label}`, () => {
    const out = redactSecrets(input);
    assert.equal(out.includes(secret), false, `secret survived redaction: ${out}`);
    assert.match(out, /\[REDACTED/);
  });
}

test('redacts a full private key block, body included', () => {
  const key = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEAxGT3JQnotarealkeybutlooksliketone123456789abcdef',
    'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/AAAAAAAAAAAAAAAAAAAAAAAAAA',
    '-----END RSA PRIVATE KEY-----',
  ].join('\n');
  const out = redactSecrets(key);
  assert.equal(out.includes('MIIEowIBAAKCAQEAxGT3JQ'), false);
  assert.match(out, /\[REDACTED PRIVATE KEY\]/);
});

test('does NOT redact ordinary text that merely looks technical', () => {
  // A scanner that flags everything is as useless as one that flags nothing.
  const benign = [
    'Connect to postgres://localhost/mydb for the dev database',
    'The function returns a token count, not a token',
    'See docs at https://example.com/api/keys for setup',
    'const skipped = items.filter(Boolean);',
  ].join('\n');
  const out = redactSecrets(benign);
  assert.equal(out.includes('[REDACTED'), false, `false positive: ${out}`);
});

test('non-string input passes through untouched', () => {
  assert.equal(redactSecrets(undefined), undefined);
  assert.equal(redactSecrets(42), 42);
});
