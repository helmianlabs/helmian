import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { applyChannelLinks, discordFooterStatus, githubFooterStatus, githubLinkHeader, mirrorLinkHeader, slackFooterStatus } from '../app/envoy-workspace.js';

// Footer truth (2026-11-08, parts 1 + 2): the channels-column footer
// ("Helmian Envoy / Discord: … / Slack: … / GitHub: …") is a workspace
// summary, but all three lines were fed from the OPEN channel's config
// alone. All three links are per-channel pairs, so a line read true
// only while the open channel happened to hold that pair — open a
// different room and it printed "ready to link" for a linked
// workspace (owner screenshot, 2026-11-08 ~17:02 MST; part 1 fixed
// Discord, part 2 fixed Slack + GitHub by the same mechanism). All
// three lines now derive from the per-channel link data the channels
// API carries — fixtures below mirror what applyChannelLinks
// produces (a `_discord` / `_slack` / `_github` flag per channel,
// plus the link object itself when the server sent one).
//
// This suite SUPERSEDES the discord-footer-bite copy of this file:
// the Discord tests are carried over unchanged; the two tests that
// pinned the old per-open-channel Slack/GitHub behaviour are
// replaced by the part-2 matrix below.

const BOT = { configured: true, inviteUrl: null };
const NO_BOT = { configured: false, inviteUrl: null };

// Channels as the channels API + applyChannelLinks leave them: #Team
// carries the workspace's Slack + GitHub pairs but no Discord pair;
// the "troy" agent room carries the Discord pair.
const TEAM = { id: 'c-team', slug: 'team', title: 'Team', kind: 'team', _discord: false, _slack: true, slack: { channelId: 'C1', channelName: 'all-helmian' }, _github: true, github: { repo: 'helmianlabs/helmian' } };
const TROY_ROOM = { id: 'c-troy', slug: 'troy', title: 'troy', kind: 'agent', _discord: true, discord: { channelId: 'd-991', channelName: 'troy-dm' }, _slack: false, _github: false };

// ---------- applyChannelLinks: the flags all three lines read ----------

test('applyChannelLinks: github flag derives from the payload repo, cache only fills an absent field', () => {
  const [a] = applyChannelLinks([{ id: 'x', discord: null, slack: null, github: { repo: 'a/b' } }], {});
  assert.equal(a._github, true);
  const [b] = applyChannelLinks([{ id: 'x', discord: null, slack: null, github: null }], {});
  assert.equal(b._github, false);
  const [c] = applyChannelLinks([{ id: 'x', discord: null, slack: null, github: { events: ['push'] } }], {});
  assert.equal(c._github, false, 'a github object without a repo is not a link');
  const [d] = applyChannelLinks([{ id: 'x', discord: null, slack: null }], { x: { g: true } });
  assert.equal(d._github, true, 'older server: the chanMeta cache stands in');
  const [e] = applyChannelLinks([{ id: 'x', discord: null, slack: null }], {});
  assert.equal(e._github, false);
  // The Discord/Slack flags keep their existing behaviour.
  const [f] = applyChannelLinks([{ id: 'x', discord: { channelId: 'd1' }, slack: { channelId: 'C1' }, github: null }], {});
  assert.equal(f._discord, true);
  assert.equal(f._slack, true);
});

// ---------- Discord (part 1, carried over) ----------

test('footer Discord: no linked channel anywhere reads "ready to link"', () => {
  assert.equal(discordFooterStatus({ channels: [TEAM], bot: BOT }), 'ready to link');
  assert.equal(discordFooterStatus({ channels: [], bot: BOT }), 'ready to link');
});

test('footer Discord: the screenshot case — pair on another room, open channel unlinked', () => {
  // Open channel is #Team (no Discord pair in its config); the footer
  // must still tell the truth about the workspace.
  const text = discordFooterStatus({ channels: [TEAM, TROY_ROOM], bot: BOT, openChannelId: 'c-team', openLink: null });
  assert.equal(text, 'linked to #troy-dm');
});

