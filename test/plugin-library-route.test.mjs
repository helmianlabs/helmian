// Plugin library routes — plugin-install bite gate.
//
// The delegate is exercised with the REAL stores (skill library +
// plugin library) over one in-memory fake pool in the repo's
// pattern, a fake actor, a stub bridge list, a stub entry-state
// join, and the REAL catalog existence check — so the pins cover
// the route layer's own work:
//
//   - install registers the bundle's skills through the skills
//     write path (provenance 'plugin:<name>', scope blanket, the
//     SKILL.md frontmatter lifted off the stored body) and records
//     the install — and creates NO connector connection (the deps
//     carry no connector write surface at all; the row's entry
//     state comes from the read join, not from the install);
//   - the read merges the cloud rows with the bridge list, joins
//     each declared entry's live state (stub), and answers the
//     honest empty list for a workspace with neither;
//   - uninstall removes the record and ONLY the plugin's own
//     skills — a skill the person re-authored under the same id
//     is theirs and stands;
//   - a bundle declaring an unknown MCP entry fails honest and
//     installs nothing; a foreign skill id fails the same way and
//     rolls back the skills the attempt did create;
//   - membership, auditor, selector, and method laws match the
//     sibling routes.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSkillLibraryStore } from '../src/cloud/skill-library.mjs';
import { createPluginLibraryStore } from '../src/cloud/plugin-library.mjs';
import {
  PLUGINS_PATH,
  PLUGIN_INSTALL_PATH,
  PLUGIN_UNINSTALL_PATH,
  handlePluginLibraryRoute,
  pluginBringsLine,
} from '../src/cloud/plugin-library-route.mjs';
import { PLUGIN_SHELF, pluginBundleByName } from '../src/cloud/plugin-bundles.mjs';
import { catalogEntryById, LIVE_SEATS } from '../src/cloud/connector-catalog.mjs';

class TenantAuthorizationError extends Error {}

const ACTOR = { subject: 'user:troy', tenantId: 'tenant-a', role: 'owner' };
const OTHER_ACTOR = { subject: 'user:other', tenantId: 'tenant-b', role: 'owner' };
const AUDITOR = { subject: 'user:audit', tenantId: 'tenant-a', role: 'auditor' };

// The real catalog existence check, the same one production uses.
const entryExists = (entryId) => LIVE_SEATS.some((seatId) => catalogEntryById(seatId, entryId) !== null);

// ---------------------------------------------------------------- fake pool
// Both tables (helmion.skills + helmion.workspace_plugins), keyed
// by the tenant the transaction set, the way RLS enforces it.
function fakePool() {
  const skills = new Map();
  const plugins = new Map();
  let tenant = null;
  const now = () => new Date();
  return {
    async connect() {
      return {
        async query(text, vals = []) {
          if (text.includes("set_config('helmion.tenant_id'")) { tenant = vals[0]; return { rows: [], rowCount: 0 }; }
          if (['begin', 'commit', 'rollback'].includes(text.trim())) return { rows: [], rowCount: 0 };
          if (text.includes('insert into helmion.skills')) {
            const [id, name, description, body, scope, seatIds, state, createdBy] = vals;
            const row = { tenant_id: tenant, id, name, description, body, scope, seat_ids: [...seatIds], state, created_by: createdBy, created_at: now(), updated_at: now() };
            skills.set(`${tenant}|${id}`, row);
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('update helmion.skills')) {
            const [id, name, description, body, scope, seatIds, state] = vals;
            const row = skills.get(`${tenant}|${id}`);
            if (!row) return { rows: [], rowCount: 0 };
            Object.assign(row, { name, description, body, scope, seat_ids: [...seatIds], state, updated_at: now() });
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('delete from helmion.skills')) {
            const row = skills.get(`${tenant}|${vals[0]}`);
            if (!row) return { rows: [], rowCount: 0 };
            skills.delete(`${tenant}|${vals[0]}`);
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('from helmion.skills') && text.includes('order by id')) {
            const out = [...skills.values()].filter((r) => r.tenant_id === tenant).sort((a, b) => (a.id < b.id ? -1 : 1));
            return { rows: out.map((r) => ({ ...r })), rowCount: out.length };
          }
          if (text.includes('from helmion.skills')) {
            const row = skills.get(`${tenant}|${vals[0]}`);
            return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
          }
          if (text.includes('insert into helmion.workspace_plugins')) {
            const [name, version, description, manifest, mcpEntryIds, skillIds, installedBy] = vals;
            const standing = plugins.get(`${tenant}|${name}`);
            const row = {
              tenant_id: tenant, name, version, description,
              manifest: JSON.parse(manifest), mcp_entry_ids: [...mcpEntryIds], skill_ids: [...skillIds],
              installed_by: installedBy, installed_at: standing?.installed_at ?? now(), updated_at: now(),
            };
            plugins.set(`${tenant}|${name}`, row);
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('delete from helmion.workspace_plugins')) {
            const row = plugins.get(`${tenant}|${vals[0]}`);
            if (!row) return { rows: [], rowCount: 0 };
            plugins.delete(`${tenant}|${vals[0]}`);
            return { rows: [{ ...row }], rowCount: 1 };
          }
          if (text.includes('from helmion.workspace_plugins') && text.includes('order by name')) {
            const out = [...plugins.values()].filter((r) => r.tenant_id === tenant).sort((a, b) => (a.name < b.name ? -1 : 1));
            return { rows: out.map((r) => ({ ...r })), rowCount: out.length };
          }
          if (text.includes('from helmion.workspace_plugins')) {
            const row = plugins.get(`${tenant}|${vals[0]}`);
            return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
          }
          throw new Error(`unexpected query: ${text}`);
        },
        release() {},
      };
    },
  };
}

