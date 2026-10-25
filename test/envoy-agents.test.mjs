import assert from 'node:assert/strict';
import test from 'node:test';
import { agentsToAnswer, mentionsIn, normalizeProvider, parseConfig, serializeConfig, publicConfig, describeAuthor, discordSubject, slackSubject, agentPrompt, emptyConfig, normalizeMessageMetadata, classifyFileAttachment, FILE_ATTACHMENT_MAX_BYTES, FILE_ATTACHMENTS_MAX_TOTAL_BYTES } from '../src/cloud/envoy-agents.mjs';

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

test('routing matrix (ordinary channel): named answers, unnamed = silence, maestro never answers', () => {
  const roster = ['maestro', 'claude', 'gemini'];
  // A named agent answers.
  assert.deepEqual(agentsToAnswer(human('@claude fix it'), roster), ['claude']);
  assert.deepEqual(agentsToAnswer(human('@Claude and @Gemini: go'), roster), ['claude', 'gemini']);
  // @all reaches every agent — and never 'maestro', which is not one.
  assert.deepEqual(agentsToAnswer(human('@all status'), roster), ['claude', 'gemini']);
  assert.deepEqual(agentsToAnswer(human('@all status'), ['claude', 'grok']), ['claude', 'grok']);
  // An unnamed message gets NO agent turn, with or without a historical
  // 'maestro' entry on the roster.
  assert.deepEqual(agentsToAnswer(human('build the page'), roster), []);
  assert.deepEqual(agentsToAnswer(human('build the page'), ['claude', 'grok']), []);
  // Naming Maestro names the human's own seat: nobody answers.
  assert.deepEqual(agentsToAnswer(human('@maestro look at this'), roster), []);
  assert.deepEqual(agentsToAnswer(human('hi'), ['maestro']), []);
  assert.deepEqual(agentsToAnswer(human('@grok hi'), roster), [], 'not a member');
  assert.deepEqual(agentsToAnswer(human('hi'), []), []);
});

test('routing: agent-authored messages dispatch nobody — there is no Maestro hop', () => {
  const roster = ['maestro', 'claude', 'gemini'];
  // The old impostor shape: a message authored "by Maestro" dispatched
  // the named workers. That hop is gone — dispatch is the human's act.
  assert.deepEqual(agentsToAnswer({ authorKind: 'agent', authorSubject: 'agent:maestro', body: '@Claude: UI. @Gemini: tests.' }, roster), []);
  assert.deepEqual(agentsToAnswer({ authorKind: 'agent', authorSubject: 'agent:maestro', body: '@all go' }, roster), []);
  assert.deepEqual(agentsToAnswer({ authorKind: 'agent', authorSubject: 'agent:claude', body: '@gemini your turn' }, roster), []);
  assert.deepEqual(agentsToAnswer({ authorKind: 'system', authorSubject: 'system:envoy', body: '@all' }, roster), []);
});