test('footer Discord: one linked channel names it by channel id when the name is missing', () => {
  const room = { id: 'c-a', title: 'ops', kind: 'agent', _discord: true, discord: { channelId: 'd-123', channelName: '' } };
  assert.equal(discordFooterStatus({ channels: [room], bot: BOT }), 'linked to #d-123');
});

test('footer Discord: the open channel\'s own freshly-loaded config supplies the name for its link', () => {
  // Just-linked flow: the channel list flags the open channel linked
  // (loadConfig refreshed _discord) but carries no link object yet;
  // the open channel's config link names it.
  const open = { id: 'c-team', slug: 'team', title: 'Team', kind: 'team', _discord: true };
  const text = discordFooterStatus({ channels: [open], bot: BOT, openChannelId: 'c-team', openLink: { channelId: 'd-5', channelName: 'general' } });
  assert.equal(text, 'linked to #general');
  // The same hint must NOT name another channel's link: with the open
  // channel elsewhere, the flagged-but-nameless first link falls back
  // to its own Envoy title instead of borrowing the hint's name.
  const other = discordFooterStatus({ channels: [open, TROY_ROOM], bot: BOT, openChannelId: 'c-nope', openLink: { channelId: 'd-5', channelName: 'general' } });
  assert.equal(other, 'linked to #Team + 1 more');
});

test('footer Discord: several linked channels read as a truthful plural', () => {
  const a = { id: 'c-a', title: 'a', _discord: true, discord: { channelId: 'd-1', channelName: 'alpha' } };
  const b = { id: 'c-b', title: 'b', _discord: true, discord: { channelId: 'd-2', channelName: 'beta' } };
  const c = { id: 'c-c', title: 'c', _discord: true, discord: { channelId: 'd-3', channelName: 'gamma' } };
  assert.equal(discordFooterStatus({ channels: [a, b], bot: BOT }), 'linked to #alpha + 1 more');
  assert.equal(discordFooterStatus({ channels: [a, b, c], bot: BOT }), 'linked to #alpha + 2 more');
});

test('footer Discord: bot not set up yet wins, as the old line behaved', () => {
  assert.equal(discordFooterStatus({ channels: [TROY_ROOM], bot: NO_BOT }), 'bot not set up yet');
  assert.equal(discordFooterStatus({ channels: [TROY_ROOM], bot: null }), 'bot not set up yet');
});

// ---------- Slack (part 2) ----------

test('footer Slack: no linked channel anywhere reads "ready to link"', () => {
  assert.equal(slackFooterStatus({ channels: [TROY_ROOM], bot: BOT }), 'ready to link');
  assert.equal(slackFooterStatus({ channels: [], bot: BOT }), 'ready to link');
});

test('footer Slack: one linked channel on the open channel names it', () => {
  const text = slackFooterStatus({ channels: [TEAM, TROY_ROOM], bot: BOT, openChannelId: 'c-team', openLink: TEAM.slack });
  assert.equal(text, 'linked to #all-helmian');
});

test('footer Slack: the flip case — pair on #Team, the "troy" room open', () => {
  // The open channel (troy) holds no Slack pair in its config; the
  // old line read that config and printed "ready to link".
  const text = slackFooterStatus({ channels: [TEAM, TROY_ROOM], bot: BOT, openChannelId: 'c-troy', openLink: null });
  assert.equal(text, 'linked to #all-helmian');
});

test('footer Slack: one linked channel names it by channel id when the name is missing', () => {
  const room = { id: 'c-a', title: 'ops', kind: 'team', _slack: true, slack: { channelId: 'C9', channelName: '' } };
  assert.equal(slackFooterStatus({ channels: [room], bot: BOT }), 'linked to #C9');
});

