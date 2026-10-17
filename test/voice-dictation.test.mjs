// Voice mode controller tests: no DOM, fake injected Recognition and
// speechSynthesis. The controller is the canonical
// web/shared/voice-dictation.mjs (inlined into the /app bundle).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceController, stripSpeechMarkup, chunkForSpeech } from '../web/shared/voice-dictation.mjs';

function makeFakes() {
  const instances = [];
  class FakeRecognition {
    constructor() { instances.push(this); this.started = false; this.stopped = false; }
    start() { this.started = true; }
    stop() { this.stopped = true; this.onend?.(); }
  }
  const spoken = [];
  let cancelled = 0;
  const synthesis = {
    speak(u) { spoken.push(u); },
    cancel() { cancelled++; },
    speaking: false,
  };
  class FakeUtterance { constructor(text) { this.text = text; } }
  return { instances, FakeRecognition, spoken, synthesis, FakeUtterance, get cancelled() { return cancelled; } };
}

function resultEvent(transcripts, final = true) {
  return { results: transcripts.map((t) => ({ isFinal: final, 0: { transcript: t }, length: 1 })) };
}

function voiceOn(f, extra = {}) {
  const states = [];
  const errors = [];
  const transcripts = [];
  const submits = [];
  const v = createVoiceController({ Recognition: f.FakeRecognition, synthesis: f.synthesis, Utterance: f.FakeUtterance });
  const ok = v.setVoiceMode(true, {
    onTranscript: (t) => transcripts.push(t),
    onSubmit: (t) => submits.push(t),
    onState: (s) => states.push(s),
    onError: (e) => errors.push(e),
    ...extra,
  });
  return { v, states, errors, transcripts, submits, ok };
}

test('supported is true when Recognition is a function', () => {
  const f = makeFakes();
  assert.equal(createVoiceController({ Recognition: f.FakeRecognition }).supported, true);
});

test('supported is false when Recognition is missing', () => {
  assert.equal(createVoiceController({ Recognition: undefined }).supported, false);
});

test('setVoiceMode(true) on unsupported calls onError and returns false', () => {
  const errors = [];
  const v = createVoiceController({ Recognition: undefined });
  assert.equal(v.setVoiceMode(true, { onError: (e) => errors.push(e) }), false);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not supported/);
});

test('setVoiceMode(true) starts a turn and reports listening', () => {
  const f = makeFakes();
  const { v, states, ok } = voiceOn(f);
  assert.equal(ok, true);
  assert.equal(v.voiceMode, true);
  assert.equal(f.instances.length, 1);
  assert.equal(f.instances[0].started, true);
  f.instances[0].onstart();
  assert.deepEqual(states, ['listening']);
  assert.equal(v.listening, true);
});

test('setVoiceMode(true) twice is a no-op', () => {
  const f = makeFakes();
  const { v } = voiceOn(f);
  assert.equal(v.setVoiceMode(true, {}), false);
  assert.equal(f.instances.length, 1);
});

test('final transcript calls onTranscript', () => {
  const f = makeFakes();
  const { transcripts } = voiceOn(f);
  f.instances[0].onstart();
  f.instances[0].onresult(resultEvent(['hello world']));
  assert.deepEqual(transcripts, ['hello world']);
});

test('interim-only results do not call onTranscript', () => {
  const f = makeFakes();
  const { transcripts } = voiceOn(f);
  f.instances[0].onstart();
  f.instances[0].onresult(resultEvent(['hel'], false));
  assert.deepEqual(transcripts, []);
});

test('onerror maps known codes to honest messages', () => {
  const cases = [
    ['not-allowed', 'Microphone permission was not granted. Nothing was recorded.'],
    ['no-speech', 'No speech detected — try again.'],
    ['audio-capture', 'No microphone found.'],
    ['network', "The browser's speech service is unavailable."],
    ['service-not-allowed', "The browser's speech service is unavailable."],
    ['mystery-code', 'Dictation stopped before a usable transcript was produced.'],
  ];
  for (const [code, expected] of cases) {
    const f = makeFakes();
    const { errors } = voiceOn(f);
    f.instances[0].onstart();
    f.instances[0].onerror({ error: code });
    assert.deepEqual(errors, [expected], `code ${code}`);
  }
});

