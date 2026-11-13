#!/usr/bin/env node
// Mint or disable a Muse connector key (sql/087,
// src/cloud/muse-connector.mjs). Operator road only — this is how a
// key for the Muse-to-Helmian connector is born and how it dies.
//
//   HELMION_DATABASE_URL=<neon url> node bin/mint-muse-connector-key.mjs --tenant-id <tenantId> --label "Muse (main)"
//   HELMION_DATABASE_URL=<neon url> node bin/mint-muse-connector-key.mjs --disable <keyId>
//
// Mint prints the key EXACTLY ONCE, on the line marked KEY:. That
// plaintext is never stored anywhere — the database keeps only its
// SHA-256 hash — so the operator's one job at mint time is to place
// the printed value straight into Muse's secure connection storage
// through the secure flow. If the value is lost, mint a new key and
// disable the old row; the old one cannot be recovered or read back.
//
// Disable is the revocation road inside Helmian: the row is flagged
// off and stamped, and the key stops working on the next call.
import { Pool } from 'pg';
import { createMuseConnectorKeyStore } from '../src/cloud/muse-connector.mjs';

const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};

const connectionString = String(process.env.HELMION_DATABASE_URL ?? '').trim();
if (!connectionString) {
  console.error('HELMION_DATABASE_URL is required (the app\'s Neon pooled URL).');
  process.exit(2);
}
const pool = new Pool({ connectionString, ssl: connectionString.includes('sslmode=disable') ? false : undefined, max: 1 });
const store = createMuseConnectorKeyStore(pool);
try {
  const disableId = get('--disable');
  if (disableId) {
    const done = await store.disable(disableId);
    console.log(done ? `Disabled key ${disableId}; it stops working on the next call.` : `No key row with id ${disableId}.`);
    process.exit(done ? 0 : 1);
  }
  const tenantId = get('--tenant-id');
  const label = get('--label') ?? 'Muse connector';
  if (!tenantId) {
    console.error('Usage: --tenant-id <tenantId> [--label <label>] | --disable <keyId>');
    process.exit(2);
  }
  const minted = await store.mint(tenantId, label);
  console.log(`Minted Muse connector key ${minted.id} for tenant ${minted.tenantId} (label: ${minted.label}).`);
  console.log('Place the value on the next line into Muse\'s secure connection storage now; it is shown once and never stored.');
  console.log(`KEY: ${minted.key}`);
} catch (error) {
  if (error?.status === 503) console.error('The key table is not there yet: apply sql/087 first.');
  else console.error(`Failed: ${error?.message ?? error}`);
  process.exit(1);
} finally {
  await pool.end().catch(() => {});
}
