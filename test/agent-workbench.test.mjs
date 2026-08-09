import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolRuntime } from '../src/agent/tools.mjs';
import { systemPrompt } from '../src/agent/providers.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'helmion-workbench-'));
  writeFileSync(join(root, 'README.md'), '# Fixture\n', 'utf8');
  writeFileSync(join(root, '.env'), 'OPENAI_API_KEY=must-not-be-visible\n', 'utf8');
  return root;
}

function parsed(value) { return JSON.parse(value); }

test('modern workbench exposes typed tools instead of arbitrary shell or overwrite', async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = createToolRuntime(root, { permissionMode: 'full', safeWorkspaceTools: true });
  t.after(() => runtime.dispose());
  assert.deepEqual(Object.keys(runtime.tools).sort(), [
    'create_file', 'edit_file', 'list_dir', 'read_file', 'run_project_task',
    'search_text', 'start_project_preview', 'stop_project_preview', 'workspace_context',
  ]);
  assert.equal('run_command' in runtime.tools, false);
  assert.equal('write_file' in runtime.tools, false);
  const prompt = systemPrompt(runtime.root, Object.keys(runtime.tools));
  assert.match(prompt, /run_project_task entries declared by the selected project/);
  assert.match(prompt, /no arbitrary terminal or OS command tool/i);
  assert.doesNotMatch(prompt, /run_command is real shell/);
});

test('workspace context is bounded, project-bound, and excludes private configuration', async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'node build.mjs' } }));
  const runtime = createToolRuntime(root, { permissionMode: 'read-tools', safeWorkspaceTools: true });
  const context = parsed(await runtime.execute('workspace_context', {}));
  assert.equal(context.contract, 'helmion.workbench.v1');
  assert.equal(context.boundaries.privateFilesExcluded, true);
  assert.ok(context.files.some((item) => item.path === 'README.md'));
  assert.ok(!context.files.some((item) => item.path === '.env'));
  assert.deepEqual(context.tasks.map((item) => item.id), ['npm:build']);
  const refused = await runtime.execute('read_file', { path: '../outside.txt' });
  assert.match(refused, /Error:|workspace/i);
  assert.match(await runtime.execute('read_file', { path: '.env' }), /private configuration/i);
  assert.doesNotMatch(await runtime.execute('list_dir', { path: '.' }), /\.env/);
  assert.equal(await runtime.execute('search_text', {
    query: 'must-not-be-visible', path: '.',
  }), 'No hits for "must-not-be-visible"');
});

test('create and exact edit refuse overwrite, ambiguity, traversal, and stale hashes', async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = createToolRuntime(root, { permissionMode: 'full', safeWorkspaceTools: true });
  const created = parsed(await runtime.execute('create_file', { path: 'src/new.txt', content: 'alpha beta' }));
  assert.equal(created.operation, 'created');
  assert.equal(readFileSync(join(root, 'src', 'new.txt'), 'utf8'), 'alpha beta');
  assert.match(await runtime.execute('create_file', { path: 'src/new.txt', content: 'overwrite' }), /already exists/);
  assert.match(await runtime.execute('create_file', { path: '../escape.txt', content: 'x' }), /Error:|escapes/i);
  assert.match(await runtime.execute('create_file', { path: '.env', content: 'x' }), /private configuration/);
  assert.match(await runtime.execute('edit_file', {
    path: 'src/new.txt', old_text: 'alpha', new_text: 'A', expected_sha256: '0'.repeat(64),
  }), /precondition did not match/);
  const edited = parsed(await runtime.execute('edit_file', {
    path: 'src/new.txt', old_text: 'alpha', new_text: 'A', expected_sha256: created.sha256,
  }));
  assert.equal(edited.operation, 'edited');
  assert.equal(readFileSync(join(root, 'src', 'new.txt'), 'utf8'), 'A beta');
  writeFileSync(join(root, 'twice.txt'), 'same same');
  assert.match(await runtime.execute('edit_file', {
    path: 'twice.txt', old_text: 'same', new_text: 'x',
  }), /exactly once/);
});

test('filesystem links cannot redirect controlled file actions outside the workspace', async (t) => {
  const root = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'helmion-workbench-outside-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  try { symlinkSync(outside, join(root, 'linked'), 'junction'); }
  catch { t.skip('filesystem link creation is unavailable'); return; }
  const runtime = createToolRuntime(root, { permissionMode: 'full', safeWorkspaceTools: true });
  const result = await runtime.execute('create_file', { path: 'linked/nope.txt', content: 'x' });
  assert.match(result, /links are not allowed/);
  assert.match(await runtime.execute('read_file', { path: 'linked/outside.txt' }), /links are not allowed/);
  assert.doesNotMatch(await runtime.execute('list_dir', { path: '.' }), /linked/);
});

test('declared task runs directly with sanitized environment and returns artifacts', async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.helmion', 'artifacts'), { recursive: true });
  writeFileSync(join(root, 'build.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync('.helmion/artifacts/result.txt', process.env.OPENAI_API_KEY ? 'leaked' : 'built');",
    "console.log(process.env.OPENAI_API_KEY ? 'secret-present' : 'secret-absent');",
  ].join('\n'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'node build.mjs' } }));
  const original = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'must-not-reach-task';
  t.after(() => { if (original === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = original; });
  const runtime = createToolRuntime(root, { permissionMode: 'full', safeWorkspaceTools: true });
  const result = parsed(await runtime.execute('run_project_task', { task_id: 'npm:build' }));
  assert.equal(result.status, 'completed');
  assert.match(result.output, /secret-absent/);
  assert.equal(readFileSync(join(root, '.helmion', 'artifacts', 'result.txt'), 'utf8'), 'built');
  assert.equal(result.artifacts[0].path, '.helmion/artifacts/result.txt');
  assert.match(await runtime.execute('run_project_task', { task_id: 'npm:not-declared' }), /not declared/);
});

test('static preview binds loopback, serves only selected files, and stops', async (t) => {
  const root = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'helmion-preview-outside-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'site'));
  writeFileSync(join(root, 'site', 'index.html'), '<h1>real preview</h1>');
  writeFileSync(join(outside, 'secret.txt'), 'must not be served');
  try { symlinkSync(outside, join(root, 'site', 'linked'), 'junction'); } catch { /* unavailable */ }
  const runtime = createToolRuntime(root, { permissionMode: 'full', safeWorkspaceTools: true });
  t.after(() => runtime.dispose());
  const started = parsed(await runtime.execute('start_project_preview', { path: 'site' }));
  assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const response = await fetch(started.url);
  assert.equal(await response.text(), '<h1>real preview</h1>');
  assert.match(response.headers.get('content-security-policy'), /object-src 'none'/);
  if (existsSync(join(root, 'site', 'linked'))) {
    const escaped = await fetch(new URL('linked/secret.txt', started.url));
    assert.notEqual(escaped.status, 200);
    assert.doesNotMatch(await escaped.text(), /must not be served/);
  }
  const stopped = parsed(await runtime.execute('stop_project_preview', {}));
  assert.equal(stopped.status, 'stopped');
  await assert.rejects(fetch(started.url));
});

test('ask mode fails closed when no approver is connected', async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = createToolRuntime(root, { permissionMode: 'ask', safeWorkspaceTools: true });
  const result = await runtime.execute('create_file', { path: 'denied.txt', content: 'no' });
  assert.match(result, /DENIED.*no approver/i);
  assert.throws(() => readFileSync(join(root, 'denied.txt')));
});
