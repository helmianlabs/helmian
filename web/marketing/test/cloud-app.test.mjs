import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { plainEvent, sessionsFromServer, VIEWS, viewFromHash, sessionModel, projectsModel, filterProjects, projectKeyFromName, approvalsModel, logLines, feedModel, maskSecret, integrationsModel, metricsModel, postureModel, isAdminRole, addSession } from '../app/app-model.mjs';

const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../app/app.css', import.meta.url), 'utf8');
const js = await readFile(new URL('../app/app.js', import.meta.url), 'utf8');

test('three columns: sidebar, center console, Guard Feed', () => {
  for (const id of ['sidebar', 'main', 'guard', 'project-filter', 'new-project-form', 'appearance', 'sessions', 'log', 'prompt', 'mcp-panel', 'session-chips', 'session-form', 'feed', 'feed-filter', 'feed-clear', 'run-suite', 'active-agent']) assert.match(html, new RegExp(`id="${id}"`), id);
  for (const label of ['HELMIAN', 'Personal Pilot', 'PROJECTS', 'APPEARANCE', 'SESSIONS', 'GUARD FEED', 'MCP Security', 'Full screen', 'Prompt...', '+ Tools', 'Voice chat', 'Dictate', 'NEW SESSION', 'Start session', 'Run tool suite', 'GUARD FEED SETTINGS', 'Live activity', 'Evidence', 'Integrations', 'Release roadmap']) assert.ok(html.includes(label), label);
  for (const p of ['Claude', 'ChatGPT', 'Grok', 'Gemini']) assert.match(html, new RegExp(`data-provider="${p}"`));
  for (const view of VIEWS) assert.match(html, new RegExp(`data-view-panel="${view}"`), view);
  assert.match(html, /href="\/admin\/auth\/login\?return=\/app"/);
});

test('spec colors, widths, monospace console and mobile drawers', () => {
  for (const c of ['#0B1120', '#111827', '#1F2937', '#374151', '#F8FAFC', '#94A3B8', '#0EA5E9', '#0284C7', '#EF4444', '#F59E0B', '#10B981']) assert.ok(css.includes(c), c);
  assert.match(css, /--side-w:280px/); assert.match(css, /--guard-w:370px/); assert.match(css, /--radius:8px/);
  assert.match(css, /\.log \{[^}]*var\(--mono\)/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*translateX\(-100%\)[\s\S]*translateX\(100%\)/);
});

test('no technical disclaimers and no framework', () => {
  for (const phrase of [/not_performed/i, /no-execution/i, /receipt/i, /preview build/i]) assert.doesNotMatch(html, phrase);
  assert.doesNotMatch(html + js, /react|vue|angular|cdn\./i);
});

