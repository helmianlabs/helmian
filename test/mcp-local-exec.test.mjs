// Local-exec MCP server tests: approval gate, allowlist, audit, transports.
// Headless. PowerShell execution is faked; no network, no cloud.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLocalExecServer,
  createEnvoyApprovalNotifier,
  isPathAllowed,
  resolveRoots,
  parseApprovalReply,
  validateBindAddress,
  argsHash,
  createAuditLog,
  runHttpServer,
  TOOL_DEFINITIONS,
} from '../src/mcp/local-exec-server.mjs';

async function makeTmp() {
  return mkdtemp(join(tmpdir(), 'mcp-local-test-'));
}

function makeServer(tmp, overrides = {}) {
  const events = [];
  const fake = { called: 0 };
  const server = createLocalExecServer({
    roots: [tmp],
    audit: createAuditLog(join(tmp, 'audit.jsonl')),
    execPowershell: async () => {
      fake.called += 1;
      return { exitCode: 0, timedOut: false, truncated: false, stdout: 'fake-out', stderr: '' };
    },
    approvalTimeoutMs: 4000,
    onPermissionEvent: (e) => events.push(e),
    ...overrides,
  });
  return { server, events, fake, auditPath: join(tmp, 'audit.jsonl') };
}

async function readAudit(auditPath) {
  const raw = await readFile(auditPath, 'utf8');
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function settleAs(server, events, decision) {
  await new Promise((r) => setTimeout(r, 30));
  const req = events.find((e) => e.event === 'permission_request');
  assert.ok(req, 'expected a permission_request event');
  assert.equal(server.approve({ id: req.id, decision }), true);
  return req;
}

test('toolset exposes exactly the four curated tools', () => {
  const names = TOOL_DEFINITIONS.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'helmion_list_dir',
    'helmion_read_file',
    'helmion_run_powershell',
    'helmion_write_file',
  ]);
});

test('approval -> powershell executes', async () => {
  const tmp = await makeTmp();
  const { server, events, fake } = makeServer(tmp);
  const promise = server.callTool('helmion_run_powershell', { command: 'Write-Output hi' });
  await settleAs(server, events, 'approve');
  const result = await promise;
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'fake-out');
  assert.equal(fake.called, 1);
  const entries = await readAudit(join(tmp, 'audit.jsonl'));
  const entry = entries.find((e) => e.tool === 'helmion_run_powershell');
  assert.ok(entry);
  assert.equal(entry.ok, true);
  assert.match(entry.argsHash, /^[0-9a-f]{64}$/);
});

test('deny -> refused, nothing executes', async () => {
  const tmp = await makeTmp();
  const { server, events, fake } = makeServer(tmp);
  const promise = server.callTool('helmion_run_powershell', { command: 'Write-Output hi' });
  await settleAs(server, events, 'deny');
  const result = await promise;
  assert.equal(result.refused, true);
  assert.equal(fake.called, 0);
});

test('no answer -> timeout denies, fail closed', async () => {
  const tmp = await makeTmp();
  const { server, fake } = makeServer(tmp, { approvalTimeoutMs: 60 });
  const result = await server.callTool('helmion_run_powershell', { command: 'Write-Output hi' });
  assert.equal(result.refused, true);
  assert.equal(fake.called, 0);
});

test('write_file outside roots is refused before any approval', async () => {
  const tmp = await makeTmp();
  const { server, events } = makeServer(tmp);
  const outside = join(tmp, '..', 'escape.txt');
  const result = await server.callTool('helmion_write_file', { path: outside, content: 'x' });
  assert.ok(result.error);
  assert.match(result.error, /allowlist/);
  assert.equal(events.filter((e) => e.event === 'permission_request').length, 0);
  assert.equal(server.pendingApprovals(), 0);
});

