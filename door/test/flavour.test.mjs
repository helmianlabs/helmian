// Flavour tests for the door split (separation step 2): one codebase,
// three flavours. The combined flavour is the door as it has always run;
// scribe fronts the memory backend only; helmian fronts the hands
// backend only. The combined flavour's rendered consent page and MCP
// instructions are byte-identical to the pre-split code (proven in the
// bite's comparison runs); these tests pin the per-flavour config,
// discovery, routing, and approvals identity.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createOAuth, normalizeScopes } from '../src/oauth.mjs';
import { createApp } from '../src/server.mjs';

const BASE_ENV = {
  PUBLIC_URL: 'https://door.example.test',
  AUTH_PASSPHRASE: 'test-passphrase',
  MEMORY_BACKEND_RESOURCE: 'https://door.example.test/mcp-memory',
  HANDS_BACKEND_RESOURCE: 'https://door.example.test/mcp-hands',
  MEMORY_BACKEND_BASE: 'http://127.0.0.1:1',
  HANDS_BACKEND_BASE: 'http://127.0.0.1:1',
};

test('loadConfig: combined is the default and requires both backends', () => {
  const c = loadConfig({ ...BASE_ENV });
  assert.equal(c.flavour, 'combined');
  assert.deepEqual(Object.keys(c.backends).sort(), ['hands', 'memory']);
  assert.deepEqual([...c.scopes], ['memory.read', 'memory.write', 'hands.read', 'hands.act']);
  assert.deepEqual([...c.defaultScopes], ['memory.read', 'hands.read']);
  assert.throws(() => loadConfig({ ...BASE_ENV, HANDS_BACKEND_RESOURCE: '' }), /HANDS_BACKEND_RESOURCE/);
});

test('loadConfig: scribe needs the memory backend only', () => {
  const env = { ...BASE_ENV, DOOR_FLAVOUR: 'scribe' };
  delete env.HANDS_BACKEND_RESOURCE;
  const c = loadConfig(env);
  assert.equal(c.flavour, 'scribe');
  assert.deepEqual(Object.keys(c.backends), ['memory']);
  assert.deepEqual([...c.scopes], ['memory.read', 'memory.write']);
  assert.deepEqual([...c.defaultScopes], ['memory.read']);
});

test('loadConfig: helmian needs the hands backend only', () => {
  const env = { ...BASE_ENV, DOOR_FLAVOUR: 'helmian' };
  delete env.MEMORY_BACKEND_RESOURCE;
  const c = loadConfig(env);
  assert.equal(c.flavour, 'helmian');
  assert.deepEqual(Object.keys(c.backends), ['hands']);
  assert.deepEqual([...c.scopes], ['hands.read', 'hands.act']);
  assert.deepEqual([...c.defaultScopes], ['hands.read']);
});

test('loadConfig: an unknown flavour is refused', () => {
  assert.throws(() => loadConfig({ ...BASE_ENV, DOOR_FLAVOUR: 'bogus' }), /DOOR_FLAVOUR/);
});

test('normalizeScopes: a flavour can never grant the other product\'s scopes', () => {
  assert.deepEqual(normalizeScopes(['memory.read', 'hands.act'], ['hands.read', 'hands.act'], ['hands.read']), ['hands.act']);
  assert.deepEqual(normalizeScopes(['hands.act'], ['memory.read', 'memory.write'], ['memory.read']), ['memory.read']);
  assert.deepEqual(normalizeScopes([], ['memory.read', 'memory.write'], ['memory.read']), ['memory.read']);
});

const stubBackends = { ready: () => false, catalog: async () => [], callTool: async () => { throw new Error('unused'); } };

async function boot(flavour, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'door-flavour-'));
  const config = loadConfig({ ...BASE_ENV, DOOR_FLAVOUR: flavour, ...extraEnv });
  const oauth = createOAuth({
    resourceId: `${config.publicUrl}${config.mcpPath}`,
    stateFile: join(dir, 'oauth-state.json'),
    scopes: config.scopes,
    defaultScopes: config.defaultScopes,
    flavour: config.flavour,
  });
  const app = createApp({ config, oauth, backends: stubBackends });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => { server.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('app: discovery lists only the flavour\'s scopes; root names only its backends', async () => {
  for (const [flavour, scopes, backends] of [
    ['combined', ['memory.read', 'memory.write', 'hands.read', 'hands.act'], ['hands', 'memory']],
    ['scribe', ['memory.read', 'memory.write'], ['memory']],
    ['helmian', ['hands.read', 'hands.act'], ['hands']],
  ]) {
    const { base, close } = await boot(flavour);
    try {
      const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
      assert.deepEqual(meta.scopes_supported, scopes, flavour);
      const root = await (await fetch(`${base}/`)).json();
      assert.deepEqual(Object.keys(root.backends).sort(), backends, flavour);
    } finally { close(); }
  }
});

test('app: the mailbox-status feed exists only where the memory backend lives', async () => {
  const scribe = await boot('scribe');
  try {
    const r = await fetch(`${scribe.base}/mailbox-status`);
    assert.equal(r.status, 502); // route mounted; stub memory base is unreachable
  } finally { scribe.close(); }
  const helmian = await boot('helmian');
  try {
    const r = await fetch(`${helmian.base}/mailbox-status`);
    assert.equal(r.status, 404);
  } finally { helmian.close(); }
});

test('app: the approvals page names its own product, and stays off without a Guard credential', async () => {
  const helmian = await boot('helmian', { GUARD_APPROVER_TOKEN: 'test-token' });
  try {
    const page = await (await fetch(`${helmian.base}/approvals`)).text();
    assert.match(page, /<h1>Helmian approvals<\/h1>/);
    assert.match(page, /part of Helmian/);
  } finally { helmian.close(); }
  const scribe = await boot('scribe', { GUARD_APPROVER_TOKEN: 'test-token' });
  try {
    const page = await (await fetch(`${scribe.base}/approvals`)).text();
    assert.match(page, /<h1>Scribe approvals<\/h1>/);
    assert.match(page, /part of Scribe/);
  } finally { scribe.close(); }
  const closed = await boot('helmian');
  try {
    const r = await fetch(`${closed.base}/approvals`);
    assert.equal(r.status, 404); // fail closed: no credential, no routes
  } finally { closed.close(); }
});
