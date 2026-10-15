import test from 'node:test';
import assert from 'node:assert/strict';
import { assertExpectedNeonEndpoint } from '../src/core/database-target.mjs';

test('self-hosted pin accepts exact host/db and refuses mismatches', () => {
  const t = assertExpectedNeonEndpoint('postgres://u:p@db:5432/helmion?sslmode=disable', 'self-hosted:db/helmion');
  assert.equal(t.selfHosted, true);
  assert.throws(() => assertExpectedNeonEndpoint('postgres://u:p@other:5432/helmion', 'self-hosted:db/helmion'), /mismatch/u);
  assert.throws(() => assertExpectedNeonEndpoint('postgres://u:p@db:5432/prod', 'self-hosted:db/helmion'), /mismatch/u);
  assert.throws(() => assertExpectedNeonEndpoint('postgres://u:p@db:5432/helmion', 'self-hosted:db'), /self-hosted:<host>/u);
});

test('Neon pin behavior unchanged', () => {
  assert.throws(() => assertExpectedNeonEndpoint('postgres://u:p@db:5432/helmion', 'ep-abc'), /not a recognizable Neon/u);
});
