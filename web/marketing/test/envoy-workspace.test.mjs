import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { AGENT_WORK_WINDOW_MS, CALM_POLL_MS, FAST_POLL_MS, agentRoomFor, agentRoomThread, dragLayout, pendingAgentWork } from '../app/envoy-workspace.js';

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

test('an unmentioned human message is pending for Maestro only', () => {
  const msgs = [human('m1', 'hello')];
  assert.deepEqual(pendingAgentWork(msgs, ROSTER, JOINED, ONLINE, NOW), ['maestro']);
});

test('a mention routes the pending work to the named agent', () => {
  const msgs = [human('m1', '@Gemini yo')];
  assert.deepEqual(pendingAgentWork(msgs, ROSTER, JOINED, ONLINE, NOW), ['gemini']);
});

test('@all makes the work pending for the whole roster, in roster order', () => {
  const msgs = [human('m1', '@all hands on deck')];
  assert.deepEqual(pendingAgentWork(msgs, ROSTER, JOINED, ONLINE, NOW), ['maestro', 'gemini']);
});

test('the work clears when the reply posts', () => {
  const msgs = [human('m1', 'hello'), reply('m2', 'm1', 'maestro')];
  assert.deepEqual(pendingAgentWork(msgs, ROSTER, JOINED, ONLINE, NOW), []);
});

test('a second unanswered ask keeps the agent pending after the first is answered', () => {
  const msgs = [human('m1', 'one', 120_000), reply('m2', 'm1', 'maestro', 90_000), human('m3', 'two', 60_000)];
  assert.deepEqual(pendingAgentWork(msgs, ROSTER, JOINED, ONLINE, NOW), ['maestro']);
});

test('work expires at the server work window, not before', () => {
  const justInside = [human('m1', 'hello', AGENT_WORK_WINDOW_MS - 1_000)];
  assert.deepEqual(pendingAgentWork(justInside, ROSTER, JOINED, ONLINE, NOW), ['maestro']);
  const justOutside = [human('m1', 'hello', AGENT_WORK_WINDOW_MS + 1_000)];
  assert.deepEqual(pendingAgentWork(justOutside, ROSTER, JOINED, ONLINE, NOW), []);
});

test('messages from before an agent joined are not its work', () => {
  const msgs = [human('m1', '@Gemini hello', 120_000)];
  const joined = { maestro: iso(3_600_000), gemini: iso(60_000) };
  assert.deepEqual(pendingAgentWork(msgs, ROSTER, joined, ONLINE, NOW), []);
});

test('offline agents are never reported as answering', () => {
  const msgs = [human('m1', 'hello')];
  assert.deepEqual(pendingAgentWork(msgs, ROSTER, JOINED, new Set(), NOW), []);
  assert.deepEqual(pendingAgentWork([human('m2', '@Gemini yo')], ROSTER, JOINED, new Set(['maestro']), NOW), []);
});

test('Maestro dispatch makes named agents pending, one hop only', () => {
  const dispatch = { id: 'm1', authorKind: 'agent', authorSubject: 'agent:maestro', body: '@Gemini: take the summary slice', createdAt: iso(60_000) };
  assert.deepEqual(pendingAgentWork([dispatch], ROSTER, JOINED, ONLINE, NOW), ['gemini']);
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
