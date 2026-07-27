import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const schemaUrl = new URL('../sql/002_maestro_phase_one.sql', import.meta.url);
const confirmationSchemaUrl = new URL('../sql/003_human_confirmations.sql', import.meta.url);

test('Maestro migration enforces one active database lease per project', async () => {
  const sql = await readFile(schemaUrl, 'utf8');
  assert.match(
    sql,
    /create unique index[\s\S]+on helmion\.maestro_leases\(project_slug\)[\s\S]+where status = 'ACTIVE'/i,
  );
});

test('Maestro migration persists checkpoints, handoffs, and idempotent operation results', async () => {
  const sql = await readFile(schemaUrl, 'utf8');
  assert.match(sql, /create table if not exists helmion\.project_checkpoints/i);
  assert.match(sql, /create table if not exists helmion\.maestro_handoffs/i);
  assert.match(sql, /unique \(project_slug, idempotency_key\)/i);
  assert.match(sql, /status = 'INCOMPLETE'[\s\S]+requires_human_confirmation = true/i);
});

test('human confirmation migration stores trusted identities and one-time action bindings', async () => {
  const sql = await readFile(confirmationSchemaUrl, 'utf8');
  assert.match(sql, /create table if not exists helmion\.human_identity_keys/i);
  assert.match(sql, /algorithm text not null check \(algorithm = 'Ed25519'\)/i);
  assert.match(sql, /create table if not exists helmion\.human_handoff_confirmations/i);
  assert.match(sql, /action_hash text not null check \(action_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/i);
  assert.match(sql, /unique \(identity_key_id, nonce\)/i);
  assert.match(sql, /consumed_at is null[\s\S]+consumed_at is not null/i);
  assert.match(sql, /'CONSUME_CONFIRMATION'/i);
});
