import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INSTALLED_PLUGINS_PATH,
  canonicalPluginName,
  installedPluginRow,
  installedPluginsWorkspace,
  listInstalledPlugins,
  pluginBrings,
} from '../src/cloud/installed-plugins.mjs';
import { LIVE_ADMIN_PLUGINS_PATH } from '../src/cloud/live-admin.mjs';
import { addPlugin, readRegistry, registryPath } from '../src/agent/plugins.mjs';
// The ledger's own functions — the approval below is a genuine positive
// control against agent-I's code, not a stub (same pattern as
// test/plugins.test.mjs).
import {
  computeCandidateFingerprint,
  defaultLedgerDirectory,
  saveBaseline,
} from '../src/core/mcp-install-ledger.mjs';

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'helmion-picker-plugins-'));
  const workspace = join(dir, 'workspace');
  await mkdir(workspace, { recursive: true });
  return { dir, workspace };
}

async function write(path, contents) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, contents);
  return path;
}

async function makePlugin(root, { name, mcp = null } = {}) {
  await write(
    join(root, '.helmion-plugin', 'plugin.json'),
    `${JSON.stringify({ name, description: `${name} plugin`, version: '1.0.0' }, null, 2)}\n`,
  );
  await write(join(root, 'commands', 'greet.md'), '---\ndescription: Greet someone\n---\nSay hello to $0.\n');
  if (mcp) {
    await write(join(root, 'server', 'index.mjs'), 'export const ok = true;\n');
    await write(join(root, '.mcp.json'), `${JSON.stringify(mcp, null, 2)}\n`);
  }
  return root;
}

const CALC_DECL = { mcpServers: { 'calc-server': { command: 'node', args: ['./server/index.mjs'] } } };

test('the route path is the one live-admin serves', () => {
  assert.equal(INSTALLED_PLUGINS_PATH, '/api/admin/plugins');
  assert.equal(LIVE_ADMIN_PLUGINS_PATH, INSTALLED_PLUGINS_PATH);
});

test('canonicalPluginName is exactly the shape a plugin attachment can carry', () => {
  assert.equal(canonicalPluginName('Calc'), 'calc', 'case is normalized like the server normalizer');
  assert.equal(canonicalPluginName('my-plugin:hello'), 'my-plugin:hello', 'namespaced names carry');
  assert.equal(canonicalPluginName('has space'), null);
  assert.equal(canonicalPluginName(''), null);
  assert.equal(canonicalPluginName('x'.repeat(65)), null);
  assert.equal(canonicalPluginName(null), null);
});

test('pluginBrings says, in plain words, what the turn gets', () => {
  assert.match(pluginBrings({ registrations: [{ name: 's' }], refusals: [], commandsDir: '/p/commands' }), /Brings 1 approved tool server/);
  assert.match(pluginBrings({ registrations: [], refusals: [], commandsDir: '/p/commands' }), /Adds its commands as skills/);
  assert.match(pluginBrings({ registrations: [], refusals: [{ name: 'r' }], commandsDir: null }), /refused by the install ledger/);
  assert.equal(pluginBrings({ registrations: [], refusals: [], commandsDir: null }), 'Installed and enabled; adds no tools or commands to a turn yet.');
  assert.deepEqual(installedPluginRow({ name: 'Bad Name', registrations: [], refusals: [] }), null, 'a name a message cannot carry is not listed');
});

test('the list comes from the real registry + ledger: approved tools show, disabled plugins do not', async (t) => {
  const { dir, workspace } = await scratch();
  t.after(() => rm(dir, { recursive: true, force: true }));

  // calc: a plugin whose MCP server the ledger has genuinely approved.
  const calcRoot = await makePlugin(join(dir, 'calc'), { name: 'calc', mcp: CALC_DECL });
  await saveBaseline({
    ledgerDir: defaultLedgerDirectory(workspace),
    serverName: 'calc-server',
    fingerprint: await computeCandidateFingerprint({ root: join(calcRoot, 'server'), declared: {} }),
    approvalRecord: { respondedAt: new Date().toISOString(), challenge: 'test-approval' },
  });
  await addPlugin({ workspace, spec: calcRoot });

  // greeter: commands only, no MCP declaration at all.
  const greeterRoot = await makePlugin(join(dir, 'greeter'), { name: 'greeter' });
  await addPlugin({ workspace, spec: greeterRoot });

  // ghost: registered, then disabled in the registry — not the turn's set,
  // so not the picker's either.
  const ghostRoot = await makePlugin(join(dir, 'ghost'), { name: 'ghost' });
  await addPlugin({ workspace, spec: ghostRoot });
  const registry = await readRegistry(workspace);
  registry.plugins = registry.plugins.map((p) => (p.name === 'ghost' ? { ...p, enabled: false } : p));
  await writeFile(registryPath(workspace), `${JSON.stringify(registry, null, 2)}\n`);

  const result = await listInstalledPlugins({ workspace });
  assert.deepEqual(result.unavailable, []);
  assert.deepEqual(result.plugins.map((p) => p.name), ['calc', 'greeter']);
  const [calc, greeter] = result.plugins;
  assert.equal(calc.version, '1.0.0');
  assert.equal(calc.tools, true, 'the ledger-approved server is what makes tools true');
  assert.equal(calc.commands, true);
  assert.match(calc.brings, /Brings 1 approved tool server — their tools join the turn/);
  assert.equal(greeter.tools, false);
  assert.equal(greeter.commands, true);
  assert.match(greeter.brings, /Adds its commands as skills/);
  assert.equal('root' in calc, false, 'no file paths ride to the picker');
});

test('an unapproved plugin is listed with NO tools — the ledger gate is the list', async (t) => {
  const { dir, workspace } = await scratch();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = await makePlugin(join(dir, 'rogue'), { name: 'rogue', mcp: CALC_DECL });
  await addPlugin({ workspace, spec: root });
  const result = await listInstalledPlugins({ workspace });
  assert.equal(result.plugins.length, 1);
  assert.equal(result.plugins[0].tools, false, 'a declared-but-unapproved server never reads as tools');
  assert.match(result.plugins[0].brings, /refused by the install ledger and stays off/);
});

test('a workspace with nothing installed lists nothing, cleanly', async (t) => {
  const { dir, workspace } = await scratch();
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(await listInstalledPlugins({ workspace }), { plugins: [], unavailable: [] });
});

test('the served workspace resolves like the agent runtime resolves it', () => {
  assert.equal(installedPluginsWorkspace({ HELMION_WORKSPACE_PATH: ' /srv/bridge ' }), '/srv/bridge');
  assert.equal(installedPluginsWorkspace({}), process.cwd());
});

test('the fixture registry on disk is the ledger the bridge reads (no second store)', async (t) => {
  const { dir, workspace } = await scratch();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = await makePlugin(join(dir, 'greeter'), { name: 'greeter' });
  await addPlugin({ workspace, spec: root });
  const onDisk = JSON.parse(await readFile(registryPath(workspace), 'utf8'));
  assert.deepEqual(onDisk.plugins.map((p) => p.name), ['greeter']);
});
