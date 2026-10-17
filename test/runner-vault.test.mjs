// Runner vault tests: AES-256-GCM round-trip, per-provider records, presence-only
// status, wipe, and fail-closed behavior (wrong master secret, missing token,
// unknown provider). Secrets never appear in status output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openVault, readDeviceToken, defaultVaultPath, PROVIDER_KEY_ENV } from '../src/runner/vault.mjs';

const TOKEN = 'test-device-token-0123456789abcdef';

async function freshVault() {
  const dir = await mkdtemp(join(tmpdir(), 'vault-test-'));
  const vaultPath = join(dir, 'vault.json');
  const vault = await openVault({ vaultPath, deviceToken: TOKEN });
  return { vault, vaultPath, dir };
}

test('set/get round-trips a provider key', async () => {
  const { vault } = await freshVault();
  await vault.set('gemini', 'api_key', 'secret-key-123');
  assert.equal(await vault.get('gemini'), 'secret-key-123');
});

test('get returns null for an absent provider', async () => {
  const { vault } = await freshVault();
  assert.equal(await vault.get('claude'), null);
});

test('status is presence-only: no secrets leak', async () => {
  const { vault } = await freshVault();
  await vault.set('gemini', 'api_key', 'secret-key-123');
  const rows = await vault.status();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'gemini');
  assert.equal(rows[0].credential_type, 'api_key');
  assert.ok(rows[0].updated_at);
  assert.ok(!JSON.stringify(rows).includes('secret-key-123'));
});

test('vault file at rest contains no plaintext', async () => {
  const { vaultPath, vault } = await freshVault();
  await vault.set('gemini', 'api_key', 'secret-key-123');
  const raw = await readFile(vaultPath, 'utf8');
  assert.ok(!raw.includes('secret-key-123'));
});

test('wrong master secret fails closed (no partial decrypt)', async () => {
  const { vaultPath, vault } = await freshVault();
  await vault.set('gemini', 'api_key', 'secret-key-123');
  const other = await openVault({ vaultPath, deviceToken: 'a-different-token-0123456789abcdef' });
  await assert.rejects(() => other.get('gemini'), /VAULT_DECRYPT_FAILED/);
});

test('short master secret is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-test-'));
  await assert.rejects(
    () => openVault({ vaultPath: join(dir, 'v.json'), deviceToken: 'short' }),
    /VAULT_NO_MASTER_SECRET/
  );
});

test('wipe removes a record and reports existence', async () => {
  const { vault } = await freshVault();
  await vault.set('gemini', 'api_key', 'secret-key-123');
  const wiped = await vault.wipe('gemini');
  assert.equal(wiped.existed, true);
  assert.equal(await vault.get('gemini'), null);
  const rewiped = await vault.wipe('gemini');
  assert.equal(rewiped.existed, false);
});

test('unknown provider is rejected', async () => {
  const { vault } = await freshVault();
  await assert.rejects(() => vault.set('nope', 'api_key', 'x'), /VAULT_UNKNOWN_PROVIDER/);
  await assert.rejects(() => vault.get('nope'), /VAULT_UNKNOWN_PROVIDER/);
});

test('empty value is rejected', async () => {
  const { vault } = await freshVault();
  await assert.rejects(() => vault.set('gemini', 'api_key', ''), /VAULT_EMPTY_VALUE/);
});

test('records survive reopen with the same token', async () => {
  const { vaultPath, vault } = await freshVault();
  await vault.set('openai', 'api_key', 'sk-abc');
  const reopened = await openVault({ vaultPath, deviceToken: TOKEN });
  assert.equal(await reopened.get('openai'), 'sk-abc');
});

test('readDeviceToken parses the bridge token file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-test-'));
  const p = join(dir, 'token.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(p, JSON.stringify({ token: TOKEN }));
  assert.equal(await readDeviceToken(p), TOKEN);
  assert.equal(await readDeviceToken(join(dir, 'missing.json')), null);
});

test('provider key env mapping covers the bridge providers', async () => {
  for (const p of ['gemini', 'claude', 'openai', 'grok', 'xai']) {
    assert.ok(PROVIDER_KEY_ENV[p], p);
  }
});

test('defaultVaultPath lives under the user home', async () => {
  assert.equal(defaultVaultPath('/home/u'), join('/home/u', '.helmian', 'vault.json'));
});