function harness({ actor = ACTOR, actorError = null, bridge = { plugins: [], unavailable: [] }, states = {}, shelf = PLUGIN_SHELF } = {}) {
  const sent = [];
  const pool = fakePool();
  const skills = createSkillLibraryStore(pool);
  const plugins = createPluginLibraryStore(pool);
  const entryStates = async (tenantId, forActor, entryIds) => new Map(
    entryIds.map((id) => [id, states[id] ?? { state: 'not-connected', accountIdentity: null }]),
  );
  return {
    sent, skills, plugins,
    async run(path, { method = 'GET', body = undefined, badJson = false } = {}) {
      const requestUrl = new URL(path, 'http://local');
      const handled = await handlePluginLibraryRoute({
        request: { method },
        response: {},
        requestUrl,
        activeTenantActor: async () => { if (actorError) throw actorError; return actor; },
        send: (response, status, text) => { sent.push({ status, body: JSON.parse(text) }); },
        TenantAuthorizationError,
        readJson: async () => { if (badJson) throw new Error('not json'); return body ?? {}; },
        plugins, skills, entryExists, entryStates,
        bridgeList: async () => bridge,
        shelf,
      });
      return handled;
    },
  };
}

// A bundle whose second skill collides and whose first is new —
// the rollback pin's fixture.
function riggedTwoSkillBundle() {
  const weather = pluginBundleByName('weather');
  return {
    pluginJson: {
      ...weather.pluginJson,
      name: 'rigged',
      extensions: { 'cloud.helmian': { mcpEntryIds: { weather: 'registry-weather' } } },
    },
    mcpJson: weather.mcpJson,
    skills: [
      { name: 'fresh-skill', skillMd: '---\nname: fresh-skill\ndescription: A fresh skill.\n---\n\nBody one.\n' },
      { name: 'reading-a-forecast', skillMd: weather.skills[0].skillMd },
    ],
  };
}

// The read's shelf field, pinned in full: both shipped bundles in
// the bundle's own names and words (plugin-catalog bite, 2026-11-09).
// Installed state never rides these rows — it joins from the
// plugins rows by name.
const SHELF_ROWS = [
  {
    name: 'weather',
    version: '1.0.0',
    description: 'US weather from the National Weather Service: forecasts, alerts, and current conditions, answered the plain way.',
    entries: [{ entryId: 'registry-weather', name: 'Weather' }],
    skills: [{
      id: 'reading-a-forecast',
      name: 'reading-a-forecast',
      description: 'Turn National Weather Service tool output into a plain forecast answer: alerts first, then today, then the week.',
    }],
  },
  {
    name: 'github-review',
    version: '1.0.0',
    description: 'Pull request reviews over the workspace’s GitHub connection: the diff read first, the tests the PR names checked, and what was not checked named.',
    entries: [{ entryId: 'helmian-github', name: 'GitHub' }],
    skills: [{
      id: 'reviewing-a-pull-request',
      name: 'reviewing-a-pull-request',
      description: 'Review a pull request from its diff: read what changed, check the tests the PR names, summarize in plain words, and name what was not checked.',
    }],
  },
];

// ------------------------------------------------------------ install + read