test('write_file inside roots executes after approval', async () => {
  const tmp = await makeTmp();
  const { server, events } = makeServer(tmp);
  const target = join(tmp, 'sub', 'note.txt');
  const promise = server.callTool('helmion_write_file', { path: target, content: 'hello' });
  await settleAs(server, events, 'approve');
  const result = await promise;
  assert.equal(result.written, true);
  assert.equal(await readFile(target, 'utf8'), 'hello');
});

test('audit never stores raw secrets', async () => {
  const tmp = await makeTmp();
  const { server, events } = makeServer(tmp);
  const secret = 'npg_fakesecret123';
  const target = join(tmp, 's.txt');
  const promise = server.callTool('helmion_write_file', { path: target, content: `key=${secret}` });
  await settleAs(server, events, 'approve');
  await promise;
  const raw = await readFile(join(tmp, 'audit.jsonl'), 'utf8');
  assert.ok(!raw.includes(secret), 'raw secret must not appear in the audit log');
  assert.ok(!raw.includes('key='), 'raw content must not appear in the audit log');
});

test('read_file is ungated and size-capped', async () => {
  const tmp = await makeTmp();
  const { server, events } = makeServer(tmp);
  const target = join(tmp, 'big.txt');
  await writeFile(target, 'x'.repeat(300 * 1024));
  const result = await server.callTool('helmion_read_file', { path: target });
  assert.equal(result.truncated, true);
  assert.ok(result.content.length < 300 * 1024);
  assert.equal(events.filter((e) => e.event === 'permission_request').length, 0);
});

test('read_file outside roots is refused', async () => {
  const tmp = await makeTmp();
  const { server } = makeServer(tmp);
  const result = await server.callTool('helmion_read_file', { path: join(tmp, '..', 'x.txt') });
  assert.ok(result.error);
});

test('list_dir is ungated and entry-capped', async () => {
  const tmp = await makeTmp();
  const { server } = makeServer(tmp);
  await mkdir(join(tmp, 'd1'));
  await writeFile(join(tmp, 'f1.txt'), 'a');
  const result = await server.callTool('helmion_list_dir', { path: tmp });
  assert.ok(Array.isArray(result.entries));
  assert.ok(result.entries.some((e) => e.name === 'f1.txt' && e.kind === 'file'));
  assert.ok(result.entries.some((e) => e.name === 'd1' && e.kind === 'dir'));
});

test('dry-run describes without executing or asking', async () => {
  const tmp = await makeTmp();
  const { server, events, fake } = makeServer(tmp, { dryRun: true });
  const result = await server.callTool('helmion_run_powershell', { command: 'Remove-Item C:\\*' });
  assert.equal(result.dryRun, true);
  assert.ok(result.wouldRun.includes('Remove-Item'));
  assert.equal(fake.called, 0);
  assert.equal(events.filter((e) => e.event === 'permission_request').length, 0);
});

test('isPathAllowed blocks escapes', () => {
  const roots = ['/srv/work'];
  assert.equal(isPathAllowed('/srv/work/a.txt', roots), true);
  assert.equal(isPathAllowed('/srv/work', roots), true);
  assert.equal(isPathAllowed('/srv/work/../evil.txt', roots), false);
  assert.equal(isPathAllowed('/srv/worker/a.txt', roots), false);
  assert.equal(isPathAllowed('/etc/passwd', roots), false);
  assert.equal(isPathAllowed('', roots), false);
});

test('resolveRoots includes cwd and env extras', () => {
  const roots = resolveRoots({ cwd: '/tmp/x', extra: '/tmp/a, /tmp/b ,,/tmp/a' });
  assert.ok(roots.includes('/tmp/x'));
  assert.ok(roots.includes('/tmp/a'));
  assert.ok(roots.includes('/tmp/b'));
});

