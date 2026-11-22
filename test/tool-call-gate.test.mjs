// The tool-call gate (Item 2): the attribute-policy check before agent
// tool calls and outbound network requests. Panel rules (the tenant rule
// store) are injected here the way production loads them from the
// database inside the call's tenant transaction; every verdict — allow
// and deny — must write its audit receipt.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createToolCallGate, ToolCallDeniedError } from '../src/cloud/tool-call-gate.mjs';
import { createMcpClient } from '../src/agent/mcp-client.mjs';

function fakePool() {
  const auditRows = [];
  const client = {
    async query(sql, values = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (['begin', 'commit', 'rollback'].includes(q)) return { rowCount: 0, rows: [] };
      if (q.startsWith('select set_config')) return { rowCount: 1, rows: [{}] };
      if (q.startsWith('select role from helmion.tenant_memberships')) return { rowCount: 1, rows: [{ role: values[1] === 'user-admin' ? 'admin' : 'member' }] };
      if (q.startsWith('insert into helmion.audit_events')) {
        auditRows.push({ tenantId: values[0], actor: values[1], actionType: values[5], decision: values[8], result: JSON.parse(values[10]) });
        return { rowCount: 1, rows: [{ id: String(auditRows.length) }] };
      }
      throw new Error(`Unexpected query: ${q}`);
    },
    release() {},
  };
  return { pool: { connect: async () => client }, auditRows };
}

const ACTOR = { tenantId: 'tenant-1', subject: 'user-1', role: 'member', jobTitle: 'dispatcher' };
const gateWith = (rules, extra = {}) => {
  const { pool, auditRows } = fakePool();
  const gate = createToolCallGate({ pool, rulesProvider: async () => rules, ...extra });
  return { gate, auditRows };
};

test('with no tenant rules, an in-tenant tool call is allowed by the floor and receipted', async () => {
  const { gate, auditRows } = gateWith([]);
  const verdict = await gate.authorizeToolCall(ACTOR, { toolName: 'read_file' });
  assert.equal(verdict.allowed, true);
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].actionType, 'tool.call');
  assert.equal(auditRows[0].decision, 'allow');
});

test('a panel DENY rule on the tool name refuses that tool, receipted, and lets others pass', async () => {
  const rules = [{ id: 'no-shell', effect: 'DENY', actions: ['tool.call'], conditions: { 'resource.toolName': 'run_shell' }, reason: 'No shell tool for this workspace.' }];
  const { gate, auditRows } = gateWith(rules);
  const denied = await gate.authorizeToolCall(ACTOR, { toolName: 'run_shell' });
  assert.equal(denied.allowed, false);
  assert.ok(denied.matchedRuleIds.includes('no-shell'));
  const allowed = await gate.authorizeToolCall(ACTOR, { toolName: 'read_file' });
  assert.equal(allowed.allowed, true);
  assert.deepEqual(auditRows.map((r) => r.decision), ['deny', 'allow']);
  await assert.rejects(() => gate.assertToolCall(ACTOR, { toolName: 'run_shell' }), (e) => e instanceof ToolCallDeniedError && e.code === 'TOOL_CALL_ATTRIBUTE_POLICY_DENIED');
});

test('a panel DENY rule on the destination domain refuses the network request, receipted', async () => {
  const rules = [{ id: 'no-exfil', effect: 'DENY', actions: ['network.request'], conditions: { 'resource.domain': 'paste.example.com' }, reason: 'No posting to paste sites.' }];
  const { gate, auditRows } = gateWith(rules);
  const denied = await gate.authorizeNetworkRequest(ACTOR, { url: 'https://paste.example.com/upload' });
  assert.equal(denied.allowed, false);
  const allowed = await gate.authorizeNetworkRequest(ACTOR, { url: 'https://hooks.slack.com/services/x' });
  assert.equal(allowed.allowed, true);
  assert.deepEqual(auditRows.map((r) => r.actionType), ['network.request', 'network.request']);
});