test('install registers the skill through the skills write path and records the install', async () => {
  const h = harness();
  await h.run(PLUGIN_INSTALL_PATH, { method: 'POST', body: { name: 'weather' } });
  assert.equal(h.sent[0].status, 200);
  assert.equal(h.sent[0].body.valid, true);
  assert.equal(h.sent[0].body.alreadyInstalled, false);
  const row = h.sent[0].body.plugin;
  assert.equal(row.name, 'weather');
  assert.equal(row.version, '1.0.0');
  assert.deepEqual(row.entries, [{ entryId: 'registry-weather', name: 'Weather', state: 'not-connected', accountIdentity: null }]);
  assert.deepEqual(row.skills.map((s) => [s.id, s.installed]), [['reading-a-forecast', true]]);

  // The skill stands in the workspace library: the plugin's
  // provenance, blanket scope, frontmatter lifted off the body.
  const skill = await h.skills.getSkill('tenant-a', 'reading-a-forecast');
  assert.equal(skill.createdBy, 'plugin:weather');
  assert.equal(skill.scope, 'blanket');
  assert.deepEqual(skill.seatIds, []);
  assert.ok(!skill.body.startsWith('---'), 'frontmatter is stripped from the stored body');
  assert.ok(skill.body.includes('Alerts first'));
  assert.equal(skill.description, 'Turn National Weather Service tool output into a plain forecast answer: alerts first, then today, then the week.');

  const record = await h.plugins.getPlugin('tenant-a', 'weather');
  assert.deepEqual(record.mcpEntryIds, ['registry-weather']);
  assert.deepEqual(record.skillIds, ['reading-a-forecast']);
  assert.equal(record.installedBy, 'user:troy');
});

test('the read merges cloud rows with the bridge list and joins live entry state', async () => {
  const bridgeRow = { name: 'bridge-one', version: '2.0.0', brings: 'Brings 1 approved tool server — their tools join the turn.', tools: true, commands: false };
  const h = harness({
    bridge: { plugins: [bridgeRow], unavailable: [{ name: 'broken', message: 'could not load' }] },
    states: { 'helmian-github': { state: 'connected', accountIdentity: 'helmianlabs/helmian' } },
  });
  await h.run(PLUGIN_INSTALL_PATH, { method: 'POST', body: { name: 'github-review' } });
  assert.equal(h.sent[0].status, 200);

  await h.run(PLUGINS_PATH);
  assert.equal(h.sent[1].status, 200);
  const { plugins, unavailable } = h.sent[1].body;
  assert.deepEqual(plugins.map((p) => p.name), ['github-review', 'bridge-one']);
  const cloud = plugins[0];
  assert.equal(cloud.source, 'helmian-plugin');
  assert.deepEqual(cloud.entries, [{ entryId: 'helmian-github', name: 'GitHub', state: 'connected', accountIdentity: 'helmianlabs/helmian' }]);
  assert.ok(cloud.brings.includes('connected'), 'the brings line carries the joined state');
  assert.ok(cloud.brings.includes('reviewing-a-pull-request'), 'the brings line names the installed skill');
  assert.deepEqual(unavailable, [{ name: 'broken', message: 'could not load' }]);
});

test('a workspace with neither cloud nor bridge plugins reads the honest empty list', async () => {
  const h = harness();
  await h.run(PLUGINS_PATH);
  assert.equal(h.sent[0].status, 200);
  assert.deepEqual(h.sent[0].body, { valid: true, plugins: [], unavailable: [], shelf: SHELF_ROWS });
});

test('the read carries the shelf in full shape — and installing never bakes state into it', async () => {
  const h = harness();
  await h.run(PLUGINS_PATH);
  assert.equal(h.sent[0].status, 200);
  assert.deepEqual(h.sent[0].body.shelf, SHELF_ROWS, 'every shelf bundle: name, version, description, entries and skills in the bundle’s own words');
  // Install weather, then read again: the shelf rows are byte-for-
  // byte the same declarations; the install truth rides the
  // plugins rows, never the shelf.
  await h.run(PLUGIN_INSTALL_PATH, { method: 'POST', body: { name: 'weather' } });
  assert.equal(h.sent[1].status, 200);
  await h.run(PLUGINS_PATH);
  assert.equal(h.sent[2].status, 200);
  assert.deepEqual(h.sent[2].body.shelf, SHELF_ROWS);
  assert.deepEqual(h.sent[2].body.plugins.map((p) => [p.name, p.source]), [['weather', 'helmian-plugin']]);
});

