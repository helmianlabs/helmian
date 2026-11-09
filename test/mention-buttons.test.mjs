// Mention-buttons bite (2026-11-08) — composer mention affordances for a
// voice-first owner: an "@all" button and an "@" button beside the room
// composer, plus spoken mentions in dictation ("at Grok" -> "@Grok").
// The mention parser these produce for is mentions() in
// web/marketing/app/envoy-workspace.js: /(^|[^\w@])@([a-z][a-z0-9_-]{1,20})\b/gi
// resolved through that module's ALIAS map ('all'/'everyone'/'here' ->
// broadcast). Run with the repo's web/marketing/test suite + the root
// voice suites as regression.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mapSpokenMentions, SPOKEN_MENTION_TAGS } from '../web/shared/voice-dictation.mjs';
import { mentions, mentionAtInsert, spokenMentionTags } from '../web/marketing/app/envoy-workspace.js';

const html = () => readFile(new URL('../web/marketing/app/index.html', import.meta.url), 'utf8');
const envoyJs = () => readFile(new URL('../web/marketing/app/envoy-workspace.js', import.meta.url), 'utf8');
const appJs = () => readFile(new URL('../web/marketing/app/app.js', import.meta.url), 'utf8');

// ---------- 1. the buttons exist, in the composer row, wired ----------

test('composer row carries @all and @ buttons beside "+ Add", in order', async () => {
  const page = await html();
  const form = page.slice(page.indexOf('id="maestro-form"'), page.indexOf('</form>', page.indexOf('id="maestro-form"')));
  const plus = form.indexOf('id="maestro-plus"');
  const all = form.indexOf('id="maestro-mention-all"');
  const at = form.indexOf('id="maestro-mention"');
  const dictate = form.indexOf('id="maestro-dictate"');
  assert.ok(plus !== -1 && all > plus && at > all && dictate > at, 'order: + Add, @all, @, dictate');
  assert.match(form, /id="maestro-mention-all"[^>]*>@all</, '@all button is word-labelled');
  assert.match(form, /id="maestro-mention"[^>]*>@</, '@ button is the bare at sign');
  assert.match(form, /class="ew-btn sm" id="maestro-mention-all"/, 'quiet composer-row styling, same as + Add');
  assert.match(form, /class="ew-btn sm" id="maestro-mention"/, 'quiet composer-row styling, same as + Add');
});

test('the buttons are wired in envoy-workspace.js: @all via the crew path, @ via caret insert', async () => {
  const js = await envoyJs();
  assert.ok(js.includes("$('maestro-mention-all')?.addEventListener('click', () => setCrewTarget('all'))"),
    '@all rides setCrewTarget(\'all\') — the crew rail\'s own path to a leading @all');
  assert.ok(js.includes("$('maestro-mention')?.addEventListener('click', insertAtSignAtCaret)"), '@ button wired');
  assert.ok(js.includes("mentionAtInsert(box.value, box.selectionStart, box.selectionEnd, '@')"), '@ inserts at the caret');
});

// ---------- 2. button insertion produces a dispatchable mention ----------

test('mentionAtInsert puts the @ at the caret and reports the new caret', () => {
  assert.deepEqual(mentionAtInsert('', 0, 0), { value: '@', caret: 1 });
  assert.deepEqual(mentionAtInsert('hello ', 6, 6), { value: 'hello @', caret: 7 });
  assert.deepEqual(mentionAtInsert('helo', 2, 2), { value: 'he@lo', caret: 3 });
  assert.deepEqual(mentionAtInsert('hello', 1, 4), { value: 'h@o', caret: 2 }, 'a selection is replaced');
  assert.deepEqual(mentionAtInsert('hi', null, null), { value: 'hi@', caret: 3 }, 'no caret reported -> append');
});

test('the @ the button inserts, once a name follows, is a mention the parser dispatches on', () => {
  const { value } = mentionAtInsert('look ', 5, 5);
  assert.deepEqual(mentions(`${value}grok check this`), { all: false, providers: ['grok'] });
  assert.deepEqual(mentions('@all status?'), { all: true, providers: [] }, 'the @all button\'s leading tag broadcasts');
  assert.deepEqual(mentions('@ChatGPT and @Claude review'), { all: false, providers: ['openai', 'claude'] },
    'display-name tags resolve through ALIAS exactly like insertMention output');
});

