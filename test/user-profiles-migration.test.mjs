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