test('only existing admin APIs are used', () => {
  const paths = [...new Set([...js.matchAll(/'(\/api\/[^'?`$]+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(paths, ['/api/admin/app/sessions', '/api/admin/app/sessions/archive', '/api/admin/cora/approvals', '/api/admin/cora/connectors', '/api/admin/envoy/channels', '/api/admin/envoy/messages', '/api/admin/events', '/api/admin/overview', '/api/admin/provider-connections', '/api/admin/release', '/api/admin/session', '/api/admin/workspace/projects']);
});

test('models', () => {
  assert.equal(viewFromHash('#evidence'), 'evidence'); assert.equal(viewFromHash('#nope'), 'console');
  assert.equal(sessionModel(200, { actor: { role: 'owner' } }).member, true);
  assert.deepEqual(sessionModel(403, { signedIn: true }), { signedIn: true, member: false, actor: null });
  const { projects } = projectsModel({ projects: [{ projectKey: 'helm', displayName: 'Helmian' }, { projectKey: 'web', displayName: 'Site' }] });
  assert.deepEqual(filterProjects(projects, 'hel').map((p) => p.key), ['helm']);
  assert.equal(projectKeyFromName('  My New Project! '), 'my-new-project');
  const a = approvalsModel({ items: [{ approvalRequired: true, decision: null }, { approvalRequired: true, decision: 'approve' }] }, 'owner');
  assert.deepEqual([a.pending, a.items[0].canDecide, a.items[1].canDecide], [1, true, false]);
  assert.equal(approvalsModel({ items: [{ approvalRequired: true }] }, 'member').items[0].canDecide, false);
  assert.deepEqual(logLines({ messages: [{ id: 1, body: 'hi', authorKind: 'human', authorSubject: 'u1' }] }, 'u1').map((l) => [l.mine, l.text]), [[true, 'hi']]);
  assert.equal(maskSecret('sk-abc123XYZ9'), '••••••••XYZ9'); assert.equal(maskSecret(), '••••••••');
  assert.deepEqual(integrationsModel({ verifierStatus: { slack: { configured: true } } }, { connections: [{ provider: 'openai' }] }).filter((i) => i.connected).map((i) => i.key), ['slack', 'openai']);
  assert.equal(metricsModel({ counts: { members: 2 } })[1][1], 2);
  assert.equal(postureModel({ settings: { database: true } })[1][1], 'Connected');
  assert.equal(isAdminRole('Admin'), true);
  const s = addSession([], { name: 'Fix login', provider: 'Claude', now: 0 }); assert.deepEqual([s.length, s[0].provider], [1, 'Claude']);
  assert.equal(addSession([], { name: 'x', provider: 'Nope' }).length, 0);
});

test('Guard Feed: approvals critical, denials warn, acknowledge turns amber, filters and clear', () => {
  const data = { approvals: [{ requestReceiptId: 'r1', summary: 'Deploy', decision: null }, { requestReceiptId: 'r2', decision: 'approve' }], events: [{ id: '1', actionType: 'cora.session.started', status: 'ALLOW' }, { id: '2', actionType: 'tool.call', status: 'DENY' }] };
  const all = feedModel(data);
  assert.deepEqual(all.map((c) => c.severity), ['critical', 'info', 'warning']);
  assert.equal(all[1].title, 'Session started');
  assert.deepEqual(feedModel(data, { filter: 'critical' }).map((c) => c.id), ['apr:r1']);
  assert.equal(feedModel(data, { showInfo: false }).length, 2);
  const acked = feedModel(data, { acknowledged: new Set(['apr:r1']) })[0];
  assert.deepEqual([acked.severity, acked.ack], ['warning', true]);
  assert.equal(feedModel(data, { cleared: new Set(['evt:1', 'evt:2']) }).length, 1);
});

test('Guard Feed wording is plain language (no internal jargon)', () => {
  const leak = { id: '4', actionType: 'cora.session.started', status: 'ALLOW', summary: 'Cora signed session started; provider usage is actual-evidence-only' };
  const [card] = feedModel({ events: [leak] });
  assert.deepEqual([card.title, card.body], ['Session started', 'An AI session was started.']);
  assert.doesNotMatch(JSON.stringify(feedModel({ events: [leak, { id: '5', actionType: 'x.thing', summary: 'Ran; usage is actual-evidence-only' }, { id: '6', actionType: 'y.z', summary: 'provider usage is actual-evidence-only' }] })), /evidence-only|provider usage/);
  assert.equal(plainEvent({ actionType: 'admin.bootstrap_owner' }).title, 'Owner added');
  assert.equal(plainEvent({ actionType: 'envoy.channel.created' }).title, 'Team channel created');
});

test('server sessions map to the sidebar list', () => {
  assert.deepEqual(sessionsFromServer({ sessions: [{ id: 'a', name: 'Fix', provider: 'Grok', createdAt: 't' }] }), [{ id: 'a', name: 'Fix', provider: 'Grok', createdAt: 't' }]);
  assert.deepEqual(sessionsFromServer({}), []);
});
