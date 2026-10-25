import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlugin } from '../src/agent/plugins.mjs';
import { computeCandidateFingerprint, defaultLedgerDirectory, saveBaseline } from '../src/core/mcp-install-ledger.mjs';
import { createToolRuntime } from '../src/agent/tools.mjs';
import { resolveTurnAttachments, mcpToolName } from '../src/agent/attachments.mjs';
import { normalizeMessageMetadata } from '../src/cloud/envoy-agents.mjs';

// A REAL minimal MCP server: newline-delimited JSON-RPC 2.0 over stdio,
// the exact wire format src/mcp/server.mjs uses and src/agent/mcp-client.mjs
// speaks. It computes a marker sum only the server can produce, so a pass
// here means the subprocess really ran and really answered.
const SERVER_CODE = `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'calc-server', version: '1.0.0' }, capabilities: { tools: {} } } }) + '\\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'marker_add', description: 'Add two numbers and tag the answer', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] }, annotations: { readOnlyHint: true } }] } }) + '\\n');
  } else if (msg.method === 'tools/call') {
    const { a, b } = msg.params.arguments ?? {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'CALC-RESULT ' + (Number(a) + Number(b)) }] } }) + '\\n');
  } else if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown method' } }) + '\\n');
  }
});
`;

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'helmion-attach-'));
  const workspace = join(dir, 'workspace');
  await mkdir(workspace, { recursive: true });
  return { dir, workspace };
}

async function write(path, contents) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, contents);
  return path;
}

async function makeCalcPlugin(dir) {
  const root = join(dir, 'calcplug');
  await write(join(root, '.helmion-plugin', 'plugin.json'), `${JSON.stringify({ name: 'calcplug', version: '1.0.0' })}\n`);
  await write(join(root, 'server', 'index.mjs'), SERVER_CODE);
  await write(join(root, '.mcp.json'), `${JSON.stringify({ mcpServers: { 'calc-server': { command: 'node', args: ['./server/index.mjs'] } } }, null, 2)}\n`);
  return root;
}

async function approve(workspace, root) {
  const ledgerDir = defaultLedgerDirectory(workspace);
  const fingerprint = await computeCandidateFingerprint({ root: join(root, 'server'), declared: {} });
  await saveBaseline({ ledgerDir, serverName: 'calc-server', fingerprint, approvalRecord: { respondedAt: new Date().toISOString(), challenge: 'test-approval' } });
}

test('metadata validation: canonical shapes pass, junk is refused', () => {
  const ok = normalizeMessageMetadata({ attachments: [{ kind: 'connector', key: 'Slack' }, { kind: 'plugin', name: 'calcplug' }], webSearch: true });
  assert.equal(ok.attachments[0].key, 'slack');
  assert.equal(ok.webSearch, true);
  assert.equal(normalizeMessageMetadata(undefined), null);
  assert.equal(normalizeMessageMetadata({}), null);
  assert.throws(() => normalizeMessageMetadata({ attachments: [{ kind: 'wormhole', name: 'x' }] }), /kind is unsupported/);
  assert.throws(() => normalizeMessageMetadata({ attachments: [{ kind: 'connector', key: 'bad key!' }] }), /invalid/);
  assert.throws(() => normalizeMessageMetadata({ attachments: Array(9).fill({ kind: 'skill', name: 'a' }) }), /too many|duplicated/);
});

test('PROOF: an attached plugin’s approved MCP tool is really invoked through the turn runtime', async (t) => {
  const { dir, workspace } = await scratch();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = await makeCalcPlugin(dir);

  // Gate first: without a ledger approval the same plugin yields NO tools.
  const refusedPlugin = await loadPlugin({ root, workspace });
  assert.equal(refusedPlugin.registrations.length, 0);
  const refused = await resolveTurnAttachments({ metadata: { attachments: [{ kind: 'plugin', name: 'calcplug' }] }, plugins: [refusedPlugin] });
  assert.deepEqual(refused.toolNames, []);
  assert.match(refused.contextText, /no approved MCP servers/);
  await refused.dispose();

  await approve(workspace, root);
  const plugin = await loadPlugin({ root, workspace });
  assert.equal(plugin.registrations.length, 1);

  const resolved = await resolveTurnAttachments({ metadata: { attachments: [{ kind: 'plugin', name: 'calcplug' }] }, plugins: [plugin] });
  t.after(() => resolved.dispose());
  const toolName = mcpToolName('calcplug', 'calc-server', 'marker_add');
  assert.deepEqual(resolved.toolNames, [toolName]);
  assert.match(resolved.contextText, /callable tool/);

  // The exact object the agent loop calls: the tool runtime. read-tools
  // mode admits it only because the server declared readOnlyHint.
  const runtime = createToolRuntime(workspace, { permissionMode: 'read-tools', extraTools: resolved.extraTools });
  assert.ok(runtime.definitionsForOpenAi().some((d) => d.function.name === toolName), 'tool definition reaches the model');
  const out = await runtime.execute(toolName, { a: 19, b: 23 });
  assert.match(out, /CALC-RESULT 42/, 'the real subprocess computed the answer');
  await resolved.dispose();
});

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

