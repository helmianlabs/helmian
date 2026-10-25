// A minimal real MCP server over stdio (NDJSON JSON-RPC), spawned by the
// tool-connection probe tests with the real stdio client — the probe must
// prove itself against a genuine tools/list, not a mock of one.
// Modes: default answers 3 tools; --fail-list answers initialize, then
// returns a JSON-RPC error for tools/list.
import { createInterface } from 'node:readline';

const failList = process.argv.includes('--fail-list');

const TOOLS = [
  { name: 'fixture_echo', description: 'echoes its input', inputSchema: { type: 'object' } },
  { name: 'fixture_time', description: 'says the time', inputSchema: { type: 'object' } },
  { name: 'fixture_sum', description: 'adds two numbers', inputSchema: { type: 'object' } },
];

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try { message = JSON.parse(text); } catch { return; }
  if (message.id === undefined || message.id === null) return; // notification
  if (message.method === 'initialize') {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0', id: message.id,
      result: { protocolVersion: '2024-11-05', serverInfo: { name: 'tool-probe-fixture', version: '1.0.0' } },
    })}\n`);
    return;
  }
  if (message.method === 'tools/list') {
    if (failList) {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0', id: message.id,
        error: { code: -32000, message: 'fixture tools/list failure' },
      })}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0', id: message.id,
    error: { code: -32601, message: `unknown method ${message.method}` },
  })}\n`);
});
