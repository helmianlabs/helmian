import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { plainEvent, sessionsFromServer, VIEWS, VIEW_TITLES, VIEW_TITLES_PLAYFUL, VIEW_TITLES_PLAIN, viewTitles, isPlainEmojiMode, PRIMARY_VIEWS, ADVANCED_VIEWS, PANEL_VIEWS, PANEL_TABS, CREATE_TYPES, viewFromHash, sessionModel, projectsModel, filterProjects, projectKeyFromName, approvalsModel, logLines, feedModel, feedAckClearIds, maskSecret, integrationsModel, toolConnectionStatus, bestToolConnectionStatus, CONNECTION_FRESH_MS, agentsModel, createModel, createIntentPayload, metricsModel, postureModel, isAdminRole, addSession, desktopsModel, forgetDesktopPayload } from '../app/app-model.mjs';

const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../app/app.css', import.meta.url), 'utf8');
const js = await readFile(new URL('../app/app.js', import.meta.url), 'utf8');

test('three columns: sidebar, center console, Guard Feed', () => {
  for (const id of ['sidebar', 'main', 'guard', 'project-filter', 'new-project-form', 'appearance', 'sessions', 'log', 'prompt', 'mcp-panel', 'session-chips', 'session-form', 'feed', 'feed-filter', 'feed-clear', 'run-suite', 'active-agent']) assert.match(html, new RegExp(`id="${id}"`), id);
  for (const label of ['HELMIAN', 'Personal Pilot', 'PROJECTS', 'APPEARANCE', 'SESSIONS', 'GUARD FEED', 'MCP SECURITY', 'Full screen', 'Prompt...', 'Tools', 'Voice chat', 'Dictate', 'NEW SESSION', 'Start session', 'Run tool suite', 'SHOW DETAILS', 'ADVANCED', 'Live activity', 'Evidence', 'Integrations', 'Release roadmap', 'Devices', 'Connect phone', 'No Desktop connected yet', 'Chat', 'Projects', 'Approvals']) assert.ok(html.includes(label), label);
  for (const p of ['Claude', 'ChatGPT', 'Grok', 'Gemini']) assert.match(html, new RegExp(`data-provider="${p}"`));
  for (const view of VIEWS) {
    // Browser, Canvas, Preview, Create live in the right workbench panel now
    // (BROWSE-001), not as center views.
    if (PANEL_VIEWS.includes(view)) assert.match(html, new RegExp(`data-panel-pane="${view}"`), view);
    else assert.match(html, new RegExp(`data-view-panel="${view}"`), view);
  }
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

test('only known admin + remote APIs are used', () => {
  const paths = [...new Set([...js.matchAll(/'(\/api\/[^'?`$]+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(paths, ['/api/admin/app/sessions', '/api/admin/app/sessions/archive', '/api/admin/app/sessions/steps', '/api/admin/app/sessions/steps/update', '/api/admin/browser/navigate', '/api/admin/cora/approvals', '/api/admin/cora/artifacts', '/api/admin/cora/connectors', '/api/admin/cora/usage', '/api/admin/desktop/link/start', '/api/admin/envoy/agents/sessions', '/api/admin/envoy/channels', '/api/admin/envoy/messages', '/api/admin/envoy/runner/presence', '/api/admin/events', '/api/admin/guard/acks', '/api/admin/guard/findings', '/api/admin/guard/pc-approvals', '/api/admin/guard/pc-approvals/decide', '/api/admin/guard/pc-upcoming', '/api/admin/maestro/checkpoints', '/api/admin/maestro/handoffs', '/api/admin/organization/invites', '/api/admin/organization/invites/revoke', '/api/admin/overview', '/api/admin/plugins', '/api/admin/profile', '/api/admin/provider-connections', '/api/admin/release', '/api/admin/runs/ledger', '/api/admin/session', '/api/admin/signup', '/api/admin/spoke/download', '/api/admin/spoke/pair-code', '/api/admin/tool-connections', '/api/admin/workspace/active-project', '/api/admin/workspace/agent-icons', '/api/admin/workspace/canvas', '/api/admin/workspace/canvas/decisions', '/api/admin/workspace/layout-preferences', '/api/admin/workspace/projects', '/api/herald-config', '/api/remote/v1/desktops', '/api/remote/v1/enrollment']);
});

test('models', () => {
  assert.equal(viewFromHash('#evidence'), 'evidence'); assert.equal(viewFromHash('#nope'), 'desktop');
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
  assert.deepEqual(integrationsModel({ verifierStatus: { slack: { configured: true } } }, { connections: [{ provider: 'openai' }] }).filter((i) => i.connected).map((i) => i.key), [], 'an env configured flag and an unverified provider row connect nothing (bite 1b)');
  assert.equal(metricsModel({ counts: { members: 2 } })[1][1], 2);
  assert.equal(postureModel({ settings: { database: true } })[1][1], 'Connected');
  assert.equal(isAdminRole('Admin'), true);
  const s = addSession([], { name: 'Fix login', provider: 'Claude', now: 0 }); assert.deepEqual([s.length, s[0].provider], [1, 'Claude']);
  assert.equal(addSession([], { name: 'x', provider: 'Nope' }).length, 0);
});

test('connection truth: a tool connection reads Connected only from a verified, fresh probe receipt', () => {
  const now = Date.parse('2026-10-25T18:00:00.000Z');
  const fresh = { serviceId: 'github', state: 'verified', lastVerifiedAt: '2026-10-25T17:30:00.000Z' };
  assert.deepEqual(toolConnectionStatus(fresh, { now }), { status: 'connected', statusText: 'Connected', connected: true });
  assert.equal(toolConnectionStatus(fresh, { now: now + CONNECTION_FRESH_MS + 1 }).statusText, 'Not checked recently', 'a verified receipt past the fresh window is stale, not Connected');
  assert.equal(toolConnectionStatus({ serviceId: 'github', state: 'verified', lastVerifiedAt: null }, { now }).statusText, 'Not checked', 'verified with no receipt timestamp proves nothing — not checked, and never Connected');
  const github = integrationsModel({}, {}, { toolConnections: [fresh], presence: [], now }).find((i) => i.key === 'github');
  assert.deepEqual([github.connected, github.statusText, github.source], [true, 'Connected', 'tool-connections']);
  const noRow = integrationsModel({}, {}, { toolConnections: [], presence: [], now }).find((i) => i.key === 'github');
  assert.deepEqual([noRow.connected, noRow.statusText, noRow.source], [false, 'Not connected', 'registry'], 'no row → the pre-1b registry answer, unchanged');
});

test('connection truth: a failed probe renders the failure state, and outranks an older verified scope', () => {
  const now = Date.parse('2026-10-25T18:00:00.000Z');
  const failed = { serviceId: 'github', state: 'failed', lastVerifiedAt: null, lastError: 'connection refused' };
  assert.deepEqual(toolConnectionStatus(failed, { now }), { status: 'failed', statusText: 'Check failed', connected: false });
  const mixed = bestToolConnectionStatus([
    { serviceId: 'github', scopeKind: 'agent', state: 'verified', lastVerifiedAt: '2026-10-20T17:00:00.000Z' },
    { serviceId: 'github', scopeKind: 'workspace', state: 'failed', lastVerifiedAt: null },
    { serviceId: 'other', state: 'verified', lastVerifiedAt: '2026-10-25T17:59:00.000Z' },
  ], 'github', { now });
  assert.equal(mixed.statusText, 'Check failed', 'a failed receipt is said out loud; other services never leak in');
  assert.equal(toolConnectionStatus({ serviceId: 'github', state: 'registered', lastVerifiedAt: null }, { now }).statusText, 'Not checked');
});

test('connection truth: Slack/Discord rows are channel mirrors — linked or not, never tool-connected', () => {
  const rows = integrationsModel({ registrations: [
    { provider: 'discord', lifecycle: 'enabled', enabled: true },
    { provider: 'slack', lifecycle: 'draft', enabled: false },
  ] }, {}, { toolConnections: [], presence: [] });
  const by = Object.fromEntries(rows.map((i) => [i.key, i]));
  assert.equal(by.discord.kind, 'Team chat mirror'); assert.equal(by.slack.kind, 'Team chat mirror');
  assert.deepEqual([by.discord.connected, by.discord.statusText, by.discord.source], [true, 'Linked', 'channel-mirror']);
  assert.deepEqual([by.slack.connected, by.slack.statusText], [false, 'Not linked'], 'a half-finished registration is not a link');
  for (const key of ['slack', 'discord']) assert.notEqual(by[key].statusText, 'Connected', 'a mirror never wears the tool-connection word');
  const evenWithToolRow = integrationsModel({ registrations: [] }, {}, { toolConnections: [{ serviceId: 'slack', state: 'verified', lastVerifiedAt: new Date().toISOString() }], presence: [] }).find((i) => i.key === 'slack');
  assert.equal(evenWithToolRow.statusText, 'Not linked', 'a tool_connections row never speaks for a mirror');
  const unchecked = integrationsModel({}, {}, {}).find((i) => i.key === 'discord');
  assert.equal(unchecked.statusText, 'Not checked', 'registrations never read → not checked, not a guessed Not linked');
});

test('connection truth: provider rows read the runner link, not tool_connections', () => {
  const now = Date.parse('2026-10-25T18:00:00.000Z');
  const geminiToolRow = { serviceId: 'google', state: 'verified', lastVerifiedAt: '2026-10-25T17:59:00.000Z' };
  const fromPresence = integrationsModel({}, {}, { toolConnections: [geminiToolRow], presence: [{ provider: 'gemini', connected: true }], now }).find((i) => i.key === 'google');
  assert.deepEqual([fromPresence.connected, fromPresence.statusText, fromPresence.source], [true, 'Connected', 'runner-presence'], 'Gemini answering in its room reads Connected from presence');
  const toolRowOnly = integrationsModel({}, { connections: [] }, { toolConnections: [geminiToolRow], presence: [], now }).find((i) => i.key === 'google');
  assert.deepEqual([toolRowOnly.connected, toolRowOnly.statusText], [false, 'Not connected'], 'a tool_connections row never connects an AI provider');
  const savedVerified = integrationsModel({}, { connections: [{ providerId: 'gemini', lifecycle: 'verified' }] }, { presence: [], now }).find((i) => i.key === 'google');
  assert.deepEqual([savedVerified.connected, savedVerified.source], [true, 'provider-connection'], 'a verified sql/031 provider connection is the saved runner link');
  const pending = integrationsModel({}, { connections: [{ providerId: 'gemini', lifecycle: 'pending' }] }, { presence: [], now }).find((i) => i.key === 'google');
  assert.equal(pending.statusText, 'Not connected', 'a pending provider connection is not a working link');
  const noSources = integrationsModel({}, {}, { now }).find((i) => i.key === 'google');
  assert.equal(noSources.statusText, 'Not checked', 'neither source answered → Not checked, never a guessed Not connected');
  const grokLive = integrationsModel({}, {}, { presence: [{ provider: 'xai', connected: true }], now }).find((i) => i.key === 'xai');
  assert.equal(grokLive.connected, true, 'presence names fold (xai feed → Grok row)');
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

test('Guard Feed ack-all: ack clears the pile for good, newer events still show', () => {
  const data = { approvals: [{ requestReceiptId: 'r1', summary: 'Deploy', decision: null }], events: [{ id: '1', actionType: 'cora.session.started', status: 'ALLOW' }, { id: '2', actionType: 'tool.call', status: 'DENY' }] };
  const findings = [{ fingerprint: 'f1', severity: 'warning' }, { fingerprint: 'f2', severity: 'critical' }, { fingerprint: 'f3', severity: 'info' }];
  // Every event card clears; findings clear except criticals (never hidden
  // by an ack); pending approvals are decisions and never clear.
  assert.deepEqual(feedAckClearIds({ events: data.events, findings }).sort(), ['evt:1', 'evt:2', 'finding:f1', 'finding:f3']);
  assert.deepEqual(feedAckClearIds({}), []);
  const cleared = new Set(feedAckClearIds({ events: data.events, findings }));
  // Re-reading the same source with the persisted cleared set (what a
  // reload does): the old pile stays gone; only the pending approval —
  // a decision, not a notice — remains.
  assert.deepEqual(feedModel(data, { cleared }).map((c) => c.id), ['apr:r1']);
  // A per-card ack removes only that card.
  assert.deepEqual(feedModel(data, { cleared: new Set(['evt:1']) }).map((c) => c.id), ['apr:r1', 'evt:2']);
  // A genuinely new event arriving after the ack still shows.
  assert.deepEqual(feedModel({ events: [{ id: '3', actionType: 'cora.session.started', status: 'ALLOW' }] }, { cleared }).map((c) => c.id), ['evt:3']);
});

test('Approvals view: the PC actions panel re-reads on the auto-refresh heartbeat', () => {
  // loadPcApprovals runs when the view opens; the heartbeat clause is what
  // makes a PC Guard ask raised WHILE the owner is already looking at the
  // Approvals view appear (and a decided one leave) without reopening it.
  assert.match(js, /if \(shell\.dataset\.view === 'approvals'\) loadPcApprovals\(\)/, 'the 6s heartbeat re-reads the PC actions panel on the Approvals view');
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
  assert.deepEqual(sessionsFromServer({ sessions: [{ id: 'a', name: 'Fix', provider: 'Grok', createdAt: 't' }] }), [{ id: 'a', name: 'Fix', provider: 'Grok', createdAt: 't', progress: null }]);
  assert.deepEqual(sessionsFromServer({}), []);
});

test('desktopsModel empty and rows', () => {
  assert.equal(desktopsModel({}).empty, true);
  assert.equal(desktopsModel({ desktops: [] }).empty, true);
  const m = desktopsModel({ desktops: [{ desktopId: 'd1', displayName: 'Troy PC', sessions: [{ sessionId: 's1', name: 'Main', state: 'live', project: { name: 'Helmian' } }] }] });
  assert.equal(m.empty, false);
  assert.deepEqual(m.rows.map((r) => [r.displayName, r.projectName, r.name, r.state]), [['Troy PC', 'Helmian', 'Main', 'live']]);
});

test('phone primary nav + Advanced + Show details (Troy polish)', () => {
  assert.deepEqual([...PRIMARY_VIEWS], ['desktop', 'home', 'workspace', 'approvals']);
  assert.ok(ADVANCED_VIEWS.includes('devices'));
  assert.equal(VIEW_TITLES.console, '💬 Session console');
  assert.equal(VIEW_TITLES.desktop, '🖥️ Workspace');
  assert.equal(VIEW_TITLES.workspace, '🗂️ Projects');
  assert.match(html, /id="advanced-nav"/);
  assert.match(html, /class="[^"]*show-details/);
  assert.doesNotMatch(html, /id="mcp-toggle"/);
  // Primary nav lists Chat/Projects/Approvals; Advanced holds Devices etc.
  const primary = html.match(/aria-label="Primary"[\s\S]*?<\/nav>/)[0];
  for (const v of ['desktop', 'home', 'workspace', 'approvals']) assert.match(primary, new RegExp(`data-view="${v}"`));
  assert.doesNotMatch(primary, /data-view="devices"/);
  const advanced = html.match(/id="advanced-nav"[\s\S]*?<\/details>/)[0];
  for (const v of ADVANCED_VIEWS) assert.match(advanced, new RegExp(`data-view="${v}"`));
});

test('viewTitles selects playful vs plain titles (emoji mode)', () => {
  assert.equal(VIEW_TITLES.console, '💬 Session console');
  assert.equal(VIEW_TITLES.desktop, '🖥️ Workspace'); // playful alias preserved
  assert.equal(viewTitles('playful').console, '💬 Session console');
  assert.equal(viewTitles('plain').console, 'Session console');
  assert.equal(viewTitles('plain').workspace, 'Projects');
  assert.equal(viewTitles(undefined).agents, '🤖 Agents');
  assert.equal(viewTitles('wild').agents, '🤖 Agents');
  assert.equal(isPlainEmojiMode('plain'), true);
  assert.equal(isPlainEmojiMode('playful'), false);
  assert.equal(isPlainEmojiMode(undefined), false);
  assert.match(html, /id="emoji-mode"/);
  assert.match(html, /id="agent-icons-picker"/);
});

test('agentsModel maps providers and sessions', () => {
  const m = agentsModel(
    { connections: [{ provider: 'anthropic', lifecycle: 'verified', authMode: 'api_key' }] },
    { sessions: [{ id: 's1', name: 'Fix', provider: 'Claude', createdAt: 't' }] },
  );
  assert.equal(m.agents.find((a) => a.name === 'Claude').connected, true);
  assert.equal(m.agents.find((a) => a.name === 'Grok').connected, false);
  assert.equal(m.active[0].name, 'Fix');
  assert.equal(m.empty, false);
  assert.ok(VIEWS.includes('agents'));
  assert.equal(VIEW_TITLES.agents, '🤖 Agents');
  assert.match(html, /data-view-panel="agents"/);
  assert.match(html, /id="agents-refresh"/);
});

test('createModel maps receipts and builds review payload', () => {
  assert.ok(VIEWS.includes('create'));
  assert.equal(VIEW_TITLES.create, '✨ Create');
  assert.ok(PANEL_VIEWS.includes('create'));
  assert.ok(!ADVANCED_VIEWS.includes('create'));
  assert.deepEqual(CREATE_TYPES.map((x) => x.id), ['training', 'orientation']);
  const m = createModel({ receipts: [{ receiptId: 'r1', title: 'Onboard guide', artifactType: 'orientation', status: 'draft', objective: 'Help new hires', department: 'ops', sourceRefs: [{ citation: 'SOP-1', title: 'SOP-1' }] }] });
  assert.equal(m.empty, false);
  assert.deepEqual([m.receipts[0].title, m.receipts[0].type, m.receipts[0].sources], ['Onboard guide', 'orientation', 1]);
  const p = createIntentPayload({ title: 'Safety brief', objective: 'Teach lockout', type: 'training', sourcesText: 'OSHA-1\n' });
  assert.equal(p.artifactType, 'training');
  assert.equal(p.stage, 'draft');
  assert.equal(p.department, 'general');
  assert.equal(p.sourceRefs.length, 1);
  assert.equal(p.approvalReason, null);
  assert.match(p.idempotencyKey, /^create-/);
  assert.match(html, /data-panel-pane="create"/);
  assert.match(html, /id="create-review"/);
  assert.match(html, />Review</);
});

test('devices empty-state uses plain words, keeps the owner doc link and Connect phone', () => {
  assert.match(html, /No Desktop connected yet/);
  assert.match(html, /id="devices-clerk-note"/);
  assert.doesNotMatch(html, /Clerk unify checklist/);
  assert.match(html, /docs\/CLERK_UNIFY\.md/);
  assert.match(html, /href="\/app\/pair"/);
  assert.match(js, /Your linked PCs can\\u2019t be listed from this page yet/);
  assert.doesNotMatch(js, /Remote Control sign-in is separate until Clerk is unified/);
});

test('independent Guard panel + workbench tabs (BROWSE-001 layout correction)', () => {
  // Guard is its own collapsible panel, not a tab: findings stay visible
  // while another workbench tab is active.
  assert.match(html, /id="guard-panel"/);
  assert.match(html, /id="guard-panel-body"/);
  assert.match(html, /id="guard-collapse"/);
  assert.match(html, /id="guard-panel-count"/);
  assert.doesNotMatch(html, /data-panel-tab="guard"/);
  assert.doesNotMatch(html, /data-panel-pane="guard"/);
  assert.doesNotMatch(html, /id="panel-guard-count"/);
  // Workbench holds the four tabs only.
  assert.match(html, /id="workbench"/);
  assert.match(html, /id="workbench-body"/);
  assert.match(html, /id="workbench-collapse"/);
  assert.deepEqual(PANEL_TABS, ['browser', 'canvas', 'preview', 'create']);
  for (const t of PANEL_TABS) {
    assert.match(html, new RegExp(`data-panel-tab="${t}"`), t);
    assert.match(html, new RegExp(`data-panel-pane="${t}"`), t);
  }
  for (const v of ['browser', 'canvas', 'preview', 'create']) assert.ok(!ADVANCED_VIEWS.includes(v), v);
  assert.doesNotMatch(html, /Desktop only/);
  assert.match(css, /\.guard-head \{ position:sticky/);
  assert.match(css, /\.panel-tabs \{ position:sticky/);
  assert.match(css, /\.guard-panel\.collapsed #guard-panel-body/);
  assert.match(css, /\.workbench\.collapsed #workbench-body/);
});

test('a paired Desktop with no session still lists so it can be forgotten', () => {
  const m = desktopsModel({ desktops: [{ desktopId: 'd1', displayName: 'Troy PC', sessions: [] }] });
  assert.equal(m.empty, true);
  assert.equal(m.noDesktops, false);
  assert.equal(desktopsModel({}).noDesktops, true);
});

test('forgetDesktopPayload matches the server revoke contract (confirmed: true)', () => {
  assert.deepEqual(forgetDesktopPayload(' d1 '), { action: 'revoke', desktopId: 'd1', confirmed: true });
  assert.throws(() => forgetDesktopPayload(''));
});

test('the session console always stays inline (the Workspace is the one chat; no sliding chat panel)', () => {
  const place = js.slice(js.indexOf('function placeChat()'), js.indexOf('function placeChat()') + 1600);
  assert.doesNotMatch(place, /panelBody\.appendChild\(consoleView\)/);
  assert.match(place, /\{[\s\S]*consoleHome\.after\(consoleView\)[\s\S]*panel\.hidden = true[\s\S]*toggle\.hidden = true/);
  assert.match(js, /if \(!consolePollTimer\) consolePollTimer = setInterval/, 'one chat poll timer, not one per visit');
  assert.match(js, /p\.hidden = p\.dataset\.viewPanel !== view && !p\.closest\('#chat-panel'\)/);
});
