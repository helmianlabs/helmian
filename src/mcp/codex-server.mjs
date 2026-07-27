import { createInterface } from 'node:readline';
import { createCodexAdapter } from '../adapters/codex.mjs';
import { createNeonStore } from '../adapters/neon.mjs';
import { ADAPTER_MODE } from '../core/maestro.mjs';

const READ_TOOLS = [
  {
    name: 'helmion_maestro_project_state',
    description: 'Read the shared project state and current Maestro lease from customer-owned Neon.',
    inputSchema: {
      type: 'object',
      properties: { projectSlug: { type: 'string' } },
      required: ['projectSlug'],
    },
  },
  {
    name: 'helmion_maestro_latest_handoff',
    description: 'Read the latest generated Maestro handoff and any incomplete-handoff warning.',
    inputSchema: {
      type: 'object',
      properties: { projectSlug: { type: 'string' } },
      required: ['projectSlug'],
    },
  },
];

const WRITE_TOOLS = [
  {
    name: 'helmion_maestro_acquire_lease',
    description: 'Acquire the project write lease for this Codex instance.',
    inputSchema: {
      type: 'object',
      properties: {
        projectSlug: { type: 'string' },
        idempotencyKey: { type: 'string' },
        ttlSeconds: { type: 'integer', minimum: 30, maximum: 86400 },
      },
      required: ['projectSlug', 'idempotencyKey'],
    },
  },
  {
    name: 'helmion_maestro_create_checkpoint',
    description: 'Create a durable checkpoint while holding the active write lease.',
    inputSchema: {
      type: 'object',
      properties: {
        projectSlug: { type: 'string' },
        leaseToken: { type: 'string' },
        idempotencyKey: { type: 'string' },
        checkpoint: {
          type: 'object',
          properties: {
            work_completed: { type: 'string' },
            files_changed: { type: 'array', items: { type: 'string' } },
            test_results: { type: 'array', items: { type: 'string' }, minItems: 1 },
            open_blockers: { type: 'array', items: { type: 'string' } },
            unresolved_risks: { type: 'array', items: { type: 'string' } },
            next_safe_action: { type: 'string' },
          },
          required: [
            'work_completed',
            'files_changed',
            'test_results',
            'open_blockers',
            'unresolved_risks',
            'next_safe_action',
          ],
        },
      },
      required: ['projectSlug', 'leaseToken', 'idempotencyKey', 'checkpoint'],
    },
  },
  {
    name: 'helmion_maestro_release_lease',
    description: 'Release the Codex write lease with a durable reason.',
    inputSchema: {
      type: 'object',
      properties: {
        projectSlug: { type: 'string' },
        leaseToken: { type: 'string' },
        idempotencyKey: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['projectSlug', 'leaseToken', 'idempotencyKey', 'reason'],
    },
  },
  {
    name: 'helmion_maestro_transfer_lease',
    description: 'Atomically transfer the write lease and generate a shared-state handoff.',
    inputSchema: {
      type: 'object',
      properties: {
        projectSlug: { type: 'string' },
        leaseToken: { type: 'string' },
        idempotencyKey: { type: 'string' },
        toCoordinatorId: { type: 'string' },
        toHolderInstanceId: { type: 'string' },
        checkpointId: { type: ['integer', 'string'] },
        incompleteReason: { type: 'string' },
        switchedBy: { type: 'string' },
        ttlSeconds: { type: 'integer', minimum: 30, maximum: 86400 },
      },
      required: [
        'projectSlug',
        'leaseToken',
        'idempotencyKey',
        'toCoordinatorId',
        'toHolderInstanceId',
        'switchedBy',
      ],
    },
  },
  {
    name: 'helmion_maestro_record_human_confirmation',
    description: [
      'Verify and durably record a signed, expiring human confirmation for one exact',
      'Tier B handoff action. The signer must already have a trusted public key in Helmion.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        projectSlug: { type: 'string' },
        handoffId: { type: ['integer', 'string'] },
        operation: { type: 'object' },
        assertion: {
          type: 'object',
          properties: {
            claims: {
              type: 'object',
              properties: {
                version: { type: 'integer', const: 1 },
                audience: { type: 'string' },
                provider: { type: 'string' },
                subject: { type: 'string' },
                key_id: { type: 'string' },
                project_slug: { type: 'string' },
                handoff_id: { type: ['integer', 'string'] },
                action_hash: { type: 'string' },
                issued_at: { type: 'string' },
                expires_at: { type: 'string' },
                nonce: { type: 'string' },
              },
              required: [
                'version',
                'audience',
                'provider',
                'subject',
                'key_id',
                'project_slug',
                'handoff_id',
                'action_hash',
                'issued_at',
                'expires_at',
                'nonce',
              ],
            },
            signature: { type: 'string' },
          },
          required: ['claims', 'signature'],
        },
      },
      required: ['projectSlug', 'handoffId', 'operation', 'assertion'],
    },
  },
  {
    name: 'helmion_maestro_authorize_handoff_action',
    description: [
      'Atomically consume one matching unexpired human confirmation while holding',
      'the handoff target lease. A successful idempotent retry returns the same authorization.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        projectSlug: { type: 'string' },
        handoffId: { type: ['integer', 'string'] },
        leaseToken: { type: 'string' },
        idempotencyKey: { type: 'string' },
        operation: { type: 'object' },
      },
      required: ['projectSlug', 'handoffId', 'leaseToken', 'idempotencyKey', 'operation'],
    },
  },
];

