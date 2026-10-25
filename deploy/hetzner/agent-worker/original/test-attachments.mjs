// test-attachments.mjs — fixture proof for worker-attachments.mjs.
// No provider is called and no job is claimed: this exercises the real
// prompt-assembly code (agentPrompt + extractReply are sliced verbatim
// out of agent-worker.mjs) and the real attachment module, with fixture
// metadata. Run: node test-attachments.mjs (from the worker directory).
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareJobMessage, attachmentContextText } from './worker-attachments.mjs';

const src = readFileSync(new URL('./agent-worker.mjs', import.meta.url), 'utf8');
const slice = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to);
  if (a < 0 || b < 0 || b <= a) throw new Error(`slice markers not found: ${from} .. ${to}`);
  return src.slice(a, b);
};
const promptSeg = slice('// ---- prompt assembly', '// ---- end replication ----');
const replySeg = slice('const PROTOCOL_KEYS', '// messageId -> { count');
const { agentPrompt, extractReply } = new Function(`${promptSeg}\n${replySeg}\nreturn { agentPrompt, extractReply };`)();

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failures += 1; };

// ---------- Fixture A: connector + plugin + skill lead + webSearch ON,
// ---------- real job workspace (no command corpus there today)
const WS = '/opt/helmian-agentbox/workspaces/test-project';
const messageA = {
  id: 'fixture-a',
  authorName: 'Troy',
  authorKind: 'member',
  source: 'helmian',
  body: '/deep-dive on the wash-tag backlog',
  metadata: {
    attachments: [
      { kind: 'skill', name: 'deep-dive' },
      { kind: 'connector', key: 'slack', name: 'Slack' },
      { kind: 'plugin', name: 'field-notes' },
    ],
    webSearch: true,
  },
};
const prepA = await prepareJobMessage(messageA, { workspace: WS });
console.log('--- Fixture A: prepared body (real workspace, empty command corpus) ---');
console.log(prepA.body);
console.log('---');
check('A: no expansion against the empty real corpus', prepA.expandedName === null);
check('A: kinds recorded', prepA.attachmentKinds.join(',') === 'skill,connector,plugin');
check('A: skill line is the honest NOT-expanded variant', prepA.body.includes('Skill attached: /deep-dive. This channel runner could not expand the command for this turn'));
check('A: connector line is the bridge line verbatim', prepA.body.includes('Connector attached: Slack (slack). It is connected in this workspace, but Helmian has NO agent-side callable tool for this connector today: you cannot call it in this turn. Treat it as context only and do not claim you used it.'));
check('A: plugin line names what it would bring + runner honesty', prepA.body.includes("Plugin attached: field-notes. In a Helmian bridge turn, this plugin's approved MCP servers would be connected and their tools callable for the turn. This channel runner is a CLI/subprocess turn and cannot connect plugin tools"));
check('A: webSearch ON line is the bridge line verbatim', prepA.body.includes('Web search: the user turned it ON for this message, but Helmian has no web-search tool today — you cannot search the web in this turn. Say so plainly if the answer needs current web information.'));
check('A: original body preserved after the block', prepA.body.endsWith('/deep-dive on the wash-tag backlog'));

const promptGemini = agentPrompt({ provider: 'gemini', channelTitle: 'troy', members: ['gemini', 'grok'], context: [], message: { ...messageA, body: prepA.body }, source: 'helmian' });
const promptGrok = agentPrompt({ provider: 'grok', channelTitle: 'troy', members: ['gemini', 'grok'], context: [], message: { ...messageA, body: prepA.body }, source: 'helmian' });
console.log('--- Fixture A: EXACT prompt the gemini runner receives ---');
console.log(promptGemini);
console.log('--- Fixture A: EXACT prompt the grok runner receives ---');
console.log(promptGrok);
console.log('---');
check('A: gemini prompt carries the attachment block', promptGemini.includes('[Attached to this message — Helmian composer "+"]'));
check('A: grok prompt carries the attachment block', promptGrok.includes('[Attached to this message — Helmian composer "+"]'));

// ---------- Fixture B: real expansion via a temp workspace command file
const wsB = mkdtempSync(join(tmpdir(), 'bite2-ws-'));
mkdirSync(join(wsB, '.helmion', 'commands'), { recursive: true });
writeFileSync(join(wsB, '.helmion', 'commands', 'deep-dive.md'), `---
description: Deep-dive a topic
arguments: [topic]
---
Do a deep dive on $topic. Pull every thread on $ARGUMENTS, then summarize what matters.
`);
const messageB = { ...messageA, id: 'fixture-b', body: '/deep-dive wash-tag backlog' };
const prepB = await prepareJobMessage(messageB, { workspace: wsB });
console.log('--- Fixture B: prepared body (temp workspace WITH the command file) ---');
console.log(prepB.body);
console.log('---');
check('B: expansion resolved', prepB.expandedName === 'deep-dive');
check('B: body lead replaced by the expanded command', prepB.body.includes('Do a deep dive on wash-tag. Pull every thread on wash-tag backlog, then summarize what matters.'));
check('B: no slash lead remains in the prepared body', !prepB.body.includes('/deep-dive wash-tag backlog'));
check('B: skill line is the bridge expanded variant', prepB.body.includes('Skill attached: /deep-dive. If the message begins with that command it has already been expanded into the command\'s instructions for this turn.'));

// ---------- Fixture C: no metadata, plain body — byte-identical passthrough
const prepC = await prepareJobMessage({ id: 'fixture-c', body: 'hello there', authorName: 'Troy' }, { workspace: WS });
check('C: plain message untouched', prepC.body === 'hello there' && prepC.contextText === null && prepC.expandedName === null && prepC.metadataDropped === false);

// ---------- Fixture D: webSearch OFF line
const ctxD = attachmentContextText({ webSearch: false });
check('D: webSearch OFF line verbatim', ctxD === '[Attached to this message — Helmian composer "+"]\nWeb search: OFF for this turn — answer without web sources.\n[/Attached]');

// ---------- Fixture E: reply-quirk fix intact in the edited worker file
check('E: marker-only output is no reply', extractReply('{"end_of_turn": true}') === '');
check('E: text + trailing marker keeps the text', extractReply('Done.\n{"end_of_turn": true}') === 'Done.');
check('E: legit JSON answer preserved', extractReply('{"name": "x"}') === '{"name": "x"}');
check('E: normal text unchanged', extractReply('Built the page.') === 'Built the page.');
check('E: empty stays empty', extractReply('') === '');

// ---------- Fixture F: invalid metadata is dropped, job still runs
const prepF = await prepareJobMessage({ id: 'fixture-f', body: 'hi', metadata: { attachments: [{ kind: 'bogus' }] } }, { workspace: WS });
check('F: invalid metadata dropped, body untouched', prepF.metadataDropped === true && prepF.body === 'hi' && prepF.contextText === null);

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
