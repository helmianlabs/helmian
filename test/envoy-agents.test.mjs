import assert from 'node:assert/strict';
import test from 'node:test';
import { agentsToAnswer, mentionsIn, normalizeProvider, parseConfig, serializeConfig, publicConfig, describeAuthor, discordSubject, agentPrompt, emptyConfig, normalizeMessageMetadata, classifyFileAttachment, FILE_ATTACHMENT_MAX_BYTES, FILE_ATTACHMENTS_MAX_TOTAL_BYTES } from '../src/cloud/envoy-agents.mjs';

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

test('discord bot status exposes only a public invite url and a yes/no', async () => {
  const { discordBotStatus } = await import('../src/cloud/envoy-mesh.mjs');
  assert.deepEqual(discordBotStatus({}), { configured: false, inviteUrl: null });
  const s = discordBotStatus({ HELMIAN_DISCORD_CLIENT_ID: '123456789012345678', HELMIAN_ENVOY_BRIDGE_TOKEN: 'x'.repeat(64) });
  assert.equal(s.configured, true);
  assert.match(s.inviteUrl, /client_id=123456789012345678&scope=bot&permissions=536939520$/);
  assert.ok(!JSON.stringify(s).includes('xxxx'));
  assert.equal(discordBotStatus({ HELMIAN_DISCORD_CLIENT_ID: 'evil&x=1' }).inviteUrl, null);
});
