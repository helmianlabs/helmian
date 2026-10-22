import assert from 'node:assert/strict';
import test from 'node:test';
import { agentsToAnswer, mentionsIn, normalizeProvider, parseConfig, serializeConfig, publicConfig, describeAuthor, discordSubject, agentPrompt, emptyConfig } from '../src/cloud/envoy-agents.mjs';

const human = (body) => ({ authorKind: 'human', authorSubject: 'user_x', body });

test('provider aliases', () => {
  assert.equal(normalizeProvider('@ChatGPT'), 'openai');
  assert.equal(normalizeProvider('manager'), 'maestro');
  assert.equal(normalizeProvider('xai'), 'grok');
  assert.equal(normalizeProvider('nope'), null);
});

test('mentions: names, numbered names, @all, emails ignored', () => {
  assert.deepEqual(mentionsIn('hey @Claude1 and @gemini').providers.sort(), ['claude', 'gemini']);
  assert.equal(mentionsIn('@all go').all, true);
  assert.deepEqual(mentionsIn('mail troy@claude.ai').providers, []);
});

test('routing: mention, @all, Maestro default, everyone when no Maestro', () => {
  const roster = ['maestro', 'claude', 'gemini'];
  assert.deepEqual(agentsToAnswer(human('@claude fix it'), roster), ['claude']);
  assert.deepEqual(agentsToAnswer(human('@all status'), roster), roster);
  assert.deepEqual(agentsToAnswer(human('build the page'), roster), ['maestro']);
  assert.deepEqual(agentsToAnswer(human('build the page'), ['claude', 'grok']), ['claude', 'grok']);
  assert.deepEqual(agentsToAnswer(human('@grok hi'), roster), [], 'not a member');
  assert.deepEqual(agentsToAnswer(human('hi'), []), []);
});

test('routing: only Maestro dispatches to agents, one hop', () => {
  const roster = ['maestro', 'claude', 'gemini'];
  assert.deepEqual(agentsToAnswer({ authorKind: 'agent', authorSubject: 'agent:maestro', body: '@Claude: UI. @Gemini: tests.' }, roster), ['claude', 'gemini']);
  assert.deepEqual(agentsToAnswer({ authorKind: 'agent', authorSubject: 'agent:claude', body: '@gemini your turn' }, roster), []);
  assert.deepEqual(agentsToAnswer({ authorKind: 'system', authorSubject: 'system:envoy', body: '@all' }, roster), []);
});

test('config round trip keeps join times, hides the code hash', () => {
  const c = emptyConfig();
  c.agents = ['claude']; c.joined = { claude: '2026-10-22T10:00:00.000Z' };
  c.pendingLink = { codeHash: 'a'.repeat(64), expiresAt: new Date(Date.now() + 60000).toISOString() };
  const back = parseConfig(serializeConfig(c));
  assert.deepEqual(back.agents, ['claude']);
  assert.equal(back.joined.claude, '2026-10-22T10:00:00.000Z');
  const pub = publicConfig(back);
  assert.equal(pub.agents[0].name, 'Claude');
  assert.ok(pub.pendingLink.expiresAt);
  assert.ok(!JSON.stringify(pub).includes('a'.repeat(64)));
  assert.equal(parseConfig('not json'), null);
});

test('author names for agents, Discord members, system', () => {
  assert.deepEqual(describeAuthor('agent:openai', 'agent'), { name: 'ChatGPT', source: 'helmian', provider: 'openai' });
  assert.equal(describeAuthor(discordSubject('123456789', 'Troy'), 'human').name, 'Troy');
  assert.equal(describeAuthor(discordSubject('123456789', 'Troy'), 'human').source, 'discord');
  assert.equal(describeAuthor('system:envoy', 'system').name, 'Helmian');
  assert.equal(describeAuthor('user_abc', 'human').name, null);
  assert.throws(() => discordSubject('abc', 'x'));
});

test('agent prompt names the role and the claim rule', () => {
  const p = agentPrompt({ provider: 'claude', channelTitle: 'build', members: ['maestro', 'claude', 'gemini'], message: { authorName: 'Troy', body: 'ship it' } });
  assert.match(p, /You are Claude/); assert.match(p, /Claim:/); assert.match(p, /Maestro, Gemini/); assert.match(p, /ship it/);
  assert.match(agentPrompt({ provider: 'maestro', channelTitle: 'x', members: ['maestro'], message: { body: 'q' } }), /manager/);
});

test('discord bot status exposes only a public invite url and a yes/no', async () => {
  const { discordBotStatus } = await import('../src/cloud/envoy-mesh.mjs');
  assert.deepEqual(discordBotStatus({}), { configured: false, inviteUrl: null });
  const s = discordBotStatus({ HELMIAN_DISCORD_CLIENT_ID: '123456789012345678', HELMIAN_ENVOY_BRIDGE_TOKEN: 'x'.repeat(64) });
  assert.equal(s.configured, true);
  assert.match(s.inviteUrl, /client_id=123456789012345678&scope=bot&permissions=536939520$/);
  assert.ok(!JSON.stringify(s).includes('xxxx'));
  assert.equal(discordBotStatus({ HELMIAN_DISCORD_CLIENT_ID: 'evil&x=1' }).inviteUrl, null);
});