test('footer Slack: the open channel\'s own freshly-loaded config supplies the name for its link', () => {
  const open = { id: 'c-team', slug: 'team', title: 'Team', kind: 'team', _slack: true };
  const text = slackFooterStatus({ channels: [open], bot: BOT, openChannelId: 'c-team', openLink: { channelId: 'C5', channelName: 'general' } });
  assert.equal(text, 'linked to #general');
  // The hint never names another channel's link.
  const ops = { id: 'c-b', title: 'ops', _slack: true, slack: { channelId: 'C2', channelName: 'ops' } };
  const other = slackFooterStatus({ channels: [open, ops], bot: BOT, openChannelId: 'c-nope', openLink: { channelId: 'C5', channelName: 'general' } });
  assert.equal(other, 'linked to #Team + 1 more');
});

test('footer Slack: several linked channels read as a truthful plural', () => {
  const b = { id: 'c-b', title: 'b', _slack: true, slack: { channelId: 'C2', channelName: 'ops' } };
  const c = { id: 'c-c', title: 'c', _slack: true, slack: { channelId: 'C3', channelName: 'dev' } };
  assert.equal(slackFooterStatus({ channels: [TEAM, b], bot: BOT }), 'linked to #all-helmian + 1 more');
  assert.equal(slackFooterStatus({ channels: [TEAM, b, c], bot: BOT }), 'linked to #all-helmian + 2 more');
});

test('footer Slack: bot not set up yet wins, as the old line behaved', () => {
  assert.equal(slackFooterStatus({ channels: [TEAM], bot: NO_BOT }), 'bot not set up yet');
  assert.equal(slackFooterStatus({ channels: [TEAM], bot: null }), 'bot not set up yet');
});

// ---------- GitHub (part 2) ----------

test('footer GitHub: no linked channel anywhere reads "ready to link"', () => {
  assert.equal(githubFooterStatus({ channels: [TROY_ROOM] }), 'ready to link');
  assert.equal(githubFooterStatus({ channels: [] }), 'ready to link');
});

test('footer GitHub: one linked channel on the open channel names its repo', () => {
  const text = githubFooterStatus({ channels: [TEAM, TROY_ROOM], openChannelId: 'c-team', openLink: TEAM.github });
  assert.equal(text, 'linked to helmianlabs/helmian');
});

test('footer GitHub: the flip case — pair on #Team, the "troy" room open', () => {
  const text = githubFooterStatus({ channels: [TEAM, TROY_ROOM], openChannelId: 'c-troy', openLink: null });
  assert.equal(text, 'linked to helmianlabs/helmian');
});

test('footer GitHub: the open channel\'s own freshly-loaded config supplies the repo for its link', () => {
  const open = { id: 'c-team', slug: 'team', title: 'Team', kind: 'team', _github: true };
  const text = githubFooterStatus({ channels: [open], openChannelId: 'c-team', openLink: { repo: 'acme/fresh' } });
  assert.equal(text, 'linked to acme/fresh');
  // The hint never names another channel's link: flag-only first
  // link with the open channel elsewhere stays coarse but truthful.
  const other = githubFooterStatus({ channels: [open, TEAM], openChannelId: 'c-nope', openLink: { repo: 'acme/fresh' } });
  assert.equal(other, 'linked to GitHub + 1 more');
});

test('footer GitHub: a link known only by its flag stays truthful but coarse', () => {
  // chanMeta-cache case against an older server: the flag says a
  // link exists, no repo was carried — never invent a repo name.
  const cached = { id: 'c-a', title: 'ops', _github: true };
  assert.equal(githubFooterStatus({ channels: [cached] }), 'linked to GitHub');
});

test('footer GitHub: several linked channels read as first repo plus a count', () => {
  const a = { id: 'c-a', title: 'a', _github: true, github: { repo: 'acme/widgets' } };
  const c = { id: 'c-c', title: 'c', _github: true, github: { repo: 'acme/gadgets' } };
  assert.equal(githubFooterStatus({ channels: [a, TEAM] }), 'linked to acme/widgets + 1 more');
  assert.equal(githubFooterStatus({ channels: [a, TEAM, c] }), 'linked to acme/widgets + 2 more');
});

