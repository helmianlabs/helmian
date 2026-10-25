import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  FILE_MAX_BYTES, MAX_ATTACHMENTS, UPLOAD_NOTE, addAttachment, applySkillToBody,
  attachmentKey, attachmentMetadata, buildMessageRequest, classifyFile,
  fileRefusalReason, normalizeFileAttachment, normalizeSkillName,
  pickerModel, removeAttachment,
} from '../app/composer-picker.mjs';
// The REAL server validator the message route applies — imported, not
// re-implemented, so a picker-built plugin payload is proven against the
// allowlist + normalizer that will actually judge it (PR #97's shape).
import { normalizeMessageMetadata } from '../../../src/cloud/envoy-agents.mjs';

// The "+" picker model. Its connectors group is the Integrations registry
// itself (PROVIDER_REGISTRY + live connection state, via integrationsModel)
// — these fixtures mirror the two API payloads loadIntegrations() merges:
// GET /api/admin/cora/connectors (registrations + verifierStatus) and
// GET /api/admin/provider-connections (connections).
const CONNECTORS = { registrations: [{ provider: 'discord' }], verifierStatus: {} };
const PROVIDERS = { connections: [{ provider: 'google' }] };
// Mirrors GET /api/admin/plugins (src/cloud/installed-plugins.mjs): the
// enabled plugins of the bridge workspace, each with what it brings.
const PLUGINS = {
  plugins: [
    { name: 'calc', version: '1.0.0', brings: 'Brings 1 approved tool server — their tools join the turn; adds its commands as skills.', tools: true, commands: true },
    { name: 'greeter', brings: 'Adds its commands as skills.', tools: false, commands: true },
  ],
  unavailable: [],
};
const model = pickerModel({ connectors: CONNECTORS, providers: PROVIDERS, plugins: PLUGINS });
const group = (id) => model.groups.find((g) => g.id === id);
const catalog = group('connectors').items;
const pluginCatalog = group('plugins').items;

test('picker groups are skills, connectors, plugins, upload — in that order', () => {
  assert.deepEqual(model.groups.map((g) => g.id), ['skills', 'connectors', 'plugins', 'upload']);
});

test('plugins group is the installed list from the bridge, with what each brings', () => {
  assert.deepEqual(pluginCatalog.map((i) => i.name), ['calc', 'greeter']);
  assert.match(pluginCatalog[0].brings, /approved tool server/);
  assert.match(group('plugins').note, /PC bridge/);
  assert.deepEqual(pickerModel({}).groups.find((g) => g.id === 'plugins').items, [], 'no list yet → an empty group, never invented plugins');
});

test('connectors group is the real registry with live connected state', () => {
  assert.deepEqual(catalog.map((i) => i.key), ['slack', 'discord', 'github', 'anthropic', 'openai', 'xai', 'google']);
  const byKey = Object.fromEntries(catalog.map((i) => [i.key, i]));
  assert.equal(byKey.discord.connected, true, 'a registration connects Discord');
  assert.equal(byKey.google.connected, true, 'a provider connection connects Gemini');
  assert.equal(byKey.google.name, 'Gemini');
  assert.equal(byKey.slack.connected, false);
  assert.equal(byKey.github.kindLabel, 'Code');
});

test('skills group carries no invented list: attach-by-name only', () => {
  const skills = group('skills');
  assert.equal(skills.byName, true);
  assert.deepEqual(skills.items, []);
  assert.match(skills.note, /PC bridge/);
});