test('parseApprovalReply handles the phone reply shapes', () => {
  assert.deepEqual(parseApprovalReply('approve perm-1-abc'), { id: 'perm-1-abc', decision: 'approve' });
  assert.deepEqual(parseApprovalReply('  deny   perm-9  '), { id: 'perm-9', decision: 'deny' });
  assert.deepEqual(parseApprovalReply('YES perm-x-1'), { id: 'perm-x-1', decision: 'approve' });
  assert.equal(parseApprovalReply('approve'), null);
  assert.equal(parseApprovalReply('hello world'), null);
  assert.equal(parseApprovalReply('approve perm-1; rm -rf /'), null);
});

test('validateBindAddress refuses public binds', () => {
  assert.throws(() => validateBindAddress('0.0.0.0'), /public/);
  assert.throws(() => validateBindAddress('::'), /public/);
  assert.throws(() => validateBindAddress(''), /public/);
  assert.equal(validateBindAddress('127.0.0.1'), '127.0.0.1');
  assert.equal(validateBindAddress('100.64.0.5'), '100.64.0.5');
});

test('non-loopback bind requires a token', async () => {
  await assert.rejects(
    runHttpServer({ port: 0, bind: '100.64.0.5', envoyNotifier: null }),
    /HELMION_LOCAL_MCP_TOKEN/,
  );
  await assert.rejects(
    runHttpServer({ port: 0, bind: '0.0.0.0', envoyNotifier: null }),
    /public/,
  );
});

test('http transport serves health and tools/list on loopback', async () => {
  const tmp = await makeTmp();
  const { httpServer, port } = await runHttpServer({
    port: 0,
    bind: '127.0.0.1',
    roots: [tmp],
    audit: createAuditLog(join(tmp, 'audit.jsonl')),
    envoyNotifier: null,
  });
  try {
    const health = await (await fetch(`http://127.0.0.1:${port}/v1/health`)).json();
    assert.equal(health.ok, true);
    const listed = await (await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })).json();
    assert.ok(Array.isArray(listed.result.tools));
    assert.equal(listed.result.tools.length, 4);
  } finally {
    httpServer.close();
  }
});

test('envoy notifier posts the approval and settles on a phone reply', async () => {
  const tmp = await makeTmp();
  const tokenPath = join(tmp, 'token.json');
  await writeFile(tokenPath, JSON.stringify({ token: 'tok-1', tenantId: 'org-a' }));
  const calls = [];
  const handled = [];
  let pending = 1;
  const broker = {
    get pendingCount() { return pending; },
    handleResponse: (m) => { handled.push(m); pending = 0; return true; },
  };
  const fetchFn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method ?? 'GET', body: opts.body });
    const json = (obj) => ({ ok: true, json: async () => obj });
    if (url.includes('/api/admin/envoy/channels')) {
      return json({ channels: [{ slug: 'team', id: 'ch-1' }] });
    }
    if (url.includes('/api/admin/envoy/messages') && (opts.method ?? 'GET') === 'POST') {
      return json({ valid: true });
    }
    // GET messages: the phone reply approving perm-9
    return json({ messages: [{ id: 'm-1', authorKind: 'human', body: 'approve perm-9' }] });
  };
  const notifier = createEnvoyApprovalNotifier({
    broker, tokenPath, fetchFn, pollMs: 20, channelSlug: 'team',
  });
  await notifier.notify({ id: 'perm-9', summary: 'helmion_run_powershell: test', tool: 'helmion_run_powershell' });
  const post = calls.find((c) => c.method === 'POST');
  assert.ok(post, 'approval request posted to the channel');
  const posted = JSON.parse(post.body);
  assert.ok(posted.body.includes('perm-9'));
  assert.equal(posted.idempotencyKey, 'mcp-approval:perm-9');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(handled.length, 1);
  assert.deepEqual(handled[0], { id: 'perm-9', decision: 'approve' });
});

test('argsHash is stable and redacts', () => {
  const a = argsHash({ command: 'x', password: 'npg_abc123' });
  const b = argsHash({ command: 'x', password: 'npg_abc123' });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});
