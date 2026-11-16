// Per-provider bot status (audit bite AT-3, T8 weakness 1; FIX-A3
// rollout precondition 2). bot-status derived each surface's
// "configured" reading from the shared HELMIAN_ENVOY_BRIDGE_TOKEN
// only, so retiring the shared value at the end of the per-provider
// rotation would have left working bridges reading "not configured".
// The reading is now per provider: a provider is configured when its
// own per-provider token is usable, or the shared fallback is — the
// same two candidates, and the same under-32-chars = not-configured
// rule, as the cloud's bridge gate (envoy-mesh bridgeProviderTokenOk).
// One provider's token never configures the other.
import assert from 'node:assert/strict';
import test from 'node:test';
import { discordBotStatus, slackBotStatus } from '../src/cloud/bot-status.mjs';

const CLIENT_ID = '123456789012345678';
const APP_ID = 'A0CBUCYTVNW';
const DISCORD = 'd'.repeat(40);
const SLACK = 's'.repeat(40);
const SHARED = 'h'.repeat(40);
const SHORT = 'x'.repeat(16);

test('discordBotStatus: the four combinations of scoped / shared, set and unset', () => {
  assert.equal(discordBotStatus({ HELMIAN_DISCORD_CLIENT_ID: CLIENT_ID }).configured, false, 'neither set');
  assert.equal(discordBotStatus({ HELMIAN_DISCORD_CLIENT_ID: CLIENT_ID, HELMIAN_ENVOY_BRIDGE_TOKEN: SHARED }).configured, true, 'shared only — the rotation fallback still counts');
  assert.equal(discordBotStatus({ HELMIAN_DISCORD_CLIENT_ID: CLIENT_ID, HELMIAN_ENVOY_BRIDGE_TOKEN_DISCORD: DISCORD }).configured, true, 'scoped only — configured after the shared value is retired');
  assert.equal(discordBotStatus({ HELMIAN_DISCORD_CLIENT_ID: CLIENT_ID, HELMIAN_ENVOY_BRIDGE_TOKEN_DISCORD: DISCORD, HELMIAN_ENVOY_BRIDGE_TOKEN: SHARED }).configured, true, 'both set');
});

test('slackBotStatus: the four combinations of scoped / shared, set and unset', () => {
  assert.equal(slackBotStatus({ HELMION_SLACK_APP_ID: APP_ID }).configured, false, 'neither set');
  assert.equal(slackBotStatus({ HELMION_SLACK_APP_ID: APP_ID, HELMIAN_ENVOY_BRIDGE_TOKEN: SHARED }).configured, true, 'shared only — the rotation fallback still counts');
  assert.equal(slackBotStatus({ HELMION_SLACK_APP_ID: APP_ID, HELMIAN_ENVOY_BRIDGE_TOKEN_SLACK: SLACK }).configured, true, 'scoped only — configured after the shared value is retired');
  assert.equal(slackBotStatus({ HELMION_SLACK_APP_ID: APP_ID, HELMIAN_ENVOY_BRIDGE_TOKEN_SLACK: SLACK, HELMIAN_ENVOY_BRIDGE_TOKEN: SHARED }).configured, true, 'both set');
});

test("one provider's token never configures the other", () => {
  assert.equal(discordBotStatus({ HELMIAN_DISCORD_CLIENT_ID: CLIENT_ID, HELMIAN_ENVOY_BRIDGE_TOKEN_SLACK: SLACK }).configured, false);
  assert.equal(slackBotStatus({ HELMION_SLACK_APP_ID: APP_ID, HELMIAN_ENVOY_BRIDGE_TOKEN_DISCORD: DISCORD }).configured, false);
});

test('a short token configures nothing, on either name — the gate rule', () => {
  assert.equal(discordBotStatus({ HELMIAN_DISCORD_CLIENT_ID: CLIENT_ID, HELMIAN_ENVOY_BRIDGE_TOKEN_DISCORD: SHORT }).configured, false, 'short scoped alone');
  assert.equal(discordBotStatus({ HELMIAN_DISCORD_CLIENT_ID: CLIENT_ID, HELMIAN_ENVOY_BRIDGE_TOKEN_DISCORD: SHORT, HELMIAN_ENVOY_BRIDGE_TOKEN: SHARED }).configured, true, 'short scoped beside a live shared fallback');
  assert.equal(slackBotStatus({ HELMION_SLACK_APP_ID: APP_ID, HELMIAN_ENVOY_BRIDGE_TOKEN_SLACK: SHORT }).configured, false, 'short scoped alone');
  assert.equal(slackBotStatus({ HELMION_SLACK_APP_ID: APP_ID, HELMIAN_ENVOY_BRIDGE_TOKEN: SHORT }).configured, false, 'short shared alone');
  assert.equal(discordBotStatus({ HELMIAN_DISCORD_CLIENT_ID: CLIENT_ID, HELMIAN_ENVOY_BRIDGE_TOKEN_DISCORD: `  ${'x'.repeat(31)}  ` }).configured, false, 'the gate trims before it measures, and so does the status');
});

test('the public id still gates the reading, tokens or not', () => {
  assert.deepEqual(discordBotStatus({ HELMIAN_ENVOY_BRIDGE_TOKEN_DISCORD: DISCORD }), { configured: false, inviteUrl: null });
  assert.equal(discordBotStatus({ HELMIAN_DISCORD_CLIENT_ID: 'evil&x=1', HELMIAN_ENVOY_BRIDGE_TOKEN_DISCORD: DISCORD }).inviteUrl, null);
  assert.deepEqual(slackBotStatus({ HELMIAN_ENVOY_BRIDGE_TOKEN_SLACK: SLACK }), { configured: false, inviteUrl: null });
  const s = discordBotStatus({ HELMIAN_DISCORD_CLIENT_ID: CLIENT_ID, HELMIAN_ENVOY_BRIDGE_TOKEN_DISCORD: DISCORD });
  assert.equal(s.configured, true);
  assert.match(s.inviteUrl, /^https:\/\/discord\.com\/oauth2\/authorize\?client_id=123456789012345678&/);
});
