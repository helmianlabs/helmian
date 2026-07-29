import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  MCP_APPROVED,
  MCP_REFUSED,
  RemoteSourceRefusedError,
  addPlugin,
  classifySource,
  declarationLocalRoot,
  evaluateMcpDeclaration,
  formatPluginReport,
  loadEnabledPlugins,
  loadPlugin,
  loadPluginManifest,
  readMcpDeclarations,
  readRegistry,
  removePlugin,
} from '../src/agent/plugins.mjs';
import { discoverCommands, resolveCommand } from '../src/agent/commands.mjs';
// agent-I's real ledger. The approval path below is a genuine positive control
// against their code, not a stub that would pass no matter what.
import {
  computeCandidateFingerprint,
  defaultLedgerDirectory,
  saveBaseline,
} from '../src/core/mcp-install-ledger.mjs';

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'helmion-plug-'));
  const workspace = join(dir, 'workspace');
  await mkdir(workspace, { recursive: true });
  return { dir, workspace };
}

async function write(path, contents) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, contents);
  return path;
}

/**
 * A plugin directory carrying a command and, optionally, an MCP server whose
 * code really exists on disk.
 */
async function makePlugin(root, {
  name = 'sample',
  manifestDir = '.helmion-plugin',
  mcp = null,
  serverCode = 'export const ok = true;\n',
} = {}) {
  await write(
    join(root, manifestDir, 'plugin.json'),
    `${JSON.stringify({ name, description: `${name} plugin`, version: '1.0.0' }, null, 2)}\n`,
  );
  await write(
    join(root, 'commands', 'greet.md'),
    '---\ndescription: Greet someone\nargument-hint: [name]\n---\nSay hello to $0.\n',
  );
  await write(
    join(root, 'commands', 'db', 'seed.md'),
    '---\ndescription: Seed the database\n---\nSeed with $ARGUMENTS.\n',
  );
  if (mcp) {
    await write(join(root, 'server', 'index.mjs'), serverCode);
    await write(join(root, '.mcp.json'), `${JSON.stringify(mcp, null, 2)}\n`);
  }
  return root;
}

const LOCAL_SERVER_DECL = {
  mcpServers: {
    'sample-server': { command: 'node', args: ['./server/index.mjs'] },
  },
};

// --- source classification -------------------------------------------------

test('remote-looking specs are classified remote, including owner/repo shorthand', () => {
  assert.equal(classifySource('https://github.com/someone/thing'), 'remote');
  assert.equal(classifySource('git@github.com:someone/thing.git'), 'remote');
  assert.equal(classifySource('someone/some-plugin'), 'remote');
  assert.equal(classifySource('C:\\plugins\\local'), 'local');
  assert.equal(classifySource('/opt/plugins/local'), 'local');
  assert.equal(classifySource('./local-plugin'), 'local');
});

test('plugin add REFUSES a remote source instead of fetching it', async (t) => {
  const { dir, workspace } = await scratch();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await assert.rejects(
    () => addPlugin({ workspace, spec: 'https://github.com/someone/evil-plugin' }),
    (err) => {
      assert.ok(err instanceof RemoteSourceRefusedError);
      assert.match(err.message, /Refusing to add/);
      assert.match(err.message, /helmion mcp-install/);
      return true;
    },
  );
  await assert.rejects(
    () => addPlugin({ workspace, spec: 'someone/evil-plugin' }),
    RemoteSourceRefusedError,
  );
  // Nothing was written: a refused add leaves no registry behind.
  assert.deepEqual((await readRegistry(workspace)).plugins, []);
});

// --- manifest + structure --------------------------------------------------

test('a manifest is read from .helmion-plugin or .claude-plugin', async (t) => {
  const { dir } = await scratch();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const helmion = await makePlugin(join(dir, 'p1'), { name: 'mine', manifestDir: '.helmion-plugin' });
  const claude = await makePlugin(join(dir, 'p2'), { name: 'theirs', manifestDir: '.claude-plugin' });

  assert.equal((await loadPluginManifest(helmion)).name, 'mine');
  assert.equal((await loadPluginManifest(claude)).name, 'theirs');
});

test('a plugin with no manifest still loads, named after its directory', async (t) => {
  const { dir, workspace } = await scratch();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'nameless-plugin');
  await write(join(root, 'commands', 'hi.md'), 'Say hi\n');

  const plugin = await loadPlugin({ root, workspace });
  assert.equal(plugin.name, 'nameless-plugin');
  assert.equal(plugin.manifestPresent, false);
  assert.ok(plugin.commandsDir);
});

test('commands/ misplaced inside the manifest directory is called out, not silently ignored', async (t) => {
  const { dir, workspace } = await scratch();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'misplaced');
  await write(join(root, '.claude-plugin', 'plugin.json'), '{"name":"misplaced"}\n');
  await write(join(root, '.claude-plugin', 'commands', 'oops.md'), 'body\n');

  const plugin = await loadPlugin({ root, workspace });
  assert.equal(plugin.commandsDir, null);
  assert.equal(plugin.warnings.length, 1);
  assert.match(plugin.warnings[0], /belongs at the plugin root/);
});

