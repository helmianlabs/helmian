import assert from 'node:assert/strict';
import test from 'node:test';
import { agentsToAnswer, mentionsIn, normalizeProvider, parseConfig, serializeConfig, publicConfig, describeAuthor, discordSubject, slackSubject, agentPrompt, emptyConfig, normalizeMessageMetadata, normalizeSkillToggles, MAX_MESSAGE_SKILLS, classifyFileAttachment, FILE_ATTACHMENT_MAX_BYTES, FILE_ATTACHMENTS_MAX_TOTAL_BYTES, sanitizeChannelAvatar, CHANNEL_AVATAR_CHARACTERS, CHANNEL_AVATAR_COLORS } from '../src/cloud/envoy-agents.mjs';
import { CHARACTERS, COLORS } from '../web/marketing/app/avatars.mjs';

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
  // The composer's active project (mirror-design §3.1, bite M2): a
  // well-shaped key is carried and normalized; a malformed one is
  // refused outright, never silently dropped or carried.
  assert.deepEqual(normalizeMessageMetadata({ projectKey: 'Helmian' }), { projectKey: 'helmian' });
  assert.equal(normalizeMessageMetadata({ projectKey: null }), null);
  assert.throws(() => normalizeMessageMetadata({ projectKey: 'bad key!' }), /project is invalid/);
  assert.throws(() => normalizeMessageMetadata({ projectKey: 'a..b' }), /project is invalid/);
  assert.throws(() => normalizeMessageMetadata({ projectKey: '-leading-dash' }), /project is invalid/);
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

