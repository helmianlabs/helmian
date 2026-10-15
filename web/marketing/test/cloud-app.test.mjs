import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { viewFromHash, sessionModel, projectsModel, filterProjects, approvalsModel, messagesModel, metricsModel, postureModel, isAdminRole, VIEWS } from '../app/app-model.mjs';

const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../app/app.css', import.meta.url), 'utf8');
const js = await readFile(new URL('../app/app.js', import.meta.url), 'utf8');

test('app shell mirrors the desktop layout: sidebar, main, guard, plus a phone tab bar', () => {
  for (const id of ['sidebar', 'main', 'guard', 'tabbar', 'project-shelf', 'composer', 'signed-out']) assert.match(html, new RegExp(`id="${id}"`));
  for (const label of ['Team workspace', 'Overview', 'Approvals', 'Review &amp; History', 'Connect', 'Agents', 'Settings', 'PROJECTS', 'NAVIGATION']) assert.ok(html.includes(label), label);
  for (const view of VIEWS) assert.match(html, new RegExp(`data-view-panel="${view}"`));
  assert.match(html, /href="\/admin\/auth\/login\?return=\/app"/);
});

test('uses the desktop Midnight palette and a phone breakpoint', () => {
  for (const c of ['#08100F', '#0B1513', '#73E6B1', '#F2C879', '#243633']) assert.ok(css.includes(c), c);
  assert.match(css, /@media \(max-width: 860px\)/);
});

test('default view has no technical disclaimer wording and no heavy framework', () => {
  for (const phrase of [/not_performed/i, /no-execution/i, /receipt/i, /preview build/i, /unavailable in this/i]) assert.doesNotMatch(html, phrase);
  assert.doesNotMatch(html + js, /react|vue|angular|cdn\./i);
});

test('only existing admin APIs are used', () => {
  const paths = [...new Set([...js.matchAll(/'(\/api\/[^'?`$]+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(paths, ['/api/admin/cora/approvals', '/api/admin/envoy/channels', '/api/admin/envoy/messages', '/api/admin/events', '/api/admin/overview', '/api/admin/session', '/api/admin/workspace/projects']);
});

test('models', () => {
  assert.equal(viewFromHash('#approvals'), 'approvals');
  assert.equal(viewFromHash('#nope'), 'console');
  assert.deepEqual(sessionModel(200, { actor: { role: 'owner' } }).member, true);
  assert.deepEqual(sessionModel(403, { signedIn: true }), { signedIn: true, member: false, actor: null });
  assert.equal(sessionModel(401, {}).signedIn, false);
  const { projects } = projectsModel({ projects: [{ projectKey: 'helm', displayName: 'Helmian', defaultBranch: 'main' }, { projectKey: 'web', displayName: 'Site' }] });
  assert.deepEqual(filterProjects(projects, 'hel').map((p) => p.key), ['helm']);
  assert.equal(projectsModel({}).empty, true);
  const a = approvalsModel({ items: [{ approvalRequired: true, decision: null }, { approvalRequired: true, decision: 'approve' }] }, 'owner');
  assert.deepEqual([a.pending, a.items[0].canDecide, a.items[1].canDecide], [1, true, false]);
  assert.equal(approvalsModel({ items: [{ approvalRequired: true }] }, 'member').items[0].canDecide, false);
  const m = messagesModel({ messages: [{ id: 1, body: 'hi', authorKind: 'human', authorSubject: 'u1' }, { id: 2, body: 'yo', authorKind: 'agent' }] }, 'u1');
  assert.deepEqual(m.messages.map((x) => [x.mine, x.who]), [[true, 'Member'], [false, 'agent']]);
  assert.equal(metricsModel({ counts: { members: 2 } })[1][1], 2);
  assert.equal(postureModel({ settings: { database: true } })[1][1], 'Connected');
  assert.equal(isAdminRole('Admin'), true);
});