// --- plugin commands -------------------------------------------------------

test("a plugin's commands become namespaced slash commands", async (t) => {
  const { dir, workspace } = await scratch();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = await makePlugin(join(dir, 'toolkit'), { name: 'toolkit' });

  const plugin = await loadPlugin({ root, workspace });
  const registry = await discoverCommands({
    workspace, home: join(dir, 'nohome'), plugins: [plugin],
  });

  // Plugin prefix, then the subdirectory namespace, then the file name.
  assert.deepEqual(
    registry.list.map((c) => c.name).sort(),
    ['toolkit:db:seed', 'toolkit:greet'],
  );
  const greet = resolveCommand(registry, 'toolkit:greet');
  assert.equal(greet.description, 'Greet someone');
  assert.equal(greet.source, 'plugin');
  assert.equal(greet.origin, 'toolkit');
});

// --- THE SECURITY GATE -----------------------------------------------------

test('SECURITY: an un-vetted MCP declaration is REFUSED, never registered', async (t) => {
  const { dir, workspace } = await scratch();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = await makePlugin(join(dir, 'connector'), {
    name: 'connector', mcp: LOCAL_SERVER_DECL,
  });

  const plugin = await loadPlugin({ root, workspace });

  assert.equal(plugin.mcpServers.length, 1);
  assert.equal(plugin.mcpServers[0].status, MCP_REFUSED);
  assert.match(plugin.mcpServers[0].reason, /never been approved/);
  assert.match(plugin.mcpServers[0].reason, /helmion mcp-install/);
  // The only list a consumer is supposed to read is empty.
  assert.deepEqual(plugin.registrations, []);
  assert.equal(plugin.refusals.length, 1);
  // And the human sees the refusal.
  assert.match(formatPluginReport([plugin]), /✗ mcp "sample-server" REFUSED/);
});

test('SECURITY: positive control — the SAME declaration is approved once the ledger holds a real baseline', async (t) => {
  const { dir, workspace } = await scratch();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = await makePlugin(join(dir, 'connector'), {
    name: 'connector', mcp: LOCAL_SERVER_DECL,
  });

  // Before: refused (proves the gate is not simply always-allow).
  const before = await loadPlugin({ root, workspace });
  assert.equal(before.mcpServers[0].status, MCP_REFUSED);

  // Record a real approval using agent-I's own ledger functions.
  const ledgerDir = defaultLedgerDirectory(workspace);
  const fingerprint = await computeCandidateFingerprint({ root: join(root, 'server'), declared: {} });
  await saveBaseline({
    ledgerDir,
    serverName: 'sample-server',
    fingerprint,
    approvalRecord: { respondedAt: new Date().toISOString(), challenge: 'test-approval' },
  });

  // After: approved, and only now does it reach `registrations`.
  const after = await loadPlugin({ root, workspace });
  assert.equal(after.mcpServers[0].status, MCP_APPROVED);
  assert.equal(after.registrations.length, 1);
  assert.equal(after.registrations[0].name, 'sample-server');
  assert.deepEqual(after.refusals, []);
  assert.match(formatPluginReport([after]), /✓ mcp "sample-server" APPROVED/);
});

test('SECURITY: an approved server that CHANGES afterwards is refused again', async (t) => {
  const { dir, workspace } = await scratch();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = await makePlugin(join(dir, 'connector'), {
    name: 'connector', mcp: LOCAL_SERVER_DECL,
  });

  const ledgerDir = defaultLedgerDirectory(workspace);
  await saveBaseline({
    ledgerDir,
    serverName: 'sample-server',
    fingerprint: await computeCandidateFingerprint({ root: join(root, 'server'), declared: {} }),
    approvalRecord: { respondedAt: new Date().toISOString(), challenge: 'test-approval' },
  });
  assert.equal((await loadPlugin({ root, workspace })).mcpServers[0].status, MCP_APPROVED);

  // The plugin quietly swaps in different code after approval.
  await writeFile(
    join(root, 'server', 'index.mjs'),
    'import { execSync } from "node:child_process";\nexecSync("whoami");\n',
  );

  const after = await loadPlugin({ root, workspace });
  assert.equal(after.mcpServers[0].status, MCP_REFUSED);
  assert.match(after.mcpServers[0].reason, /changed since it was approved/);
  assert.deepEqual(after.registrations, []);
});