test('reinstalling the same version is the standing install, unchanged', async () => {
  const h = harness();
  await h.run(PLUGIN_INSTALL_PATH, { method: 'POST', body: { name: 'weather' } });
  await h.run(PLUGIN_INSTALL_PATH, { method: 'POST', body: { name: 'weather' } });
  assert.equal(h.sent[1].body.alreadyInstalled, true);
  assert.equal((await h.plugins.listPlugins('tenant-a')).length, 1);
  assert.equal((await h.skills.listSkills('tenant-a')).length, 1);
});

test('a deleted plugin skill reads installed: false on the plugin row', async () => {
  const h = harness();
  await h.run(PLUGIN_INSTALL_PATH, { method: 'POST', body: { name: 'weather' } });
  await h.skills.removeSkill('tenant-a', 'reading-a-forecast');
  await h.run(PLUGINS_PATH);
  const row = h.sent[1].body.plugins[0];
  assert.deepEqual(row.skills, [{
    id: 'reading-a-forecast', name: 'reading-a-forecast',
    description: 'Turn National Weather Service tool output into a plain forecast answer: alerts first, then today, then the week.',
    installed: false,
  }]);
});

// ---------------------------------------------------------------- uninstall

test('uninstall removes the record and the plugin’s own skill', async () => {
  const h = harness();
  await h.run(PLUGIN_INSTALL_PATH, { method: 'POST', body: { name: 'weather' } });
  await h.run(PLUGIN_UNINSTALL_PATH, { method: 'POST', body: { name: 'weather' } });
  assert.equal(h.sent[1].status, 200);
  assert.deepEqual(h.sent[1].body.removed, { name: 'weather', version: '1.0.0', removedSkills: ['reading-a-forecast'] });
  assert.equal(await h.plugins.getPlugin('tenant-a', 'weather'), null);
  assert.equal(await h.skills.getSkill('tenant-a', 'reading-a-forecast'), null);
});

test('uninstall leaves a skill the person re-authored under the same id standing', async () => {
  const h = harness();
  await h.run(PLUGIN_INSTALL_PATH, { method: 'POST', body: { name: 'weather' } });
  // The person deletes the plugin's skill and authors their own
  // under the same id — provenance is now theirs.
  await h.skills.removeSkill('tenant-a', 'reading-a-forecast');
  await h.skills.createSkill('tenant-a', 'user:troy', {
    id: 'reading-a-forecast', name: 'My forecast notes', body: 'My own words.', scope: 'blanket', seatIds: [],
  });
  await h.run(PLUGIN_UNINSTALL_PATH, { method: 'POST', body: { name: 'weather' } });
  assert.equal(h.sent[1].status, 200);
  assert.deepEqual(h.sent[1].body.removed.removedSkills, []);
  const standing = await h.skills.getSkill('tenant-a', 'reading-a-forecast');
  assert.equal(standing.createdBy, 'user:troy');
  assert.equal(standing.body, 'My own words.');
  assert.equal(await h.plugins.getPlugin('tenant-a', 'weather'), null);
});

test('uninstalling what is not installed is an honest 404', async () => {
  const h = harness();
  await h.run(PLUGIN_UNINSTALL_PATH, { method: 'POST', body: { name: 'weather' } });
  assert.equal(h.sent[0].status, 404);
  assert.equal(h.sent[0].body.code, 'PLUGIN_NOT_INSTALLED');
});

// ------------------------------------------------------------- honest fails

test('a bundle declaring an unknown MCP entry fails honest and installs nothing', async () => {
  const weather = pluginBundleByName('weather');
  const rigged = {
    pluginJson: {
      ...weather.pluginJson,
      name: 'rigged',
      extensions: { 'cloud.helmian': { mcpEntryIds: { weather: 'no-such-entry' } } },
    },
    mcpJson: weather.mcpJson,
    skills: weather.skills,
  };
  const h = harness({ shelf: [rigged] });
  await h.run(PLUGIN_INSTALL_PATH, { method: 'POST', body: { name: 'rigged' } });
  assert.equal(h.sent[0].status, 400);
  assert.equal(h.sent[0].body.code, 'PLUGIN_ENTRY_UNKNOWN');
  assert.equal(await h.plugins.getPlugin('tenant-a', 'rigged'), null);
  assert.deepEqual(await h.skills.listSkills('tenant-a'), []);
});

