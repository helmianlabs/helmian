import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolRuntime } from '../src/agent/tools.mjs';
import { createSessionState } from '../src/agent/loop.mjs';

test('read-only mode provides zero tools', () => {
  const runtime = createToolRuntime('.', { permissionMode: 'read-only' });
  const tools = Object.keys(runtime.tools);
  assert.strictEqual(tools.length, 0, 'read-only should have no tools');
  assert.strictEqual(runtime.permissionMode, 'read-only');
});

test('read-tools mode provides exactly read_file, list_dir, search_text', () => {
  const runtime = createToolRuntime('.', { permissionMode: 'read-tools' });
  const tools = Object.keys(runtime.tools).sort();
  assert.deepStrictEqual(
    tools,
    ['list_dir', 'read_file', 'search_text'],
    'read-tools must provide exactly the three read tools'
  );
  assert.strictEqual(runtime.permissionMode, 'read-tools');
});

test('full mode provides all five tools including write_file and run_command', () => {
  const runtime = createToolRuntime('.', { permissionMode: 'full' });
  const tools = Object.keys(runtime.tools).sort();
  assert.deepStrictEqual(
    tools,
    ['list_dir', 'read_file', 'run_command', 'search_text', 'write_file'],
    'full mode must provide all 5 tools including write and execute'
  );
  assert.strictEqual(runtime.permissionMode, 'full');
});

test('CLI agent session defaults to full tools', () => {
  const state = createSessionState('.');
  const tools = Object.keys(state.runtime.tools).sort();
  assert.deepStrictEqual(
    tools,
    ['list_dir', 'read_file', 'run_command', 'search_text', 'write_file'],
    'CLI session must default to full tools (not read-only zero)'
  );
  assert.strictEqual(state.runtime.permissionMode, 'full');
});

test('agent session with explicit read-tools provides only read tools', () => {
  const state = createSessionState('.', { permissionMode: 'read-tools' });
  const tools = Object.keys(state.runtime.tools).sort();
  assert.deepStrictEqual(
    tools,
    ['list_dir', 'read_file', 'search_text'],
    'explicit read-tools mode should limit to read operations'
  );
  assert.strictEqual(state.runtime.permissionMode, 'read-tools');
});

test('agent session with explicit read-only provides zero tools', () => {
  const state = createSessionState('.', { permissionMode: 'read-only' });
  const tools = Object.keys(state.runtime.tools);
  assert.strictEqual(
    tools.length,
    0,
    'explicit read-only mode should provide no tools'
  );
  assert.strictEqual(state.runtime.permissionMode, 'read-only');
});

test('permission mode normalization accepts aliases', () => {
  const full1 = createToolRuntime('.', { permissionMode: 'execution' });
  const full2 = createToolRuntime('.', { permissionMode: 'on' });
  const full3 = createToolRuntime('.', { permissionMode: 'write' });
  
  assert.strictEqual(full1.permissionMode, 'full');
  assert.strictEqual(full2.permissionMode, 'full');
  assert.strictEqual(full3.permissionMode, 'full');
  
  const readTools1 = createToolRuntime('.', { permissionMode: 'read' });
  const readTools2 = createToolRuntime('.', { permissionMode: 'tools-read' });
  
  assert.strictEqual(readTools1.permissionMode, 'read-tools');
  assert.strictEqual(readTools2.permissionMode, 'read-tools');
});

test('invalid permission mode defaults to read-only', () => {
  const runtime = createToolRuntime('.', { permissionMode: 'invalid-mode' });
  assert.strictEqual(runtime.permissionMode, 'read-only');
  assert.strictEqual(Object.keys(runtime.tools).length, 0);
});

test('tool execution is blocked when permission denies it', async () => {
  const runtime = createToolRuntime('.', { permissionMode: 'read-tools' });
  
  // read_file should work
  const readResult = await runtime.execute('read_file', { path: 'package.json' });
  assert.ok(!readResult.includes('Error: tool'), 'read_file should work in read-tools mode');
  
  // write_file should be blocked
  const writeResult = await runtime.execute('write_file', { path: 'test.txt', content: 'test' });
  assert.ok(
    writeResult.includes('Error: tool') && writeResult.includes('blocked by permission'),
    'write_file must be blocked in read-tools mode'
  );
  
  // run_command should be blocked
  const cmdResult = await runtime.execute('run_command', { command: 'echo test' });
  assert.ok(
    cmdResult.includes('Error: tool') && cmdResult.includes('blocked by permission'),
    'run_command must be blocked in read-tools mode'
  );
});
