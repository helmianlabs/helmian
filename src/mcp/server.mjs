import { createInterface } from 'node:readline';
import { createNeonStore } from '../adapters/neon.mjs';

const TOOLSETS = {
  context: [{
    name: 'helmion_get_context',
    description: 'Fetch active blockers, enforced rules, and project invariants.',
    inputSchema: {
      type: 'object',
      properties: { projectSlug: { type: 'string' } },
      required: ['projectSlug'],
    },
  }],
  flywheel: [
    {
      name: 'helmion_list_blockers',
      description: 'List active shared blockers before starting work.',
      inputSchema: {
        type: 'object',
        properties: { projectSlug: { type: 'string' } },
      },
    },
    {
      name: 'helmion_resolve_blocker',
      description: 'Resolve a blocker with mandatory empirical proof.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          outcome: { type: 'string' },
          citation: { type: 'string' },
          root_cause: { type: 'string' },
          snippet: { type: 'string' },
          lesson: { type: 'string' },
        },
        required: ['id', 'outcome', 'citation', 'root_cause', 'snippet'],
      },
    },
  ],
  advisory: [
    {
      name: 'helmion_record_review',
      description: 'Record one read-only advisor vote for an immutable action hash.',
      inputSchema: {
        type: 'object',
        properties: {
          action_hash: { type: 'string' },
          advisor: { enum: ['claude', 'gemini', 'grok', 'openai'] },
          decision: { enum: ['APPROVED', 'REJECTED'] },
          read_only: { const: true },
          rationale: { type: 'string' },
          evidence: { type: 'object' },
        },
        required: ['action_hash', 'advisor', 'decision', 'read_only'],
      },
    },
    {
      name: 'helmion_consensus_status',
      description: 'Check Tier B advisory completeness; model votes never replace human approval.',
      inputSchema: {
        type: 'object',
        properties: {
          actionHash: { type: 'string' },
          operation: { type: 'object' },
        },
        required: ['actionHash', 'operation'],
      },
    },
  ],
};

function response(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function errorResponse(id, error) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code: -32000, message: error?.message ?? String(error) },
  });
}

export async function runMcpServer(mode) {
  if (!TOOLSETS[mode]) throw new Error(`Unknown Helmion MCP mode: ${mode}`);
  const store = await createNeonStore();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

  const callTool = async (name, args) => {
    if (name === 'helmion_get_context') return store.getContext(args.projectSlug);
    if (name === 'helmion_list_blockers') return store.listActiveBlockers(args.projectSlug ?? null);
    if (name === 'helmion_resolve_blocker') return store.resolveBlocker(args.id, args);
    if (name === 'helmion_record_review') return store.recordReview(args);
    if (name === 'helmion_consensus_status') return store.getConsensus(args.actionHash, args.operation);
    throw new Error(`Unknown tool: ${name}`);
  };

  input.on('line', async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
      if (message.method === 'initialize') {
        process.stdout.write(`${response(message.id, {
          protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: `mcp-helmion-${mode}`, version: '0.1.0' },
        })}\n`);
      } else if (message.method === 'tools/list') {
        process.stdout.write(`${response(message.id, { tools: TOOLSETS[mode] })}\n`);
      } else if (message.method === 'tools/call') {
        const value = await callTool(message.params?.name, message.params?.arguments ?? {});
        process.stdout.write(`${response(message.id, {
          content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        })}\n`);
      } else if (message.id != null) {
        process.stdout.write(`${errorResponse(message.id, new Error(`Unsupported method: ${message.method}`))}\n`);
      }
    } catch (error) {
      if (message?.id != null) process.stdout.write(`${errorResponse(message.id, error)}\n`);
    }
  });

  const shutdown = async () => {
    await store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