test('aborted error is silent', () => {
  const f = makeFakes();
  const { errors } = voiceOn(f);
  f.instances[0].onstart();
  f.instances[0].onerror({ error: 'aborted' });
  assert.deepEqual(errors, []);
});

test('"send it" suffix triggers onSubmit with the phrase stripped', () => {
  const f = makeFakes();
  const { transcripts, submits } = voiceOn(f);
  f.instances[0].onstart();
  f.instances[0].onresult(resultEvent(['please summarize this send it']));
  assert.deepEqual(submits, ['please summarize this']);
  assert.deepEqual(transcripts, []);
});

test('"send it" matches case-insensitively', () => {
  const f = makeFakes();
  const { submits } = voiceOn(f);
  f.instances[0].onstart();
  f.instances[0].onresult(resultEvent(['do the thing SEND IT']));
  assert.deepEqual(submits, ['do the thing']);
});

test('"send it" mid-sentence does not trigger submit', () => {
  const f = makeFakes();
  const { transcripts, submits } = voiceOn(f);
  f.instances[0].onstart();
  f.instances[0].onresult(resultEvent(['please send it now']));
  assert.deepEqual(transcripts, ['please send it now']);
  assert.deepEqual(submits, []);
});

test('"send it" alone submits the composer as-is', () => {
  const f = makeFakes();
  const { transcripts, submits } = voiceOn(f);
  f.instances[0].onstart();
  f.instances[0].onresult(resultEvent(['send it']));
  f.instances[0].onresult(resultEvent(['  send it.  ']));
  assert.deepEqual(transcripts, []);
  assert.deepEqual(submits, ['', '']); // empty text: wiring submits composer content
});

test('onresult is ignored when voice mode is off', () => {
  const f = makeFakes();
  const { v, transcripts, submits } = voiceOn(f);
  f.instances[0].onstart();
  const inst = f.instances[0];
  v.setVoiceMode(false, {});
  inst.onresult(resultEvent(['hello send it']));
  assert.deepEqual(transcripts, []);
  assert.deepEqual(submits, []);
});

test('onend with voice mode on starts the next turn', () => {
  const f = makeFakes();
  const { v } = voiceOn(f);
  f.instances[0].onstart();
  f.instances[0].onend();
  assert.equal(f.instances.length, 2);
  assert.equal(f.instances[1].started, true);
  assert.equal(v.listening, false); // until the new turn's onstart
});

test('setVoiceMode(false) stops recognition, cancels speech, reports idle', () => {
  const f = makeFakes();
  const { v, states } = voiceOn(f);
  f.instances[0].onstart();
  const before = f.cancelled;
  const states2 = [];
  assert.equal(v.setVoiceMode(false, { onState: (s) => states2.push(s) }), true);
  assert.equal(v.voiceMode, false);
  assert.equal(f.instances[0].stopped, true);
  assert.ok(f.cancelled > before, 'synthesis.cancel called');
  assert.ok(states2.includes('idle'));
  assert.ok(states.includes('listening'));
});

test('speak() reads aloud when voice mode is on, stripping markdown', () => {
  const f = makeFakes();
  const { v } = voiceOn(f, { mode: 'voice' });
  f.instances[0].onstart();
  assert.equal(v.speak('Hello **world**, see [docs](https://x.com).'), true);
  assert.equal(f.spoken.length, 1);
  assert.equal(f.spoken[0].text, 'Hello world, see docs.');
});

test('speak() does nothing when voice mode is off', () => {
  const f = makeFakes();
  const { v } = voiceOn(f);
  v.setVoiceMode(false, {});
  assert.equal(v.speak('hi'), false);
  assert.equal(f.spoken.length, 0);
});