// ---------- The full flip: all three lines with the "troy" room open ----------

test('footer: all three lines stay truthful from the "troy" room', () => {
  // Open channel = troy: its config holds only the Discord pair.
  const channels = [TEAM, TROY_ROOM];
  assert.equal(discordFooterStatus({ channels, bot: BOT, openChannelId: 'c-troy', openLink: TROY_ROOM.discord }), 'linked to #troy-dm');
  assert.equal(slackFooterStatus({ channels, bot: BOT, openChannelId: 'c-troy', openLink: null }), 'linked to #all-helmian');
  assert.equal(githubFooterStatus({ channels, openChannelId: 'c-troy', openLink: null }), 'linked to helmianlabs/helmian');
  // And from #Team, whose config holds only the Slack + GitHub pairs.
  assert.equal(discordFooterStatus({ channels, bot: BOT, openChannelId: 'c-team', openLink: null }), 'linked to #troy-dm');
  assert.equal(slackFooterStatus({ channels, bot: BOT, openChannelId: 'c-team', openLink: TEAM.slack }), 'linked to #all-helmian');
  assert.equal(githubFooterStatus({ channels, openChannelId: 'c-team', openLink: TEAM.github }), 'linked to helmianlabs/helmian');
});

// ---------- Chat-head models: untouched ----------

test('chat-head header models are unchanged (the badges keep their per-channel derivation)', () => {
  assert.equal(mirrorLinkHeader({ link: { channelId: 'C1', channelName: 'all-helmian' }, bot: BOT, label: 'Slack' }).statusText, 'linked to #all-helmian');
  assert.equal(mirrorLinkHeader({ link: null, bot: BOT, label: 'Slack' }).statusText, 'ready to link');
  assert.equal(githubLinkHeader({ github: { repo: 'helmianlabs/helmian' } }).statusText, 'linked to helmianlabs/helmian');
  assert.equal(githubLinkHeader({ github: null }).statusText, 'ready to link');
});

// ---------- Render wiring ----------

test('render wiring: all three footer lines use the workspace derivations; chat-head badges untouched', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  assert.match(js, /\$\('ew-discord-status-text'\)\.textContent = discordFooterStatus\(\{ channels: ws\.channels/, 'footer Discord line derives from the channel list');
  assert.ok(!js.includes("$('ew-discord-status-text').textContent = dh.statusText"), 'footer Discord line no longer reads the open channel config');
  assert.match(js, /\$\('ew-slack-status-text'\)\.textContent = slackFooterStatus\(\{ channels: ws\.channels/, 'footer Slack line derives from the channel list');
  assert.ok(!js.includes("$('ew-slack-status-text').textContent = sh.statusText"), 'footer Slack line no longer reads the open channel config');
  assert.match(js, /ghStatus\.textContent = githubFooterStatus\(\{ channels: ws\.channels/, 'footer GitHub line derives from the channel list');
  assert.ok(!js.includes('ghStatus.textContent = gh.statusText'), 'footer GitHub line no longer reads the open channel config');
  // The chat-head badges still use the per-channel header models.
  assert.ok(js.includes("mirrorLinkHeader({ link: d, pending: Boolean(ws.config?.pendingLink), bot: ws.discordBot, admin, label: 'Discord' })"), 'chat-head Discord badge derivation unchanged');
  assert.ok(js.includes("mirrorLinkHeader({ link: s, bot: ws.slackBot, admin, label: 'Slack' })"), 'chat-head Slack badge derivation unchanged');
  assert.ok(js.includes('githubLinkHeader({ github: ws.config?.github, admin })'), 'chat-head GitHub badge derivation unchanged');
  // loadConfig keeps the open channel's github flag + cache in step.
  assert.ok(js.includes('ch._github = Boolean(ws.config.github?.repo)'), 'loadConfig refreshes the open channel github flag');
  assert.ok(js.includes('g: ch._github'), 'chanMeta cache carries the github flag');
});