function response(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function errorResponse(id, error) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message: error?.message ?? String(error),
      data: error?.details ?? undefined,
    },
  });
}

export function codexToolsForMode(mode = ADAPTER_MODE.READ_ONLY) {
  if (mode === ADAPTER_MODE.READ_ONLY) return [...READ_TOOLS];
  if (mode === ADAPTER_MODE.READ_WRITE) return [...READ_TOOLS, ...WRITE_TOOLS];
  throw new TypeError(`Unknown Codex MCP mode: ${mode}`);
}

export async function runCodexMcpServer({
  mode = process.env.HELMION_CODEX_MODE ?? ADAPTER_MODE.READ_ONLY,
  instanceId = process.env.HELMION_CODEX_INSTANCE_ID ?? null,
} = {}) {
  const store = await createNeonStore();
  const adapter = createCodexAdapter({ store, mode, instanceId });
  const tools = codexToolsForMode(mode);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

  const callTool = async (name, args) => {
    if (name === 'helmion_maestro_project_state') return adapter.getProjectState(args.projectSlug);
    if (name === 'helmion_maestro_latest_handoff') return adapter.getLatestHandoff(args.projectSlug);
    if (name === 'helmion_maestro_acquire_lease') return adapter.acquireWriteLease(args);
    if (name === 'helmion_maestro_create_checkpoint') return adapter.createCheckpoint(args);
    if (name === 'helmion_maestro_release_lease') return adapter.releaseWriteLease(args);
    if (name === 'helmion_maestro_transfer_lease') return adapter.transferWriteLease(args);
    if (name === 'helmion_maestro_record_human_confirmation') {
      return adapter.recordHumanConfirmation(args);
    }
    if (name === 'helmion_maestro_authorize_handoff_action') {
      return adapter.authorizeHandoffOperation(args);
    }
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
          serverInfo: {
            name: 'mcp-helmion-codex',
            version: '0.1.0',
            mode,
          },
        })}\n`);
      } else if (message.method === 'tools/list') {
        process.stdout.write(`${response(message.id, { tools })}\n`);
      } else if (message.method === 'tools/call') {
        const value = await callTool(message.params?.name, message.params?.arguments ?? {});
        process.stdout.write(`${response(message.id, {
          content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        })}\n`);
      } else if (message.id != null) {
        process.stdout.write(`${errorResponse(
          message.id,
          new Error(`Unsupported method: ${message.method}`),
        )}\n`);
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
