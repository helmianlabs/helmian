import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { CALM_POLL_MS, MAESTRO_DESK_SLUG, activityCue, activityCueText, activityCues, activityElapsed, activityLive, activityName, activityProviderNames, addressed, agentRoomFor, agentRoomThread, customAgentCreateBody, deskChannelFor, deskRoster, deskTargets, dialogConnectFields, dragLayout, isDeskChannel, latestActivity, mergeReactionPost, mirrorLinkHeader, pickerAgentContext, reactionActorLabel, reactionChar, reactionChipModel, roomAddressed } from '../app/envoy-workspace.js';
import * as envoyWorkspace from '../app/envoy-workspace.js';

// Layout bite 2 (Troy's ruling + Slack/Discord UX research, 2026-10-23):
// one human-chat surface flips between Envoy and Discord via a labelled
// two-segment switch at the top of the channels pane, with a network
// strip directly above the composer as the anti-mis-send cue.
test('layout bite 2: Envoy/Discord flip switch and network strip exist with mode hooks', async () => {
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  const pane = html.indexOf('id="ew-channels"');
  const sw = html.indexOf('id="ew-net-envoy"');
  const list = html.indexOf('id="ew-channel-list"');
  assert.ok(pane !== -1 && sw > pane && sw < list, 'the network switch sits at the top of the channels pane, above the list');
  assert.match(html, /id="ew-net-envoy"[^>]*>Envoy</, 'Envoy segment is word-labelled');
  assert.match(html, /Discord<span id="ew-net-discord-count"/, 'Discord segment is word-labelled and carries the count chip');
  const msgs = html.indexOf('id="ew-messages"');
  const strip = html.indexOf('id="ew-net-strip"');
  const form = html.indexOf('id="maestro-form"');
  assert.ok(msgs !== -1 && strip > msgs && strip < form, 'the network strip sits directly above the composer');
  for (const needle of ['function setNetMode', 'function renderNetStrip', 'function renderNetSwitch', 'linkedChannels', 'netChannel.', "ws.mode === 'discord'"]) {
    assert.ok(js.includes(needle), `envoy-workspace.js has ${needle}`);
  }
});

// The age-derived pending-work mirror (pendingAgentWork/deskPending)
// is DELETED (activity desk bite, 2026-11-04, Troy's order): it derived
// "answering" from message age and lit seats that had no job running.
// The server's own agentWork() rules live on in src/cloud/envoy-mesh.mjs
// alone. What a seat is doing now comes only from the runner activity
// feed — the pure helpers below are its whole client side.

const NOW = Date.parse('2026-10-22T18:00:00.000Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const human = (id, body, msAgo = 60_000) => ({ id, authorKind: 'human', authorSubject: 'user:troy', body, createdAt: iso(msAgo) });
const reply = (id, toId, provider, msAgo = 30_000) => ({ id, authorKind: 'agent', authorSubject: `agent:${provider}`, body: 'On it.', createdAt: iso(msAgo), idempotencyKey: `reply:${toId}` });
const ev = (provider, stage, msAgo, channelId = 'c1', ttlMs = 300_000) => ({ provider, channelId, stage, at: iso(msAgo), expiresAt: new Date(NOW - msAgo + ttlMs).toISOString() });
const ROSTER = ['maestro', 'gemini'];

test('the age-derived pending-work mirror is deleted, not just unwired', () => {
  for (const name of ['pendingAgentWork', 'deskPending', 'AGENT_WORK_WINDOW_MS', 'FAST_POLL_MS']) {
    assert.equal(name in envoyWorkspace, false, `${name} must not be exported`);
  }
  assert.equal(CALM_POLL_MS, 2500, 'the calm poll cadence is unchanged');
});

test('an unmentioned human message routes to nobody (Bite 2: unnamed = silence)', () => {
  assert.deepEqual(addressed(human('m1', 'hello'), ROSTER), []);
  // Naming Maestro names the human's own seat: still nobody.
  assert.deepEqual(addressed(human('m1', '@Maestro look'), ROSTER), []);
});

test('in a private room the unnamed prompt IS the room agent\'s work (the room is the address)', () => {
  assert.deepEqual(roomAddressed(human('m1', 'just us here'), ['gemini']), ['gemini']);
  assert.deepEqual(roomAddressed(human('m1', '@Claude wrong room'), ['gemini']), []);
  assert.deepEqual(roomAddressed(human('m1', 'hello'), ['maestro']), [], 'a maestro room seats nobody');
});

test('activity: the newest unexpired event for the seat in this channel is the cue', () => {
  const feed = [ev('claude', 'started', 90_000), ev('claude', 'working', 30_000), ev('gemini', 'working', 10_000)];
  assert.equal(latestActivity(feed, 'claude', 'c1', NOW)?.stage, 'working');
  assert.equal(latestActivity(feed, 'gemini', 'c1', NOW)?.stage, 'working');
  assert.equal(latestActivity(feed, 'claude', 'c2', NOW), null, 'events belong to their channel');
  assert.equal(latestActivity(feed, 'grok', 'c1', NOW), null, 'a seat with no event shows nothing');
});

test('activity: expired events are invisible, however recent the seat', () => {
  const feed = [ev('claude', 'working', 400_000)];
  assert.equal(latestActivity(feed, 'claude', 'c1', NOW), null);
  assert.deepEqual(activityCues(feed, 'c1', [], NOW), []);
  assert.equal(activityLive(feed, 'c1', [], NOW), false);
});

test('activity: seats report under presence names — qwen is ollama, grok may be xai', () => {
  assert.deepEqual(activityProviderNames('qwen'), ['qwen', 'ollama']);
  assert.deepEqual(activityProviderNames('grok'), ['grok', 'xai']);
  assert.deepEqual(activityProviderNames('claude'), ['claude']);
  const feed = [ev('ollama', 'working', 5_000), ev('xai', 'started', 5_000)];
  assert.equal(latestActivity(feed, 'qwen', 'c1', NOW)?.provider, 'ollama');
  assert.equal(latestActivity(feed, 'grok', 'c1', NOW)?.provider, 'xai');
  assert.deepEqual(activityCues(feed, 'c1', [{ handle: 'qwen', name: 'Qwen' }], NOW).map((c) => c.provider), ['grok', 'qwen'], 'built-ins in AGENTS order, then custom agents');
  assert.equal(activityName('qwen', [{ handle: 'qwen', name: 'Qwen' }]), 'Qwen');
  assert.equal(activityName('openai', []), 'ChatGPT');
});

test('presence: a seat reporting under its engine name still reads online — qwen is ollama, grok may be xai', () => {
  const states = envoyWorkspace.agentStates([], ['qwen', 'grok', 'claude'], new Set(['ollama', 'xai']), NOW);
  assert.equal(states.qwen.state, 'idle', 'qwen checks in as ollama — she is online, not OFFLINE');
  assert.equal(states.grok.state, 'idle', 'grok may check in as xai');
  assert.equal(states.claude.state, 'offline', 'a seat with no presence name in the set stays offline');
});

test('activity: a terminal event shows briefly, then clears — older work never resurrects', () => {
  const fresh = [ev('claude', 'working', 60_000), ev('claude', 'done', 5_000)];
  assert.equal(activityCue(fresh, 'claude', 'c1', NOW)?.stage, 'done');
  const stale = [ev('claude', 'working', 60_000), ev('claude', 'done', 11_000)];
  assert.equal(activityCue(stale, 'claude', 'c1', NOW), null, 'past the brief showing, the finished seat is quiet');
  const failed = [ev('gemini', 'failed', 2_000)];
  assert.equal(activityCue(failed, 'gemini', 'c1', NOW)?.stage, 'failed');
});

test('activity: cue text is Name · stage words · m:ss elapsed', () => {
  assert.equal(activityElapsed(ev('claude', 'working', 0), NOW), '0:00');
  assert.equal(activityElapsed(ev('claude', 'working', 65_000), NOW), '1:05');
  assert.equal(activityElapsed(ev('claude', 'working', 600_000), NOW), '10:00');
  assert.equal(activityCueText('Claude', ev('claude', 'working', 65_000), NOW), 'Claude · working on it · 1:05');
  assert.equal(activityCueText('Gemini', ev('gemini', 'file-placed', 9_000), NOW), 'Gemini · placing files on the PC · 0:09');
  assert.equal(activityCueText('Grok', ev('grok', 'failed', 3_000), NOW), 'Grok · hit a problem · 0:03');
});

// Private agent rooms (Bite 7, 2026-10-24): the Agent Chat pane no
// longer filters the open channel — it reads the picked agent's own
// room (channel kind 'agent', slug agent-<provider>). The room seats
// exactly one agent, so the thread is the room's whole non-system
// stream, and room lookup is by kind + slug, never by title or position.
const ids = (list) => list.map((m) => m.id);

test('room thread: prompts and the room agent\'s replies are the conversation, in room order', () => {
  const msgs = [human('m1', 'just between us'), reply('m2', 'm1', 'gemini')];
  assert.deepEqual(ids(agentRoomThread(msgs)), ['m1', 'm2']);
});

test('room thread: system rows (config, join notices) never render', () => {
  const config = { id: 'm0', authorKind: 'system', authorSubject: 'system:envoy-config', body: '{}', createdAt: iso(90_000) };
  const notice = { id: 'm2', authorKind: 'system', authorSubject: 'system', body: 'Gemini joined', createdAt: iso(50_000) };
  assert.deepEqual(ids(agentRoomThread([config, human('m1', 'hi'), notice, reply('m3', 'm1', 'gemini')])), ['m1', 'm3']);
});

test('room thread: it is the room, not a filter — every member of the room shows', () => {
  const other = { id: 'm1', authorKind: 'human', authorSubject: 'user:someone-else', body: 'in the room too', createdAt: iso(60_000) };
  assert.deepEqual(ids(agentRoomThread([other, reply('m2', 'm1', 'claude')])), ['m1', 'm2']);
  assert.deepEqual(agentRoomThread(null), []);
  assert.deepEqual(agentRoomThread([]), []);
});

const ROOM_CHANNELS = [
  { id: 'c-team', slug: 'team', title: 'Team', kind: 'team' },
  { id: 'c-decoy', slug: 'agent-claude', title: 'Not a room', kind: 'team' },
  { id: 'c-gemini', slug: 'agent-gemini', title: 'Gemini', kind: 'agent' },
  { id: 'c-claude', slug: 'agent-claude', title: 'Claude', kind: 'agent' },
];

test('room lookup: finds the room by kind and slug only', () => {
  assert.equal(agentRoomFor(ROOM_CHANNELS, 'claude')?.id, 'c-claude');
  assert.equal(agentRoomFor(ROOM_CHANNELS, 'gemini')?.id, 'c-gemini');
  assert.equal(agentRoomFor(ROOM_CHANNELS, 'grok'), null, 'a room that was never created is not in the list');
  assert.equal(agentRoomFor(ROOM_CHANNELS, null), null);
  assert.equal(agentRoomFor([], 'claude'), null);
});

test('panes removal: no agent-chat pane remains; rooms render as channels', async () => {
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../app/envoy.css', import.meta.url), 'utf8');
  for (const id of ['ew-cli', 'ew-cli-sessions', 'ew-cli-thread', 'ew-cli-form', 'ew-agents']) {
    assert.equal(html.indexOf(`id="${id}"`), -1, `index.html no longer has #${id}`);
  }
  assert.ok(!js.includes('function renderCliThread'), 'envoy-workspace.js no longer renders a pane conversation');
  assert.doesNotMatch(css, /\.ew-cli-thread \{/, 'envoy.css no longer styles the pane conversation');
  assert.ok(js.includes('AGENT ROOMS'), 'agent rooms still render as their own section of the channel list');
});

// Panes removal (Troy's order, 2026-11-08): the room is channels | chat |
// guard | workbench — the agent CLI pane and the agents roster pane are
// deleted outright, splits, toggles and all; channels stay plain.
test('desktop layout: no agent CLI or agents panes; channels are plain', async () => {
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  const chat = html.indexOf('id="ew-chat"');
  const guard = html.indexOf('id="ew-guard"');
  const bench = html.indexOf('id="ew-bench"');
  assert.ok(chat !== -1 && guard !== -1 && bench !== -1, 'chat, guard and workbench panes exist');
  assert.ok(chat < guard && guard < bench, 'guard sits between the chat and the workbench');
  for (const gone of ['id="ew-cli"', 'id="ew-agents"', 'data-pane="cli"', 'data-pane="agents"', 'data-toggle="cli"', 'data-toggle="agents"', 'data-split="cli"', 'data-split="agents"', 'id="ew-cli-new"', 'id="ew-create-agent-btn"', 'id="ew-agent-add"']) {
    assert.equal(html.indexOf(gone), -1, `index.html no longer has ${gone}`);
  }
  assert.match(html, /id="ew-add-channel"[^>]*>\+</);
  assert.doesNotMatch(html, /ew-new-channel-agent/);
  // The one pane function with no other home — adding a seat to the
  // channel — moved into the CREW section of the channels rail.
  const crew = html.indexOf('id="ew-crew"');
  const crewAdd = html.indexOf('id="ew-crew-add"');
  assert.ok(crew !== -1 && crewAdd > crew, 'the add-to-channel pills render inside the CREW section');
});

// Sliders fix (Troy's live report, 2026-10-23): every pane must drag in
// both directions to a slim minimum, collapse must have a reveal path, and
// the nav rail must collapse/peek from the rail itself.
test('pane sliders: every pane has a split, a collapse control and a way back', async () => {
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  for (const name of ['channels', 'guard', 'bench']) {
    assert.match(html, new RegExp(`id="ew-${name}"`), name);
    assert.match(html, new RegExp(`data-split="${name}"`), name);
    assert.match(html, new RegExp(`data-collapse="${name}"`), name);
  }
  for (const name of ['guard', 'bench']) {
    assert.match(html, new RegExp(`data-toggle="${name}"`), name);
  }
  assert.match(html, /data-open="channels"/);
});

test('splitter drag: pointer capture with cancel handling, per-pane floors, slide-to-collapse', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  assert.match(js, /setPointerCapture/);
  assert.match(js, /pointercancel/);
  assert.match(js, /PANE_MIN = \{ channels: 132, guard: 150, bench: 200 \}/);
  assert.match(js, /will-collapse/);
  const css = await readFile(new URL('../app/envoy.css', import.meta.url), 'utf8');
  assert.match(css, /\.ew\.dragging \.ew-pane \{ transition:none; flex-shrink:0; \}/);
  assert.match(css, /\.ew-pane\.will-collapse/);
  // CSS floors match the JS PANE_MIN table (a mismatch = dead drag travel).
  for (const [pane, min] of Object.entries({ channels: 132, guard: 150, bench: 200 })) {
    assert.match(css, new RegExp(`\\.ew-${pane} \\{[^}]*min-width:${min}px`), pane);
  }
});

// Polish Bite A (sliders S1–S6, audit 2026-10-23): the blank-workspace trap
// and its slider family. Structural, same style as the slider tests above.
test('S1: hiding the workbench clears bench-max first — Hide always wins over Expand', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  const body = js.slice(js.indexOf('function setPane'), js.indexOf('const paneOpen'));
  assert.match(body, /name === 'bench' && !open/);
  assert.match(body, /classList\.remove\('bench-max'\)/);
  // The clear runs before the collapse toggle, so the chat is never left
  // zeroed with its restore controls inside an invisible bench.
  assert.ok(body.indexOf("classList.remove('bench-max')") < body.indexOf("classList.toggle('collapsed'"), 'bench-max clears before collapse applies');
  // The chat header toggle (the way back) still reopens the bench.
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  assert.match(html, /data-toggle="bench"/);
});