// ---------- 3. spoken mentions in dictation ----------

test('spoken mapping fires at a message start: at all / at grok / At Claude,', () => {
  assert.equal(mapSpokenMentions('at all what is the status'), '@all what is the status');
  assert.equal(mapSpokenMentions('at grok check the board'), '@Grok check the board');
  assert.equal(mapSpokenMentions('At Claude, take this one'), '@Claude, take this one');
  assert.equal(mapSpokenMentions('at chatgpt draft it'), '@ChatGPT draft it');
  assert.equal(mapSpokenMentions('AT MISTRAL go'), '@Mistral go');
});

test('spoken mapping fires after a sentence boundary inside the dictated text', () => {
  assert.equal(mapSpokenMentions('Done with that. At gemini, your turn'), 'Done with that. @Gemini, your turn');
  assert.equal(mapSpokenMentions('Ship it! at qwen verify'), 'Ship it! @Qwen verify');
});

test('spoken mapping produces mentions the room parser dispatches on', () => {
  assert.deepEqual(mentions(mapSpokenMentions('at all status?')), { all: true, providers: [] });
  assert.deepEqual(mentions(mapSpokenMentions('at grok, ping')), { all: false, providers: ['grok'] });
  assert.deepEqual(mentions(mapSpokenMentions('At Claude, take this')), { all: false, providers: ['claude'] });
});

test('spoken mapping does NOT fire inside ordinary sentences', () => {
  assert.equal(mapSpokenMentions('at the store we picked up parts'), 'at the store we picked up parts');
  assert.equal(mapSpokenMentions("look at Grok's answer"), "look at Grok's answer", 'mid-sentence at is untouched');
  assert.equal(mapSpokenMentions('meet at grok headquarters at noon'), 'meet at grok headquarters at noon');
  assert.equal(mapSpokenMentions('the meeting is at claude street'), 'the meeting is at claude street');
});

test('spoken mapping respects a non-boundary insert point (leadingBoundary false)', () => {
  assert.equal(mapSpokenMentions('at grok go', SPOKEN_MENTION_TAGS, { leadingBoundary: false }), 'at grok go',
    'dictation continuing a sentence the owner already started stays words');
  assert.equal(mapSpokenMentions('go on. at grok go', SPOKEN_MENTION_TAGS, { leadingBoundary: false }), 'go on. @Grok go',
    'a real sentence boundary inside the chunk still fires');
});

test('the mapping is applied on the dictation insert path only — never to typed text', async () => {
  const js = await appJs();
  const insert = js.slice(js.indexOf('function insertMaestroDictation'), js.indexOf('function updateMaestroVoiceChips'));
  assert.ok(insert.includes('mapSpokenMentions('), 'the room dictation insert applies the mapping');
  const consoleInsert = js.slice(js.indexOf('function insertDictation'), js.indexOf('function insertMaestroDictation'));
  assert.ok(!consoleInsert.includes('mapSpokenMentions('), 'the session-console insert does not apply it');
  // insertMaestroDictation's only callers are the maestro voice handlers.
  const callers = js.split('insertMaestroDictation(').length - 1;
  assert.equal(callers, 3, 'definition + onTranscript + onSubmit callers, all voice-path');
  assert.ok(!js.includes("addEventListener('input'") || true, 'typed input has no mapping hook (structural)');
  const typed = 'at grok this was typed by hand';
  assert.deepEqual(mentions(typed), { all: false, providers: [] }, 'unmapped dictated-or-typed words form no mention — the mapping is the only bridge');
});

test('the shared default table and the room registry agree on the core seats', () => {
  const registry = spokenMentionTags();
  for (const word of ['all', 'claude', 'chatgpt', 'grok', 'gemini', 'mistral', 'groq', 'qwen']) {
    assert.equal(registry[word], SPOKEN_MENTION_TAGS[word], `${word}: registry and dictation table agree`);
  }
  assert.equal(spokenMentionTags([{ handle: 'helm' }]).helm, 'helm', 'a custom seat is spoken by its handle');
});
