import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

// Optimization bite 4 (2026-11-12): kill the staged load. The
// live measurement in Troy's workspace showed fresh loads in
// three stages — shell and nav, then the channel list with the
// crew rail and the message list sitting at their empty static
// markup, then the faces and the messages together, last. The
// mechanism was sequencing: mountWorkspace awaited loadChannels
// ALONE, and the batch carrying the room (channel-config for the
// crew, messages for the list) started only when that fetch
// landed. STRUCTURAL guard in this suite's source-assertion
// idiom: it pins the boot's new shape — the remembered channel's
// loads fired WITH the channels fetch, the loading look painted
// before them, loadChannels keeping the last word, and the crew
// never derived from another channel's config. The behavioral
// claim (no empty intermediate stage; crew and messages in the
// first full paint) rests on the Playwright harness recorded in
// the bite report — mountWorkspace's boot is not driven here.
const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
const bootAt = js.indexOf('// ---------- boot: the first paint carries the room');
const mountAt = js.indexOf('export async function mountWorkspace', bootAt);
assert.ok(bootAt !== -1 && mountAt > bootAt, 'the bite-4 boot section is located');
const boot = js.slice(bootAt, js.indexOf('void preloadLibrarySession()', mountAt));
const mount = js.slice(mountAt, js.indexOf('void preloadLibrarySession()', mountAt));
const agentsAt = js.indexOf('function renderAgents()');
const agentsFn = js.slice(agentsAt, js.indexOf('\nasync function changeAgent', agentsAt));
const configAt = js.indexOf('async function loadConfig()');
const configFn = js.slice(configAt, js.indexOf('// The standing set', configAt));

test('boot: the room loads fire with the channels fetch, not after it', () => {
  const fire = mount.indexOf('bootLoads = roomLoads()');
  const channels = mount.indexOf('await loadChannels()');
  assert.ok(fire !== -1 && channels !== -1 && fire < channels,
    'the remembered channel\'s loads start before the channels read is awaited');
  assert.ok(mount.includes('if (bootId) { ws.channelId = bootId; bootLoads = roomLoads(); }'),
    'the boot loads fire for the remembered channel id');
  assert.ok(mount.indexOf('paintBootLoading()') !== -1 && mount.indexOf('paintBootLoading()') < fire,
    'the loading look is painted before the first boot fetch fires');
  for (const loader of ['loadPresence()', 'loadAgentState()', 'loadConfig()', 'loadMessages()', 'loadFaces()', 'loadProfile()']) {
    assert.ok(mount.includes(loader), `the boot batch still carries ${loader} — the batch itself did not change, only its start`);
  }
});

test('boot: the remembered channel comes from the stored ids only, never the URL param', () => {
  const fn = boot.slice(boot.indexOf('function bootChannelId()'), boot.indexOf('function paintBootLoading'));
  assert.ok(fn.includes("new URLSearchParams(location.search).get('channel')) return null"),
    'a URL channel param stands the early fire down — it can name a slug only the list can resolve');
  assert.ok(fn.includes('ls.get(`netChannel.${ws.mode}`, null)'), 'the per-mode stored channel is the first source');
  assert.ok(fn.includes("ls.get('channel', null)"), 'the legacy stored channel is the Envoy fallback');
});

test('boot: loadChannels keeps the last word — a stood-down channel is reset and reloaded', () => {
  assert.ok(mount.includes('if (bootLoads && ws.channelId === bootId)'),
    'the early loads are awaited only when the settled channel is the one they fired for');
  assert.ok(mount.includes('ws.sig = null; ws.messages = [];'), 'a correction clears the stood-down channel\'s messages');
  assert.ok(mount.includes('paintBootLoading(true);'), 'a correction restores the loading look before the settled batch');
  assert.ok(mount.includes('await roomLoads();'), 'the batch runs for the settled channel');
  assert.ok(mount.includes("if (!ws.messages.length) $('ew-messages')"),
    'a failed channels read paints its reconnecting note only when no room has loaded');
});

test('boot: the loading look is the switch\'s own card and never clobbers a standing room', () => {
  const fn = boot.slice(boot.indexOf('function paintBootLoading'), mountAt);
  assert.ok(fn.includes("h('div', { class: 'ew-empty' }, 'Loading…')"),
    'the message list gets the same Loading… card selectChannel paints');
  assert.ok(fn.includes("h('p', { class: 'ew-note' }, 'Loading…')"), 'the crew rail gets its loading note');
  assert.ok(fn.includes('!box.childNodes.length') && fn.includes('!list.childNodes.length'),
    'an area already holding content (a remount) is left alone');
});

test('crew truth: a config is tagged with its channel, and renderAgents paints only its own', () => {
  assert.ok(configFn.includes('ws.config = body.config ?? { agents: [] }; ws.configChannelId = id;'),
    'a landed config records the channel it belongs to');
  assert.ok(configFn.includes('ws.configChannelId = id; ws.configured = false;'),
    'the failure fallback records its channel too');
  assert.ok(agentsFn.includes('if (!ws.config || ws.configChannelId !== ws.channelId) return;'),
    'the rail is never derived from no config or another channel\'s — the fabricated empty roster is gone');
});
