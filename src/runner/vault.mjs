// Runner credential vault (v1): per-user encrypted store for provider keys.
// Principle: credentials live with the compute that calls the provider.
// The cloud never sees plaintext; it only learns presence ("gemini: connected").
//
// At-rest encryption: AES-256-GCM. The data key is derived from the bridge's
// device token (the pairing secret established at link time) via HKDF, so
// wiping the device token crypto-shreds the vault. No new master secret to
// manage. Fail-closed: a missing or wrong token means the vault does not open.
//
// v1 scope: paste-a-key storage (API keys, long-lived tokens). No OAuth
// device flows yet (v2). Single-user (the runner owner); per-tenant vaults
// are a later step if the runner ever becomes shared.
import { hkdfSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const VAULT_VERSION = 1;
const KEY_INFO = 'helmian-vault-v1';

// Provider name -> env var the agent child reads (kept in sync with
// bin/pc-bridge.mjs and src/agent/providers.mjs).
export const PROVIDER_KEY_ENV = {
  gemini: 'GEMINI_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  grok: 'XAI_API_KEY',
  xai: 'XAI_API_KEY',
};

function deriveDataKey(deviceToken, salt) {
  if (!deviceToken || typeof deviceToken !== 'string' || deviceToken.length < 16) {
    throw new Error('VAULT_NO_MASTER_SECRET');
  }
  return hkdfSync('sha256', deviceToken, salt, KEY_INFO, 32);
}

function encrypt(dataKey, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: ciphertext.toString('base64'),
  };
}

function decrypt(dataKey, record) {
  const decipher = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(record.data, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

async function readVaultFile(vaultPath) {
  try {
    const raw = await readFile(vaultPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.version !== VAULT_VERSION || typeof parsed?.salt !== 'string' || typeof parsed?.records !== 'object') {
      throw new Error('VAULT_CORRUPT');
    }
    return parsed;
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

// Opens the vault at vaultPath using deviceToken as the master secret.
// Returns a handle { set, get, wipe, status }. All crypto is local.
export async function openVault({ vaultPath, deviceToken }) {
  const file = await readVaultFile(vaultPath);
  const salt = file ? Buffer.from(file.salt, 'base64') : randomBytes(16);
  const dataKey = deriveDataKey(deviceToken, salt);
  let records = file?.records ?? {};

  async function persist() {
    await mkdir(dirname(vaultPath), { recursive: true });
    const tmp = `${vaultPath}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: VAULT_VERSION, salt: salt.toString('base64'), records }, null, 2), { mode: 0o600 });
    await rename(tmp, vaultPath);
  }

  function normProvider(provider) {
    const p = String(provider || '').toLowerCase();
    if (!PROVIDER_KEY_ENV[p]) throw new Error(`VAULT_UNKNOWN_PROVIDER:${provider}`);
    return p;
  }

  return {
    // Stores a credential. Never logs or returns the plaintext.
    async set(provider, credentialType, plaintext) {
      const p = normProvider(provider);
      if (!plaintext || typeof plaintext !== 'string') throw new Error('VAULT_EMPTY_VALUE');
      records[p] = {
        credential_type: String(credentialType || 'api_key'),
        updated_at: new Date().toISOString(),
        ...encrypt(dataKey, plaintext),
      };
      await persist();
      return { ok: true, provider: p };
    },

    // Returns the plaintext credential, or null when absent.
    async get(provider) {
      const p = normProvider(provider);
      const rec = records[p];
      if (!rec) return null;
      try {
        return decrypt(dataKey, rec);
      } catch {
        // Wrong master secret (or tampered file): fail closed, never partial.
        throw new Error('VAULT_DECRYPT_FAILED');
      }
    },

    async wipe(provider) {
      const p = normProvider(provider);
      const existed = Boolean(records[p]);
      delete records[p];
      await persist();
      return { ok: true, provider: p, existed };
    },

    // Presence-only: provider names + timestamps, never secrets.
    async status() {
      return Object.entries(records).map(([provider, rec]) => ({
        provider,
        credential_type: rec.credential_type,
        updated_at: rec.updated_at,
      }));
    },
  };
}

// Reads the bridge's device token from its token file. Returns null when
// the bridge has never paired (vault stays closed until pairing).
export async function readDeviceToken(tokenPath) {
  try {
    const raw = await readFile(tokenPath, 'utf8');
    const parsed = JSON.parse(raw);
    const token = parsed?.token || parsed?.deviceToken || null;
    return typeof token === 'string' && token.length >= 16 ? token : null;
  } catch {
    return null;
  }
}

// Default vault path for a user: ~/.helmian/vault.json (0600).
export function defaultVaultPath(homeDir) {
  return join(homeDir, '.helmian', 'vault.json');
}