test('cross-tenant access is denied by default, rules or no rules', async () => {
  const { gate } = gateWith([]);
  const verdict = await gate.authorizeToolCall(ACTOR, { toolName: 'read_file', resourceTenantId: 'tenant-2' });
  assert.equal(verdict.allowed, false);
  assert.match(verdict.reason, /tenant does not match/);
});

test('rules can match on role, job title, data label, and time', async () => {
  const byRole = [{ id: 'members-no-send', effect: 'DENY', actions: ['tool.call'], conditions: { 'actor.role': 'member', 'resource.toolName': 'send_email' }, reason: 'Members do not send.' }];
  const { gate: g1 } = gateWith(byRole);
  assert.equal((await g1.authorizeToolCall(ACTOR, { toolName: 'send_email' })).allowed, false);
  assert.equal((await g1.authorizeToolCall({ ...ACTOR, subject: 'user-admin', role: 'admin' }, { toolName: 'send_email' })).allowed, true);

  const byLabel = [{ id: 'no-secret-egress', effect: 'DENY', actions: ['network.request'], conditions: { 'resource.dataLabel': 'secret' }, reason: 'Secret-labelled data does not leave.' }];
  const { gate: g2 } = gateWith(byLabel);
  assert.equal((await g2.authorizeNetworkRequest(ACTOR, { url: 'https://example.com/x', dataLabel: 'secret' })).allowed, false);
  assert.equal((await g2.authorizeNetworkRequest(ACTOR, { url: 'https://example.com/x', dataLabel: 'public' })).allowed, true);

  const byTitle = [{ id: 'drivers-no-billing', effect: 'DENY', actions: ['tool.call'], conditions: { 'actor.jobTitle': 'driver', 'resource.toolName': 'billing' }, reason: 'Drivers do not touch billing.' }];
  const { gate: g3 } = gateWith(byTitle);
  assert.equal((await g3.authorizeToolCall({ ...ACTOR, jobTitle: 'driver' }, { toolName: 'billing' })).allowed, false);
  assert.equal((await g3.authorizeToolCall(ACTOR, { toolName: 'billing' })).allowed, true);

  const byTime = [{ id: 'night-lock', effect: 'DENY', actions: ['tool.call'], conditions: { 'request.hour': { gte: 22 } }, reason: 'No tool calls at night.' }];
  const { gate: g4 } = gateWith(byTime, { now: () => new Date('2026-11-21T23:30:00Z') });
  assert.equal((await g4.authorizeToolCall(ACTOR, { toolName: 'read_file' })).allowed, false);
  const { gate: g5 } = gateWith(byTime, { now: () => new Date('2026-11-21T12:00:00Z') });
  assert.equal((await g5.authorizeToolCall(ACTOR, { toolName: 'read_file' })).allowed, true);
});

test('the MCP client refuses a gated tool call before anything reaches the server', async () => {
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
  const child = new EventEmitter();
  child.stdin = stdin; child.stdout = stdout; child.stderr = stderr;
  child.kill = () => child.emit('exit', 0, null);
  let sent = '';
  stdin.on('data', (chunk) => {
    sent += chunk.toString();
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue;
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (message.method === 'initialize') {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'fake', version: '9.9' } } })}\n`);
      }
    }
  });
  const gate = {
    authorizeToolCall: async () => ({ allowed: false, reason: 'denied by test rule', receiptId: 'r-1', matchedRuleIds: ['no-shell'] }),
  };
  const client = await createMcpClient({ command: 'fake', spawnFn: () => child, gate, gateActor: ACTOR });
  await assert.rejects(
    () => client.callTool('run_shell', {}),
    (e) => e.code === 'TOOL_CALL_ATTRIBUTE_POLICY_DENIED' && e.receiptId === 'r-1',
  );
  assert.ok(!sent.includes('tools/call'), 'the refused call was sent to the server');
  await client.close();
});
