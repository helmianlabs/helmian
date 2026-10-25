import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  ATTACH_STATE, FILE_MAX_BYTES, MAX_ATTACHMENTS, UPLOAD_NOTE, WEB_SEARCH_NOTE, addAttachment, agentEcosystem, applySkillToBody,
  attachmentKey, attachmentMetadata, buildMessageRequest, classifyFile,
  fileRefusalReason, normalizeAgentKey, normalizeFileAttachment, normalizeSkillName,
  pickerModel, removeAttachment,
} from '../app/composer-picker.mjs';
// The REAL server validator the message route applies — imported, not
// re-implemented, so a picker-built plugin payload is proven against the
// allowlist + normalizer that will actually judge it (PR #97's shape).
import { normalizeMessageMetadata } from '../../../src/cloud/envoy-agents.mjs';

// The "+" picker model. Its facts are the Integrations registry's
// (PROVIDER_REGISTRY + connection truth, via integrationsModel)
// — these fixtures mirror the API payloads the loaders merge:
// GET /api/admin/cora/connectors (registrations), GET
// /api/admin/provider-connections (connections), GET
// /api/admin/tool-connections (probe receipts) and the runner presence
// feed. Shapes are the real ones the repositories return (bite 1b).
const CONNECTORS = { registrations: [{ provider: 'discord', lifecycle: 'enabled', enabled: true }], verifierStatus: {} };
const PROVIDERS = { connections: [{ providerId: 'google', lifecycle: 'verified' }] };
// Mirrors GET /api/admin/plugins (src/cloud/installed-plugins.mjs): the
// enabled plugins of the bridge workspace, each with what it brings.
const PLUGINS = {
  plugins: [
    { name: 'calc', version: '1.0.0', brings: 'Brings 1 approved tool server — their tools join the turn; adds its commands as skills.', tools: true, commands: true },
    { name: 'greeter', brings: 'Adds its commands as skills.', tools: false, commands: true },
  ],
  unavailable: [],
};
const NOW = Date.parse('2026-10-25T18:00:00.000Z');
const model = pickerModel({ connectors: CONNECTORS, providers: PROVIDERS, plugins: PLUGINS });
const group = (id) => model.groups.find((g) => g.id === id);
// The same facts, plus a fresh verified probe receipt for GitHub — the
// one service the registry carries — so attach tests have a connector
// whose truth says connected.
const connectedModel = pickerModel({ connectors: CONNECTORS, providers: PROVIDERS, plugins: PLUGINS, presence: [],
  toolConnections: [{ serviceId: 'github', state: 'verified', lastVerifiedAt: '2026-10-25T17:45:00.000Z' }], now: NOW });
const catalog = connectedModel.groups.find((g) => g.id === 'connectors').items;
const pluginCatalog = group('plugins').items;

