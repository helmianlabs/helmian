// Plugin bundles + the plugin library store — plugin-install bite.
//
// The shelf is pinned as DATA first: exactly the two bundles Troy
// asked for, each a whole Agent Plugins 1.0 package (validateBundle
// is the shape law), each declaring catalog entries that really
// exist with the endpoints the catalog itself carries — a bundle
// may declare an entry, never redefine one, so a drift between the
// bundle's mcp.json and the catalog fails here, not in production.
// The skills' content pins are the brief's own words: the forecast
// skill leads with alerts and never invents a number; the review
// skill ends by naming what was NOT checked.
//
// The store is exercised over an in-memory fake pool in the repo's
// pattern (rows keyed by the tenant the transaction set, the way
// RLS enforces it): record / read / list / remove, tenant isolation,
// and the 42P01 honesty (reads empty, writes 503) when the table
// is not there yet.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PLUGIN_SHELF,
  pluginBundleByName,
  bundleEntryIds,
  bundleSkillRefs,
  validateBundle,
} from '../src/cloud/plugin-bundles.mjs';
import { createPluginLibraryStore } from '../src/cloud/plugin-library.mjs';
import { catalogEntryById, LIVE_SEATS } from '../src/cloud/connector-catalog.mjs';

// ---------------------------------------------------------------- fake pool

function fakePool({ missingTable = false } = {}) {
  const plugins = new Map();
  let tenant = null;
  const key = (name) => `${tenant}|${name}`;
  const now = () => new Date();
  const gone = () => { throw Object.assign(new Error('relation "helmion.workspace_plugins" does not exist'), { code: '42P01' }); };
  return {
    async connect() {
      return {
        async query(text, vals = []) {
          if (text.includes("set_config('helmion.tenant_id'")) { tenant = vals[0]; return { rows: [], rowCount: 0 }; }
          if (['begin', 'commit', 'rollback'].includes(text.trim())) return { rows: [], rowCount: 0 };
          if (missingTable) gone();
          if (text.includes('insert into helmion.workspace_plugins')) {
            const [name, version, description, manifest, mcpEntryIds, skillIds, installedBy] = vals;
            const standing = plugins.get(key(name));
            const row = {
              tenant_id: tenant, name, version, description,
              manifest: JSON.parse(manifest), mcp_entry_ids: [...mcpEntryIds], skill_ids: [...skillIds],
              installed_by: installedBy,
              installed_at: standing?.installed_at ?? now(), updated_at: now(),
            };
            plugins.set(key(name), row);
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('delete from helmion.workspace_plugins')) {
            const row = plugins.get(key(vals[0]));
            if (!row) return { rows: [], rowCount: 0 };
            plugins.delete(key(vals[0]));
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('from helmion.workspace_plugins') && text.includes('order by name')) {
            const out = [...plugins.values()].filter((r) => r.tenant_id === tenant).sort((a, b) => (a.name < b.name ? -1 : 1));
            return { rows: out.map((r) => ({ ...r })), rowCount: out.length };
          }
          if (text.includes('from helmion.workspace_plugins')) {
            const row = plugins.get(key(vals[0]));
            return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
          }
          throw new Error(`unexpected query: ${text}`);
        },
        release() {},
      };
    },
  };
}

const INSTALL = {
  name: 'weather',
  version: '1.0.0',
  description: 'US weather, answered the plain way.',
  manifest: { name: 'weather', version: '1.0.0' },
  mcpEntryIds: ['registry-weather'],
  skillIds: ['reading-a-forecast'],
};

// ---------------------------------------------------------------- the shelf

