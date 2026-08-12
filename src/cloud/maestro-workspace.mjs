/**
 * Browser Maestro workspace contract.
 *
 * This is deliberately a projection-only boundary. It accepts already
 * authorized event data and returns bounded UI state; it does not execute a
 * provider, select a tenant, or grant an agent authority.
 */

export const MAESTRO_AGENTS = Object.freeze([
  Object.freeze({ id: 'maestro', label: 'Maestro', role: 'orchestrator' }),
  Object.freeze({ id: 'claude', label: 'Claude', role: 'monitor' }),
  Object.freeze({ id: 'chatgpt', label: 'ChatGPT', role: 'monitor' }),
  Object.freeze({ id: 'grok', label: 'Grok', role: 'builder-or-monitor' }),
  Object.freeze({ id: 'gemini', label: 'Gemini', role: 'monitor' }),
]);

const STATUS = new Set(['idle', 'running', 'blocked', 'waiting']);

function boundedText(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

export function normalizeWorkspaceEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const agentId = boundedText(event.agentId, 32).toLowerCase();
  const status = boundedText(event.status, 16).toLowerCase();
  if (!MAESTRO_AGENTS.some((agent) => agent.id === agentId) || !STATUS.has(status)) return null;
  return Object.freeze({
    agentId,
    status,
    lastAction: boundedText(event.lastAction, 180),
    occurredAt: boundedText(event.occurredAt, 48),
  });
}

export function buildMaestroWorkspaceSnapshot({ tenantId, scope = 'tenant', events = [] } = {}) {
  const safeTenant = boundedText(tenantId, 160);
  if (!safeTenant) throw new TypeError('tenantId is required');
  const safeScope = boundedText(scope, 80) || 'tenant';
  const latest = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const normalized = normalizeWorkspaceEvent(event);
    if (normalized && !latest.has(normalized.agentId)) latest.set(normalized.agentId, normalized);
  }
  return Object.freeze({
    format: 'helmion.maestro.workspace.v1',
    scope: { kind: safeScope, tenantId: safeTenant },
    agents: MAESTRO_AGENTS.map((agent) => Object.freeze({
      ...agent,
      status: latest.get(agent.id)?.status ?? 'idle',
      lastAction: latest.get(agent.id)?.lastAction ?? '',
      occurredAt: latest.get(agent.id)?.occurredAt ?? '',
    })),
    execution: 'not_performed',
  });
}
