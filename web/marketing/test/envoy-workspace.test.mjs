import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { AGENT_WORK_WINDOW_MS, CALM_POLL_MS, FAST_POLL_MS, MAESTRO_DESK_SLUG, addressed, agentRoomFor, agentRoomThread, deskChannelFor, deskPending, deskRoster, deskTargets, dragLayout, isDeskChannel, pendingAgentWork, roomAddressed } from '../app/envoy-workspace.js';

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

// pendingAgentWork mirrors the server's agentWork() rules
// (src/cloud/envoy-mesh.mjs): a routed message is pending for a provider
// until its reply:<id> lands, it ages out of the 30-minute work window,
// or it predates the provider joining the channel. Only online providers
// are reported — an offline agent is not "answering".

const NOW = Date.parse('2026-10-22T18:00:00.000Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const human = (id, body, msAgo = 60_000) => ({ id, authorKind: 'human', authorSubject: 'user:troy', body, createdAt: iso(msAgo) });
const reply = (id, toId, provider, msAgo = 30_000) => ({ id, authorKind: 'agent', authorSubject: `agent:${provider}`, body: 'On it.', createdAt: iso(msAgo), idempotencyKey: `reply:${toId}` });
const ROSTER = ['maestro', 'gemini'];
const JOINED = { maestro: iso(3_600_000), gemini: iso(3_600_000) };
const ONLINE = new Set(['maestro', 'gemini']);

test('an unmentioned human message is pending for nobody (Bite 2: unnamed = silence)', () => {
  const msgs = [human('m1', 'hello')];
  assert.deepEqual(pendingAgentWork(msgs, ROSTER, JOINED, ONLINE, NOW), []);
  assert.deepEqual(addressed(human('m1', 'hello'), ROSTER), []);
  // Naming Maestro names the human's own seat: still nobody.
  assert.deepEqual(addressed(human('m1', '@Maestro look'), ROSTER), []);
});

test('a mention routes the pending work to the named agent', () => {
  const msgs = [human('m1', '@Gemini yo')];
  assert.deepEqual(pendingAgentWork(msgs, ROSTER, JOINED, ONLINE, NOW), ['gemini']);
});

test('@all makes the work pending for every agent — never for Maestro', () => {
  const msgs = [human('m1', '@all hands on deck')];
  assert.deepEqual(pendingAgentWork(msgs, ROSTER, JOINED, ONLINE, NOW), ['gemini']);
});

test('the work clears when the reply posts', () => {
  const msgs = [human('m1', '@Gemini hello'), reply('m2', 'm1', 'gemini')];
  assert.deepEqual(pendingAgentWork(msgs, ROSTER, JOINED, ONLINE, NOW), []);
});

test('a second unanswered ask keeps the agent pending after the first is answered', () => {
  const msgs = [human('m1', '@Gemini one', 120_000), reply('m2', 'm1', 'gemini', 90_000), human('m3', '@Gemini two', 60_000)];
  assert.deepEqual(pendingAgentWork(msgs, ROSTER, JOINED, ONLINE, NOW), ['gemini']);
});

test('work expires at the server work window, not before', () => {
  const justInside = [human('m1', '@Gemini hello', AGENT_WORK_WINDOW_MS - 1_000)];
  assert.deepEqual(pendingAgentWork(justInside, ROSTER, JOINED, ONLINE, NOW), ['gemini']);
  const justOutside = [human('m1', '@Gemini hello', AGENT_WORK_WINDOW_MS + 1_000)];
  assert.deepEqual(pendingAgentWork(justOutside, ROSTER, JOINED, ONLINE, NOW), []);
});

test('in a private room the unnamed prompt IS the room agent\'s work (the room is the address)', () => {
  const msgs = [human('m1', 'just us here')];
  assert.deepEqual(pendingAgentWork(msgs, ['gemini'], { gemini: iso(3_600_000) }, new Set(['gemini']), NOW, roomAddressed), ['gemini']);
  assert.deepEqual(roomAddressed(human('m1', '@Claude wrong room'), ['gemini']), []);
  assert.deepEqual(roomAddressed(human('m1', 'hello'), ['maestro']), [], 'a maestro room seats nobody');
});

test('messages from before an agent joined are not its work', () => {
  const msgs = [human('m1', '@Gemini hello', 120_000)];
  const joined = { maestro: iso(3_600_000), gemini: iso(60_000) };
  assert.deepEqual(pendingAgentWork(msgs, ROSTER, joined, ONLINE, NOW), []);
});

test('offline agents are never reported as answering', () => {
  const msgs = [human('m1', '@Gemini hello')];
  assert.deepEqual(pendingAgentWork(msgs, ROSTER, JOINED, new Set(), NOW), []);
  assert.deepEqual(pendingAgentWork([human('m2', '@Gemini yo')], ROSTER, JOINED, new Set(['maestro']), NOW), []);
});

test('agent-authored messages make nobody pending — there is no dispatch hop', () => {
  // The old shape: a message authored "by Maestro" dispatched the named
  // workers in the client's mirror too. Gone (Bite 2).
  const dispatch = { id: 'm1', authorKind: 'agent', authorSubject: 'agent:maestro', body: '@Gemini: take the summary slice', createdAt: iso(60_000) };
  assert.deepEqual(pendingAgentWork([dispatch], ROSTER, JOINED, ONLINE, NOW), []);
  const workerNote = { id: 'm2', authorKind: 'agent', authorSubject: 'agent:gemini', body: '@Maestro done', createdAt: iso(60_000) };
  assert.deepEqual(pendingAgentWork([workerNote], ROSTER, JOINED, ONLINE, NOW), []);
});

test('no roster, no work', () => {
  assert.deepEqual(pendingAgentWork([human('m1', 'hello')], [], {}, ONLINE, NOW), []);
});

test('poll cadence: fast while work is pending, calm otherwise', () => {
  assert.equal(FAST_POLL_MS, 800);
  assert.equal(CALM_POLL_MS, 2500);
  assert.equal(AGENT_WORK_WINDOW_MS, 30 * 60_000);
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

test('agent-first increment 1: the pane has a conversation region and the workspace renders into it', async () => {
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../app/envoy.css', import.meta.url), 'utf8');
  const sessions = html.indexOf('id="ew-cli-sessions"');
  const thread = html.indexOf('id="ew-cli-thread"');
  const form = html.indexOf('id="ew-cli-form"');
  assert.ok(sessions !== -1 && thread > sessions && thread < form, 'the conversation region sits between the sessions and the composer, inside the Agent Chat pane');
  assert.ok(js.includes('function renderCliThread'), 'envoy-workspace.js renders the pane conversation');
  assert.ok((js.match(/renderCliThread\(\)/g) ?? []).length >= 4, 'the conversation re-renders on message loads and target changes');
  assert.match(css, /\.ew-cli-thread \{/, 'envoy.css styles the conversation region');
});

// Layout bite 1 (Troy's ruling, 2026-10-23): the agent CLI is its own
// center pane between the human chat and the agents roster; the channels
// pane creates plain channels (no agent select), and "+ New session"
// lives in the CLI pane.
test('desktop layout: agent CLI pane sits between chat and agents; channels are plain', async () => {
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  const chat = html.indexOf('id="ew-chat"');
  const cli = html.indexOf('id="ew-cli"');
  const agents = html.indexOf('id="ew-agents"');
  assert.ok(chat !== -1 && cli !== -1 && agents !== -1, 'chat, CLI and agents panes all exist');
  assert.ok(chat < cli && cli < agents, 'CLI pane is between the chat and the agents roster');
  assert.match(html, /data-pane="cli"/);
  assert.match(html, /data-toggle="cli"/);
  assert.match(html, /data-split="cli"/);
  for (const id of ['ew-cli-chips', 'ew-cli-new', 'ew-cli-session-form', 'ew-cli-session-name', 'ew-cli-sessions', 'ew-cli-form', 'ew-cli-input', 'ew-cli-dictate', 'ew-cli-voice', 'ew-cli-send']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /id="ew-cli-new"[^>]*>\+ New session</);
  assert.match(html, /id="ew-add-channel"[^>]*>\+ New channel</);
  assert.doesNotMatch(html, /ew-new-channel-agent/);
});

// Sliders fix (Troy's live report, 2026-10-23): every pane must drag in
// both directions to a slim minimum, collapse must have a reveal path, and
// the nav rail must collapse/peek from the rail itself.
test('pane sliders: every pane has a split, a collapse control and a way back', async () => {
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  for (const name of ['channels', 'cli', 'agents', 'guard', 'bench']) {
    assert.match(html, new RegExp(`id="ew-${name}"`), name);
    assert.match(html, new RegExp(`data-split="${name}"`), name);
    assert.match(html, new RegExp(`data-collapse="${name}"`), name);
  }
  for (const name of ['cli', 'agents', 'guard', 'bench']) {
    assert.match(html, new RegExp(`data-toggle="${name}"`), name);
  }
  assert.match(html, /data-open="channels"/);
});

test('splitter drag: pointer capture with cancel handling, per-pane floors, slide-to-collapse', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  assert.match(js, /setPointerCapture/);
  assert.match(js, /pointercancel/);
  assert.match(js, /PANE_MIN = \{ channels: 132, cli: 150, agents: 150, guard: 150, bench: 200 \}/);
  assert.match(js, /will-collapse/);
  const css = await readFile(new URL('../app/envoy.css', import.meta.url), 'utf8');
  assert.match(css, /\.ew\.dragging \.ew-pane \{ transition:none; flex-shrink:0; \}/);
  assert.match(css, /\.ew-pane\.will-collapse/);
  // CSS floors match the JS PANE_MIN table (a mismatch = dead drag travel).
  for (const [pane, min] of Object.entries({ channels: 132, cli: 150, agents: 150, guard: 150, bench: 200 })) {
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
  assert.match(maestro[1], /Add/, 'maestro composer button is labelled Add');
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
  const lay = fullRow('channels', 300); // +100: bench (farthest) yields to its floor, guard yields the rest
  assert.equal(lay.width, 300);
  assert.deepEqual(lay.widths, { channels: 300, cli: 220, agents: 200, guard: 180, bench: 200 });
  const fromRight = fullRow('bench', 480); // +200 from the right edge yields channels first
  assert.equal(fromRight.width, 480);
  assert.deepEqual(fromRight.widths, { channels: 132, cli: 150, agents: 150, guard: 188, bench: 480 });
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
// (src/cloud/envoy-agents.mjs agentsToAnswer with desk:true) — and
// deskPending mirrors pendingAgentWork over those targets.
const DESK_TEAM = ['claude', 'openai', 'grok', 'gemini'];
const DESK_JOINED = Object.fromEntries(DESK_TEAM.map((p) => [p, iso(3_600_000)]));
const DESK_ONLINE = new Set(DESK_TEAM);

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

test('desk pending: an unnamed dispatch is pending for the whole online desk', () => {
  const msgs = [human('m1', 'status, everyone')];
  assert.deepEqual(deskPending(msgs, DESK_TEAM, DESK_JOINED, DESK_ONLINE, NOW), DESK_TEAM);
  // The contrast that defines the desk: the same message under ordinary
  // routing is pending for nobody at all (Bite 2: unnamed = silence).
  assert.deepEqual(pendingAgentWork(msgs, ['maestro', ...DESK_TEAM], { maestro: iso(3_600_000), ...DESK_JOINED }, new Set(['maestro', ...DESK_TEAM]), NOW), []);
});

test('desk pending: a named dispatch is pending for the named agent; its reply clears only its share', () => {
  const msgs = [human('m1', 'status, everyone'), human('m2', '@Claude the numbers'), reply('m3', 'm2', 'claude')];
  assert.deepEqual(deskPending(msgs, DESK_TEAM, DESK_JOINED, DESK_ONLINE, NOW), DESK_TEAM, 'the unnamed dispatch still waits on everyone, Claude included');
  const afterAll = [...msgs, reply('m4', 'm1', 'claude'), reply('m5', 'm1', 'openai'), reply('m6', 'm1', 'grok'), reply('m7', 'm1', 'gemini')];
  assert.deepEqual(deskPending(afterAll, DESK_TEAM, DESK_JOINED, DESK_ONLINE, NOW), []);
});

test('desk pending: offline agents and expired work are not pending', () => {
  const msgs = [human('m1', 'status, everyone')];
  assert.deepEqual(deskPending(msgs, DESK_TEAM, DESK_JOINED, new Set(['claude']), NOW), ['claude']);
  const old = [human('m1', 'status, everyone', AGENT_WORK_WINDOW_MS + 1_000)];
  assert.deepEqual(deskPending(old, DESK_TEAM, DESK_JOINED, DESK_ONLINE, NOW), []);
});

test('the seat on screen: banner over the thread, desk panel, and the mode hooks', async () => {
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../app/envoy.css', import.meta.url), 'utf8');
  const head = html.indexOf('ew-chat-head');
  const banner = html.indexOf('id="ew-maestro-banner"');
  const msgs = html.indexOf('id="ew-messages"');
  assert.ok(head !== -1 && banner > head && banner < msgs, 'the manager-mode banner sits between the chat head and the thread');
  assert.match(html, /id="ew-maestro-banner"[^>]*hidden/, 'the banner starts hidden — it shows only in the seat');
  assert.match(html, /You are Maestro — manager mode/, 'the banner names the mode in plain words');
  assert.match(html, /id="ew-maestro-exit"[^>]*>Leave the seat</, 'the banner carries the way out of the seat');
  for (const id of ['ew-desk', 'ew-desk-handoffs', 'ew-desk-checkpoints', 'ew-desk-note']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  const agentsPane = html.indexOf('id="ew-agents"');
  const deskPanel = html.indexOf('id="ew-desk"');
  assert.ok(deskPanel > agentsPane, 'the desk panel lives in the Agents pane');
  for (const needle of ['function renderMaestroMode', 'function enterMaestroSeat', 'function leaveMaestroSeat', 'function loadDeskLists', "post('/api/admin/envoy/maestro-desk'", "'/api/admin/maestro/handoffs'", "'/api/admin/maestro/checkpoints'", 'inMaestroMode()', 'Dispatched to']) {
    assert.ok(js.includes(needle), `envoy-workspace.js has ${needle}`);
  }
  assert.match(css, /\.ew-maestro-banner \{/, 'envoy.css styles the banner');
  assert.match(css, /#ew-chat\.maestro-mode \{/, 'envoy.css frames the chat pane in manager mode');
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
  assert.ok(render.includes('enterMaestroSeat'), 'the no-desk-channel branch builds the enter-the-seat row');
  assert.ok(render.includes('Your manager seat'), 'the desk-exists branch builds the desk row — both branches render a seat');
});

test('app shell cache: vercel.json forces revalidation for /app assets so a deploy is never hidden behind a 4-hour CDN default', async () => {
  const raw = await readFile(new URL('../vercel.json', import.meta.url), 'utf8');
  const config = JSON.parse(raw);
  const appRule = (config.headers ?? []).find((entry) =>
    typeof entry.source === 'string' && entry.source.includes('/app/')
    && (entry.headers ?? []).some((header) => header.key.toLowerCase() === 'cache-control'));
  assert.ok(appRule, 'vercel.json carries a Cache-Control rule scoped to /app/');
  const value = appRule.headers.find((header) => header.key.toLowerCase() === 'cache-control').value;
  assert.ok(/max-age=0|no-cache|no-store/.test(value), `the /app Cache-Control forces revalidation (got: ${value})`);
});

test('tenant onboarding: the asleep banner helper + element + state fetch are wired', async () => {
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