test('picker groups are the six agents, then connectors, plugins, upload, web-search — in that order', () => {
  assert.deepEqual(model.groups.map((g) => g.id), ['agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'connectors', 'plugins', 'upload', 'web-search']);
  assert.equal(model.agent, null, 'no agent in context → no agent group leads');
});

test('web-search group is a per-message toggle with the agent-honest note', () => {
  const ws = group('web-search');
  assert.equal(ws.toggle, true);
  assert.deepEqual(ws.items, [], 'a toggle carries no attachable items');
  assert.equal(ws.note, WEB_SEARCH_NOTE);
  assert.match(ws.note, /Claude searches for real/, 'the note says which agent is real');
  assert.match(ws.note, /say plainly/, 'and that the others say so instead of pretending');
});

test('plugins group is the installed list from the bridge, with what each brings', () => {
  assert.deepEqual(pluginCatalog.map((i) => i.name), ['calc', 'greeter']);
  assert.match(pluginCatalog[0].brings, /approved tool server/);
  assert.match(group('plugins').note, /PC bridge/);
  assert.deepEqual(pickerModel({}).groups.find((g) => g.id === 'plugins').items, [], 'no list yet → an empty group, never invented plugins');
});

test('connectors group holds services only — GitHub from the registry today', () => {
  assert.deepEqual(group('connectors').items.map((i) => i.key), ['github'], 'the registry\'s one service; everything else in it is a mirror or an agent');
  const github = group('connectors').items[0];
  assert.equal(github.name, 'GitHub');
  assert.equal(github.kindLabel, 'Code');
  assert.equal(github.statusText, 'Not connected', 'no probe row yet → the registry answer');
  // The mirrors (Slack, Discord) and the agents (Claude, ChatGPT, Grok,
  // Gemini) are connector rows NOWHERE in the picker.
  for (const key of ['slack', 'discord', 'anthropic', 'openai', 'xai', 'google']) {
    assert.ok(!catalog.some((i) => i.key === key), `${key} is not a connector`);
  }
  const everyItem = model.groups.flatMap((g) => g.items);
  assert.ok(!everyItem.some((i) => i.key === 'slack' || i.key === 'discord'), 'mirror rows appear nowhere in the picker model');
  assert.ok(!everyItem.some((i) => i.name === 'Slack' || i.name === 'Discord'), 'mirrors are not listed at all');
});

test('connectors group renders probe truth for tool connections (bite 1b)', () => {
  const now = Date.parse('2026-10-25T18:00:00.000Z');
  const withRows = pickerModel({ connectors: CONNECTORS, providers: PROVIDERS, plugins: PLUGINS, presence: [],
    toolConnections: [{ serviceId: 'github', state: 'failed', lastVerifiedAt: null, lastError: 'connection refused' }], now });
  const github = withRows.groups.find((g) => g.id === 'connectors').items.find((i) => i.key === 'github');
  assert.deepEqual([github.connected, github.statusText, github.source], [false, 'Check failed', 'tool-connections'], 'a failed probe is what the panel says');
  const verified = pickerModel({ connectors: CONNECTORS, providers: PROVIDERS, plugins: PLUGINS, presence: [],
    toolConnections: [{ serviceId: 'github', state: 'verified', lastVerifiedAt: '2026-10-25T17:45:00.000Z' }], now });
  const gh2 = verified.groups.find((g) => g.id === 'connectors').items.find((i) => i.key === 'github');
  assert.deepEqual([gh2.connected, gh2.statusText], [true, 'Connected'], 'a fresh verified receipt is the only road to Connected');
});

test('skills live under their agent: every agent group attaches by name, no invented list anywhere', () => {
  assert.ok(!model.groups.some((g) => g.id === 'skills'), 'no standalone skills group — a skill belongs to an agent');
  for (const g of model.groups.filter((x) => x.id === 'agent')) {
    assert.equal(g.byName, true, `${g.agent}'s skills attach by name from its own group`);
    assert.deepEqual(g.items.filter((i) => i.kind === 'skill'), [], 'no invented skill rows');
    assert.match(g.note, /PC bridge/);
  }
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
  const r = addAttachment([], conn('github'), { catalog });
  assert.equal(r.added, true);
  assert.deepEqual(r.list, [{ kind: 'connector', key: 'github', name: 'GitHub' }]);
});

test('addAttachment refuses connectors the registry does not have or that are not connected', () => {
  assert.match(addAttachment([], conn('github'), { catalog: group('connectors').items }).reason, /not connected/, 'the same service, without the probe receipt, refuses');
  assert.equal(addAttachment([], conn('nope'), { catalog }).added, false);
  assert.match(addAttachment([], conn('nope'), { catalog }).reason, /not in the registry/);
  assert.match(addAttachment([], conn('discord'), { catalog }).reason, /not in the registry/, 'a mirror is not a connector at all');
  assert.match(addAttachment([], conn('google'), { catalog }).reason, /not in the registry/, 'an agent is not a connector');
});

test('addAttachment dedupes and caps the list', () => {
  const one = addAttachment([], skill('deploy')).list;
  assert.equal(addAttachment(one, skill('deploy')).reason, 'Already attached.');
  let list = addAttachment([], conn('github'), { catalog }).list;
  list = addAttachment(list, skill('review')).list;
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
  const list = [skill('deploy'), { kind: 'connector', key: 'github', name: 'GitHub' }];
  assert.deepEqual(removeAttachment(list, conn('github')), [skill('deploy')]);
  assert.deepEqual(removeAttachment(list, skill('other')), list);
  assert.equal(attachmentKey(skill('deploy')), 'skill:deploy');
  assert.equal(attachmentKey(conn('github')), 'connector:github');
  assert.equal(attachmentKey(null), null);
});

test('attachmentMetadata is the structured carry: plain JSON, null when empty', () => {
  assert.equal(attachmentMetadata([]), null);
  const meta = attachmentMetadata([skill('deploy'), { kind: 'connector', key: 'github', name: 'GitHub' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(meta)), {
    attachments: [{ kind: 'skill', name: 'deploy' }, { kind: 'connector', key: 'github', name: 'GitHub' }],
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
  const req = buildMessageRequest({ channelId: 'c1', body: 'ship it', idempotencyKey: 'k1', attachments: [skill('deploy'), { kind: 'connector', key: 'github', name: 'GitHub' }] });
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
  assert.match(js, /buildMessageRequest\(\{ channelId: ws\.channelId, body, idempotencyKey: key, attachments: ws\.attach\.channel, webSearch: ws\.webSearch\.channel \}\)/, 'channel send builds its request through the picker model, web-search toggle included');
  assert.match(js, /attachments: ws\.attach\.cli/, 'agent-chat send carries its own attachments');
  assert.match(js, /attachments: ws\.attach\.cli, webSearch: ws\.webSearch\.cli/, 'agent-chat send carries its own web-search toggle');
  assert.match(js, /g\.id === 'web-search'/, 'the workspace picker renders the web-search toggle group');
  assert.match(js, /ws\.webSearch\[which\] = !on/, 'the toggle flips per-composer state, never the attach list');
  assert.match(js, /api\('\/api\/admin\/cora\/connectors'\)/, 'the picker reads the same connectors registry as Integrations');
  assert.match(js, /api\('\/api\/admin\/plugins'\)/, 'the picker reads the installed-plugins list the bridge ledger backs');
});

test('the picker model reuses the Integrations registry instead of inventing one', async () => {
  const src = await readFile(new URL('../app/composer-picker.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \{ bestToolConnectionStatus, integrationsModel \} from '\.\/app-model\.mjs'/, 'connection truth comes from the same model the Integrations page renders');
});

test('a third attach list (the session console’s) is independent of the other composers’ lists', () => {
  const channelList = addAttachment([], conn('github'), { catalog }).list;
  const consoleList = addAttachment([], skill('deploy')).list;
  assert.deepEqual(channelList.map(attachmentKey), ['connector:github']);
  assert.deepEqual(consoleList.map(attachmentKey), ['skill:deploy']);
  assert.deepEqual(removeAttachment(consoleList, skill('deploy')), [], 'clearing the console list empties only it');
  assert.deepEqual(channelList.map(attachmentKey), ['connector:github'], 'the channel list is untouched');
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
  assert.match(js, /buildMessageRequest\(\{ channelId: state\.channelId, body, idempotencyKey: crypto\.randomUUID\(\), attachments: consoleAttach\.list, webSearch: consoleAttach\.webSearch \}\)/, 'console send builds its request through the picker model with its own list and toggle');
  assert.match(js, /consoleAttach\.list = \[\]; consoleAttach\.webSearch = false; renderConsoleAttachChips\(\); closeConsolePicker\(\)/, 'a successful console send clears its own attachments and toggle');
  assert.match(js, /const consoleAttach = \{ list: \[\], webSearch: false, open: false, data: null \}/, 'the console keeps a separate attach list and toggle from the workspace’s channel/cli state');
  assert.match(js, /g\.id === 'web-search'/, 'the console picker renders the web-search toggle group too');
});

test('the workspace renders the upload group as a file input wired to the model', async () => {
  const js = await readFile(new URL('../app/envoy-workspace.js', import.meta.url), 'utf8');
  assert.match(js, /type: 'file'/, 'a real file input, not a disabled button');
  assert.match(js, /fileRefusalReason\(\{ name: file\.name/, 'type/size are refused before the read');
  assert.match(js, /readFileAsBase64\(file\)/, 'the picked file is read to base64 for the metadata');
  assert.match(js, /addAttachment\(ws\.attach\[which\], \{ kind: 'file'/, 'the file joins the same attach list as skills and connectors');
});

// ---- the web-search toggle: reachable in the composer, carried as
// ---- metadata.webSearch, accepted by the REAL server normalizer, and
// ---- absent (byte-identical wire) when off — the flag every consumer
// ---- already reads (bridge resolver, cloud worker) but no composer
// ---- could set before.

test('web search ON with nothing attached still produces metadata — and the server accepts it', () => {
  const meta = attachmentMetadata([], { webSearch: true });
  assert.deepEqual(JSON.parse(JSON.stringify(meta)), { webSearch: true });
  assert.deepEqual(normalizeMessageMetadata(meta), meta, 'the canonical validator keeps the flag');
  const req = buildMessageRequest({ channelId: 'c1', body: 'what happened today?', idempotencyKey: 'kw1', webSearch: true });
  assert.deepEqual(Object.keys(req.payload).sort(), ['body', 'channelId', 'idempotencyKey', 'metadata'], 'the flag rides the payload on its own');
  assert.deepEqual(req.payload.metadata, { webSearch: true });
  assert.equal(req.payload.body, 'what happened today?', 'the body is untouched');
});

test('web search ON rides alongside attachments in the same metadata object', () => {
  const req = buildMessageRequest({ channelId: 'c1', body: 'see attached', idempotencyKey: 'kw2', attachments: [skill('deploy')], webSearch: true });
  assert.deepEqual(JSON.parse(JSON.stringify(req.metadata)), {
    attachments: [{ kind: 'skill', name: 'deploy' }],
    webSearch: true,
  });
  assert.deepEqual(normalizeMessageMetadata(req.payload.metadata), req.metadata, 'the combined shape is the stored shape');
});

test('web search OFF (or never touched) is the pre-toggle wire, byte for byte', () => {
  assert.equal(attachmentMetadata([], { webSearch: false }), null);
  assert.equal(attachmentMetadata([], {}), null);
  const off = buildMessageRequest({ channelId: 'c1', body: 'hi', idempotencyKey: 'kw3', webSearch: false });
  assert.equal(off.metadata, null);
  assert.deepEqual(Object.keys(off.payload).sort(), ['body', 'channelId', 'idempotencyKey'], 'no metadata key at all when off');
  const withAtt = buildMessageRequest({ channelId: 'c1', body: 'hi', idempotencyKey: 'kw4', attachments: [skill('deploy')], webSearch: false });
  assert.deepEqual(JSON.parse(JSON.stringify(withAtt.metadata)), { attachments: [{ kind: 'skill', name: 'deploy' }] }, 'no webSearch key appears when off');
});

// ---- the agents section ----
// The plus is for the agents first: six agent groups — ChatGPT,
// Antigravity, Claude, Grok, Claude Code, Gemini — each carrying its
// own connection row, its by-name skills and the bridge plugins. The
// room's agent leads in a private room. Connectors are services only,
// and the truth rules hold throughout: a connector is note-only, never
// "connected"; plugins work; an agent's own row reports its connection
// and can never be attached as anything.

const agentGroupsOf = (m) => m.groups.filter((g) => g.id === 'agent');
const agentRowOf = (m, agentKey) => agentGroupsOf(m).find((g) => g.agent === agentKey).items[0];
const SIX_AGENTS = ['openai', 'antigravity', 'claude', 'grok', 'claude-code', 'gemini'];

test('agents section: exactly the six agents, in Troy\'s order', () => {
  assert.deepEqual(agentGroupsOf(model).map((g) => g.agent), SIX_AGENTS);
  assert.deepEqual(agentGroupsOf(model).map((g) => g.title),
    ['ChatGPT\'s ecosystem', 'Antigravity\'s ecosystem', 'Claude\'s ecosystem', 'Grok\'s ecosystem', 'Claude Code\'s ecosystem', 'Gemini\'s ecosystem']);
  for (const g of agentGroupsOf(model)) {
    assert.equal(g.section, 'agents');
    assert.equal(g.lead, false, 'no agent in context → nobody leads');
  }
});

test('agents section: each agent carries its own connection row and the bridge plugins', () => {
  for (const g of agentGroupsOf(model)) {
    const row = g.items[0];
    assert.equal(row.kind, 'provider', `${g.agent}'s first row is its own connection, a status — never an attachment`);
    assert.equal(row.agent, g.agent);
    assert.equal(row.kindLabel, 'This agent\'s connection');
    assert.deepEqual(g.items.slice(1).map((i) => i.name), ['calc', 'greeter'], 'the bridge plugins the agent can be handed ride in its group too');
    for (const item of g.items.slice(1)) assert.equal(item.state, 'connected', 'an installed plugin really works on the turn');
  }
  // The fixtures' facts: PROVIDERS verifies a google connection.
  assert.deepEqual(
    { kind: agentRowOf(model, 'gemini').kind, key: agentRowOf(model, 'gemini').key, name: agentRowOf(model, 'gemini').name, connected: agentRowOf(model, 'gemini').connected, state: agentRowOf(model, 'gemini').state },
    { kind: 'provider', key: 'google', name: 'Gemini', connected: true, state: 'connected' },
    'Gemini\'s row reports its own connection from the same registry facts');
  assert.equal(agentRowOf(model, 'gemini').stateLabel, 'Works');
  assert.equal(agentRowOf(model, 'antigravity').connected, true, 'Antigravity runs on the Google connection');
  assert.equal(agentRowOf(model, 'claude').connected, false, 'no anthropic connection in the fixtures');
  assert.equal(agentRowOf(model, 'claude-code').connected, false, 'Claude Code reads the same anthropic facts');
});

test('agents section: the room\'s agent leads in a private room, the rest follow in order', () => {
  const m = pickerModel({ connectors: CONNECTORS, providers: PROVIDERS, plugins: PLUGINS, agent: 'gemini' });
  assert.equal(m.agent, 'gemini');
  assert.deepEqual(agentGroupsOf(m).map((g) => g.agent), ['gemini', 'openai', 'antigravity', 'claude', 'grok', 'claude-code']);
  assert.equal(agentGroupsOf(m)[0].lead, true);
  assert.ok(agentGroupsOf(m).slice(1).every((g) => g.lead === false));
  assert.equal(agentGroupsOf(m)[0].title, 'Gemini\'s ecosystem');
  assert.equal(agentGroupsOf(m)[0].byName, true, 'the agent\'s skills attach by name from its own group');
  assert.match(agentGroupsOf(m)[0].note, /Gemini's own skills, plugins and commands/);
  assert.deepEqual(m.groups.map((g) => g.id), ['agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'connectors', 'plugins', 'upload', 'web-search'], 'agents first, then the shared groups in their order');
});

test('agents section: an agent named any way its surfaces name it resolves to its group', () => {
  assert.equal(pickerModel({ agent: 'ChatGPT' }).agent, 'openai', 'display name');
  assert.equal(pickerModel({ agent: 'openai' }).agent, 'openai', 'agent key');
  assert.equal(pickerModel({ agent: 'google' }).agent, 'gemini', 'registry key');
  assert.equal(pickerModel({ agent: 'anthropic' }).agent, 'claude', 'registry key');
  assert.equal(pickerModel({ agent: 'xai' }).agent, 'grok', 'registry key');
  assert.equal(pickerModel({ agent: 'Claude Code' }).agent, 'claude-code', 'display name');
  assert.equal(pickerModel({ agent: 'Antigravity' }).agent, 'antigravity', 'display name');
  assert.equal(normalizeAgentKey('Gemini'), 'gemini');
  assert.equal(normalizeAgentKey(' chatgpt '), 'openai');
  assert.equal(normalizeAgentKey('claude code'), 'claude-code');
  assert.equal(normalizeAgentKey('agy'), 'antigravity');
  assert.equal(agentEcosystem('Grok').registryKey, 'xai');
  assert.equal(agentEcosystem('Claude Code').registryKey, 'anthropic');
  assert.equal(agentEcosystem('Antigravity').registryKey, 'google');
});

test('agents section: Maestro and unknown agents lead nothing — the six still stand in order', () => {
  for (const agent of [null, undefined, 'maestro', 'Maestro', 'nonsense', '']) {
    const m = pickerModel({ connectors: CONNECTORS, providers: PROVIDERS, plugins: PLUGINS, agent });
    assert.equal(m.agent, null);
    assert.deepEqual(agentGroupsOf(m).map((g) => g.agent), SIX_AGENTS, `agent ${JSON.stringify(agent)} → the six in their plain order`);
    assert.ok(agentGroupsOf(m).every((g) => g.lead === false));
  }
  assert.equal(normalizeAgentKey('maestro'), null, 'Maestro is the human manager, never an agent');
  assert.equal(agentEcosystem('maestro'), null);
});

test('state truthfulness: a connector with no real door NEVER renders as connected', () => {
  const models = [
    model, connectedModel,
    ...SIX_AGENTS.map((agent) => pickerModel({ connectors: CONNECTORS, providers: PROVIDERS, plugins: PLUGINS, agent })),
  ];
  for (const m of models) {
    for (const g of m.groups) {
      for (const item of g.items) {
        if (item.kind === 'connector') {
          assert.notEqual(item.state, ATTACH_STATE.CONNECTED, `${item.key} must never claim to work — attaching it is a note`);
          assert.equal(item.state, item.connected ? ATTACH_STATE.NOTE_ONLY : ATTACH_STATE.NOT_CONNECTED);
        }
      }
    }
  }
  // The fixtures' facts, stated plainly: GitHub with a fresh verified
  // probe receipt is attachable but note-only; without one it is not
  // connected. Plugins are the working exception.
  const gh = catalog.find((i) => i.key === 'github');
  assert.equal(gh.state, 'note-only');
  assert.equal(gh.stateLabel, 'Note only');
  const ghPlain = group('connectors').items.find((i) => i.key === 'github');
  assert.equal(ghPlain.state, 'not-connected');
  assert.equal(ghPlain.stateLabel, 'Not connected');
  assert.match(model.groups.find((g) => g.id === 'connectors').note, /hands the agent a note/, 'the connectors group says what attaching does, in plain words');
  for (const item of group('plugins').items) {
    assert.equal(item.state, 'connected');
    assert.equal(item.stateLabel, 'Works');
  }
});

test('state truthfulness: an agent\'s own row follows the same facts — no connection, no claim', () => {
  const m = pickerModel({ connectors: {}, providers: {}, plugins: {}, agent: 'claude' });
  const row = agentRowOf(m, 'claude');
  assert.equal(row.key, 'anthropic');
  assert.equal(row.connected, false);
  assert.equal(row.state, 'not-connected', 'an unconnected agent row says so');
  const connected = pickerModel({ connectors: {}, providers: { connections: [{ providerId: 'anthropic', lifecycle: 'verified' }] }, plugins: {}, agent: 'claude' });
  assert.equal(agentRowOf(connected, 'claude').state, 'connected', 'the row is connected only when the registry says the provider connection exists');
  assert.equal(agentRowOf(connected, 'claude-code').state, 'connected', 'Claude Code runs on the same Claude connection');
  assert.equal(agentRowOf(connected, 'gemini').state, 'not-connected', 'other agents\' rows are untouched by it');
});

test('agents are never attachable — not as their own row, not as connector notes', () => {
  const m = pickerModel({ connectors: CONNECTORS, providers: PROVIDERS, plugins: PLUGINS, agent: 'gemini' });
  const geminiItems = agentGroupsOf(m)[0].items;
  const asConnector = addAttachment([], { kind: 'connector', key: 'google' }, { catalog: geminiItems });
  assert.equal(asConnector.added, false, 'the agent\'s own row is a status, not an attachment');
  assert.match(asConnector.reason, /not in the registry/);
  const plugin = addAttachment([], { kind: 'plugin', name: 'calc' }, { catalog: geminiItems });
  assert.equal(plugin.added, true, 'plugins still attach from the agent group catalog');
  assert.deepEqual(plugin.list, [{ kind: 'plugin', name: 'calc' }]);
  // And an agent as its own kind is refused outright.
  assert.equal(addAttachment([], { kind: 'provider', key: 'google' }).added, false);
});

test('connectors: a service earns its row from tool-connections data alone', () => {
  const m = pickerModel({ connectors: {}, providers: {}, plugins: {}, presence: [],
    toolConnections: [
      { serviceId: 'vercel', state: 'verified', lastVerifiedAt: '2026-10-25T17:45:00.000Z', accountLabel: 'Vercel' },
      { serviceId: 'slack', state: 'verified', lastVerifiedAt: '2026-10-25T17:45:00.000Z' },
    ], now: NOW });
  const items = m.groups.find((g) => g.id === 'connectors').items;
  const vercel = items.find((i) => i.key === 'vercel');
  assert.ok(vercel, 'a service with a real probe row appears — Vercel included, the day its data exists');
  assert.deepEqual([vercel.name, vercel.connected, vercel.statusText, vercel.state, vercel.stateLabel],
    ['Vercel', true, 'Connected', 'note-only', 'Note only'], 'the probe\'s truth — and still only a note on the turn');
  assert.ok(!items.some((i) => i.key === 'slack'), 'a mirror stays out even when a tool-connections row names it');
  assert.ok(!group('connectors').items.some((i) => i.key === 'vercel'), 'no data → no invented row');
});

test('picker copy carries neither retired word', () => {
  const models = [model, connectedModel, pickerModel({ connectors: CONNECTORS, providers: PROVIDERS, plugins: PLUGINS, agent: 'gemini' })];
  for (const m of models) {
    const json = JSON.stringify(m);
    assert.ok(!/helper/i.test(json), 'no "helper" anywhere in the picker model');
    assert.ok(!/\bseat\b/i.test(json), 'no "seat" anywhere in the picker model');
  }
  assert.ok(!/helper/i.test(WEB_SEARCH_NOTE) && !/\bseat\b/i.test(WEB_SEARCH_NOTE), 'the exported notes are clean too');
  assert.ok(!/\bseat\b/i.test(UPLOAD_NOTE));
});

test('the session console builds its picker for the active session\'s agent', async () => {
  const js = await readFile(new URL('../app/app.js', import.meta.url), 'utf8');
  assert.match(js, /pickerModel\(\{ \.\.\.consoleAttach\.data, agent: consolePickerAgent\(\) \}\)/, 'the console renders the per-agent model for the session in context');
  assert.match(js, /function consolePickerAgent\(\)/, 'the console resolves its agent from the active session');
  assert.match(js, /g\.id === 'agent'/, 'the console renders the ecosystem group');
  assert.match(js, /item\.stateLabel/, 'the console shows the truthful state labels, not a blanket Connected');
});