test('upload group is a real file input whose note states the bounds plainly', () => {
  const upload = group('upload');
  assert.equal(upload.fileInput, true);
  assert.equal(upload.note, UPLOAD_NOTE);
  assert.match(upload.note, /256 KB per file/);
  assert.match(upload.note, /can't be read yet/, 'the note owns what uploads cannot do');
});

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const textFile = (name, text, mediaType = 'text/plain') => ({ kind: 'file', name, mediaType, size: Buffer.byteLength(text), data: b64(text) });

test('file classification mirrors the server: text and the three image types, nothing else', () => {
  assert.equal(classifyFile({ name: 'a.txt', mediaType: 'text/plain' }), 'text');
  assert.equal(classifyFile({ name: 'a.png', mediaType: 'image/png' }), 'image');
  assert.equal(classifyFile({ name: 'a.jpg', mediaType: 'image/jpeg' }), 'image');
  assert.equal(classifyFile({ name: 'notes.md', mediaType: '' }), 'text', 'extension decides when the browser gives no type');
  assert.equal(classifyFile({ name: 'a.pdf', mediaType: 'application/pdf' }), null);
  assert.equal(classifyFile({ name: 'a.bin', mediaType: 'application/octet-stream' }), null);
});

test('fileRefusalReason refuses before any bytes are read', () => {
  assert.equal(fileRefusalReason({ name: 'a.txt', mediaType: 'text/plain', size: 12 }), null);
  assert.match(fileRefusalReason({ name: 'a.pdf', mediaType: 'application/pdf', size: 12 }), /can't read that kind of file yet/);
  assert.match(fileRefusalReason({ name: 'a.txt', mediaType: 'text/plain', size: FILE_MAX_BYTES + 1 }), /256 KB per file/);
  assert.match(fileRefusalReason({ name: 'a.txt', mediaType: 'text/plain', size: 0 }), /empty/);
});

test('normalizeFileAttachment carries the bytes and refuses a truncated read', () => {
  const ok = normalizeFileAttachment({ name: 'Notes.TXT', mediaType: 'Text/Plain', size: 5, data: b64('hello') });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.attachment, { kind: 'file', name: 'Notes.TXT', mediaType: 'text/plain', size: 5, data: b64('hello') });
  const short = normalizeFileAttachment({ name: 'a.txt', mediaType: 'text/plain', size: 9, data: b64('hello') });
  assert.equal(short.ok, false);
  assert.match(short.reason, /could not be read completely/);
});

test('addAttachment attaches files, dedupes by name+size, and enforces the per-message total', () => {
  const a = textFile('a.txt', 'hello');
  const r = addAttachment([], a);
  assert.equal(r.added, true);
  assert.equal(attachmentKey(r.list[0]), 'file:a.txt:5');
  assert.equal(addAttachment(r.list, a).reason, 'Already attached.');
  const sameNameBigger = textFile('a.txt', 'hello world');
  assert.equal(addAttachment(r.list, sameNameBigger).added, true, 'same name, different file: both ride');
  const big = (name) => textFile(name, 'x'.repeat(200 * 1024));
  let list = addAttachment([], big('b1.txt')).list;
  list = addAttachment(list, big('b2.txt')).list;
  const third = addAttachment(list, big('b3.txt'));
  assert.equal(third.added, false);
  assert.match(third.reason, /512 KB of files per message/);
  assert.match(addAttachment([], { kind: 'file', name: 'a.pdf', mediaType: 'application/pdf', size: 4, data: b64('junk') }).reason, /can't read that kind/);
});

test('attachmentMetadata carries a file with its bytes, unchanged for the other kinds', () => {
  const meta = attachmentMetadata([textFile('a.txt', 'hello'), skill('deploy')]);
  assert.deepEqual(JSON.parse(JSON.stringify(meta)), {
    attachments: [
      { kind: 'file', name: 'a.txt', mediaType: 'text/plain', size: 5, data: b64('hello') },
      { kind: 'skill', name: 'deploy' },
    ],
  });
  const req = buildMessageRequest({ channelId: 'c1', body: 'see attached', idempotencyKey: 'k9', attachments: [textFile('a.txt', 'hello')] });
  assert.equal(req.payload.metadata.attachments[0].data, b64('hello'), 'the bytes ride the wire payload itself');
  assert.equal(removeAttachment([textFile('a.txt', 'hello')], textFile('a.txt', 'hello')).length, 0);
});

test('normalizeSkillName mirrors the command registry naming', () => {
  assert.deepEqual(normalizeSkillName('deploy'), { ok: true, name: 'deploy', reason: null });
  assert.equal(normalizeSkillName('/Deploy').name, 'deploy', 'a leading slash and case are normalized');
  assert.equal(normalizeSkillName('my-plugin:hello').name, 'my-plugin:hello', 'plugin skills are namespaced');
  assert.equal(normalizeSkillName('').ok, false);
  assert.equal(normalizeSkillName('has space').ok, false);
  assert.equal(normalizeSkillName('two:colons:here').ok, false);
  assert.equal(normalizeSkillName('x'.repeat(65)).ok, false);
});

const skill = (name) => ({ kind: 'skill', name });
const conn = (key) => ({ kind: 'connector', key });

test('addAttachment attaches a connected connector from the catalog', () => {
  const r = addAttachment([], conn('discord'), { catalog });
  assert.equal(r.added, true);
  assert.deepEqual(r.list, [{ kind: 'connector', key: 'discord', name: 'Discord' }]);
});

test('addAttachment refuses connectors the registry does not have or that are not connected', () => {
  assert.match(addAttachment([], conn('slack'), { catalog }).reason, /not connected/);
  assert.equal(addAttachment([], conn('nope'), { catalog }).added, false);
  assert.match(addAttachment([], conn('nope'), { catalog }).reason, /not in the registry/);
});

test('addAttachment dedupes and caps the list', () => {
  const one = addAttachment([], skill('deploy')).list;
  assert.equal(addAttachment(one, skill('deploy')).reason, 'Already attached.');
  let list = addAttachment([], conn('discord'), { catalog }).list;
  list = addAttachment(list, conn('google'), { catalog }).list;
  for (let i = 0; i < MAX_ATTACHMENTS; i += 1) list = [...list, { kind: 'connector', key: `c${i}`, name: `C${i}` }];
  assert.equal(addAttachment(list, conn('xai')).added, false);
  assert.match(addAttachment(list, conn('xai')).reason, /Up to 8/);
});

test('only one skill can lead a message', () => {
  const one = addAttachment([], skill('deploy')).list;
  const r = addAttachment(one, skill('review'));
  assert.equal(r.added, false);
  assert.match(r.reason, /Only one skill/);
  assert.deepEqual(r.list, one, 'a refused attach leaves the list untouched');
});

const plug = (name) => ({ kind: 'plugin', name });

test('addAttachment attaches an installed plugin from the list', () => {
  const r = addAttachment([], plug('calc'), { catalog: pluginCatalog });
  assert.equal(r.added, true);
  assert.deepEqual(r.list, [{ kind: 'plugin', name: 'calc' }]);
  assert.equal(attachmentKey(plug('calc')), 'plugin:calc');
});

test('addAttachment refuses a plugin that is not installed', () => {
  const r = addAttachment([], plug('nope'), { catalog: pluginCatalog });
  assert.equal(r.added, false);
  assert.match(r.reason, /not installed on your PC bridge/);
  assert.equal(addAttachment([], plug('has space'), { catalog: pluginCatalog }).added, false, 'a name a message cannot carry is refused before the list is even consulted');
  assert.equal(addAttachment([], plug('')).added, false);
});

test('only one plugin can ride on a message', () => {
  const one = addAttachment([], plug('calc'), { catalog: pluginCatalog }).list;
  assert.equal(addAttachment(one, plug('calc'), { catalog: pluginCatalog }).reason, 'Already attached.');
  const r = addAttachment(one, plug('greeter'), { catalog: pluginCatalog });
  assert.equal(r.added, false);
  assert.match(r.reason, /Only one plugin/);
  assert.deepEqual(r.list, one, 'a refused attach leaves the list untouched');
  assert.deepEqual(removeAttachment(one, plug('calc')), [], 'and it removes by the same identity key');
});

test('a plugin attachment rides as the metadata shape the server accepts', () => {
  const list = addAttachment([], plug('calc'), { catalog: pluginCatalog }).list;
  const meta = attachmentMetadata(list);
  assert.deepEqual(JSON.parse(JSON.stringify(meta)), { attachments: [{ kind: 'plugin', name: 'calc' }] });
  // The REAL allowlist + normalizer (src/cloud/envoy-agents.mjs) accepts
  // the picker's payload unchanged — this is the shape envoy-chat stores
  // and src/agent/attachments.mjs resolves against the installed plugins.
  assert.deepEqual(normalizeMessageMetadata(meta), meta);
  const req = buildMessageRequest({ channelId: 'c1', body: 'total these up', idempotencyKey: 'k3', attachments: list });
  assert.deepEqual(normalizeMessageMetadata(req.payload.metadata), req.metadata);
  assert.equal(req.payload.body, 'total these up', 'a plugin rides as metadata only — the body is untouched');
});

test('removeAttachment removes by identity key', () => {
  const list = [skill('deploy'), { kind: 'connector', key: 'discord', name: 'Discord' }];
  assert.deepEqual(removeAttachment(list, conn('discord')), [skill('deploy')]);
  assert.deepEqual(removeAttachment(list, skill('other')), list);
  assert.equal(attachmentKey(skill('deploy')), 'skill:deploy');
  assert.equal(attachmentKey(conn('xai')), 'connector:xai');
  assert.equal(attachmentKey(null), null);
});

test('attachmentMetadata is the structured carry: plain JSON, null when empty', () => {
  assert.equal(attachmentMetadata([]), null);
  const meta = attachmentMetadata([skill('deploy'), { kind: 'connector', key: 'discord', name: 'Discord' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(meta)), {
    attachments: [{ kind: 'skill', name: 'deploy' }, { kind: 'connector', key: 'discord', name: 'Discord' }],
  });
});

test('applySkillToBody leads the message with the skill invocation', () => {
  assert.deepEqual(applySkillToBody('ship it', [skill('deploy')]), { body: '/deploy ship it', skillCarried: true, note: null });
  assert.equal(applySkillToBody('@Gemini ship it', [skill('deploy')]).body, '/deploy @Gemini ship it', 'the skill leads even ahead of an @mention');
  assert.deepEqual(applySkillToBody('plain', []), { body: 'plain', skillCarried: false, note: null });
});

test('applySkillToBody never double-prefixes and never fights a typed command', () => {
  assert.equal(applySkillToBody('/deploy ship it', [skill('deploy')]).skillCarried, true);
  assert.equal(applySkillToBody('/deploy ship it', [skill('deploy')]).body, '/deploy ship it');
  const clash = applySkillToBody('/review ship it', [skill('deploy')]);
  assert.equal(clash.body, '/review ship it', 'the typed command wins');
  assert.equal(clash.skillCarried, false);
  assert.match(clash.note, /metadata only/);
});

test('buildMessageRequest: the wire payload is exactly the fields the route accepts', () => {
  const req = buildMessageRequest({ channelId: 'c1', body: 'ship it', idempotencyKey: 'k1', attachments: [skill('deploy'), { kind: 'connector', key: 'discord', name: 'Discord' }] });
  assert.deepEqual(Object.keys(req.payload).sort(), ['body', 'channelId', 'idempotencyKey', 'metadata']);
  assert.deepEqual(req.payload.metadata, req.metadata, 'metadata rides the payload now that the route accepts, stores and consumes it');
  assert.equal(req.payload.body, '/deploy ship it', 'the skill is carried in the body, the shape the bridge expands');
  assert.equal(req.skillCarried, true);
  assert.deepEqual(req.metadata.attachments.map((a) => a.kind), ['skill', 'connector'], 'connectors ride as structured metadata');
  const bare = buildMessageRequest({ channelId: 'c1', body: 'hi', idempotencyKey: 'k2' });
  assert.equal(bare.metadata, null);
  assert.deepEqual(Object.keys(bare.payload).sort(), ['body', 'channelId', 'idempotencyKey'], 'no attachments → the original wire shape, byte for byte');
  assert.equal(bare.payload.body, 'hi');
});

test('both composers carry the picker: plus buttons, panels, chips, wiring', async () => {
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  for (const id of ['maestro-plus', 'ew-picker', 'ew-attach-chips', 'ew-cli-plus', 'ew-cli-picker', 'ew-cli-attach-chips']) {
    assert.ok(html.includes(`id="${id}"`), `index.html has #${id}`);
  }
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  assert.match(js, /from '\.\/composer-picker\.mjs'/);
  assert.match(js, /\$\('maestro-plus'\)\.addEventListener\('click', \(\) => togglePicker\('channel'\)\)/);
  assert.match(js, /\$\('ew-cli-plus'\)\.addEventListener\('click', \(\) => togglePicker\('cli'\)\)/);
  assert.match(js, /buildMessageRequest\(\{ channelId: ws\.channelId, body, idempotencyKey: key, attachments: ws\.attach\.channel \}\)/, 'channel send builds its request through the picker model');
  assert.match(js, /attachments: ws\.attach\.cli/, 'agent-chat send carries its own attachments');
  assert.match(js, /api\('\/api\/admin\/cora\/connectors'\)/, 'the picker reads the same connectors registry as Integrations');
  assert.match(js, /api\('\/api\/admin\/plugins'\)/, 'the picker reads the installed-plugins list the bridge ledger backs');
});

test('the picker model reuses the Integrations registry instead of inventing one', async () => {
  const src = await readFile(new URL('../app/composer-picker.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \{ integrationsModel \} from '\.\/app-model\.mjs'/);
});

test('a third attach list (the session console’s) is independent of the other composers’ lists', () => {
  const channelList = addAttachment([], conn('discord'), { catalog }).list;
  const consoleList = addAttachment([], skill('deploy')).list;
  assert.deepEqual(channelList.map(attachmentKey), ['connector:discord']);
  assert.deepEqual(consoleList.map(attachmentKey), ['skill:deploy']);
  assert.deepEqual(removeAttachment(consoleList, skill('deploy')), [], 'clearing the console list empties only it');
  assert.deepEqual(channelList.map(attachmentKey), ['connector:discord'], 'the channel list is untouched');
  const req = buildMessageRequest({ channelId: 'c9', body: 'status', idempotencyKey: 'k9', attachments: consoleList });
  assert.deepEqual(req.metadata.attachments, [{ kind: 'skill', name: 'deploy' }], 'the console send carries its attachments as metadata');
  assert.equal(req.payload.body, '/deploy status', 'the skill leads the console message body, the shape the bridge expands');
  const bare = buildMessageRequest({ channelId: 'c9', body: 'status', idempotencyKey: 'k10', attachments: [] });
  assert.equal(bare.metadata, null);
  assert.deepEqual(Object.keys(bare.payload).sort(), ['body', 'channelId', 'idempotencyKey'], 'an empty console send is the original wire shape');
});

test('the session console carries the picker too: plus button, panel, chips, its own list', async () => {
  const html = await readFile(new URL('../app/index.html', import.meta.url), 'utf8');
  for (const id of ['console-plus', 'console-picker', 'console-attach-chips']) {
    assert.ok(html.includes(`id="${id}"`), `index.html has #${id}`);
  }
  const plus = html.match(/<button[^>]*id="console-plus"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(plus, '#console-plus exists');
  assert.match(plus[1], /\+/, 'console composer button shows the plus');
  assert.match(plus[1], /Add/, 'console composer button is labelled Add');
  const js = await readFile(new URL('../app/app.js', import.meta.url), 'utf8');
  assert.match(js, /from '\.\/composer-picker\.mjs'/, 'app.js imports the shared picker model — no forked picker logic');
  assert.match(js, /\$\('#console-plus'\)\.onclick = \(\) => toggleConsolePicker\(\)/, 'the console plus toggles the console picker');
  assert.match(js, /api\('\/api\/admin\/cora\/connectors'\)/, 'the console picker reads the same connectors registry as Integrations');
  assert.match(js, /api\('\/api\/admin\/provider-connections'\)/, 'the console picker reads the same provider connections');
  assert.match(js, /buildMessageRequest\(\{ channelId: state\.channelId, body, idempotencyKey: crypto\.randomUUID\(\), attachments: consoleAttach\.list \}\)/, 'console send builds its request through the picker model with its own list');
  assert.match(js, /consoleAttach\.list = \[\]; renderConsoleAttachChips\(\); closeConsolePicker\(\)/, 'a successful console send clears its own attachments');
  assert.match(js, /const consoleAttach = \{ list: \[\], open: false, data: null \}/, 'the console keeps a separate attach list from the workspace’s channel/cli lists');
});

test('the workspace renders the upload group as a file input wired to the model', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  assert.match(js, /type: 'file'/, 'a real file input, not a disabled button');
  assert.match(js, /fileRefusalReason\(\{ name: file\.name/, 'type/size are refused before the read');
  assert.match(js, /readFileAsBase64\(file\)/, 'the picked file is read to base64 for the metadata');
  assert.match(js, /addAttachment\(ws\.attach\[which\], \{ kind: 'file'/, 'the file joins the same attach list as skills and connectors');
});