test('S2: a drag freezes only the dragged pane var — responsive defaults survive', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  assert.match(js, /const freeze = \(only\) =>/);
  assert.match(js, /if \(n !== only\) continue;/);
  assert.match(js, /freeze\(name\)\[name\]/);
  assert.doesNotMatch(js, /freeze\(\)\[name\]/);
});

test('S3: rail widths are single-sourced in envoy.css; peek width equals pinned width', async () => {
  const css = await readFile(new URL('../app/envoy.css', import.meta.url), 'utf8');
  assert.match(css, /--rail-w:60px; --side-full-w:228px;/);
  assert.match(css, /\.shell \{ --side-w:var\(--side-full-w\); \}/);
  assert.match(css, /\.shell\.sidebar-rail \{ --side-w:var\(--rail-w\); \}/);
  assert.match(css, /\.sidebar\.rail \{ width:auto; \}/);
  assert.match(css, /\.sidebar\.rail\.peek \{[^}]*width:var\(--side-full-w\)/);
  const appCss = await readFile(new URL('../app/app.css', import.meta.url), 'utf8');
  assert.doesNotMatch(appCss, /--side-w: 56px/);
  assert.doesNotMatch(appCss, /\.sidebar\.rail \{\s*width:/);
});

test('S4: the collapse hint arms at the pane floor, collapse itself still waits for SNAP', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  assert.match(js, /classList\.toggle\('will-collapse', raw < min\)/);
  assert.match(js, /if \(raw < SNAP\)/);
  const css = await readFile(new URL('../app/envoy.css', import.meta.url), 'utf8');
  assert.match(css, /\.ew-pane\.will-collapse \{[^}]*box-shadow:/);
});

test('S5: separators carry a full ARIA range and a live value', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  assert.match(js, /setAttribute\('aria-valuemin', String\(PANE_MIN\[name\]\)\)/);
  assert.match(js, /setAttribute\('aria-valuemax', String\(PANE_MAX\)\)/);
  // Initialized in wireSplitters, kept current by persist and by setPane.
  assert.match(js, /const persist = \(name, w\) => \{[\s\S]{0,320}aria-valuenow/);
  assert.match(js, /function syncSplitterAria\(name\)/);
  const body = js.slice(js.indexOf('function setPane'), js.indexOf('function syncSplitterAria'));
  assert.match(body, /syncSplitterAria\(name\)/);
});

test('S6: keyboard users can collapse a pane and reset its width', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  assert.match(js, /e\.key === 'Home'/);
  assert.match(js, /e\.key === 'End' \|\| e\.key === 'Enter'/);
  assert.match(js, /const resetWidth = \(\) =>/);
  assert.match(js, /addEventListener\('dblclick', resetWidth\)/);
});

