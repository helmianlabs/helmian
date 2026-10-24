import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCoraClm } from '../src/cora/clm-server.mjs';
import { discoverCommands, projectCommandsDir, userCommandsDir } from '../src/agent/commands.mjs';
import { createLiveHelmianCloudAdminHandler } from '../src/cloud/live-admin.mjs';
import { SLASH_COMMANDS_PATH, listSlashCommands, slashCommandRow, slashCommandsWorkspace } from '../src/cloud/slash-commands.mjs';

async function writeCommand(root, relPath, contents) {
  const full = join(root, relPath);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, contents);
  return full;
}

test('the menu list is the bridge discovery set: workspace + personal + plugin, user-invocable only', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'helmion-slash-menu-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workspace = join(dir, 'ws');
  const home = join(dir, 'home');
  const pluginDir = join(dir, 'kit-commands');
  await writeCommand(projectCommandsDir(workspace), 'deploy.md',
    '---\ndescription: Ship the current branch\nargument-hint: [env]\n---\nDeploy to $0.\n');
  await writeCommand(projectCommandsDir(workspace), 'frontend/component.md',
    '---\ndescription: Scaffold a component\n---\nCreate component $ARGUMENTS.\n');
  await writeCommand(projectCommandsDir(workspace), 'model-only.md',
    '---\ndescription: For the model, not the menu\nuser-invocable: false\n---\nHidden.\n');
  await writeCommand(userCommandsDir(home), 'standup.md',
    '---\ndescription: Write my standup note\n---\nSummarize $ARGUMENTS.\n');
  await writeCommand(pluginDir, 'announce.md',
    '---\ndescription: Announce to the channel\n---\nPost $ARGUMENTS.\n');

  const result = await listSlashCommands({
    workspace,
    discoverCommandsImpl: (opts) => discoverCommands({ ...opts, home }),
    loadEnabledPluginsImpl: async () => ({ plugins: [{ name: 'kit', commandsDir: pluginDir }], errors: [] }),
  });

  assert.deepEqual(result.commands, [
    { name: 'deploy', description: 'Ship the current branch', origin: 'workspace' },
    { name: 'frontend:component', description: 'Scaffold a component', origin: 'workspace' },
    { name: 'kit:announce', description: 'Announce to the channel', origin: 'plugin' },
    { name: 'standup', description: 'Write my standup note', origin: 'personal' },
  ]);
  assert.deepEqual(result.unavailable, []);
  // No internals ride along: rows carry exactly the three public fields.
  for (const row of result.commands) assert.deepEqual(Object.keys(row).sort(), ['description', 'name', 'origin']);
});

test('rows: non-invocable and nameless commands drop out, long descriptions are capped, errors carry no path', async () => {
  const long = 'x'.repeat(500);
  const result = await listSlashCommands({
    workspace: '/unused',
    loadEnabledPluginsImpl: async () => ({ plugins: [], errors: [] }),
    discoverCommandsImpl: async () => ({
      list: [
        { name: 'big', description: long, source: 'project', userInvocable: true },
        { name: 'quiet', description: 'hidden', source: 'user', userInvocable: false },
        { name: '', description: 'nameless', source: 'project', userInvocable: true },
        { name: 'odd', description: 'unknown source defaults to workspace', source: 'somewhere', userInvocable: true },
      ],
      errors: [{ path: '/secret/disk/layout.md', message: 'could not read' }],
    }),
  });
  assert.deepEqual(result.commands.map((c) => c.name), ['big', 'odd']);
  assert.ok(result.commands[0].description.length <= 200);
  assert.equal(result.commands[1].origin, 'workspace');
  assert.deepEqual(result.unavailable, [{ message: 'could not read' }]);
  assert.equal(slashCommandRow(null), null);
});

test('workspace resolution matches the runtime: HELMION_WORKSPACE_PATH wins, else cwd', () => {
  assert.equal(slashCommandsWorkspace({ HELMION_WORKSPACE_PATH: ' /srv/ws ' }), '/srv/ws');
  assert.equal(slashCommandsWorkspace({}), process.cwd());
});

const env = { HELMION_CLOUD_ENVIRONMENT: 'staging', HELMION_DATABASE_URL: 'postgresql://app:x@ep-silent-rain-a1b2c3d4.us-east-2.aws.neon.tech/neondb?sslmode=require', HELMION_EXPECTED_ENDPOINT_ID: 'ep-silent-rain-a1b2c3d4', HELMION_ADMIN_ISSUER: 'https://identity.example.com', HELMION_ADMIN_CLIENT_ID: 'helmian', HELMION_ADMIN_REDIRECT_URI: 'https://helmian.example.com/admin/auth/callback' };

function pool() {
  const client = { async query(sql) {
    const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (['begin', 'commit', 'rollback'].includes(q) || q.startsWith('select set_config')) return { rowCount: 0, rows: [] };
    if (q.includes('from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ tenant_id: 'customer-a', role: 'owner' }] };
    throw new Error(`unexpected query ${q}`);
  }, release() {} };
  return { connect: async () => client };
}

test('GET /api/admin/commands is tenant-gated and returns the lister rows', async (t) => {
  const rows = [{ name: 'deploy', description: 'Ship the current branch', origin: 'workspace' }];
  const admin = await createLiveHelmianCloudAdminHandler({
    env, pool: pool(),
    identity: { getSession: (id) => (id === 's1' ? { subject: 'user-1' } : null) },
    page: '<p>t</p>', script: 'void 0;', expectedMigrations: [],
    commandLister: async () => ({ commands: rows, unavailable: [] }),
  });
  const clm = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 'test' }), notifyBackgroundAgents: false, httpRequestHandler: admin.handler });
  t.after(async () => { await clm.close(); await admin.close(); });
  const base = clm.healthUrl.replace('/healthz', '');
  const headers = { cookie: 'helmion_admin_session=s1' };

  const res = await fetch(`${base}${SLASH_COMMANDS_PATH}`, { headers });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.valid, true);
  assert.deepEqual(body.commands, rows);

  // No session → membership gate.
  assert.equal((await fetch(`${base}${SLASH_COMMANDS_PATH}`)).status, 403);
  // An authority selector is refused before anything is read.
  const sel = await fetch(`${base}${SLASH_COMMANDS_PATH}?tenant_id=x`, { headers });
  assert.equal(sel.status, 400);
  assert.equal((await sel.json()).code, 'COMMANDS_SELECTOR_INVALID');
});

test('GET /api/admin/commands reports a lister failure as 503, not a fake empty list', async (t) => {
  const admin = await createLiveHelmianCloudAdminHandler({
    env, pool: pool(),
    identity: { getSession: (id) => (id === 's1' ? { subject: 'user-1' } : null) },
    page: '<p>t</p>', script: 'void 0;', expectedMigrations: [],
    commandLister: async () => { throw new Error('disk gone'); },
  });
  const clm = await startCoraClm({ host: '127.0.0.1', port: 0, runTurn: async () => ({ text: 'ok', model: 'test' }), notifyBackgroundAgents: false, httpRequestHandler: admin.handler });
  t.after(async () => { await clm.close(); await admin.close(); });
  const base = clm.healthUrl.replace('/healthz', '');
  const res = await fetch(`${base}${SLASH_COMMANDS_PATH}`, { headers: { cookie: 'helmion_admin_session=s1' } });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'COMMANDS_READ_FAILED');
});
