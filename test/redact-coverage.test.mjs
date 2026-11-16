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
  // The 2026-11-15 audit (letter 719) found the shapes below passing through
  // untouched even though the Guard extension scanners, the hands protocol,
  // and the audit log already carried several of them. Pinned 2026-11-16.
  ['nvidia nvapi-', 'NVIDIA_API_KEY=nvapi-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', 'nvapi-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
  ['github fine-grained pat', 'token: github_pat_11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789', 'github_pat_11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'],
  ['github ghu_', 'ghu_AbCdEfGhIjKlMnOpQrStUvWxYz012345', 'ghu_AbCdEfGhIjKlMnOpQrStUvWxYz012345'],
  ['github ghr_', 'ghr_AbCdEfGhIjKlMnOpQrStUvWxYz012345', 'ghr_AbCdEfGhIjKlMnOpQrStUvWxYz012345'],
  ['webhook whsec_', 'WEBHOOK_SECRET=whsec_AbCdEfGhIjKlMnOpQrStUvWxYz0123', 'whsec_AbCdEfGhIjKlMnOpQrStUvWxYz0123'],
  ['slack app xapp-', 'SLACK_APP_TOKEN=xapp-1-A0123456789-0123456789012-abcdef0123456789abcdef0123456789', 'xapp-1-A0123456789-0123456789012-abcdef0123456789abcdef0123456789'],
  ['slack xoxe refresh', 'xoxe-123456789012-abcdefghijklmnop', 'xoxe-123456789012-abcdefghijklmnop'],
  ['discord bot', 'DISCORD_BOT_TOKEN=AAAAAAAAAAAAAAAAAAAAAAAA.BBBBBB.CCCCCCCCCCCCCCCCCCCCCCCCCCC', 'AAAAAAAAAAAAAAAAAAAAAAAA.BBBBBB.CCCCCCCCCCCCCCCCCCCCCCCCCCC'],
  ['gitlab glpat-', 'glpat-AbCdEfGhIjKlMnOpQrSt', 'glpat-AbCdEfGhIjKlMnOpQrSt'],
  ['resend re_', 'RESEND=re_12345678_abcdefghijklmnop', 're_12345678_abcdefghijklmnop'],
  ['google oauth ya29.', 'access_token: ya29.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', 'ya29.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
  ['mistral named assignment', 'MISTRAL_API_KEY=fakefakefakefakefakefakefakefake', 'fakefakefakefakefakefakefakefake'],
  ['cloudflare named assignment', 'CLOUDFLARE_API_TOKEN=fakefakefakefakefakefakefakefakefakefake', 'fakefakefakefakefakefakefakefakefakefake'],
  ['cloudflare json assignment', '"CLOUDFLARE_API_TOKEN": "fakefakefakefakefakefakefakefakefakefake"', 'fakefakefakefakefakefakefakefakefakefake'],
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

test('does NOT redact bare hashes, ids, or bare prefixes', () => {
  // The prefix-less formats (Mistral, Cloudflare) are covered only under
  // their credential names, on purpose: a bare 32 or 40 character string is
  // as likely to be a hash or an id as a key, and eating those would make
  // redacted output useless. Bare prefixes with no body are not secrets
  // either (the Guard README makes the same call).
  const benign = [
    'md5 d41d8cd98f00b204e9800998ecf8427e',
    'commit a4e870cb19ff5c1c7dd5fa7a085b9255e5263761',
    'session 0d7ca4d3-a2f4-458a-936b-d8a002a569e0',
    'Set WEBHOOK_SECRET=whsec_ in the env file before deploying',
    'The github_pat_ prefix marks a fine-grained token',
    'product id AbCdEfGhIjKlMnOpQrStUvWxYz012345 shipped',
  ].join('\n');
  const out = redactSecrets(benign);
  assert.equal(out.includes('[REDACTED'), false, `false positive: ${out}`);
});

test('non-string input passes through untouched', () => {
  assert.equal(redactSecrets(undefined), undefined);
  assert.equal(redactSecrets(42), 42);
});