test('the shelf carries exactly the two bundles, both whole Agent Plugins packages', () => {
  assert.equal(PLUGIN_SHELF.length, 2);
  assert.deepEqual(PLUGIN_SHELF.map((b) => b.pluginJson.name), ['weather', 'github-review']);
  for (const bundle of PLUGIN_SHELF) {
    assert.equal(validateBundle(bundle), bundle);
    assert.equal(bundle.pluginJson.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
    assert.equal(bundle.mcpJson.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  }
  assert.equal(pluginBundleByName('Weather')?.pluginJson.name, 'weather');
  assert.equal(pluginBundleByName('github-review')?.pluginJson.name, 'github-review');
  assert.equal(pluginBundleByName('nope'), null);
});

test('each bundle declares a catalog entry that exists, at the endpoint the catalog carries', () => {
  const weather = pluginBundleByName('weather');
  assert.deepEqual(bundleEntryIds(weather), ['registry-weather']);
  const weatherEntry = LIVE_SEATS.map((s) => catalogEntryById(s, 'registry-weather')).find(Boolean);
  assert.ok(weatherEntry, 'the catalog carries registry-weather');
  assert.equal(weather.mcpJson.mcpServers.weather.type, 'streamable-http');
  assert.equal(weather.mcpJson.mcpServers.weather.url, weatherEntry.mcpEndpointUrl);
  assert.equal(weather.mcpJson.mcpServers.weather.url, 'https://nws.caseyjhand.com/mcp');

  const review = pluginBundleByName('github-review');
  assert.deepEqual(bundleEntryIds(review), ['helmian-github']);
  const githubEntry = LIVE_SEATS.map((s) => catalogEntryById(s, 'helmian-github')).find(Boolean);
  assert.ok(githubEntry, 'the catalog carries the brokered helmian-github entry');
  assert.equal(githubEntry.brokerMode, 'helmian');
  assert.equal(review.mcpJson.mcpServers.github.url, githubEntry.mcpEndpointUrl);
});

test('the bundle skills carry the brief’s content in their SKILL.md bodies', () => {
  const [forecast] = bundleSkillRefs(pluginBundleByName('weather'));
  assert.equal(forecast.id, 'reading-a-forecast');
  assert.ok(forecast.skillMd.includes('Alerts first'), 'alerts lead the forecast');
  assert.ok(forecast.skillMd.includes('Never invent a number'), 'no invented numbers');
  assert.ok(forecast.skillMd.includes('National Weather Service'), 'the source is named');

  const [review] = bundleSkillRefs(pluginBundleByName('github-review'));
  assert.equal(review.id, 'reviewing-a-pull-request');
  assert.ok(review.skillMd.includes('Read the diff first'), 'the diff is read first');
  assert.ok(review.skillMd.includes('tests the PR names'), 'the named tests are checked');
  assert.ok(review.skillMd.includes('NOT checked'), 'what was not checked is named');
});

test('validateBundle refuses a bundle whose mapping or skill shape rots', () => {
  const weather = pluginBundleByName('weather');
  const unmapped = {
    pluginJson: { ...weather.pluginJson, extensions: {} },
    mcpJson: weather.mcpJson,
    skills: weather.skills,
  };
  assert.throws(() => validateBundle(unmapped), /no catalog entry mapping/);
  const badSkill = {
    pluginJson: weather.pluginJson,
    mcpJson: weather.mcpJson,
    skills: [{ name: 'x', skillMd: 'no frontmatter at all' }],
  };
  assert.throws(() => validateBundle(badSkill), /not a skill slug/);
});

// ---------------------------------------------------------------- the store

test('record → read → list → remove round trip, tenant-isolated', async () => {
  const store = createPluginLibraryStore(fakePool());
  const record = await store.recordInstall('tenant-a', 'user:troy', INSTALL);
  assert.equal(record.name, 'weather');
  assert.equal(record.version, '1.0.0');
  assert.deepEqual(record.mcpEntryIds, ['registry-weather']);
  assert.deepEqual(record.skillIds, ['reading-a-forecast']);
  assert.equal(record.installedBy, 'user:troy');
  assert.deepEqual(record.manifest, INSTALL.manifest);

  assert.equal((await store.getPlugin('tenant-a', 'weather')).name, 'weather');
  assert.deepEqual((await store.listPlugins('tenant-a')).map((p) => p.name), ['weather']);
  // Another tenant's shelf is empty and its read of the name is absent.
  assert.equal(await store.getPlugin('tenant-b', 'weather'), null);
  assert.deepEqual(await store.listPlugins('tenant-b'), []);

  const removed = await store.removePlugin('tenant-a', 'weather');
  assert.equal(removed.name, 'weather');
  assert.equal(await store.removePlugin('tenant-a', 'weather'), null);
  assert.equal(await store.getPlugin('tenant-a', 'weather'), null);
});

test('recordInstall upserts: a re-record refreshes the standing row', async () => {
  const store = createPluginLibraryStore(fakePool());
  await store.recordInstall('tenant-a', 'user:troy', INSTALL);
  const again = await store.recordInstall('tenant-a', 'user:troy', { ...INSTALL, skillIds: ['reading-a-forecast', 'extra'] });
  assert.deepEqual(again.skillIds, ['reading-a-forecast', 'extra']);
  assert.equal((await store.listPlugins('tenant-a')).length, 1);
});

test('a missing table reads empty and writes an honest 503', async () => {
  const store = createPluginLibraryStore(fakePool({ missingTable: true }));
  assert.equal(await store.getPlugin('tenant-a', 'weather'), null);
  assert.deepEqual(await store.listPlugins('tenant-a'), []);
  await assert.rejects(() => store.recordInstall('tenant-a', 'user:troy', INSTALL), (e) => e.status === 503);
  await assert.rejects(() => store.removePlugin('tenant-a', 'weather'), (e) => e.status === 503);
});

test('the store validates its inputs in plain words', async () => {
  const store = createPluginLibraryStore(fakePool());
  await assert.rejects(() => store.recordInstall('tenant-a', 'user:troy', { ...INSTALL, name: 'Not A Slug!' }), /plugin name is invalid/);
  await assert.rejects(() => store.recordInstall('tenant-a', 'user:troy', { ...INSTALL, version: '' }), /plugin version is required/);
  await assert.rejects(() => store.recordInstall('tenant-a', '', INSTALL), /installer subject is required/);
});