test('nav rail: the pin lives on the rail, hover peek is desktop-pointer only', async () => {
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="rail-pin"/);
  assert.doesNotMatch(html, /id="rail-toggle"/);
  const js = await readFile(new URL('../app/app.js', import.meta.url), 'utf8');
  assert.match(js, /getElementById\('rail-pin'\)/);
  assert.match(js, /store\.get\('navPinned'/);
  assert.match(js, /classList\.add\('peek'\)/);
  assert.match(js, /classList\.remove\('peek'\)/);
  const css = await readFile(new URL('../app/envoy.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(min-width: 901px\) and \(hover: hover\) and \(pointer: fine\)/);
  assert.match(css, /\.sidebar\.rail\.peek \{/);
});

// Panel bite (Troy's final word, 2026-11-08): the channels pane rests as
// a slim rail everywhere, hover opens it over the chat, a click pins it;
// the nav sidebar's rail is likewise the default at every width; the
// named surfaces carry no scrollbar at all; the "+" menu byline wraps.
test('panel bite: channels pane rests as a rail, peeks on hover, pins on click', async () => {
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="ew-channels-rail-tab"/);
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  assert.match(js, /function setChannelsRest\(rest, \{ user = false \} = \{\}\)/);
  assert.match(js, /function wireChannelsRail\(\)/);
  assert.match(js, /classList\.add\('peeking'\)/);
  assert.match(js, /if \(ls\.get\('open\.channels', false\)\) setPane\('channels', true\);/);
  assert.match(js, /if \(n === 'channels'\) \{ setChannelsRest\(true, \{ user: true \}\); return; \}/);
  const css = await readFile(new URL('../app/envoy.css', import.meta.url), 'utf8');
  assert.match(css, /\.ew-channels\.rail-rest \{ flex:0 0 48px; min-width:48px; \}/);
  assert.match(css, /\.ew-channels\.rail-rest\.peeking \{ position:fixed;[^}]*width:var\(--ew-channels\)/);
  assert.match(css, /\.ew-channels\.rail-rest:not\(\.peeking\) > :not\(\.ew-channels-rail-tab\) \{ display:none !important; \}/);
});

// Hover-push (Troy, 2026-11-09): the peeking channels pane pushes the
// chat right by its full open width instead of covering it, animated on
// the panes' own --dur/--ease; at rest the chat carries no offset.
test('hover-push: the peeking channels pane pushes the chat right, resting state has no offset', async () => {
  const css = await readFile(new URL('../app/envoy.css', import.meta.url), 'utf8');
  // The offset exists and is keyed to the peeking state only.
  assert.match(css, /\.ew-channels\.rail-rest\.peeking ~ \.ew-chat \{ margin-left:var\(--ew-channels\); \}/);
  // The push animates with the pane transition list plus margin-left.
  assert.match(css, /\.ew > \.ew-chat \{ transition:flex-basis var\(--dur\) var\(--ease\), opacity var\(--dur\) var\(--ease\), transform var\(--dur\) var\(--ease\), margin-left var\(--dur\) var\(--ease\); \}/);
  // The resting base rule for the chat carries no margin at all.
  assert.doesNotMatch(css, /^\.ew-chat \{[^}]*margin-left/m);
});

test('panel bite: sleek scrollbars — the named surfaces carry no bar, and no arrows', async () => {
  const css = await readFile(new URL('../app/envoy.css', import.meta.url), 'utf8');
  for (const sel of ['.ew-messages', '.ew-channel-list', '.ew-crew-list', '.ew-picker', '.sidebar']) {
    assert.match(css, new RegExp(sel.replace('.', '\\.') + '[\\s\\S]{0,240}?\\{ scrollbar-width:none; \\}'), sel);
    assert.match(css, new RegExp(sel.replace('.', '\\.') + '::-webkit-scrollbar[\\s\\S]{0,320}?\\{ width:0; height:0; display:none; \\}'), sel);
  }
  // The byline in the "+" popup wraps instead of clipping mid-word.
  assert.match(css, /\.ew-lib-line \{[^}]*white-space:normal/);
  assert.doesNotMatch(css, /\.ew-lib-line \{[^}]*text-overflow:ellipsis/);
});

test('panel bite: the nav rail is the default at every width; a stored pin still wins', async () => {
  const js = await readFile(new URL('../app/app.js', import.meta.url), 'utf8');
  assert.match(js, /store\.get\('navPinned', false\)/);
  assert.doesNotMatch(js, /store\.get\('navPinned', window\.innerWidth/);
});

// Polish Bites C/D (audit 2026-10-23): F2's leftover double animation, the
// rail tooltips (I1) and the I2 interim — the composer "+" was a labelled
// Tools button until real attach landed. It has now landed (composer "+"
// picker, app/composer-picker.mjs): the channel composer's "+" opens the
// picker; the Session console's button (app.js) is still the Tools opener.
test('I1: every nav item carries a rail tooltip (data-tip) matching its label', async () => {
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  const items = [...html.matchAll(/<button class="nav-item[^"]*"([^>]*)>([\s\S]*?)<\/button>/g)]
    .filter((m) => m[1].includes('data-view='));
  assert.equal(items.length, 14, 'all 14 view nav items are present');
  for (const [, attrs, inner] of items) {
    const tip = attrs.match(/data-tip="([^"]+)"/)?.[1];
    const label = inner.match(/<span class="label">([^<]+)<\/span>/)?.[1];
    assert.ok(tip, `nav item "${label}" carries data-tip for rail mode`);
    assert.equal(tip, label, 'the rail tooltip text is the nav label');
  }
});

test('I2 landed: the channel composer "+" opens the attach picker; the console Tools button is unchanged', async () => {
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  const maestro = html.match(/<button[^>]*id="maestro-plus"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(maestro, '#maestro-plus exists');
  assert.match(maestro[1], /\+/, 'maestro composer button shows the plus');
  assert.doesNotMatch(maestro[1], /Add/, 'maestro composer button is a bare plus — no Add label');
  assert.doesNotMatch(maestro[1], /Tools/, 'maestro composer button no longer routes to Tools');
  const consoleBtn = html.match(/<button[^>]*data-tool="tools"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(consoleBtn, 'console composer tools button exists');
  assert.match(consoleBtn[1], /🔧/, 'console composer button shows the wrench glyph');
  assert.match(consoleBtn[1], /Tools/, 'console composer button shows the word Tools');
  // The channel "+" opens the picker; the console button still opens Tools.
  const ejs = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  assert.match(ejs, /\$\('maestro-plus'\)\.addEventListener\('click', \(\) => togglePicker\('channel'\)\)/);
  const ajs = await readFile(new URL('../app/app.js', import.meta.url), 'utf8');
  assert.match(ajs, /t\.dataset\.tool === 'tools'\) openTools\(\)/);
});

// Slider drag travel fix (2026-10-23): the old clamp bounded a drag by
// the container's already-free space, which is ~0 in a full row — a
// +300px drag on channels landed +76px in the live app (measured with
// real pointer events). dragLayout is the pure geometry the pointer and
// keyboard paths now share: growth comes from the rest of the row (the
// flexible chat to its floor, then the other panes to theirs).
const FLOORS = { channels: 132, cli: 150, agents: 150, guard: 150, bench: 200 };
const FULL = { channels: 200, cli: 220, agents: 200, guard: 200, bench: 280 }; // sums to 1100; chat = 1500 − 20 − 1100 = 380, exactly its floor
const fullRow = (name, target, containerW = 1500) => dragLayout({ widths: { ...FULL }, floors: FLOORS, chatFloor: 380, containerW, splitsW: 20, name, target });

test('drag travel: a +300px drag in a full row grows the pane by the full pointer travel the row can yield', () => {
  // Every other pane sits at its floor afterwards and the chat keeps its
  // floor: 450 is all the row can give, and the drag takes all of it —
  // the old free-space clamp gave 0 growth on this exact row.
  const lay = fullRow('channels', 500);
  assert.equal(lay.width, 450);
  assert.deepEqual(lay.widths, { channels: 450, cli: 150, agents: 150, guard: 150, bench: 200 });
});

test('drag travel: with room in the chat, a +300px drag lands the full +300 and touches nobody', () => {
  const lay = fullRow('channels', 500, 2000); // chat is 880 here — it absorbs the growth
  assert.equal(lay.width, 500);
  assert.deepEqual(lay.widths, { ...FULL, channels: 500 });
});

test('drag travel: growth is taken farthest-first, so the panes next to the pointer stay put longest', () => {
  // The live row since the panes removal: channels | chat | guard | bench,
  // chat exactly at its floor so every pixel comes from the sized panes.
  const FLOORS3 = { channels: 132, guard: 150, bench: 200 };
  const row3 = (name, target) => dragLayout({ widths: { channels: 200, guard: 300, bench: 280 }, floors: FLOORS3, chatFloor: 380, containerW: 1170, splitsW: 10, name, target });
  const lay = row3('channels', 300); // +100: bench (farthest) yields to its floor, guard yields the rest
  assert.equal(lay.width, 300);
  assert.deepEqual(lay.widths, { channels: 300, guard: 280, bench: 200 });
  const fromRight = row3('bench', 480); // +200 from the right edge yields channels first, then guard
  assert.equal(fromRight.width, 480);
  assert.deepEqual(fromRight.widths, { channels: 132, guard: 168, bench: 480 });
});

test('drag travel: the chat yields before any sized pane does', () => {
  // Chat is 100px above its floor (container 1600): a +150 drag takes
  // 100 from the chat and only 50 from the farthest pane.
  const lay = fullRow('channels', 350, 1600);
  assert.equal(lay.width, 350);
  assert.deepEqual(lay.widths, { ...FULL, channels: 350, bench: 230 });
});

test('drag travel: shrinking stops at the pane floor and frees space without touching neighbours', () => {
  const lay = fullRow('channels', 40); // below SNAP at runtime; the geometry just floors it — collapse is the caller's job
  assert.equal(lay.width, 132);
  assert.deepEqual(lay.widths, { ...FULL, channels: 132 });
  const cli = fullRow('cli', 100);
  assert.equal(cli.width, 150);
  assert.deepEqual(cli.widths, { ...FULL, cli: 150 });
});

test('drag travel: PANE_MAX still caps an oversized drag', () => {
  const lay = dragLayout({ widths: { channels: 200, cli: 220 }, floors: FLOORS, chatFloor: 380, containerW: 4000, splitsW: 10, name: 'channels', target: 2000 });
  assert.equal(lay.width, 900);
  assert.equal(lay.widths.cli, 220); // the chat had room for all of it
});

test('drag travel: the pointer and keyboard paths clamp through dragLayout, not free space', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  assert.match(js, /export function dragLayout/);
  assert.equal(js.split('dragLayout({ ...snap, name, target:').length - 1, 2, 'both the pointer move and the arrow-key step call dragLayout');
  assert.doesNotMatch(js, /clientWidth - used/, 'the old already-free-space clamp is gone');
});

test('I3: brand marks are real SVG glyphs, not color blocks or a literal glyph', async () => {
  const css = await readFile(new URL('../app/envoy.css', import.meta.url), 'utf8');
  const discordRule = css.match(/\.ew-discord-mark \{[^}]*\}/)?.[0] ?? '';
  assert.match(discordRule, /mask:url\("data:image\/svg\+xml/, 'Discord mark is an SVG mask glyph');
  assert.match(discordRule, /M20\.317 4\.3698/, 'Discord mark carries the real Discord silhouette path');
  assert.doesNotMatch(discordRule, /background:#5865F2/, 'Discord mark is no longer a plain blurple square');
  const slackRule = css.match(/\.ew-slack-mark \{[^}]*\}/)?.[0] ?? '';
  assert.match(slackRule, /mask:url\("data:image\/svg\+xml/, 'Slack mark is an SVG mask glyph');
  assert.match(slackRule, /M5\.042 15\.165/, 'Slack mark carries the real Slack silhouette path');
  assert.match(css, /\.int-icon \.ew-slack-mark/, 'Integrations icon sizing covers the Slack mark');
  const view = await readFile(new URL('../app/integrations-view.mjs', import.meta.url), 'utf8');
  const slackCard = view.match(/\{ key: 'slack'[^}]*\}/)?.[0] ?? '';
  assert.match(slackCard, /icon: \{ mark: 'slack' \}/, 'Slack card uses the Slack mark');
  assert.doesNotMatch(slackCard, /glyph: '#'/, 'Slack card no longer uses a literal "#" glyph');
});

test('I6: channel-row status markers are glyphs, not unexplained color dots', async () => {
  const css = await readFile(new URL('../app/envoy.css', import.meta.url), 'utf8');
  const discordMini = css.match(/\.ew-mini\.discord \{[^}]*\}/)?.[0] ?? '';
  assert.match(discordMini, /mask:url\("data:image\/svg\+xml/, 'the linked-to-Discord marker is the Discord glyph');
  const agentsMini = css.match(/\.ew-mini\.agents \{[^}]*\}/)?.[0] ?? '';
  assert.match(agentsMini, /mask:url\("data:image\/svg\+xml/, 'the has-agents marker is the Agents people glyph');
  assert.doesNotMatch(css, /\.ew-mini \{[^}]*border-radius:50%/, 'the markers are no longer round color dots');
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  assert.match(js, /class: 'ew-mini discord', title: 'Linked to Discord'/, 'channel rows still flag Discord links');
  assert.match(js, /class: 'ew-mini agents', title:/, 'channel rows still flag agent membership');
});

// The Maestro desk (Maestro Bite 1, 2026-10-25): the human's manager
// seat is one channel per tenant (slug 'maestro-desk'). In the desk a
// send is a dispatch — deskTargets mirrors the server's desk routing
// (src/cloud/envoy-agents.mjs agentsToAnswer with desk:true).
const DESK_TEAM = ['claude', 'openai', 'grok', 'gemini'];

test('desk identity: the desk channel is found by its reserved slug, never by title', () => {
  const channels = [
    { id: 'c-team', slug: 'team', title: 'Maestro', kind: 'team' },
    { id: 'c-desk', slug: 'maestro-desk', title: 'Maestro', kind: 'team' },
  ];
  assert.equal(MAESTRO_DESK_SLUG, 'maestro-desk');
  assert.equal(isDeskChannel(channels[1]), true);
  assert.equal(isDeskChannel(channels[0]), false, 'a channel merely titled Maestro is not the desk');
  assert.equal(isDeskChannel(null), false);
  assert.equal(deskChannelFor(channels)?.id, 'c-desk');
  assert.equal(deskChannelFor([]), null);
});

test('desk roster: AGENTS order, and Maestro is never on it', () => {
  assert.deepEqual(deskRoster(['gemini', 'maestro', 'claude']), ['claude', 'gemini']);
  assert.deepEqual(deskRoster(['maestro']), []);
  assert.deepEqual(deskRoster([]), []);
  assert.deepEqual(deskRoster(null), []);
});

test('desk roster: the four catalog seats sit on the desk and answer to their names', () => {
  assert.deepEqual(
    deskRoster(['openrouter', 'groq', 'cloudflare', 'nvidia', 'claude']),
    ['claude', 'groq', 'nvidia', 'cloudflare', 'openrouter'],
    'catalog seats join the roster in AGENTS order, after the sign-in seats',
  );
  assert.equal(activityName('groq'), 'Groq');
  assert.equal(activityName('nvidia'), 'NVIDIA');
  assert.equal(activityName('cloudflare'), 'Cloudflare');
  assert.equal(activityName('openrouter'), 'OpenRouter');
  assert.deepEqual(deskTargets(human('m1', '@Groq and @OpenRouter: go'), ['groq', 'openrouter', 'claude']), ['groq', 'openrouter']);
  assert.deepEqual(deskTargets(human('m1', '@nim check the build'), ['nvidia']), ['nvidia'], 'the nim alias reaches the NVIDIA seat');
});

test('desk targets: unnamed is everyone, @all is everyone, @name is the named alone', () => {
  assert.deepEqual(deskTargets(human('m1', 'build the page'), DESK_TEAM), DESK_TEAM);
  assert.deepEqual(deskTargets(human('m1', '@all status'), DESK_TEAM), DESK_TEAM);
  assert.deepEqual(deskTargets(human('m1', '@Claude fix it'), DESK_TEAM), ['claude']);
  assert.deepEqual(deskTargets(human('m1', '@Claude and @Grok: go'), DESK_TEAM), ['claude', 'grok']);
});

test('desk targets: naming Maestro dispatches to nobody — Maestro is the sender', () => {
  assert.deepEqual(deskTargets(human('m1', '@Maestro look'), DESK_TEAM), []);
  assert.deepEqual(deskTargets(human('m1', 'hello'), ['maestro', 'claude']), ['claude'], 'a stray maestro on the roster is stripped');
  assert.deepEqual(deskTargets(human('m1', '@Grok hi'), ['claude']), [], 'not seated on the desk');
});

test('desk targets: agent and system messages dispatch nobody', () => {
  const agentMsg = { id: 'm1', authorKind: 'agent', authorSubject: 'agent:claude', body: '@Gemini your turn', createdAt: iso(60_000) };
  assert.deepEqual(deskTargets(agentMsg, DESK_TEAM), []);
  const sysMsg = { id: 'm2', authorKind: 'system', authorSubject: 'system:envoy', body: '@all', createdAt: iso(60_000) };
  assert.deepEqual(deskTargets(sysMsg, DESK_TEAM), []);
});

test('the desk on screen: no banner, no manager mode, no seat to leave — desk hooks stay, the pane panel is gone', async () => {
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../app/envoy.css', import.meta.url), 'utf8');
  assert.equal(html.indexOf('id="ew-maestro-banner"'), -1, 'no manager-mode banner in the shell (fun pass F4)');
  assert.equal(html.indexOf('id="ew-maestro-exit"'), -1, 'no Leave-the-seat button in the shell');
  assert.doesNotMatch(html, /You are Maestro — manager mode/, 'the banner copy is gone');
  assert.doesNotMatch(html, /Leave the seat/, 'the way-out-of-the-seat copy is gone');
  // Panes removal (2026-11-08): the desk panel that rode in the Agents
  // pane is gone with the pane; the handoff/checkpoint lists' surviving
  // home is the shell's Evidence view (app.js, same endpoints).
  for (const id of ['ew-desk', 'ew-desk-handoffs', 'ew-desk-checkpoints', 'ew-desk-note']) {
    assert.equal(html.indexOf(`id="${id}"`), -1, `index.html no longer has #${id}`);
  }
  assert.ok(!js.includes('function loadDeskLists') && !js.includes('function renderDeskLists'), 'envoy-workspace.js no longer renders desk lists');
  for (const needle of ['function renderMaestroMode', 'function openDeskChannel', "post('/api/admin/envoy/maestro-desk'", 'inMaestroMode()', 'Dispatched to', '@name for one agent, no name for everyone']) {
    assert.ok(js.includes(needle), `envoy-workspace.js has ${needle}`);
  }
  const appJs = await readFile(new URL('../app/app.js', import.meta.url), 'utf8');
  assert.ok(appJs.includes('/api/admin/maestro/handoffs') && appJs.includes('/api/admin/maestro/checkpoints'), 'the Evidence view in app.js still reads the handoff and checkpoint lists');
  for (const gone of ['function enterMaestroSeat', 'function leaveMaestroSeat', 'ew-maestro-exit', 'ew-maestro-banner', 'maestro-mode']) {
    assert.ok(!js.includes(gone), `envoy-workspace.js no longer has ${gone}`);
  }
  assert.doesNotMatch(css, /\.ew-maestro-banner \{/, 'envoy.css no longer styles a banner');
  assert.doesNotMatch(css, /#ew-chat\.maestro-mode \{/, 'envoy.css no longer frames the chat pane in a manager mode');
  assert.match(css, /\.ew-channel\.seat \{/, 'envoy.css marks the seat row in the channel list');
});

test('I8: the phone panels button is the Guard shield plus a visible Guard caption', async () => {
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  const btn = html.match(/<button id="guard-toggle"[^>]*>([\s\S]*?)<\/button>/)?.[1] ?? '';
  assert.match(btn, /class="ew-shield"/, 'the button reuses the Guard shield mark');
  assert.match(btn, /class="guard-lbl">Guard</, 'the button carries a visible Guard caption');
  assert.doesNotMatch(btn, /⛨/, 'the obscure shield-cross glyph is gone');
  const pane = html.match(/<span class="ew-shield" aria-hidden="true"><\/span><strong>Guard<\/strong>/);
  assert.ok(pane, 'the desktop Guard pane uses the same shield + Guard pairing');
  const appCss = await readFile(new URL('../app/app.css', import.meta.url), 'utf8');
  assert.match(appCss, /#guard-toggle \{[^}]*width:auto/, 'the toggle widens to fit its caption');
});

// ---------- Maestro seat invisibility: cache, not code (2026-10-25) ----------
// Browser-proven twice on the live app: the channel list rendered with
// NO Maestro section at all, while the server served envoy-workspace.js
// byte-identical to main (seat code included). The rendered list matched
// the PRE-seat renderChannels output exactly. Cause: no Cache-Control
// anywhere in vercel.json for the /app shell, so the CDN stamps its
// default `public, max-age=14400` on the unversioned shell files; a
// browser that fetched the shell before a deploy runs the stale copy
// for up to 4 hours — and the service worker's network-first fetch()
// is satisfied by that fresh HTTP-cache entry, so the SW cannot rescue
// it. These tests pin both halves: the renderer's unconditional seat
// (with the real list shape from the live proof) and the header that
// keeps the shell revalidating.

test('seat render: with the live-proof channel shape (Team + agent rooms, no desk channel) the seat falls to its enter row and still renders above ENVOY', async () => {
  // The exact shape seen live, 2026-10-25: one team channel, three
  // private agent rooms (troy, Gemini, and the OLD Maestro room), and
  // no desk channel — the state in which the seat was reported missing.
  const channels = [
    { id: 'c-team', slug: 'team', title: 'Team', kind: 'team' },
    { id: 'c-room-troy', slug: 'troy', title: 'troy', kind: 'agent' },
    { id: 'c-room-gemini', slug: 'gemini', title: 'Gemini', kind: 'agent' },
    { id: 'c-room-maestro', slug: 'maestro', title: 'Maestro', kind: 'agent' },
  ];
  assert.equal(deskChannelFor(channels), null, 'no desk channel exists in this shape — the seat must use its enter row');
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  const render = js.slice(js.indexOf('function renderChannels()'), js.indexOf('async function selectChannel'));
  const maestroHead = render.indexOf("'MAESTRO'");
  const envoyHead = render.indexOf("'ENVOY'");
  assert.ok(maestroHead !== -1 && envoyHead !== -1 && maestroHead < envoyHead, 'the MAESTRO head renders above the ENVOY head');
  assert.ok(render.includes('seatRow,'), 'the seat row is emitted with the list children');
  assert.ok(render.includes('openDeskChannel'), 'the no-desk-channel branch builds the desk row that opens (and creates) the desk');
  assert.ok(render.includes('Your manager seat'), 'the desk-exists branch builds the desk row — both branches render a seat');
});

test('app shell cache: vercel.json forces revalidation for /app assets so a deploy is never hidden behind a 4-hour CDN default', async () => {
  const raw = await readFile(new URL('../vercel.json', import.meta.url), 'utf8');
  const config = JSON.parse(raw);
  const appRules = (config.headers ?? []).filter((entry) =>
    typeof entry.source === 'string' && entry.source.includes('/app/')
    && (entry.headers ?? []).some((header) => header.key.toLowerCase() === 'cache-control'));
  // The split law (2026-11-09, the shell stamp): this pin's original
  // law — no deploy hidden behind a CDN default — is now carried by
  // TWO rules. A /app URL without the ?v= stamp (the document above
  // all) still forces revalidation, so a deploy is never hidden; a
  // stamped URL is a content address whose bytes cannot change, and
  // serves immutable.
  const unstamped = appRules.find((entry) => (entry.missing ?? []).some((c) => c.type === 'query' && c.key === 'v'));
  assert.ok(unstamped, 'vercel.json carries the unstamped /app Cache-Control rule (missing the v query)');
  const value = unstamped.headers.find((header) => header.key.toLowerCase() === 'cache-control').value;
  assert.ok(/max-age=0|no-cache|no-store/.test(value), `the unstamped /app Cache-Control forces revalidation (got: ${value})`);
  const stamped = appRules.find((entry) => (entry.has ?? []).some((c) => c.type === 'query' && c.key === 'v'));
  assert.ok(stamped, 'vercel.json carries the stamped /app Cache-Control rule (has the v query)');
  const stampedValue = stamped.headers.find((header) => header.key.toLowerCase() === 'cache-control').value;
  assert.equal(stampedValue, 'public, max-age=31536000, immutable', 'stamped /app assets serve immutable — the URL is a content address');
});

test('tenant onboarding: the asleep banner + element + state fetch are wired', async () => {
  const { agentStateBanner } = await import('../app/envoy-workspace.js');
  assert.equal(agentStateBanner(null), null);
  assert.equal(agentStateBanner({ state: 'awake', line: null }), null);
  assert.equal(
    agentStateBanner({ state: 'asleep', line: 'Your agents wake up when you connect a subscription.' }),
    'Your agents wake up when you connect a subscription.',
  );
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="ew-agent-state"/, 'the banner element sits in the chat pane');
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  assert.match(js, /\/api\/admin\/envoy\/agent-state/, 'the workspace fetches the tenant agent state');
  const css = await readFile(new URL('../app/envoy.css', import.meta.url), 'utf8');
  assert.match(css, /\.ew-agent-state \{/, 'the banner has its own style');
});

// ---- per-agent "+" picker (plus-parity bite 1) ----
// The workspace picker is built for the agent the composer is talking
// to: the room's agent in a private room, the picked agent in Agent
// Chat, the addressed agent in a channel — and the shared model at the
// desk, where Maestro dispatches to everyone.
const TEAM = { id: 'c1', slug: 'general', name: 'general', kind: 'team' };
const DESK = { id: 'c2', slug: MAESTRO_DESK_SLUG, name: 'Maestro’s desk', kind: 'team' };
const ROOM = { id: 'c3', slug: 'agent-gemini', name: 'Gemini', kind: 'agent' };

test('picker agent context: a private room talks to the room\'s agent', () => {
  assert.equal(pickerAgentContext({ which: 'channel', channel: ROOM }), 'gemini');
  assert.equal(pickerAgentContext({ which: 'channel', channel: { ...ROOM, slug: 'agent-grok' } }), 'grok');
});

test('picker agent context: the desk keeps the shared model, even addressed', () => {
  assert.equal(pickerAgentContext({ which: 'channel', channel: DESK, draft: '@Gemini look at this' }), null);
  assert.equal(pickerAgentContext({ which: 'channel', channel: null }), null);
});

test('picker agent context: a channel talks to the agent its draft addresses', () => {
  assert.equal(pickerAgentContext({ which: 'channel', channel: TEAM, draft: '@Gemini summarise this' }), 'gemini');
  assert.equal(pickerAgentContext({ which: 'channel', channel: TEAM, draft: '@ChatGPT draft a reply' }), 'openai');
  assert.equal(pickerAgentContext({ which: 'channel', channel: TEAM, draft: 'no one addressed' }), null);
  assert.equal(pickerAgentContext({ which: 'channel', channel: TEAM, draft: '@all hands on deck' }), null, '@all is everyone — no single ecosystem');
  assert.equal(pickerAgentContext({ which: 'channel', channel: TEAM, draft: '@Maestro route this' }), null, 'Maestro is the human\'s seat — the shared model');
});

test('picker agent context: Agent Chat talks to its picked agent', () => {
  assert.equal(pickerAgentContext({ which: 'cli', cliProvider: 'claude' }), 'claude');
  assert.equal(pickerAgentContext({ which: 'cli', cliProvider: 'maestro' }), null, 'the desk seat in Agent Chat keeps the shared model');
  assert.equal(pickerAgentContext({ which: 'cli', cliProvider: null }), null);
});

test('picker wiring: the "+" face renders the seat menu model, not the old registry panel (bite 3R-b)', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  assert.match(js, /menuForSeat/, 'Level 2 comes from the shipped per-seat menu definitions');
  assert.match(js, /plusMenuLevel2Model/, 'the workspace composes the definitions with the library read');
  assert.match(js, /renderPlusMenuLevel1/, 'Level 1 is the seat pick');
  assert.match(js, /ew-plus-menu/, 'the room picker wears the narrow popup class');
  assert.doesNotMatch(js, /pickerModel/, 'the old generic picker model is no longer consulted by the face');
  assert.doesNotMatch(js, /Add to this message/, 'the old full-width panel head is gone');
});

// Slack link button (stacked on the G-1 inbound bite): the client half of
// the link-slack mesh action — the control in the chat head, the dialog,
// and the linked state, mirroring the Discord link UI. The header state
// derivation is pure (mirrorLinkHeader); the dialog is DOM and is pinned
// by source assertions, the same split the desk tests use.
const SLACK_LINK = { teamId: 'T0BP40EFJ1W', channelId: 'C0BN7LCK946', channelName: 'all-helmian', teamName: 'HELMIAN', linkedAt: '2026-10-25T00:00:00.000Z' };

test('link slack: the control renders for an unlinked channel — admin sees Link Slack, badge hidden', () => {
  const bot = { configured: true, inviteUrl: null };
  const admin = mirrorLinkHeader({ link: null, bot, admin: true, label: 'Slack' });
  assert.equal(admin.buttonHidden, false);
  assert.equal(admin.buttonLabel, 'Link Slack');
  assert.equal(admin.badgeHidden, true);
  assert.equal(admin.statusText, 'ready to link');
  const member = mirrorLinkHeader({ link: null, bot, admin: false, label: 'Slack' });
  assert.equal(member.buttonHidden, true, 'starting a link is owner/admin work, like Discord');
  const noBot = mirrorLinkHeader({ link: null, bot: { configured: false, inviteUrl: null }, admin: true, label: 'Slack' });
  assert.equal(noBot.statusText, 'bot not set up yet');
  assert.equal(noBot.buttonHidden, false, 'the control still renders; the dialog says the bot is not set up');
});

test('link slack: linked state renders from the config link + bot status', () => {
  const linked = mirrorLinkHeader({ link: SLACK_LINK, bot: { configured: true, inviteUrl: null }, admin: false, label: 'Slack' });
  assert.equal(linked.badgeHidden, false);
  assert.equal(linked.badgeClass, 'slack');
  assert.equal(linked.badgeText, 'Slack #all-helmian');
  assert.equal(linked.buttonLabel, 'Slack linked');
  assert.equal(linked.buttonHidden, false, 'a linked channel keeps the control so the link can be reviewed/unlinked');
  assert.equal(linked.statusText, 'linked to #all-helmian');
  const byId = mirrorLinkHeader({ link: { ...SLACK_LINK, channelName: '' }, bot: { configured: true }, admin: true, label: 'Slack' });
  assert.equal(byId.badgeText, 'Slack #C0BN7LCK946', 'falls back to the channel id like Discord');
});

test('link slack: the shared pendingLink is never claimed by the Slack badge', () => {
  // The config carries ONE pendingLink for both link flows; only the
  // Discord call site passes it, so a pending Slack code cannot make the
  // Slack badge lie — and Discord's pending rendering is unchanged.
  const slack = mirrorLinkHeader({ link: null, bot: { configured: true }, admin: true, label: 'Slack' });
  assert.equal(slack.badgeHidden, true);
  const discord = mirrorLinkHeader({ link: null, pending: true, bot: { configured: true }, admin: true, label: 'Discord' });
  assert.equal(discord.badgeHidden, false);
  assert.equal(discord.badgeClass, 'pending');
  assert.equal(discord.badgeText, 'Discord link pending');
});

test('link slack: control, dialog wiring and state plumbing exist in the app', async () => {
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../app/envoy.css', import.meta.url), 'utf8');
  for (const id of ['ew-link-slack', 'ew-slack-badge', 'ew-slack-status', 'ew-slack-status-text']) {
    assert.match(html, new RegExp(`id="${id}"`), `index.html has #${id}`);
  }
  assert.ok(html.indexOf('id="ew-link-slack"') > html.indexOf('id="ew-link-discord"'), 'the Slack control sits beside the Discord one in the chat head');
  for (const needle of [
    'async function linkSlack()',
    "{ action: 'link-slack', channelId: ws.channelId }",
    "{ action: 'unlink-slack', channelId: ws.channelId }",
    'res.linkCommand',
    'ws.slackBot = body.slackBot ?? null',
    "$('ew-link-slack').addEventListener('click', linkSlack)",
    'Linked to Slack #',
    'The code itself is the key',
  ]) assert.ok(js.includes(needle), `envoy-workspace.js has ${needle}`);
  assert.match(css, /\.ew-badge\.slack \{/, 'envoy.css styles the Slack badge');
  assert.match(css, /\.ew-mini\.slack \{/, 'envoy.css styles the Slack channel tag');
  assert.match(css, /#ew-link-discord, #ew-link-slack \{ display:none; \}/, 'the phone head hides both link controls');
});

// Bite 2 (2026-10-26, from the forensic sweep): the Discord panel lied
// twice — a room linked server-side but never opened in this browser
// was invisible as linked, and the bot status only loaded with an open
// channel, so the panel defaulted to "bot is not connected yet". The
// channels payload now carries the links and the bot status; these
// cases run the panel's own functions on that payload.
test('bite 2: a room linked but never opened in this browser reads linked from the channels payload', async () => {
  const { applyChannelLinks, linkedChannels, netStripText, discordEmptyText } = await import('../app/envoy-workspace.js');
  // The payload as the fixed server sends it; chanMeta is EMPTY — this
  // browser has never opened either channel.
  const channels = applyChannelLinks([
    { id: 'team-1', slug: 'team', title: 'Team', kind: 'team', discord: null, slack: null },
    { id: 'room-1', slug: 'troy', title: 'troy', kind: 'agent', discord: { guildId: '1563445314692718645', channelId: '1563445315237974069', channelName: 'general', guildName: 'HELMIAN', linkedAt: null }, slack: null },
  ], {});
  assert.equal(channels[0]._discord, false);
  assert.equal(channels[1]._discord, true, 'the room link comes from the payload, not from having opened the room');
  assert.deepEqual(linkedChannels(channels).map((c) => c.id), ['room-1'], 'Discord mode has a channel to open');
  assert.equal(netStripText({ mode: 'discord', channel: channels[1] }), "You're posting to Discord · #general");
  assert.equal(netStripText({ mode: 'discord', channel: null }), "You're in Discord · no channel linked yet", 'the no-link wording remains for a workspace with truly nothing linked');
});

test('bite 2: bot status known at boot resolves the empty-state wording to the truth', async () => {
  const { discordEmptyText } = await import('../app/envoy-workspace.js');
  assert.equal(discordEmptyText({ configured: true, inviteUrl: 'https://discord.com/oauth2/authorize?client_id=1' }), 'No channels are linked to Discord yet. Flip to Envoy, open a channel and use Link Discord to mirror it here.', 'configured bot + nothing linked says so — never "bot is not connected"');
  assert.equal(discordEmptyText({ configured: false, inviteUrl: null }), 'The Helmian Discord bot is not connected yet. Once it is, linked channels mirror here.', 'a bot that truly is not configured keeps the original wording');
  assert.equal(discordEmptyText(null), 'The Helmian Discord bot is not connected yet. Once it is, linked channels mirror here.');
});

test('bite 2: an older server payload (no link fields) still falls back to the chanMeta cache', async () => {
  const { applyChannelLinks } = await import('../app/envoy-workspace.js');
  const channels = applyChannelLinks([{ id: 'room-1', slug: 'troy', title: 'troy', kind: 'agent' }], { 'room-1': { a: 1, d: true, s: false } });
  assert.equal(channels[0]._discord, true);
  assert.equal(channels[0]._agents, 1);
});

test('monday launch: custom agent creator, free-willy debate, github link, phone QR, and mobile bottom nav exist and derive header states', async () => {
  const { githubLinkHeader, debateHeaderState, CUSTOM_AGENT_EMOJIS } = await import('../app/envoy-workspace.js');
  assert.ok(Array.isArray(CUSTOM_AGENT_EMOJIS) && CUSTOM_AGENT_EMOJIS.length >= 20, 'smiley/emoji picker has 20+ avatars');

  const ghUnlinked = githubLinkHeader({ github: null, admin: true });
  assert.equal(ghUnlinked.badgeHidden, true);
  assert.equal(ghUnlinked.buttonLabel, 'Link GitHub');

  const ghLinked = githubLinkHeader({ github: { repo: 'troyhelm/helmion', events: ['push', 'pull_request'] }, admin: false });
  assert.equal(ghLinked.badgeHidden, false);
  assert.equal(ghLinked.badgeText, 'GitHub troyhelm/helmion');
  assert.equal(ghLinked.buttonLabel, 'GitHub linked');

  const debateOff = debateHeaderState({ debateMode: 'off', maxRoundTurns: 12 });
  assert.equal(debateOff.active, false);
  assert.equal(debateOff.badgeHidden, true);
  assert.equal(debateOff.stopHidden, true);

  const debateOn = debateHeaderState({ debateMode: 'free-willy', maxRoundTurns: 15 });
  assert.equal(debateOn.active, true);
  assert.equal(debateOn.badgeHidden, false);
  assert.equal(debateOn.stopHidden, false);
  assert.match(debateOn.badgeText, /15 turns/);

  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  assert.match(js, /id: 'ew-left-create-agent'/, 'envoy-workspace.js renders #ew-left-create-agent in left rail');
  for (const id of [
    // 'ew-create-agent-btn' (the Agents pane's button) is gone with the
    // pane (panes removal, 2026-11-08); the creator's homes are the
    // channels footer button below, the rail '+' above, and #ew-crew-add.
    'ew-foot-create-agent',
    'ew-crew-add',
    'ew-link-github',
    'ew-github-badge',
    'ew-debate-toggle',
    'ew-debate-badge',
    'ew-debate-stop',
    'ew-phone-qr',
    'ew-foot-phone-qr',
    'ew-mobile-nav',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `index.html has #${id}`);
  }
});

// Maestro always-on (Troy's ruling, 2026-11-09, superseding the
// per-channel Maestro follow switch shipped the same morning): Maestro
// follows the human in every channel. There is no toggle in the
// header — only the permanent badge — and the composer placeholder,
// the empty-channel line and the net strip all carry the dispatch
// wording as their standing text, whatever any stored flag says.
test('maestro always-on: permanent badge, dispatch wording everywhere, no toggle anywhere', async () => {
  const { maestroHeaderState, composerPlaceholderText, emptyChannelText, netStripText } = await import('../app/envoy-workspace.js');

  const on = maestroHeaderState({});
  assert.equal(on.active, true, 'Maestro is always on');
  assert.equal(on.badgeHidden, false);
  assert.equal(on.badgeText, 'Maestro following');
  assert.equal('buttonLabel' in on, false, 'there is no toggle button to label');
  assert.equal('toggleHidden' in on, false, 'there is no toggle to hide');

  const desk = maestroHeaderState({ desk: true });
  assert.equal(desk.active, true, 'the desk always dispatches');
  assert.equal(desk.badgeHidden, true, 'the desk shows no badge — Maestro is already home there');

  assert.equal(composerPlaceholderText({ mode: 'envoy', title: 'Team', hasAgents: true }),
    'Message #Team · Maestro follows you here — @name for one agent, no name for everyone');
  assert.equal(composerPlaceholderText({ mode: 'envoy', title: 'Team', hasAgents: false }),
    'Message #Team · Maestro follows you here — @name for one agent, no name for everyone', 'the dispatch wording stands even before a crew is added');
  assert.equal(composerPlaceholderText({ mode: 'discord', title: 'Team' }), 'Message #Team');

  assert.match(emptyChannelText({ hasAgents: true }), /Maestro follows you here/);
  assert.match(emptyChannelText({ hasAgents: true }), /name nobody and it goes to everyone in this channel/);
  assert.equal(emptyChannelText({ desk: true }), 'This is your desk. Send a dispatch — @name for one agent, @all for everyone, or name nobody and it goes to everyone on the desk.');
  assert.equal(emptyChannelText({ hasAgents: false }), 'No messages yet. Say hello, or add an agent to make this an agent chat.');

  const channel = { id: 'c1', slug: 'team', title: 'Team', kind: 'team' };
  assert.equal(netStripText({ mode: 'envoy', channel, config: {} }),
    "You're dispatching as Maestro · Maestro follows you in #Team — replies come back under each agent's own name");
  assert.equal(netStripText({ mode: 'envoy', channel, config: { maestroFollow: false } }),
    "You're dispatching as Maestro · Maestro follows you in #Team — replies come back under each agent's own name",
    'a stored maestroFollow:false changes nothing — Maestro is always on');

  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../app/envoy.css', import.meta.url), 'utf8');
  assert.match(html, /id="ew-maestro-follow-badge"/, 'index.html keeps the permanent badge');
  assert.ok(!html.includes('ew-maestro-follow-toggle'), 'index.html has no Maestro toggle');
  assert.ok(!js.includes("action: 'set-maestro-follow'"), 'nothing posts the retired set-maestro-follow action');
  assert.ok(!js.includes('toggleMaestroFollow'), 'the toggle handler is deleted, not hidden');
  assert.ok(!js.includes('maestroFollow'), 'the web never reads the stored follow flag');
  assert.ok(css.includes('.ew-badge.maestro'), 'envoy.css styles the permanent badge');
});

// One-road Bite 5 (2026-11-01): the create-agent dialog's connect step
// is the shared ConnectFields (email + password) for the provider
// currently picked, and the seat-mode select is dead — there is no
// mode choice anywhere in the dialog, and the create submit carries
// the single authMode 'password_session'.
test('bite 5: the create-agent dialog renders no seat-mode select and embeds the connect fields', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  assert.ok(!js.includes('CUSTOM_AUTH_OPTIONS'), 'the seat-mode options constant is gone');
  assert.ok(!js.includes('CUSTOM_AUTH_LABELS'), 'the seat-mode card labels are gone');
  assert.ok(!js.includes('ew-ca-auth'), 'no seat-mode select is rendered in the dialog');
  assert.ok(!js.includes('Seat / Connection Mode'), 'the seat-mode field label is gone');
  for (const mode of ['browser-free', 'browser-paid', 'api-key']) {
    assert.ok(!js.includes(mode), `legacy mode value ${mode} is gone from the workspace`);
  }
  for (const label of ['Subscription Sign-In (Pro / Max / Plus / SuperGrok)', 'Free Browser Seat (Web Session)', 'Paid Browser Seat (Web Session)', 'API Key / SDK (PC Vault)', 'Local CLI Seat (Claude Code / Codex / Gemini CLI)']) {
    assert.ok(!js.includes(label), `legacy mode label "${label}" is gone`);
  }
  assert.ok(!js.includes('Runs on your connected subscription, browser seat, or PC bridge key.'), 'the old footer copy is gone');
  assert.ok(js.includes('Runs on the account you connect with your email and password.'), 'the footer states the one road');
  // The specifier carries the shell stamp (?v=…, 2026-11-09 speed
  // fix); the wiring law is the import itself.
  assert.match(js, /import \{ createConnectFields \} from '\.\/connect-fields\.mjs(\?v=[0-9a-f]{16})?';/, 'the dialog imports the shared ConnectFields component');
  assert.match(js, /providerSelect\.addEventListener\('change', renderConnectFields\)/, 'provider switches re-render the connect fields');
  assert.match(js, /'6\. Connect the account — email and password'/, 'step 6 is the connect step, in the law\u2019s words');
});

// ---- minimal DOM for the component factory (only what it touches) ----
class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.className = '';
    this._text = '';
    this.dataset = {};
    this.value = '';
    this.disabled = false;
    this.hidden = false;
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  append(...kids) { this.children.push(...kids); }
  setAttribute() {}
}
const fakeDoc = { createElement: (tag) => new FakeElement(tag) };
function* walk(node) { yield node; for (const c of node.children) yield* walk(c); }
const findAll = (root, pred) => [...walk(root)].filter(pred);

test('bite 5: dialogConnectFields renders email + password for the chosen provider and follows provider switches', () => {
  const post = async () => ({});
  const forClaude = dialogConnectFields('claude', post, fakeDoc);
  assert.ok(forClaude, 'fields render for the picked provider');
  assert.equal(forClaude.dataset.provider, 'claude');
  assert.deepEqual(findAll(forClaude, (n) => n.tagName === 'INPUT').map((i) => [i.name, i.type]), [['username', 'email'], ['password', 'password']]);
  // A provider switch re-renders through the same function the dialog's
  // change handler calls — the fields then name the new provider.
  const forGrok = dialogConnectFields('grok', post, fakeDoc);
  assert.equal(forGrok.dataset.provider, 'grok', 'the re-rendered fields are for the newly picked provider');
  assert.notEqual(forGrok, forClaude, 'a switch produces a fresh fields form');
});

test('bite 5: the create submit body carries authMode password_session and nothing mode-shaped', () => {
  const body = customAgentCreateBody({ channelId: 'chan-1', handle: 'rusty', name: 'Rusty', emoji: '🦀', provider: 'mistral', jobTitle: 'Rust Systems Architect', jobPrompt: 'Review memory safety.' });
  assert.deepEqual(body, {
    action: 'create-custom-agent',
    channelId: 'chan-1',
    agent: { handle: 'rusty', name: 'Rusty', emoji: '🦀', provider: 'mistral', authMode: 'password_session', jobTitle: 'Rust Systems Architect', jobPrompt: 'Review memory safety.' },
  });
});

// Emoji bite 3 (reactions UI): the desk renders bite 2's summaries as
// chips. The data contract lives in src/cloud/envoy-reactions.mjs —
// emoji is bite 1's slug there; these pure helpers are the whole
// client-side translation (slug -> shipped art, summary -> chip model,
// POST response -> stored state).

test('reactions: a stored slug resolves to its character only when the art ships', () => {
  assert.equal(reactionChar('fire'), '🔥');
  assert.equal(reactionChar('crab'), '🦀');
  assert.equal(reactionChar('middle-finger'), '🖕');
  assert.equal(reactionChar('not-a-slug'), null);
  assert.equal(reactionChar(''), null);
  assert.equal(reactionChar(undefined), null);
});

test('reactions: actor labels prefer server names, then provider names, then kind', () => {
  assert.equal(reactionActorLabel([{ name: 'Gemini', kind: 'agent' }, { name: 'You', kind: 'human' }]), 'Gemini, You');
  assert.equal(reactionActorLabel([{ provider: 'grok', kind: 'agent' }]), 'Grok');
  assert.equal(reactionActorLabel([{ kind: 'agent' }]), 'Agent');
  assert.equal(reactionActorLabel([{ kind: 'human' }]), 'Member');
  assert.equal(reactionActorLabel([]), '');
  assert.equal(reactionActorLabel(undefined), '');
});

test('reactions: the chip model keeps server order, flags mine, and drops what cannot render', () => {
  const summary = [
    { emoji: 'fire', pack: 'default', count: 2, actors: [{ name: 'Gemini', kind: 'agent' }, { name: 'You', kind: 'human' }] },
    { emoji: 'heart-red', pack: 'default', count: 1, actors: [{ name: 'Claude', kind: 'agent' }] },
    { emoji: 'future-pack-slug', pack: 'future', count: 5, actors: [] },
    { emoji: 'check', pack: 'default', count: 0, actors: [] },
  ];
  assert.deepEqual(reactionChipModel(summary, ['fire']), [
    { slug: 'fire', char: '🔥', count: 2, mine: true, actors: 'Gemini, You' },
    { slug: 'heart-red', char: '❤', count: 1, mine: false, actors: 'Claude' },
  ]);
  assert.deepEqual(reactionChipModel([], []), []);
  assert.deepEqual(reactionChipModel(undefined, undefined), []);
});

test('reactions: a POST toggle response folds into the store without mutating it', () => {
  const state = { byId: { m1: [{ emoji: 'fire', count: 1, actors: [] }], m2: [{ emoji: 'check', count: 3, actors: [] }] }, mine: { m1: [], m2: ['check'] } };
  const added = mergeReactionPost(state, { messageId: 'm1', emoji: 'fire', reacted: true, reactions: [{ emoji: 'fire', count: 2, actors: [] }] });
  assert.deepEqual(added.byId.m1, [{ emoji: 'fire', count: 2, actors: [] }], 'the message summary is replaced wholesale');
  assert.deepEqual(added.mine.m1, ['fire']);
  assert.deepEqual(added.byId.m2, state.byId.m2, 'other messages are untouched');
  assert.deepEqual(state.mine.m1, [], 'the input state is not mutated');
  const removed = mergeReactionPost(added, { messageId: 'm1', emoji: 'fire', reacted: false, reactions: [{ emoji: 'fire', count: 1, actors: [] }] });
  assert.deepEqual(removed.mine.m1, []);
  assert.deepEqual(removed.byId.m1, [{ emoji: 'fire', count: 1, actors: [] }]);
  assert.deepEqual(mergeReactionPost(state, {}), state, 'a response without a message id changes nothing');
});

test('reactions: the desk wires bite 2\'s route, the chips, and the bite-1 grid as the picker', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../app/envoy.css', import.meta.url), 'utf8');
  for (const needle of ['/api/admin/envoy/message-reactions', 'ew-reactions', 'ew-rchip', 'ew-react-add', 'ew-react-pop', 'loadReactions', 'toggleReaction', 'syncReactionChips']) {
    assert.ok(js.includes(needle), `envoy-workspace.js has ${needle}`);
  }
  assert.ok(js.includes("'ew-emoji-grid ew-react-grid'"), 'the reaction picker reuses the bite-1 emoji grid classes');
  for (const needle of ['.ew-rchip', '.ew-rchip.mine', '.ew-react-add', '.ew-react-pop', '.ew-reactions:empty']) {
    assert.ok(css.includes(needle), `envoy.css has ${needle}`);
  }
});

// ---------- faces (emoji bite 5) ----------
// Seat faces resolve stored-over-default through the shipped map;
// the desk wiring (faces route, member face, channel face, Qwen's
// pill art) is pinned in source like the bite-3 reaction wiring.

test('seatFaceFor: defaults render before load, stored faces win, junk falls back', () => {
  const { seatFaceFor } = envoyWorkspace;
  assert.equal(seatFaceFor(null, 'claude'), '🧠');
  assert.equal(seatFaceFor(null, 'openai'), '🤖');
  assert.equal(seatFaceFor(null, 'grok'), '⚡');
  assert.equal(seatFaceFor(null, 'gemini'), '🌟');
  assert.equal(seatFaceFor(null, 'mistral'), '🦉');
  assert.equal(seatFaceFor({ claude: '🦊' }, 'claude'), '🦊');
  assert.equal(seatFaceFor({ claude: '🍕' }, 'claude'), '🧠', 'an undrawn stored face never renders');
  assert.equal(seatFaceFor({ claude: '🦊' }, 'gemini'), '🌟', 'one seat\u2019s face never leaks to another');
  assert.equal(seatFaceFor(null, 'maestro'), null, 'Maestro keeps the stock mark');
  assert.equal(seatFaceFor(null, 'qwen'), null, 'custom agents render from their own records');
  assert.equal(seatFaceFor(null, null), null);
});

// ---------- avatar motion (emoji bite 4) ----------
// Motion is a rendering of the same activity feed: stage -> kind ->
// class, gated by the desk's still gate (plain mode / reduced
// motion). No event, no motion; a finished seat is still.

test('motion: working stages roll, publishing talks, terminal and idle are still', () => {
  const { activityMotionKind, activityMotionClass } = envoyWorkspace;
  for (const stage of ['started', 'working', 'file-placed']) {
    assert.equal(activityMotionKind(stage), 'roll', `${stage} rolls`);
    assert.equal(activityMotionClass(stage, false), 'ew-ava-roll');
  }
  assert.equal(activityMotionKind('published'), 'talk', 'a reply landing talks');
  assert.equal(activityMotionClass('published', false), 'ew-ava-talk');
  for (const stage of ['done', 'failed', 'idle', '', null, undefined]) {
    assert.equal(activityMotionKind(stage), null, `${stage} is still`);
    assert.equal(activityMotionClass(stage, false), '');
  }
});

test('motion: the still gate (plain mode / reduced motion) kills every class', () => {
  const { activityMotionClass } = envoyWorkspace;
  for (const stage of ['started', 'working', 'file-placed', 'published']) {
    assert.equal(activityMotionClass(stage, true), '', `${stage} never moves a still user`);
  }
});

test('motion: the stage comes from the live cue — terminal linger and expiry are still', () => {
  const { activityMotionStage } = envoyWorkspace;
  assert.equal(activityMotionStage([ev('claude', 'working', 5_000)], 'claude', 'c1', NOW), 'working');
  assert.equal(activityMotionStage([ev('claude', 'published', 5_000)], 'claude', 'c1', NOW), 'published');
  assert.equal(activityMotionStage([ev('claude', 'done', 5_000)], 'claude', 'c1', NOW), null, 'a finished seat is still even while its row lingers');
  assert.equal(activityMotionStage([ev('claude', 'failed', 5_000)], 'claude', 'c1', NOW), null);
  assert.equal(activityMotionStage([ev('claude', 'working', 400_000, 'c1', 300_000)], 'claude', 'c1', NOW), null, 'expired work never moves');
  assert.equal(activityMotionStage([], 'claude', 'c1', NOW), null, 'no event, no motion');
  assert.equal(activityMotionStage([ev('ollama', 'working', 5_000)], 'qwen', 'c1', NOW), 'working', 'presence names map like the cues do');
  assert.equal(activityMotionStage([ev('claude', 'working', 5_000, 'c2')], 'claude', 'c1', NOW), null, 'another channel\u2019s work never moves this view');
});

test('motion wiring: rows, cards and message avatars carry it; css animates the picture, not the shell', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../app/envoy.css', import.meta.url), 'utf8');
  for (const needle of ['activityMotionClass', 'activityMotionStage', 'syncCrewMotion', 'syncMsgMotion', 'msgSeatAvatar', 'crewSeatFaceClip', 'face-ava', 'ew-ava-roll', 'ew-ava-talk', 'data-provider']) {
    assert.ok(js.includes(needle), `envoy-workspace.js has ${needle}`);
  }
  for (const needle of ['.ew-avatar.ew-ava-roll > img', '.ew-crew-face.ew-ava-roll > img', '.ew-avatar.ew-ava-talk > img', '.ew-crew-face.ew-ava-talk > img', '@keyframes ew-ava-roll', '@keyframes ew-ava-talk']) {
    assert.ok(css.includes(needle), `envoy.css has ${needle}`);
  }
  assert.ok(!css.includes('.ew-avatar.ew-ava-roll {'), 'the avatar shell itself is never the animated node');
  assert.ok(!css.includes('.ew-avatar.ew-ava-talk {'), 'the avatar shell itself is never the animated node');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[^}]*ew-ava-roll[^}]*animation:none/, 'reduced motion turns the avatar animation off in css too');
});

test('boxless faces: no 28px tile, no dark stage, mask on, clips in message rows, clock out of the signature', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../app/envoy.css', import.meta.url), 'utf8');
  assert.ok(!css.includes('.ew-msg .ew-avatar { width:28px; height:28px; border-radius:8px;'), 'the 28px message-face box is gone');
  assert.ok(!css.includes('.ew-msg .ew-avatar:not(.discord):not(.slack) { background:#10151F;'), 'the dark stage tile is gone from message faces');
  assert.ok(css.includes('.ew-msg .ew-avatar.face-ava'), 'message character faces carry a boxless rule');
  assert.ok(css.includes('background:transparent'), 'boxless faces sit on transparency');
  assert.ok(css.includes('mask-image:var(--face-mask)'), 'clips are masked with the still');
  assert.ok(css.includes('.ew-msg .ew-avatar.face-ava > video.ew-crew-face-video { width:36px; height:36px;'), 'message-row clips carry the same explicit 36px size as crew clips (an unsized video renders at its 512px intrinsic size)');
  const msgSeat = js.slice(js.indexOf('function msgSeatAvatar'), js.indexOf('function msgOwnerAvatar'));
  assert.ok(msgSeat.includes('crewSeatFaceClip'), 'message faces mount the clip stack, not the still alone');
  assert.ok(!msgSeat.includes('crewSeatFaceImg'), 'message faces no longer mount the still alone');
  const sig = js.slice(js.indexOf('function activityViewSignature'), js.indexOf('function syncActivityClocks'));
  assert.ok(!sig.includes('activityElapsed'), 'the elapsed clock is not part of the rebuild signature');
});

test('bite 5 wiring: faces route, member face, channel face, custom pill art', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../app/envoy.css', import.meta.url), 'utf8');
  for (const needle of ['/api/admin/envoy/agent-faces', 'loadFaces', 'openSeatFaceModal', 'saveSeatFace', 'seatAvatar', 'seatFaceImg', 'ew-me-face', 'openMyFaceModal', 'saveMyFace', 'authorEmoji', 'set-channel-avatar', 'Saved for the whole workspace.']) {
    assert.ok(js.includes(needle), `envoy-workspace.js has ${needle}`);
  }
  assert.ok(js.includes("'/api/admin/profile'"), 'the member face rides the profile route');
  assert.ok(!js.includes("h('span', {}, ca.emoji || '🤖')"), 'custom-agent mention pills render bite-1 art, never a raw glyph');
  for (const needle of ['.ew-agent-btns', '.ew-me-face']) {
    assert.ok(css.includes(needle), `envoy.css has ${needle}`);
  }
});

// ---------- Speaking proof (speaker-proof bite) ----------
// Troy's ask: a speaker icon on the seat's message that lights while
// that seat's voice is actually playing. The voice controller reports
// playback start/end; envoy draws the marker. These tests pin the
// envoy half with a minimal fake DOM: noteSpeaking patches the icon
// onto the spoken message's meta line (or after it, for a grouped
// follow-up whose meta is hidden), the marker carries the checkable
// data attributes, and clearing removes it.

class FakeEl {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.className = ''; this.dataset = {}; this.parentNode = null; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v); }
  append(...kids) { for (const kid of kids.flat()) { if (kid && typeof kid === 'object') { kid.parentNode = this; this.children.push(kid); } } }
  after(node) { const p = this.parentNode; const i = p.children.indexOf(this); node.parentNode = p; p.children.splice(i + 1, 0, node); }
  remove() { if (this.parentNode) { const i = this.parentNode.children.indexOf(this); if (i >= 0) this.parentNode.children.splice(i, 1); this.parentNode = null; } }
  get classList() { const self = this; return { contains: (c) => self.className.split(/\s+/).includes(c) }; }
  descendants() { const out = []; const walk = (n) => { for (const c of n.children) { if (c instanceof FakeEl) { out.push(c); walk(c); } } }; walk(this); return out; }
  querySelectorAll(sel) { const cls = sel.replace(/^\./, ''); return this.descendants().filter((n) => n.classList.contains(cls)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}

function withFakeRoom(fn) {
  const prevDocument = globalThis.document;
  const prevNode = globalThis.Node;
  const box = new FakeEl('div');
  globalThis.Node = FakeEl;
  globalThis.document = {
    getElementById: (id) => (id === 'ew-messages' ? box : null),
    createElement: (tag) => new FakeEl(tag),
    createTextNode: (text) => ({ text }),
  };
  const mkRow = (id, cont = false) => {
    const row = new FakeEl('div');
    row.className = cont ? 'ew-msg cont' : 'ew-msg';
    row.setAttribute('data-id', id);
    const cell = new FakeEl('div');
    const meta = new FakeEl('div');
    meta.className = 'ew-meta';
    cell.append(meta);
    row.append(cell);
    box.append(row);
    return { row, meta };
  };
  try { return fn(box, mkRow); } finally {
    if (prevDocument === undefined) delete globalThis.document; else globalThis.document = prevDocument;
    if (prevNode === undefined) delete globalThis.Node; else globalThis.Node = prevNode;
  }
}

test('speaking proof: noteSpeaking patches the marker onto the spoken message and clearing removes it', () => {
  withFakeRoom((box, mkRow) => {
    const a = mkRow('m1');
    mkRow('m2');
    envoyWorkspace.noteSpeaking({ seat: 'claude', engine: 'kokoro', ref: 'm1' });
    const icons = box.querySelectorAll('.ew-speaking');
    assert.equal(icons.length, 1, 'exactly one message is lit');
    assert.equal(icons[0].attrs['data-speaking'], 'true');
    assert.equal(icons[0].attrs['data-seat'], 'claude');
    assert.equal(icons[0].attrs['data-engine'], 'kokoro');
    assert.equal(icons[0].parentNode, a.meta, 'the icon stands in the spoken message’s meta line');
    envoyWorkspace.noteSpeaking({ seat: 'grok', engine: 'backup', ref: 'm2' });
    const moved = box.querySelectorAll('.ew-speaking');
    assert.equal(moved.length, 1, 'a new speaker moves the one light');
    assert.equal(moved[0].attrs['data-seat'], 'grok');
    envoyWorkspace.noteSpeaking(null);
    assert.equal(box.querySelectorAll('.ew-speaking').length, 0, 'playback end clears the marker');
  });
});

test('speaking proof: a grouped follow-up carries the marker after its hidden meta', () => {
  withFakeRoom((box, mkRow) => {
    const { row, meta } = mkRow('m9', true);
    envoyWorkspace.noteSpeaking({ seat: 'gemini', engine: 'backup', ref: 'm9' });
    const icons = box.querySelectorAll('.ew-speaking');
    assert.equal(icons.length, 1);
    assert.notEqual(icons[0].parentNode, meta, 'not buried in the hidden meta');
    assert.equal(icons[0].parentNode, meta.parentNode, 'it stands in the message body column, beside the text');
    assert.equal(row.querySelectorAll('.ew-speaking').length, 1, 'and inside the spoken message’s row');
    envoyWorkspace.noteSpeaking(null);
  });
});

test('speaking proof: wiring — the speak call carries the message id, renders consult the signal, the style exists', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../app/envoy.css', import.meta.url), 'utf8');
  assert.ok(js.includes('ws.ctx.voiceSpeak(m.body, who.provider ?? null, m.id)'), 'speakNewMessages passes the message id as the speaking ref');
  assert.ok(js.includes('export function noteSpeaking(info)'), 'envoy exports the controller signal sink');
  assert.ok(js.includes('speakingNow.ref === m.id'), 'renderMessages draws the icon from the standing signal (poll rebuilds keep it)');
  assert.ok(js.includes("'data-speaking': 'true'"), 'the marker carries data-speaking="true" for checkers');
  assert.ok(css.includes('.ew-speaking {'), 'the lit style exists');
  assert.ok(css.includes('@media (prefers-reduced-motion: reduce) { .ew-speaking { animation:none; } }'), 'reduced motion stills the pulse');
});

// ---- Slash-skills bite S3: the "/" menu's Helmian skills group, the
// ---- scope step, composer chips, message-row chips and the authoring
// ---- editor, wired in the channel workspace. The pure behaviour is
// ---- proven in app-slash-menu / app-composer-picker /
// ---- app-skill-editor; these needles pin the workspace wiring.

test('slash-skills S3: the workspace wires the skills group, scope step, chips and editor', async () => {
  const jsRaw = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  // Import specifiers carry the shell stamp (?v=…, 2026-11-09 speed
  // fix); the needles below name the bare specifiers, so strip the
  // stamps before the includes checks — the wiring is what is pinned.
  const js = jsRaw.replace(/\?v=[0-9a-f]{16}/g, '');
  const css = await readFile(new URL('../app/envoy.css', import.meta.url), 'utf8');
  for (const needle of [
    "from './skill-editor.mjs'",
    "from './slash-menu.mjs'",
    'slashPickList',
    'slashSkillScopeModel',
    "ws.ctx.api('/api/admin/skills')",
    'function loadSkills()',
    'function invalidateSkills()',
    'function channelSkillSeats()',
    'function skillSeatLabel(',
    'function slashView(',
    'function armSlashSkill(',
    'function openSkillEditor(',
    'function renderSlashScopeStep(',
    "class: 'ew-chip helmian-skill'",
    'ws.skillAttach.channel = [];',
    "method: 'PUT'",
    "method: 'DELETE'",
    "ws.ctx.post('/api/admin/skills', payload)",
    'ew-msg-skills',
    'skill-ref',
  ]) {
    assert.ok(js.includes(needle), `envoy-workspace.js has ${needle}`);
  }
  assert.match(js, /seatForProvider\(provider\)/, 'channel seats map room providers to library seat ids for metadata.skills');
  assert.ok(!js.includes("registerCommand('skill'") && !js.includes("name: 'skill'"), 'no fake skill command is registered anywhere');
  assert.ok(css.includes('.ew-msg-skills {'), 'the message-row skill chip row has its style');
  assert.ok(css.includes('.ew-chip.skill-ref {'), 'the display-only skill chip has its style');
  // No new scrollable surface: the scope step renders inside the
  // existing #ew-slash-menu element, which carries .ew-picker.
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  assert.match(html, /class="ew-picker ew-slash-menu" id="ew-slash-menu"/, 'the skills group and scope step live in the one existing menu element');
});

// ---------- the first-run hand-off card (polish P1, 2026-11-09) ----------
// After "Turn on Maestro", the empty workspace points at the one
// next step: connect an AI. The card model is present exactly while
// no provider is connected and its button target is the Agents tab.
test('first-run hand-off: card present with zero seats, absent after one connects', async () => {
  const { firstRunHandoff } = await import('../app/envoy-workspace.js');
  const zeroSeats = { state: 'asleep', reason: 'no-provider', connectedProviders: [], hasRunner: false, gated: true, line: 'x' };
  const card = firstRunHandoff(zeroSeats);
  assert.ok(card, 'a fresh workspace with no AI connected shows the card');
  assert.equal(card.label, 'Connect your first AI');
  assert.equal(firstRunHandoff({ ...zeroSeats, connectedProviders: ['claude'] }), null, 'gone the moment the first seat connects');
  assert.equal(firstRunHandoff({ state: 'asleep', reason: 'no-runner', connectedProviders: ['claude'], hasRunner: false, gated: true }), null, 'PC-asleep is the banner’s case, not the card’s');
  assert.equal(firstRunHandoff({ state: 'awake', connectedProviders: ['claude'], hasRunner: true }), null);
  assert.equal(firstRunHandoff(null), null, 'no state read yet — nothing shown on a guess');
  assert.equal(firstRunHandoff({}), null);
});

test('first-run hand-off: the card target is the Agents tab of Integrations', async () => {
  const { firstRunHandoff } = await import('../app/envoy-workspace.js');
  const card = firstRunHandoff({ state: 'asleep', connectedProviders: [] });
  assert.equal(card.view, 'integrations');
  assert.equal(card.tab, 'agents');
});

test('first-run hand-off: the shell carries the card element and the Agents-tab road', async () => {
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="ew-first-run"/, 'the chat pane carries the first-run card element beside the agent-state banner');
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  assert.match(js, /renderFirstRunCard\(\)/, 'the workspace renders the card from the agent-state load');
  const appJs = await readFile(new URL('../app/app.js', import.meta.url), 'utf8');
  assert.match(appJs, /function openAgentsTab\(\) \{ selectIntegrationsTab\('agents'\)/, 'the shell road selects the Agents tab before opening Integrations');
  assert.match(appJs, /openAgentsTab,/, 'the road is handed to the workspace through its context');
});