test('maestroFollow config (legacy field): round-trips for backward compatibility; routing never consults it', () => {
  const plain = emptyConfig();
  assert.equal(plain.maestroFollow, false);
  // Byte-stability: a config without the follow flag serializes
  // exactly as before Maestro follow existed (no "maestroFollow").
  assert.ok(!serializeConfig(plain).includes('maestroFollow'));
  assert.equal(parseConfig(serializeConfig(plain)).maestroFollow, false);
  // An old stored body (no maestroFollow field at all) parses off.
  const oldBody = JSON.stringify({ format: 'helmian.envoy.channel-config.v1', agents: ['claude'], joined: {}, discord: null, pendingLink: null });
  assert.equal(parseConfig(oldBody).maestroFollow, false);
  assert.equal(publicConfig(parseConfig(oldBody)).maestroFollow, false);

  const follow = emptyConfig();
  follow.maestroFollow = true; follow.agents = ['claude', 'gemini'];
  const back = parseConfig(serializeConfig(follow));
  assert.equal(back.maestroFollow, true);
  assert.equal(back.desk, false, 'follow is its own flag, never the desk flag');
  assert.deepEqual(back.agents, ['claude', 'gemini']);
  assert.equal(publicConfig(back).maestroFollow, true);
  // A truthy non-boolean in a stored body does not turn follow on.
  const junk = JSON.stringify({ format: 'helmian.envoy.channel-config.v1', agents: [], joined: {}, discord: null, pendingLink: null, maestroFollow: 'yes' });
  assert.equal(parseConfig(junk).maestroFollow, false);
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

test('custom agents: sanitizeCustomAgent normalizes handle, emoji, jobTitle, jobPrompt, provider, authMode and round-trips through config', async () => {
  const { sanitizeCustomAgent, sanitizeGithubLink } = await import('../src/cloud/envoy-agents.mjs');
  const agent = sanitizeCustomAgent({
    handle: '@Rusty_Bot!',
    name: 'Rusty',
    emoji: '🦀',
    jobTitle: 'Rust Systems Architect',
    jobPrompt: 'Review memory safety and zero-copy paths.',
    provider: 'mistral',
    authMode: 'subscription',
  });
  assert.ok(agent);
  assert.equal(agent.id, 'rusty_bot');
  assert.equal(agent.handle, 'rusty_bot');
  assert.equal(agent.name, 'Rusty');
  assert.equal(agent.emoji, '🦀');
  assert.equal(agent.jobTitle, 'Rust Systems Architect');
  assert.equal(agent.provider, 'mistral');
  assert.equal(agent.authMode, 'password_session', 'the legacy input collapses to the one road on sanitize');

  const cfg = emptyConfig();
  cfg.customAgents = [agent];
  cfg.agents = ['claude', agent.id];
  cfg.debateMode = 'free-willy';
  cfg.maxRoundTurns = 14;
  cfg.github = sanitizeGithubLink({ repo: ' TroyHelm/Helmion ', events: ['push', 'pull_request'], linkedAt: '2026-11-01T00:00:00.000Z' });

  const back = parseConfig(serializeConfig(cfg));
  assert.equal(back.customAgents.length, 1);
  assert.equal(back.customAgents[0].id, 'rusty_bot');
  assert.equal(back.customAgents[0].authMode, 'password_session', 'the round-trip keeps the single mode');
  assert.equal(back.debateMode, 'free-willy');
  assert.equal(back.maxRoundTurns, 14);
  assert.equal(back.github.repo, 'TroyHelm/Helmion');

  const pub = publicConfig(back);
  assert.equal(pub.customAgents[0].emoji, '🦀');
  assert.equal(pub.debateMode, 'free-willy');
  assert.equal(pub.github.repo, 'TroyHelm/Helmion');
  assert.equal(describeAuthor('agent:rusty_bot', 'agent', back.customAgents).name, '🦀 Rusty');
  assert.equal(describeAuthor('agent:rusty_bot', 'agent', back.customAgents).engine, 'mistral');
});

test('debate turn cap persists across off-writes (Free-Willy cap truth, 2026-11-04)', () => {
  // The operator's cap is a setting, not part of the on/off state: turning
  // debate off (stop-debate / set 'off') must not erase a non-default cap.
  const on = emptyConfig();
  on.debateMode = 'free-willy';
  on.maxRoundTurns = 6;
  const off = parseConfig(serializeConfig({ ...on, debateMode: 'off' }));
  assert.equal(off.debateMode, 'off');
  assert.equal(off.maxRoundTurns, 6, 'cap survives the off-write');
  const backOn = parseConfig(serializeConfig({ ...off, debateMode: 'free-willy' }));
  assert.equal(backOn.debateMode, 'free-willy');
  assert.equal(backOn.maxRoundTurns, 6, 'cap survives the off→on round-trip');
  // Byte-stability: a default-cap, mode-off config still stores no cap key.
  const plain = emptyConfig();
  assert.ok(!serializeConfig(plain).includes('maxRoundTurns'), 'default off config stores no cap key');
  assert.equal(parseConfig(serializeConfig(plain)).maxRoundTurns, 10, 'absent cap reads back as the server default');
});

test('custom agents: every legacy authMode collapses to password_session, and stored records still load (one-road Bite 5)', async () => {
  const { sanitizeCustomAgent, CUSTOM_AGENT_AUTH_MODE } = await import('../src/cloud/envoy-agents.mjs');
  assert.equal(CUSTOM_AGENT_AUTH_MODE, 'password_session');
  for (const legacy of ['subscription', 'browser-free', 'browser-paid', 'api-key', 'cli', 'SUBSCRIPTION', 'nonsense', '', undefined]) {
    const a = sanitizeCustomAgent({ handle: 'rusty', provider: 'claude', authMode: legacy });
    assert.ok(a, `record with authMode ${String(legacy)} still sanitizes`);
    assert.equal(a.authMode, 'password_session', `authMode ${String(legacy)} collapses to the one road`);
  }
  // A record stored by an old build, carrying a legacy mode in its
  // saved JSON, still loads through parseConfig — and comes out
  // carrying the single mode, its other fields untouched.
  const stored = JSON.stringify({
    format: 'helmian.envoy.channel-config.v1',
    agents: ['rusty'],
    customAgents: [{ handle: 'rusty', name: 'Rusty', emoji: '🦀', provider: 'mistral', authMode: 'cli', jobTitle: 'Rust Systems Architect', jobPrompt: 'Review memory safety.' }],
  });
  const back = parseConfig(stored);
  assert.ok(back, 'stored record parses');
  assert.equal(back.customAgents.length, 1, 'the stored agent still loads');
  assert.equal(back.customAgents[0].authMode, 'password_session');
  assert.equal(back.customAgents[0].jobTitle, 'Rust Systems Architect');
  assert.equal(publicConfig(back).customAgents[0].authMode, 'password_session', 'the public view carries the single mode too');
});

test('free-willy debate mode: human message dispatches all seated agents; agent message continues debate until maxRoundTurns', () => {
  const customAgents = [{ id: 'rusty_bot', handle: 'rusty_bot', name: 'Rusty', emoji: '🦀', provider: 'mistral' }];
  const roster = ['claude', 'gemini', 'rusty_bot'];
  // Human message in free-willy mode dispatches all seated agents even without @all
  assert.deepEqual(
    agentsToAnswer(human('design the consensus protocol'), roster, { debateMode: 'free-willy', roundTurns: 0, maxRoundTurns: 6, customAgents }),
    ['claude', 'gemini', 'rusty_bot'],
  );
  // Agent turn in free-willy mode triggers peers (excluding speaker) while roundTurns < maxRoundTurns
  assert.deepEqual(
    agentsToAnswer(
      { authorKind: 'agent', authorSubject: 'agent:claude', body: 'Here is my proposal.' },
      roster,
      { debateMode: 'free-willy', roundTurns: 2, maxRoundTurns: 6, customAgents },
    ),
    ['gemini', 'rusty_bot'],
  );
  // Once roundTurns >= maxRoundTurns, agent turns stop dispatching
  assert.deepEqual(
    agentsToAnswer(
      { authorKind: 'agent', authorSubject: 'agent:claude', body: 'Final thought.' },
      roster,
      { debateMode: 'free-willy', roundTurns: 6, maxRoundTurns: 6, customAgents },
    ),
    [],
  );
});

// ---------- channel faces (emoji bite 5) ----------
// A channel's look rides its config so the whole workspace sees the
// same face; before this bite it lived in one browser's localStorage.

test('channel avatar: the cloud mirror matches the desk avatar vocabulary', () => {
  assert.deepEqual([...CHANNEL_AVATAR_CHARACTERS], CHARACTERS.map(([id]) => id));
  assert.equal(CHANNEL_AVATAR_COLORS, COLORS.length);
});

test('sanitizeChannelAvatar keeps drawn choices and refuses the rest', () => {
  assert.deepEqual(sanitizeChannelAvatar({ k: 'char', id: 'fox' }), { k: 'char', id: 'fox' });
  assert.deepEqual(sanitizeChannelAvatar({ k: 'plain', c: 0 }), { k: 'plain', c: 0 });
  assert.deepEqual(sanitizeChannelAvatar({ k: 'plain', c: 7 }), { k: 'plain', c: 7 });
  assert.equal(sanitizeChannelAvatar({ k: 'char', id: 'dragon' }), null);
  assert.equal(sanitizeChannelAvatar({ k: 'plain', c: 8 }), null);
  assert.equal(sanitizeChannelAvatar({ k: 'plain', c: -1 }), null);
  assert.equal(sanitizeChannelAvatar({ k: 'plain', c: 1.5 }), null);
  assert.equal(sanitizeChannelAvatar({ k: 'emoji', c: '🦊' }), null);
  assert.equal(sanitizeChannelAvatar(null), null);
  assert.equal(sanitizeChannelAvatar(undefined), null);
  assert.equal(sanitizeChannelAvatar('fox'), null);
});

test('channel avatar round-trips through parse/serialize/publicConfig', () => {
  const config = { ...emptyConfig(), avatar: { k: 'char', id: 'octo' } };
  const body = serializeConfig(config);
  assert.deepEqual(JSON.parse(body).avatar, { k: 'char', id: 'octo' });
  const parsed = parseConfig(body);
  assert.deepEqual(parsed.avatar, { k: 'char', id: 'octo' });
  assert.deepEqual(publicConfig(parsed).avatar, { k: 'char', id: 'octo' });
});

test('a config without an avatar keeps its exact stored shape', () => {
  const body = serializeConfig(emptyConfig());
  assert.ok(!('avatar' in JSON.parse(body)), 'unset avatar is never written');
  assert.equal(parseConfig(body).avatar, null);
  assert.equal(publicConfig(parseConfig(body)).avatar, null);
  const junk = parseConfig(JSON.stringify({ format: 'helmian.envoy.channel-config.v1', avatar: { k: 'char', id: 'nope' } }));
  assert.equal(junk.avatar, null, 'a stored junk avatar reads back as none');
});

test('skill toggles: canonical pairs pass, including the blanket target', () => {
  assert.equal(normalizeSkillToggles(undefined), undefined);
  assert.equal(normalizeSkillToggles(null), undefined);
  assert.equal(normalizeSkillToggles([]), undefined, 'an empty attach list is the untouched composer — the field is omitted');
  const out = normalizeSkillToggles([
    { skillId: 'deep-research', seatId: 'all' },
    { skillId: 'wash-check', seatId: 'claude' },
    { skillId: 'wash-check', seatId: 'grok' },
  ]);
  assert.deepEqual(out, [
    { skillId: 'deep-research', seatId: 'all' },
    { skillId: 'wash-check', seatId: 'claude' },
    { skillId: 'wash-check', seatId: 'grok' },
  ], 'one skill may target two seats — the pair is the identity');
  assert.ok(Object.isFrozen(out) && Object.isFrozen(out[0]));
});

test('skill toggles: fail-closed on shape, duplicates and the cap', () => {
  assert.throws(() => normalizeSkillToggles('deep-research'), /invalid/);
  assert.throws(() => normalizeSkillToggles([{ skillId: 'deep-research' }]), /invalid/, 'a toggle names its target');
  assert.throws(() => normalizeSkillToggles([{ skillId: 'Deep Research', seatId: 'all' }]), /invalid/);
  assert.throws(() => normalizeSkillToggles([{ skillId: 'deep-research', seatId: 'bad seat!' }]), /invalid/);
  assert.throws(() => normalizeSkillToggles([
    { skillId: 'deep-research', seatId: 'all' },
    { skillId: 'deep-research', seatId: 'all' },
  ]), /duplicated/);
  assert.equal(MAX_MESSAGE_SKILLS, 3);
  assert.throws(() => normalizeSkillToggles([
    { skillId: 'a', seatId: 'all' }, { skillId: 'b', seatId: 'all' },
    { skillId: 'c', seatId: 'all' }, { skillId: 'd', seatId: 'all' },
  ]), /too many skills/);
});

test('message metadata: skills round-trip, omit when empty, and ride beside other fields', () => {
  const meta = normalizeMessageMetadata({ skills: [{ skillId: 'deep-research', seatId: 'all' }] });
  assert.deepEqual(meta, { skills: [{ skillId: 'deep-research', seatId: 'all' }] });
  assert.equal(normalizeMessageMetadata({ skills: [] }), null, 'no skills and nothing else is no metadata');
  assert.equal(normalizeMessageMetadata({}), null);
  const mixed = normalizeMessageMetadata({
    webSearch: true,
    connectors: [{ seatId: 'claude', entryId: 'helmian-github' }],
    skills: [{ skillId: 'wash-check', seatId: 'grok' }],
  });
  assert.deepEqual(mixed.skills, [{ skillId: 'wash-check', seatId: 'grok' }]);
  assert.deepEqual(mixed.connectors, [{ seatId: 'claude', entryId: 'helmian-github' }], 'the two roads stay separate in one metadata object');
  assert.equal(mixed.webSearch, true);
  assert.throws(() => normalizeMessageMetadata({ skills: [{ skillId: 'x', seatId: 'all' }, { skillId: 'x', seatId: 'all' }] }), /duplicated/);
});