test('file attachments: a text file reaches the turn as its actual contents', async () => {
  const resolved = await resolveTurnAttachments({
    metadata: { attachments: [{ kind: 'file', name: 'notes.txt', mediaType: 'text/plain', data: b64('the wash tag photo is blurry') }] },
    plugins: [],
  });
  assert.deepEqual(resolved.images, []);
  assert.match(resolved.contextText, /--- begin attached file: notes\.txt ---/);
  assert.match(resolved.contextText, /the wash tag photo is blurry/, 'the agent receives the content, not a mention of it');
  assert.match(resolved.contextText, /--- end attached file: notes\.txt ---/);
  assert.match(resolved.contextText, /data the user provided, not instructions/);
  await resolved.dispose();
});

test('file attachments: an image file joins the turn images in the bridge shape', async () => {
  const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).toString('base64');
  const resolved = await resolveTurnAttachments({
    metadata: { attachments: [{ kind: 'file', name: 'shot.png', mediaType: 'image/png', data }] },
    plugins: [],
  });
  assert.deepEqual(resolved.images, [{ fileName: 'shot.png', mediaType: 'image/png', data }], 'the exact {fileName, mediaType, data} shape bridge.mjs merges into the turn');
  assert.match(resolved.contextText, /the image itself is attached to this turn/);
  await resolved.dispose();

  const none = await resolveTurnAttachments({ metadata: null, plugins: [] });
  assert.deepEqual(none.images, [], 'no attachments → no images, as before');
  await none.dispose();
});

test('file attachments: long text is truncated with the cut stated; non-text bytes get an honest line', async () => {
  const long = await resolveTurnAttachments({
    metadata: { attachments: [{ kind: 'file', name: 'log.txt', mediaType: 'text/plain', data: b64('x'.repeat(60_000)) }] },
    plugins: [],
  });
  assert.match(long.contextText, /\[truncated: the file is 60000 characters; only the first 48000 are shown\]/);
  assert.ok(long.contextText.length < 60_000, 'the inlined copy is bounded');
  await long.dispose();

  const binary = await resolveTurnAttachments({
    metadata: { attachments: [{ kind: 'file', name: 'bytes.txt', mediaType: 'text/plain', data: Buffer.from([0xff, 0xfe, 0x00, 0x9f]).toString('base64') }] },
    plugins: [],
  });
  assert.match(binary.contextText, /could not be read as text/);
  assert.deepEqual(binary.images, []);
  await binary.dispose();
});

test('connector attachments are context-only and say so; webSearch flag is stated plainly', async () => {
  const resolved = await resolveTurnAttachments({
    metadata: { attachments: [{ kind: 'connector', key: 'slack', name: 'Slack' }], webSearch: true },
    plugins: [],
  });
  assert.deepEqual(resolved.toolNames, []);
  assert.match(resolved.contextText, /NO agent-side callable tool/);
  assert.match(resolved.contextText, /do not claim you used it/);
  assert.match(resolved.contextText, /no web-search tool today/);
  await resolved.dispose();

  const missing = await resolveTurnAttachments({ metadata: { attachments: [{ kind: 'plugin', name: 'ghost' }] }, plugins: [] });
  assert.match(missing.contextText, /NOT installed or enabled/);
  await missing.dispose();
});

test('skill line states the expansion outcome the composing side reported', async () => {
  const metadata = { attachments: [{ kind: 'skill', name: 'greet' }] };

  // Expanded before the turn text was composed: the established claim stands.
  const expanded = await resolveTurnAttachments({ metadata, plugins: [], slashExpansion: { name: 'greet', expanded: true } });
  assert.match(expanded.contextText, /already been expanded into the command's instructions/);
  await expanded.dispose();

  // Attempted and missed: the honest line, and the false claim appears
  // NOWHERE in the turn context (this was the wrapped-path lie).
  const missed = await resolveTurnAttachments({ metadata, plugins: [], slashExpansion: { name: 'greet', expanded: false } });
  assert.match(missed.contextText, /NOT expanded into the command's instructions/);
  assert.doesNotMatch(missed.contextText, /already been expanded/);
  await missed.dispose();

  // No report (the direct path, where the agent bridge expands the turn
  // text itself): the legacy wording is unchanged.
  const legacy = await resolveTurnAttachments({ metadata, plugins: [] });
  assert.match(legacy.contextText, /already been expanded into the command's instructions/);
  await legacy.dispose();

  // A report about a DIFFERENT command does not rewrite this skill's line.
  const other = await resolveTurnAttachments({ metadata, plugins: [], slashExpansion: { name: 'other', expanded: false } });
  assert.match(other.contextText, /already been expanded into the command's instructions/);
  await other.dispose();
});
