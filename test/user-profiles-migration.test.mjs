import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('062 repairs user_profiles without the undefined set_updated_at() trigger', () => {
  const sql = readFileSync(new URL('../sql/062_user_profiles_repair.sql', import.meta.url), 'utf8');
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.match(code, /create table if not exists helmion\.user_profiles/);
  assert.doesNotMatch(code, /set_updated_at/);
  assert.doesNotMatch(code, /create trigger/i);
});

test('059 creates user_profiles without calling the undefined set_updated_at()', () => {
  // Regression guard for the live defect: 059 originally ended with a
  // trigger executing helmion.set_updated_at(), which no migration
  // defines, so the file failed as a whole and the table never existed —
  // the Envoy profile save (Settings > ENVOY PROFILE) could not persist.
  const sql = readFileSync(new URL('../sql/059_user_profiles.sql', import.meta.url), 'utf8');
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(code, /set_updated_at/);
  assert.doesNotMatch(code, /create trigger/i);
  // The table must carry exactly the columns user-profile.mjs reads/writes.
  assert.match(code, /create table if not exists helmion\.user_profiles/);
  for (const column of ['subject', 'nickname', 'avatar_emoji', 'created_at', 'updated_at']) {
    assert.match(code, new RegExp(`\\b${column}\\b`), `059 must declare ${column}`);
  }
});
