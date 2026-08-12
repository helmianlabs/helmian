import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMaestroWorkspaceSnapshot, normalizeWorkspaceEvent } from '../src/cloud/maestro-workspace.mjs';

test('workspace events are allowlisted and bounded', () => {
  assert.deepEqual(normalizeWorkspaceEvent({
    agentId: 'GROK', status: 'RUNNING', lastAction: 'x'.repeat(300), occurredAt: '2026-08-12T00:00:00Z', secret: 'drop',
  }), {
    agentId: 'grok', status: 'running', lastAction: 'x'.repeat(180), occurredAt: '2026-08-12T00:00:00Z',
  });
  assert.equal(normalizeWorkspaceEvent({ agentId: 'shell', status: 'running' }), null);
  assert.equal(normalizeWorkspaceEvent({ agentId: 'grok', status: 'complete' }), null);
});

test('workspace snapshot uses the first (newest) accepted event per agent and never grants execution', () => {
  const snapshot = buildMaestroWorkspaceSnapshot({
    tenantId: 'tenant-a',
    scope: 'customer',
    events: [
      { agentId: 'grok', status: 'running', lastAction: 'older' },
      { agentId: 'grok', status: 'blocked', lastAction: 'newer' },
      { agentId: 'claude', status: 'waiting', lastAction: 'review' },
      { agentId: 'shell', status: 'running', lastAction: 'must drop' },
    ],
  });
  assert.equal(snapshot.scope.tenantId, 'tenant-a');
  assert.equal(snapshot.execution, 'not_performed');
  assert.equal(snapshot.agents.find((agent) => agent.id === 'grok').status, 'running');
  assert.equal(snapshot.agents.find((agent) => agent.id === 'claude').status, 'waiting');
  assert.equal(snapshot.agents.some((agent) => agent.id === 'shell'), false);
});