test('SECURITY: a server fetched at run time cannot be vetted, so it is refused', async (t) => {
  const { dir, workspace } = await scratch();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'npx-plugin');
  await write(join(root, '.helmion-plugin', 'plugin.json'), '{"name":"npx-plugin"}\n');
  await write(join(root, '.mcp.json'), `${JSON.stringify({
    mcpServers: {
      remote: { command: 'npx', args: ['-y', 'some-package'] },
      hosted: { type: 'http', url: 'https://example.com/mcp' },
    },
  }, null, 2)}\n`);

  const plugin = await loadPlugin({ root, workspace });
  assert.equal(plugin.registrations.length, 0);
  assert.equal(plugin.refusals.length, 2);
  for (const refusal of plugin.refusals) {
    assert.match(refusal.reason, /not on local disk/);
  }
});

test('declarationLocalRoot resolves vettable code and refuses the rest', () => {
  // Built with resolve() so the assertion is the same on Windows and POSIX;
  // a bare '/plugins/p' is drive-relative on Windows and would differ per box.
  const pluginRoot = resolve(tmpdir(), 'plugins', 'p');
  assert.equal(
    declarationLocalRoot({ command: 'node', args: ['./server/index.mjs'] }, pluginRoot),
    join(pluginRoot, 'server'),
  );
  assert.equal(declarationLocalRoot({ command: 'npx', args: ['-y', 'pkg'] }, pluginRoot), null);
  assert.equal(declarationLocalRoot({ url: 'https://x/mcp' }, pluginRoot), null);
  assert.equal(declarationLocalRoot({ command: 'some-binary' }, pluginRoot), null);
});

test('a broken ledger fails CLOSED rather than approving by default', async (t) => {
  const { dir, workspace } = await scratch();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = await makePlugin(join(dir, 'connector'), {
    name: 'connector', mcp: LOCAL_SERVER_DECL,
  });

  const verdict = await evaluateMcpDeclaration({
    serverName: 'sample-server',
    declaration: LOCAL_SERVER_DECL.mcpServers['sample-server'],
    pluginRoot: root,
    pluginName: 'connector',
    ledgerDir: join(workspace, '.helmion', 'mcp-security'),
    ledger: {
      checkForDrift: async () => { throw new Error('ledger unreadable'); },
    },
  });
  assert.equal(verdict.status, MCP_REFUSED);
  assert.match(verdict.reason, /Ledger check failed/);
});

test('a malformed .mcp.json registers nothing and says why', async (t) => {
  const { dir, workspace } = await scratch();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'broken');
  await write(join(root, '.mcp.json'), '{ not json');

  const declarations = await readMcpDeclarations(root);
  assert.deepEqual(declarations.servers, []);
  assert.match(declarations.warnings[0], /not valid JSON/);

  const plugin = await loadPlugin({ root, workspace });
  assert.deepEqual(plugin.registrations, []);
});

// --- registry --------------------------------------------------------------

test('a local plugin can be added, listed, and removed', async (t) => {
  const { dir, workspace } = await scratch();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = await makePlugin(join(dir, 'toolkit'), { name: 'toolkit' });

  const added = await addPlugin({ workspace, spec: root });
  assert.equal(added.plugin.name, 'toolkit');
  assert.equal(added.replaced, false);

  const loaded = await loadEnabledPlugins({ workspace });
  assert.equal(loaded.plugins.length, 1);
  assert.equal(loaded.plugins[0].name, 'toolkit');

  assert.deepEqual(await removePlugin({ workspace, name: 'toolkit' }), { removed: true });
  assert.deepEqual((await loadEnabledPlugins({ workspace })).plugins, []);
  assert.deepEqual(await removePlugin({ workspace, name: 'toolkit' }), { removed: false });
});

test('adding a path that is not a directory fails loudly', async (t) => {
  const { dir, workspace } = await scratch();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    () => addPlugin({ workspace, spec: join(dir, 'does-not-exist') }),
    /Not a directory/,
  );
});

test('a registered plugin whose directory vanished is reported, not thrown', async (t) => {
  const { dir, workspace } = await scratch();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = await makePlugin(join(dir, 'gone'), { name: 'gone' });
  await addPlugin({ workspace, spec: root });
  await rm(root, { recursive: true, force: true });

  const loaded = await loadEnabledPlugins({ workspace });
  // The plugin loads as an empty shell rather than taking the session down.
  assert.equal(loaded.plugins.length + loaded.errors.length, 1);
  if (loaded.plugins.length) assert.equal(loaded.plugins[0].commandsDir, null);
});

test('a disabled plugin contributes nothing', async (t) => {
  const { dir, workspace } = await scratch();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = await makePlugin(join(dir, 'toolkit'), { name: 'toolkit' });
  await addPlugin({ workspace, spec: root });

  const registryFile = join(workspace, '.helmion', 'plugins.json');
  const current = await readRegistry(workspace);
  current.plugins[0].enabled = false;
  await writeFile(registryFile, `${JSON.stringify(current, null, 2)}\n`);

  assert.deepEqual((await loadEnabledPlugins({ workspace })).plugins, []);
});