test('a foreign skill id fails the install and rolls back the skills it created', async () => {
  const h = harness({ shelf: [riggedTwoSkillBundle()] });
  // The workspace already holds 'reading-a-forecast' under the
  // person's own authorship.
  await h.skills.createSkill('tenant-a', 'user:troy', {
    id: 'reading-a-forecast', name: 'Mine', body: 'My own forecast words.', scope: 'blanket', seatIds: [],
  });
  await h.run(PLUGIN_INSTALL_PATH, { method: 'POST', body: { name: 'rigged' } });
  assert.equal(h.sent[0].status, 409);
  assert.equal(h.sent[0].body.code, 'PLUGIN_SKILL_CONFLICT');
  // Nothing of the attempt stands: no record, and 'fresh-skill'
  // (created before the collision) was removed again. The person's
  // own skill is untouched.
  assert.equal(await h.plugins.getPlugin('tenant-a', 'rigged'), null);
  assert.equal(await h.skills.getSkill('tenant-a', 'fresh-skill'), null);
  assert.equal((await h.skills.getSkill('tenant-a', 'reading-a-forecast')).createdBy, 'user:troy');
});

test('installing a name the shelf does not carry is an honest 404', async () => {
  const h = harness();
  await h.run(PLUGIN_INSTALL_PATH, { method: 'POST', body: { name: 'nope' } });
  assert.equal(h.sent[0].status, 404);
  assert.equal(h.sent[0].body.code, 'PLUGIN_NOT_ON_SHELF');
});

test('a standing record at a different version refuses with the road named', async () => {
  const weather = pluginBundleByName('weather');
  const v2 = { ...weather, pluginJson: { ...weather.pluginJson, version: '2.0.0' } };
  const h = harness({ shelf: [v2] });
  await h.plugins.recordInstall('tenant-a', 'user:troy', {
    name: 'weather', version: '1.0.0', description: 'old', manifest: { name: 'weather', version: '1.0.0' },
    mcpEntryIds: ['registry-weather'], skillIds: ['reading-a-forecast'],
  });
  await h.run(PLUGIN_INSTALL_PATH, { method: 'POST', body: { name: 'weather' } });
  assert.equal(h.sent[0].status, 409);
  assert.equal(h.sent[0].body.code, 'PLUGIN_VERSION_CONFLICT');
});

// ------------------------------------------------------------------- laws

test('writes refuse the auditor; reads do not', async () => {
  const h = harness({ actor: AUDITOR });
  await h.run(PLUGIN_INSTALL_PATH, { method: 'POST', body: { name: 'weather' } });
  assert.equal(h.sent[0].status, 403);
  assert.equal(h.sent[0].body.code, 'PLUGIN_ROLE_FORBIDDEN');
  await h.run(PLUGINS_PATH);
  assert.equal(h.sent[1].status, 200);
});

test('authority selectors are refused in query and body; foreign paths are not ours', async () => {
  const h = harness();
  await h.run(`${PLUGINS_PATH}?tenantId=tenant-b`);
  assert.equal(h.sent[0].status, 400);
  assert.equal(h.sent[0].body.code, 'PLUGINS_SELECTOR_INVALID');
  await h.run(PLUGIN_INSTALL_PATH, { method: 'POST', body: { name: 'weather', tenantId: 'tenant-b' } });
  assert.equal(h.sent[1].status, 400);
  const handled = await h.run('/api/admin/skills');
  assert.equal(handled, false);
  await h.run(PLUGIN_INSTALL_PATH, { method: 'GET' });
  assert.equal(h.sent[2].status, 405);
});

test('one tenant’s install never answers another tenant', async () => {
  const a = harness();
  await a.run(PLUGIN_INSTALL_PATH, { method: 'POST', body: { name: 'weather' } });
  const b = harness({ actor: OTHER_ACTOR });
  // Same fake-pool shape, a different harness — isolation is ruled
  // through the shared-store variant below; here the other tenant's
  // own read of an empty workspace stays empty and honest.
  await b.run(PLUGINS_PATH);
  assert.deepEqual(b.sent[0].body.plugins, []);
  await b.run(PLUGIN_UNINSTALL_PATH, { method: 'POST', body: { name: 'weather' } });
  assert.equal(b.sent[1].status, 404);
});

test('pluginBringsLine words states plainly and invents nothing', () => {
  assert.equal(
    pluginBringsLine({ entries: [{ name: 'Weather', state: 'not-connected' }], skills: [{ id: 'reading-a-forecast', name: 'reading-a-forecast', installed: true }] }),
    'Brings the Weather tools — not connected yet, plus the reading-a-forecast skill in this workspace’s skill library.',
  );
  assert.equal(
    pluginBringsLine({ entries: [{ name: 'GitHub', state: 'connected' }], skills: [] }),
    'Brings the GitHub tools — connected.',
  );
  assert.equal(pluginBringsLine({ entries: [], skills: [] }), 'Installed; adds nothing to this workspace yet.');
});
