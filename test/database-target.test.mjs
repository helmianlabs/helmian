import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertExpectedNeonEndpoint,
  describeDatabaseTarget,
  normalizeNeonEndpointId,
} from '../src/core/database-target.mjs';

const directUrl = [
  'postgresql://role:secret@',
  'ep-lively-tree-a1b2c3d4.us-west-2.aws.neon.tech/neondb',
  '?sslmode=require&channel_binding=require',
].join('');

test('Neon target description exposes no username, password, or connection URL', () => {
  assert.deepEqual(describeDatabaseTarget(directUrl), {
    host: 'ep-lively-tree-a1b2c3d4.us-west-2.aws.neon.tech',
    endpointId: 'ep-lively-tree-a1b2c3d4',
    databaseName: 'neondb',
    sslRequired: true,
  });
});

test('expected endpoint guard accepts pooled hosts and normalizes the endpoint ID', () => {
  const pooled = directUrl.replace(
    'ep-lively-tree-a1b2c3d4.',
    'ep-lively-tree-a1b2c3d4-pooler.',
  );
  assert.equal(
    assertExpectedNeonEndpoint(pooled, 'EP-LIVELY-TREE-A1B2C3D4').endpointId,
    'ep-lively-tree-a1b2c3d4',
  );
  assert.equal(
    normalizeNeonEndpointId('ep-lively-tree-a1b2c3d4-pooler'),
    'ep-lively-tree-a1b2c3d4',
  );
});

test('expected endpoint mismatch fails before opening a database connection', () => {
  assert.throws(
    () => assertExpectedNeonEndpoint(directUrl, 'ep-different-target-a9b8c7d6'),
    /target mismatch.*no connection was opened/i,
  );
  assert.throws(
    () => assertExpectedNeonEndpoint(
      directUrl.replace('sslmode=require', 'sslmode=disable'),
      'ep-lively-tree-a1b2c3d4',
    ),
    /explicitly require ssl.*no connection was opened/i,
  );
  assert.throws(
    () => assertExpectedNeonEndpoint(
      directUrl.replace('?sslmode=require&channel_binding=require', ''),
      'ep-lively-tree-a1b2c3d4',
    ),
    /explicitly require ssl.*no connection was opened/i,
  );
});