test('routing: a private room routes unnamed prompts to its one agent', () => {
  assert.deepEqual(agentsToAnswer(human('just us here'), ['gemini'], { room: true }), ['gemini']);
  assert.deepEqual(agentsToAnswer(human('@claude wrong room'), ['gemini'], { room: true }), []);
  assert.deepEqual(agentsToAnswer(human('hello'), ['maestro'], { room: true }), [], 'a maestro room seats nobody');
  assert.deepEqual(agentsToAnswer({ authorKind: 'agent', authorSubject: 'agent:gemini', body: 'note to self' }, ['gemini'], { room: true }), []);
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

test('slack authors: subject shape, badge source, bad ids rejected', () => {
  assert.equal(slackSubject('U0ABC12345', 'Troy'), 'slack:U0ABC12345:Troy');
  assert.equal(slackSubject('U0ABC12345', ''), 'slack:U0ABC12345:Slack member');
  const who = describeAuthor(slackSubject('U0ABC12345', 'Troy'), 'human');
  assert.equal(who.name, 'Troy');
  assert.equal(who.source, 'slack');
  assert.equal(who.provider, null);
  assert.throws(() => slackSubject('not-an-id', 'x'));
  assert.throws(() => slackSubject('u0abc', 'x'), 'lowercase is not a Slack id');
});

test('slack config: link round-trips, old bodies parse slackless, bad ids drop the link', () => {
  const c = emptyConfig();
  assert.equal(c.slack, null);
  // Byte-stability: a config with no Slack link serializes exactly as
  // before the link existed (no "slack" key in the stored body).
  assert.ok(!serializeConfig(c).includes('slack'));
  const oldBody = JSON.stringify({ format: 'helmian.envoy.channel-config.v1', agents: ['claude'], joined: {}, discord: null, pendingLink: null });
  assert.equal(parseConfig(oldBody).slack, null);

  c.slack = { teamId: 'T0BP40EFJ1W', channelId: 'C0BN7LCK946', channelName: 'all-helmian', teamName: 'HELMIAN', linkedAt: '2026-10-25T00:00:00.000Z' };
  const back = parseConfig(serializeConfig(c));
  assert.deepEqual(back.slack, c.slack);
  assert.deepEqual(publicConfig(back).slack, c.slack);

  const bad = emptyConfig();
  bad.slack = { teamId: 'nope', channelId: 'C0BN7LCK946', channelName: '', teamName: '', linkedAt: null };
  assert.equal(parseConfig(serializeConfig(bad)).slack, null);
});

test('message metadata: the bridge source stamp survives normalization, junk is dropped', () => {
  const meta = normalizeMessageMetadata({ source: { provider: 'slack', teamId: 'T0BP40EFJ1W', channelId: 'C0BN7LCK946', channelName: 'all-helmian', evil: 'x' } });
  assert.deepEqual(meta.source, { provider: 'slack', teamId: 'T0BP40EFJ1W', channelId: 'C0BN7LCK946', channelName: 'all-helmian' });
  assert.equal(normalizeMessageMetadata({ source: { provider: 'slack', channelId: 'not an id' } }), null);
  assert.equal(normalizeMessageMetadata({ source: { provider: 'myspace', channelId: 'C0BN7LCK946' } }), null);
  assert.equal(normalizeMessageMetadata({}), null);
  // The stamp rides alongside attachments without disturbing them.
  const both = normalizeMessageMetadata({ source: { provider: 'discord', channelId: '222222', channelName: 'general' }, webSearch: true });
  assert.equal(both.source.provider, 'discord');
  assert.equal(both.webSearch, true);
});

test('agent prompt names the role and the claim rule', () => {
  const p = agentPrompt({ provider: 'claude', channelTitle: 'build', members: ['maestro', 'claude', 'gemini'], message: { authorName: 'Troy', body: 'ship it' } });
  assert.match(p, /You are Claude/); assert.match(p, /Claim:/); assert.match(p, /ship it/);
  // Maestro is not listed among the other agents: it is not one.
  assert.match(p, /Other agents here: Gemini\./);
  assert.doesNotMatch(p, /Maestro/);
});

test('no prompt is ever composed for Maestro', () => {
  assert.throws(
    () => agentPrompt({ provider: 'maestro', channelTitle: 'x', members: ['maestro'], message: { body: 'q' } }),
    /not an agent/,
  );
});

test('bridge-authored posts are named for the bridge, never Maestro', () => {
  assert.deepEqual(describeAuthor('user_abc:bridge', 'agent'), { name: 'PC bridge', source: 'helmian', provider: null });
});

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const fileAtt = (name, text, mediaType = 'text/plain', extra = {}) => ({ kind: 'file', name, mediaType, data: b64(text), ...extra });

test('file attachments: canonical shape carries name, type, computed size and bytes', () => {
  const meta = normalizeMessageMetadata({ attachments: [fileAtt('Notes.TXT', 'hello', 'Text/Plain')] });
  assert.deepEqual(meta.attachments[0], { kind: 'file', name: 'Notes.TXT', mediaType: 'text/plain', size: 5, data: b64('hello') });
  const declared = normalizeMessageMetadata({ attachments: [fileAtt('a.txt', 'hello', 'text/plain', { size: 5 })] });
  assert.equal(declared.attachments[0].size, 5, 'a declared size that matches the bytes is accepted');
  const png = normalizeMessageMetadata({ attachments: [{ kind: 'file', name: 'shot.png', mediaType: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') }] });
  assert.equal(png.attachments[0].size, 4, 'binary bytes are sized from the base64, not decoded as text');
});

test('file attachments: classification is the consumption contract', () => {
  assert.equal(classifyFileAttachment({ name: 'a.txt', mediaType: 'text/plain' }), 'text');
  assert.equal(classifyFileAttachment({ name: 'a.webp', mediaType: 'image/webp' }), 'image');
  assert.equal(classifyFileAttachment({ name: 'data.csv', mediaType: '' }), 'text');
  assert.equal(classifyFileAttachment({ name: 'a.pdf', mediaType: 'application/pdf' }), null);
  assert.throws(() => normalizeMessageMetadata({ attachments: [fileAtt('a.pdf', 'junk', 'application/pdf')] }), /file type is unsupported/);
  assert.throws(() => normalizeMessageMetadata({ attachments: [fileAtt('run.bin', 'junk', 'application/octet-stream')] }), /file type is unsupported/);
});

test('file attachments: fail-closed on size, total, base64, names and mismatched size', () => {
  const tooBig = Buffer.alloc(FILE_ATTACHMENT_MAX_BYTES + 1, 0x61).toString('base64');
  assert.throws(() => normalizeMessageMetadata({ attachments: [{ kind: 'file', name: 'big.txt', mediaType: 'text/plain', data: tooBig }] }), /too large|size is invalid/);
  const chunk = Buffer.alloc(200 * 1024, 0x62).toString('base64');
  const three = [1, 2, 3].map((i) => ({ kind: 'file', name: `f${i}.txt`, mediaType: 'text/plain', data: chunk }));
  assert.ok(3 * 200 * 1024 > FILE_ATTACHMENTS_MAX_TOTAL_BYTES);
  assert.throws(() => normalizeMessageMetadata({ attachments: three }), /too large in total/);
  assert.throws(() => normalizeMessageMetadata({ attachments: [fileAtt('a.txt', 'hi', 'text/plain', { data: 'not!base64' })] }), /data is invalid/);
  assert.throws(() => normalizeMessageMetadata({ attachments: [fileAtt('a.txt', 'hi', 'text/plain', { data: '' })] }), /data is invalid|size is invalid/);
  assert.throws(() => normalizeMessageMetadata({ attachments: [fileAtt('a.txt', 'hello', 'text/plain', { size: 9 })] }), /size is invalid/, 'a declared size that disagrees with the bytes is refused');
  assert.throws(() => normalizeMessageMetadata({ attachments: [fileAtt('../evil.txt', 'hi')] }), /file name is invalid/);
  assert.throws(() => normalizeMessageMetadata({ attachments: [fileAtt('a/b.txt', 'hi')] }), /file name is invalid/, 'a path is not a file name');
});

test('file attachments: dedupe is name+size, and other kinds are untouched', () => {
  const dup = [fileAtt('a.txt', 'hello'), fileAtt('a.txt', 'hello')];
  assert.throws(() => normalizeMessageMetadata({ attachments: dup }), /duplicated/);
  const two = normalizeMessageMetadata({ attachments: [fileAtt('a.txt', 'hello'), fileAtt('a.txt', 'hello world')] });
  assert.equal(two.attachments.length, 2, 'same name, different contents: both are stored');
  const mixed = normalizeMessageMetadata({ attachments: [fileAtt('a.txt', 'hello'), { kind: 'skill', name: 'deploy' }], webSearch: false });
  assert.deepEqual(mixed.attachments.map((a) => a.kind), ['file', 'skill']);
  assert.equal(mixed.webSearch, false);
  assert.equal(normalizeMessageMetadata({ attachments: [{ kind: 'skill', name: 'deploy' }] }).attachments[0].data, undefined, 'non-file metadata gains no file fields');
});

test('desk routing: a human send is a dispatch — @all, @name, unnamed = everyone', () => {
  const team = ['claude', 'openai', 'grok', 'gemini'];
  // Unnamed reaches the whole desk (desk-only rule; ordinary channels
  // would route this to nobody).
  assert.deepEqual(agentsToAnswer(human('build the page'), team, { desk: true }), team);
  assert.deepEqual(agentsToAnswer(human('@all status'), team, { desk: true }), team);
  assert.deepEqual(agentsToAnswer(human('@claude fix it'), team, { desk: true }), ['claude']);
  assert.deepEqual(agentsToAnswer(human('@Claude and @Gemini: go'), team, { desk: true }), ['claude', 'gemini']);
  assert.deepEqual(agentsToAnswer(human('@gpt draft it'), team, { desk: true }), ['openai']);
});

test('desk routing: Maestro is never a dispatch target', () => {
  const roster = ['maestro', 'claude', 'gemini'];
  assert.deepEqual(agentsToAnswer(human('build the page'), roster, { desk: true }), ['claude', 'gemini']);
  assert.deepEqual(agentsToAnswer(human('@all status'), roster, { desk: true }), ['claude', 'gemini']);
  // Naming yourself dispatches to nobody.
  assert.deepEqual(agentsToAnswer(human('@maestro look at this'), roster, { desk: true }), []);
  assert.deepEqual(agentsToAnswer(human('anything'), ['maestro'], { desk: true }), []);
  assert.deepEqual(agentsToAnswer(human('@grok hi'), ['claude'], { desk: true }), [], 'not seated on the desk');
});

test('desk routing: agent and system messages keep the ordinary rules', () => {
  const team = ['claude', 'openai', 'grok', 'gemini'];
  assert.deepEqual(agentsToAnswer({ authorKind: 'agent', authorSubject: 'agent:claude', body: '@gemini your turn' }, team, { desk: true }), []);
  assert.deepEqual(agentsToAnswer({ authorKind: 'agent', authorSubject: 'agent:maestro', body: '@all go' }, team, { desk: true }), [], 'no agent speaks as Maestro, even in the desk');
  assert.deepEqual(agentsToAnswer({ authorKind: 'system', authorSubject: 'system:envoy', body: '@all' }, team, { desk: true }), []);
});

test('ordinary routing holds when desk is off or absent: unnamed = silence', () => {
  const roster = ['maestro', 'claude', 'gemini'];
  assert.deepEqual(agentsToAnswer(human('build the page'), roster), []);
  assert.deepEqual(agentsToAnswer(human('build the page'), roster, {}), []);
  assert.deepEqual(agentsToAnswer(human('build the page'), roster, { desk: false }), []);
  assert.deepEqual(agentsToAnswer(human('@all status'), roster, { desk: false }), ['claude', 'gemini']);
  assert.deepEqual(agentsToAnswer(human('@gemini status'), roster, { desk: false }), ['gemini']);
});

test('desk config: desk flag round-trips and stays out of configs that never had it', () => {
  const plain = emptyConfig();
  assert.equal(plain.desk, false);
  // Byte-stability: a config without the desk flag serializes exactly
  // as before the desk existed (no "desk" key in the stored body).
  assert.ok(!serializeConfig(plain).includes('desk'));
  assert.equal(parseConfig(serializeConfig(plain)).desk, false);
  // An old stored body (no desk field at all) parses with desk off.
  const oldBody = JSON.stringify({ format: 'helmian.envoy.channel-config.v1', agents: ['claude'], joined: {}, discord: null, pendingLink: null });
  assert.equal(parseConfig(oldBody).desk, false);

  const desk = emptyConfig();
  desk.desk = true; desk.agents = ['claude', 'gemini'];
  const back = parseConfig(serializeConfig(desk));
  assert.equal(back.desk, true);
  assert.deepEqual(back.agents, ['claude', 'gemini']);
  assert.equal(publicConfig(back).desk, true);
  assert.equal(publicConfig(parseConfig(oldBody)).desk, false);
});


test('slack bot status: app id plus bridge token, no secret ever shown', async () => {
  const { slackBotStatus } = await import('../src/cloud/envoy-mesh.mjs');
  assert.deepEqual(slackBotStatus({}), { configured: false, inviteUrl: null });
  assert.deepEqual(slackBotStatus({ HELMION_SLACK_APP_ID: 'A0CBUCYTVNW', HELMIAN_ENVOY_BRIDGE_TOKEN: 'x'.repeat(64) }), { configured: true, inviteUrl: null });
  assert.equal(slackBotStatus({ HELMION_SLACK_APP_ID: 'A0CBUCYTVNW' }).configured, false, 'no bridge token, no bridge');
  assert.equal(slackBotStatus({ HELMION_SLACK_APP_ID: 'evil&x=1', HELMIAN_ENVOY_BRIDGE_TOKEN: 'x'.repeat(64) }).configured, false);
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