test('speak() is unavailable without speechSynthesis', () => {
  const f = makeFakes();
  const v = createVoiceController({ Recognition: f.FakeRecognition });
  assert.equal(v.canSpeak, false);
  v.setVoiceMode(true, {});
  assert.equal(v.speak('hi'), false);
});

test('stripSpeechMarkup handles code blocks, headings, and quotes', () => {
  assert.equal(stripSpeechMarkup('```js\nconst x = 1;\n``` done'), 'code block done');
  assert.equal(stripSpeechMarkup('# Title\n`code` here'), 'Title code here');
  assert.equal(stripSpeechMarkup('> quoted\nnormal'), 'quoted normal');
  assert.equal(stripSpeechMarkup(''), '');
});

test('dictate mode never speaks', () => {
  const f = makeFakes();
  const { v } = voiceOn(f, { mode: 'dictate' });
  assert.equal(v.mode, 'dictate');
  assert.equal(v.speak('hello'), false);
  assert.equal(f.spoken.length, 0);
});

test('voice mode speaks replies', () => {
  const f = makeFakes();
  const { v } = voiceOn(f, { mode: 'voice' });
  assert.equal(v.mode, 'voice');
  assert.equal(v.speak('hello there'), true);
  assert.equal(f.spoken.length, 1);
  assert.equal(f.spoken[0].text, 'hello there');
});

test('mode defaults to dictate', () => {
  const f = makeFakes();
  const { v } = voiceOn(f);
  assert.equal(v.mode, 'dictate');
});

test('speak() delays when interrupting playing audio (Chrome cancel quirk)', async () => {
  const f = makeFakes();
  f.synthesis.speaking = true;
  const { v } = voiceOn(f, { mode: 'voice' });
  assert.equal(v.speak('hello'), true);
  assert.equal(f.spoken.length, 0); // delayed, not swallowed
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(f.spoken.length, 1);
  assert.equal(f.spoken[0].text, 'hello');
});

test('chunkForSpeech splits long replies into sentence-sized pieces', () => {
  const short = chunkForSpeech('Hello there.');
  assert.deepEqual(short, ['Hello there.']);
  const long = chunkForSpeech('First sentence here. Second sentence there. Third one too.');
  assert.ok(long.length === 3, `expected 3 chunks, got ${long.length}`);
  assert.ok(long.every((c) => c.length <= 180));
  const oneLongSentence = chunkForSpeech('x'.repeat(400));
  assert.ok(oneLongSentence.length >= 3, 'overlong sentence is hard-split');
  assert.deepEqual(chunkForSpeech(''), []);
});

test('speak() chains chunks via onend so long replies are fully spoken', () => {
  const f = makeFakes();
  const { v } = voiceOn(f, { mode: 'voice' });
  const reply = 'First part here. Second part there. Third part everywhere.';
  assert.equal(v.speak(reply), true);
  assert.equal(f.spoken.length, 1);
  assert.equal(f.spoken[0].text, 'First part here.');
  f.spoken[0].onend(); // first chunk finished -> pump the next
  assert.equal(f.spoken.length, 2);
  assert.equal(f.spoken[1].text, 'Second part there.');
  f.spoken[1].onend();
  assert.equal(f.spoken.length, 3);
  assert.equal(f.spoken[2].text, 'Third part everywhere.');
});

test('a new speak() replaces the queued reply in progress', () => {
  const f = makeFakes();
  const { v } = voiceOn(f, { mode: 'voice' });
  v.speak('First part here. Second part there.');
  assert.equal(f.spoken.length, 1);
  v.speak('Brand new reply.');
  f.spoken[0].onend(); // old queue was cleared; nothing more pumps
  assert.equal(f.spoken.length, 2);
  assert.equal(f.spoken[1].text, 'Brand new reply.');
});
