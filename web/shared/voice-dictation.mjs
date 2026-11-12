// Voice mode controller: a toggle that enables a voice loop, in one of two
// modes:
//
// - "dictate": speech-to-text only. Final transcripts go to onTranscript for
//   insertion into the visible composer; "send it" submits. Replies are
//   never spoken aloud — the user reads them.
// - "voice": full two-way voice chat. speak(text) reads agent replies
//   aloud, and there is NO command word to say: each final transcript
//   still lands in the composer through onTranscript, and once the
//   speaker stops — no new final or interim words for
//   VOICE_AUTO_SUBMIT_MS — the utterance submits itself (onSubmit with
//   an empty remainder: the composer as-is). "send it" still works in
//   voice mode and submits immediately; it is never required. While a
//   reply is actually playing the mic's results are dropped whole
//   (echo guard) and a pending auto-submit holds until the playback
//   ends, so the two sides take turns. A reply that is only queued or
//   still being generated is not playing: the mic stays open for it.
//
// - "send it": a final transcript whose trimmed text ends with "send it"
//   (case-insensitive, trailing punctuation ignored) strips those two words
//   and fires onSubmit with the remainder. "send it" alone (nothing left)
//   submits the composer as-is (onSubmit with an empty remainder). Only
//   acts while the toggle is actively listening — never from plain
//   typing, never from a hidden tab.
// - Interim results stream to onInterim for display only: they are never
//   committed text and never trigger "send it". Only final results
//   insert or submit, and each final is committed exactly once.
// - Toggle OFF stops everything: recognition stops, speech cancels.
// - The mic pauses while the tab is hidden and resumes when visible.
//
// TTS ENGINE SEAM: the controller only calls tts.speak(text, seat) /
// tts.cancel(). The seat selects the per-seat Kokoro voice (voiceForSeat).
//
// Primary engine is Kokoro (kokoro-js, fully local, Apache 2.0). The model
// warms up as soon as voice chat is enabled — not at the first spoken reply —
// and the one-time download (dynamic import via the import map in
// index.html) is cached by the browser afterwards (the engine's own
// transformers.js Cache Storage; no second cache is built here), so later
// visits warm from cache. While the model loads, replies queue behind it
// and the engine status reads "Voice loading…" — but the wait is BOUNDED
// (the voice-silence law): a reply never waits more than
// KOKORO_SPEAK_WAIT_MS from the moment the load started; past the bound
// the labelled backup voice speaks the reply while the load keeps running
// in the background, and Kokoro takes over when it lands. A load that
// never settles at all — a hung import, fetch, or GPU session cannot be
// caught, only abandoned — is abandoned past KOKORO_LOAD_ABANDON_MS and
// retried fresh. The room never goes silent. The same law bounds
// each generate: one still running past KOKORO_GENERATE_MS is
// treated as a generate failure — the backup voice speaks the chunk
// and the queue moves on — so a wedged generate can neither silence
// a reply nor, by holding the reply in flight forever, hold the
// microphone with it. The browser's
// speechSynthesis is the BACKUP voice only: it speaks when Kokoro truly
// cannot load, is still loading past the bound, or in environments
// without Web Audio, and whenever it speaks the engine status says it is
// the backup voice — it is never substituted silently.
//
// Recognition and speech are dependency-injected for tests. Defaults use
// the browser's SpeechRecognition (Chrome/Edge; Firefox has neither, so
// `supported` is false), speechSynthesis, and AudioContext.

// Default Kokoro voice preset (a voice setting UI comes later).
export const KOKORO_VOICE = 'af_heart';
// Two-way voice: the silence that ends an utterance. A final transcript
// only reaches this controller after the recogniser's own end-pointing
// has already heard a pause, so this bound is not the speech detector —
// it spans the gap between recognition turns when a speaker pauses
// mid-thought (a turn ends, the loop restarts, they resume) and leaves
// a conversational beat before the room answers. 1.5s: long enough to
// never cut a thinking speaker off, short enough to feel like talk.
export const VOICE_AUTO_SUBMIT_MS = 1500;
export const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const KOKORO_SAMPLE_RATE = 24000;
// ---- Served TTS (lag bite 1, 2026-11-10) ----
// Server-side synthesis is the primary voice road: reply chunks are
// synthesized on the Helmian server box (deploy/hetzner/voice-tts/),
// and the tab only fetches and plays the finished audio, through the
// ONE served playback queue below. The in-tab Kokoro engine and the
// speechSynthesis backup stay as the fallback road only — they speak
// when the served road is unavailable or fails (and the served road
// is unavailable until deploy sets SERVED_TTS_TOKEN to the token the
// service runs with; an empty token disables it, so an undeployed
// build behaves exactly like the pre-bite tab). Synthesis on the
// tab's own CPU was the freeze: a q8 WASM generate for one chunk can
// occupy the tab for seconds (see KOKORO_GENERATE_MS), and ten
// replies landing in one poll turned that into the Chrome
// "page unresponsive" dialog.
export const SERVED_TTS_URL = 'https://voice.5-78-222-178.sslip.io';
export const SERVED_TTS_TOKEN = '69cd453fe41dc09b084128a679b8b437b12eb4bb590c1bc7a8afc689faf6b218';
export const SERVED_TTS_TIMEOUT_MS = 30000;

// Per-seat voices. Every id below is a voice the bundled model actually
// ships (onnx-community/Kokoro-82M-v1.0-ONNX, voices/<id>.bin — verified
// against the model repo's file list). af_heart stays the house voice:
// Maestro speaks with it, and so does anything unmapped that is not a
// custom seat. Every one of the fourteen room seats carries a NAMED
// entry below — a seat's voice is its spoken identity, fixed across
// sessions and devices, never a dice roll — and all fourteen are
// distinct. The owner takes bm_daniel, the strongest unused male
// voice, rather than af_heart: af_heart is Maestro's (above). Unmapped
// custom seats hash into a small pool so distinct seats usually sound
// distinct, stably across sessions; the pool never reuses a named
// seat's voice, so a custom seat can never collide with a known one.
export const SEAT_VOICES = {
  maestro: 'af_heart',
  claude: 'af_bella',
  chatgpt: 'am_michael',
  grok: 'am_fenrir',
  gemini: 'af_nova',
  mistral: 'bf_emma',
  groq: 'am_puck',
  nvidia: 'am_onyx',
  openrouter: 'bf_isabella',
  cloudflare: 'af_sky',
  qwen: 'af_kore',
  muse: 'af_aoede',
  helm: 'bm_george',
  owner: 'bm_daniel',
};
const SEAT_VOICE_POOL = ['af_nicole', 'am_adam', 'bf_lily', 'am_liam', 'af_sarah'];
export function voiceForSeat(seat) {
  const key = String(seat ?? '').trim().toLowerCase();
  if (!key) return KOKORO_VOICE;
  if (SEAT_VOICES[key]) return SEAT_VOICES[key];
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return SEAT_VOICE_POOL[hash % SEAT_VOICE_POOL.length];
}

// WASM-only device choice for the Kokoro load. WebGPU is never
// used, with or without an adapter in hand: on the vendored runtime
// versions (onnxruntime-web 1.22 + transformers.js 3.8.1) the q8
// model on WebGPU loads without a murmur and then silently computes
// garbage — right length, right engine label, unintelligible tonal
// mush where the words should be (published measurements on this
// model + runtime; heard in Troy's own tab, 2026-11-08). The
// underlying vocoder bug was also measured at fp32, so no dtype swap
// rescues the GPU road — and every clean proof of this pipeline ran
// q8 on WASM. So there is no device decision left to make: no
// adapter probe, no WebGPU attempt, just the WASM load. (The loader
// used to probe the adapter and try WebGPU first; the probe went
// away with the road it served.)
export async function loadKokoroEngine(mod) {
  return mod.KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: 'q8', device: 'wasm' });
}

export function createVoiceController({
  Recognition = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition,
  synthesis = globalThis.speechSynthesis,
  Utterance = globalThis.SpeechSynthesisUtterance,
  // Kokoro injection for tests: kokoroLoader() resolves to a KokoroTTS-like
  // ({ generate(text, { voice }) -> { audio, sampling_rate } }),
  // makeAudioContext() resolves to an AudioContext-like.
  kokoroLoader = null,
  makeAudioContext = null,
  // Served-TTS injection for tests: servedTts(text, { voice, seat, ref })
  // resolves to a generate-like ({ audio, sampling_rate }). Null in
  // production, where defaultServedTts fetches from SERVED_TTS_URL.
  servedTts = null,
} = {}) {
  const supported = typeof Recognition === 'function';
  const canSpeak = typeof synthesis?.speak === 'function' && typeof Utterance === 'function';
  let recognition = null;
  let listening = false; // a recognition turn is currently active
  let voiceMode = false; // the toggle
  let voiceKind = 'dictate'; // 'dictate' (text only) or 'voice' (two-way)
  let handlers = {};
  let restartTimer = null; // held mic restart while a reply is speaking (see restartTurn)
  let autoSubmitTimer = null; // two-way voice: the pending end-of-utterance submit (see scheduleAutoSubmit)
  let autoSubmitPending = false; // an utterance has landed and is inside its silence bound

  const ERROR_MESSAGES = {
    'not-allowed': 'Microphone permission was not granted. Nothing was recorded.',
    'no-speech': 'No speech detected — try again.',
    'audio-capture': 'No microphone found.',
    'network': "The browser's speech service is unavailable.",
    'service-not-allowed': "The browser's speech service is unavailable.",
  };

  // "send it" command: the text to submit, null when empty after stripping,
  // undefined when the transcript is not a send command.
  function sendCommand(text) {
    const trimmed = String(text ?? '').trim().replace(/[.!?…]+$/, '');
    if (!/send it$/i.test(trimmed)) return undefined;
    const rest = trimmed.slice(0, -'send it'.length).trim();
    return rest || null;
  }

  function stopTurn() {
    if (!recognition || !listening) return false;
    recognition.stop();
    return true;
  }

  function startTurn() {
    cancelSpeech(); // a new dictation turn silences any reply in progress
    recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
    recognition.onstart = () => {
      listening = true;
      handlers.onState?.('listening');
    };
    recognition.onresult = (event) => {
      if (!voiceMode) return; // commands only act while the toggle is on
      if (typeof document !== 'undefined' && document.hidden) return; // never transcribe a hidden tab
      // Echo guard (two-way voice): while a reply is being read aloud,
      // results are the reply's own audio coming back through the mic —
      // a turn can still be open when a reply starts (e.g. one a typed
      // message set off). They are dropped whole: never displayed,
      // never inserted, never submitted, and they never arm or re-arm
      // the auto-submit. The loop's restart is already held until the
      // reply drains (restartTurn), so the next real turn starts clean.
      if (voiceKind === 'voice' && speechActive()) return;
      // Interim/final tracking (bite 2a): results before event.resultIndex
      // were already reported by earlier events in this turn, so each
      // final is committed exactly once (the old handler re-joined every
      // final in the event and could insert one twice). Interim text is
      // display-only: it goes to onInterim and never inserts, submits,
      // or triggers "send it" — finals only.
      const results = event.results ?? [];
      const from = typeof event.resultIndex === 'number' ? event.resultIndex : 0;
      let finalText = '';
      let interimText = '';
      for (let i = from; i < results.length; i += 1) {
        const result = results[i];
        const transcript = String(result?.[0]?.transcript ?? '').trim();
        if (!transcript) continue;
        if (result.isFinal) finalText = finalText ? `${finalText} ${transcript}` : transcript;
        else interimText = interimText ? `${interimText} ${transcript}` : transcript;
      }
      if (interimText) handlers.onInterim?.(interimText);
      // Still talking: interim words from a resumed turn push a pending
      // auto-submit's bound out — the send waits for a real stop, not
      // for a breath between recognition turns.
      if (interimText && autoSubmitPending) scheduleAutoSubmit();
      if (!finalText) return;
      const cmd = sendCommand(finalText);
      if (cmd === undefined) {
        handlers.onTranscript?.(finalText);
        // Two-way voice: no "send it" needed — the utterance that just
        // landed submits itself once the speaker has stopped (the
        // silence bound in scheduleAutoSubmit). Dictate keeps the
        // command word; scheduleAutoSubmit arms only in voice kind.
        scheduleAutoSubmit();
      } else {
        clearAutoSubmit(); // an explicit "send it" supersedes a pending auto-submit
        handlers.onSubmit?.(cmd ?? ''); // null = bare "send it": submit the composer as-is
      }
    };
    recognition.onerror = (event) => {
      if (event?.error === 'aborted') return; // user tapped to stop; silent
      handlers.onError?.(ERROR_MESSAGES[event?.error] ?? 'Dictation stopped before a usable transcript was produced.');
    };
    recognition.onend = () => {
      listening = false;
      recognition = null;
      const hidden = typeof document !== 'undefined' && document.hidden;
      // Mic-held state (voice-hardening bite): the turn ended while
      // voice stays on — the mic is held (its restart waits out a
      // playing or queued voice) or released (hidden tab) until the
      // next turn starts. Surfaces hear 'held' so the voice chips
      // can show the held state instead of claiming a live mic; the
      // next turn's onstart reports 'listening' again.
      if (voiceMode) handlers.onState?.('held');
      if (voiceMode && !hidden) restartTurn(); // next turn of the loop, held while a voice is playing or committed to play
      else if (!voiceMode) handlers.onState?.('idle');
    };
    recognition.start();
  }

  // Whether sound is actually coming out of the speakers right now
  // (either engine: a Kokoro buffer source playing, or a backup
  // utterance speaking). This — and only this — is what the mic must
  // not hear: the echo guard drops recognition results while it is
  // true, and a pending auto-submit holds until it clears. A reply
  // that is merely queued or still generating is NOT speech yet and
  // must not close the mic (mic-hostage fix): while an answer is
  // being prepared, the user's words are accepted normally. The mic
  // loop's restart keys on this predicate widened by servedPlaying
  // (latency fix L1; see restartTurn).
  function speechActive() {
    if (activeSource) return true;
    if (synthSpeaking) return true;
    try { return !!(synthesis?.speaking); } catch { return false; }
  }

  // The mic loop's restart gate (latency fix L1, 2026-11-10): the
  // restart holds only while a voice is playing or about to play.
  // It previously keyed on the wider in-flight state (queued,
  // waiting behind the model load, or generating), which held the
  // mic closed for a whole round — minutes. Now the user can
  // dictate the next message while the room is still thinking:
  // replies that are merely queued or generating no longer close
  // the mic. The gate is speechActive() — actual playback only,
  // the same predicate the echo guard keys on — widened by
  // servedPlaying: on the served road a chunk is committed to
  // speak from the moment its fetch starts, about a second before
  // sound comes out, and a restart in that window would cancel
  // the fetch and orphan the reply (starting a turn cancels
  // speech). This module and the app.js inline copy carry the
  // gate identically — lockstep, pinned by the lockstep test.
  // Starting a turn still replaces what has not played yet
  // — the established turn-taking contract. The gate can never
  // fire mid-playback: speechActive() is true for the whole of
  // any chunk's playback, and the 400ms re-check below keeps
  // polling until it clears.
  function restartTurn() {
    if (!voiceMode) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    if (speechActive() || servedPlaying) {
      if (!restartTimer) {
        restartTimer = setTimeout(() => { restartTimer = null; restartTurn(); }, 400);
      }
      return;
    }
    startTurn();
  }

  // Two-way voice auto-submit (voice kind only). The utterance already
  // sits in the composer — it arrived through onTranscript like any
  // dictation — so firing is exactly the bare "send it" contract:
  // onSubmit with an empty remainder submits the composer as-is, and
  // every wiring's own empty-composer guard keeps a late or duplicate
  // fire harmless. Firing never happens from a hidden tab, and holds
  // while a reply is actually playing (turn-taking: the send goes out
  // once the playback ends, on the restart loop's poll rhythm). A
  // reply still being generated does not hold the send.
  function fireAutoSubmit() {
    autoSubmitTimer = null;
    if (!voiceMode || voiceKind !== 'voice') { autoSubmitPending = false; return; }
    if (typeof document !== 'undefined' && document.hidden) { autoSubmitPending = false; return; }
    if (speechActive()) {
      autoSubmitTimer = setTimeout(fireAutoSubmit, 400);
      return;
    }
    autoSubmitPending = false;
    handlers.onSubmit?.('');
  }

  function scheduleAutoSubmit() {
    if (!voiceMode || voiceKind !== 'voice') return; // dictate never auto-submits
    autoSubmitPending = true;
    if (autoSubmitTimer) clearTimeout(autoSubmitTimer);
    autoSubmitTimer = setTimeout(fireAutoSubmit, VOICE_AUTO_SUBMIT_MS);
  }

  function clearAutoSubmit() {
    autoSubmitPending = false;
    if (autoSubmitTimer) { clearTimeout(autoSubmitTimer); autoSubmitTimer = null; }
  }

  function setVoiceMode(on, next = {}) {
    if (!supported) {
      next.onError?.('Voice mode is not supported by this browser. You can still type or paste a message.');
      return false;
    }
    if (on && !voiceMode) {
      voiceMode = true;
      voiceKind = next.mode === 'voice' ? 'voice' : 'dictate';
      handlers = next;
      startTurn();
      // Voice chat speaks, so warm the Kokoro model NOW — at enable time,
      // not inside the first reply. Dictate never speaks, never warms.
      if (voiceKind === 'voice') void warmup();
      return true;
    }
    if (!on && voiceMode) {
      voiceMode = false;
      voiceKind = 'dictate';
      handlers = {};
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      clearAutoSubmit();
      stopTurn();
      cancelSpeech();
      // Voice off clears the engine status with it — the label belongs
      // to the voice session, and a stale "Backup voice — …" line left
      // standing after off reads as a live state (defect D2).
      setVoiceStatus('', '');
      next.onState?.('idle');
      return true;
    }
    return false;
  }

  // Pause the mic while the tab is hidden: speech meant for another tab must
  // never be transcribed, and "send it" must never fire from a hidden tab.
  // Resumes automatically when the tab is visible again.
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
      try {
        if (document.hidden) { stopTurn(); cancelSpeech(); clearAutoSubmit(); }
        else if (voiceMode && !listening) { startTurn(); }
      } catch {}
    });
  }

  // ---- Speaking proof (speaker-proof bite) ----
  // A truthful, per-seat "this reply is being spoken right now" signal:
  // Troy asked for a little speaker icon on each seat's message that
  // lights while that seat's voice is actually playing, so a person —
  // or an automated checker — can see WHICH seat's voice fired. The
  // controller owns no message DOM; it reports the signal through the
  // listener registered with setSpeakingListener, and the surface that
  // renders messages (the Envoy room) draws the icon. The signal
  // reflects ACTUAL playback, never intent: on the Kokoro road it is
  // lit from the buffer source's start() until its onended; on the
  // backup road from the utterance's speak() until its onend/onerror.
  // Loading, generating, and queueing never light it.
  // info = { seat, engine: 'kokoro' | 'backup', ref } — ref is the
  // caller-supplied reference speak() was handed (the room passes the
  // message id), or null when the caller has none.
  let speakingListener = null;
  let speakingNow = null;    // the info currently lit, or null
  let speakingSource = null; // the source/utterance that lit it
  function noteSpeaking(seat, engine, ref, source) {
    speakingNow = { seat: seat ?? null, engine, ref: ref ?? null };
    speakingSource = source ?? null;
    try { speakingListener?.(speakingNow); } catch {}
  }
  function clearSpeaking(source) {
    if (!speakingNow) return;
    // A stale source ending (a stopped buffer source, an interrupted
    // utterance) must not clear a newer source's light.
    if (source !== undefined && speakingSource !== source) return;
    speakingNow = null;
    speakingSource = null;
    try { speakingListener?.(null); } catch {}
  }
  function setSpeakingListener(fn) {
    speakingListener = typeof fn === 'function' ? fn : null;
  }

  // ---- Legacy speechSynthesis engine (fallback) ----
  // Long replies are chunked: Chrome's speechSynthesis truncates long
  // utterances, so a reply goes out as sentence-sized pieces chained via
  // onend. A new reply clears the queue; toggle-off cancels everything.
  // Queue entries carry the seat and message ref beside the text so the
  // speaking proof can name the seat each chunk belongs to.
  const synthQueue = [];
  let synthSpeaking = false;
  function pumpSynth() {
    if (synthSpeaking || synthQueue.length === 0 || !canSpeak) return;
    const item = synthQueue.shift();
    const utter = new Utterance(item.text);
    synthSpeaking = true;
    utter.onend = () => { synthSpeaking = false; clearSpeaking(utter); pumpSynth(); };
    utter.onerror = () => { synthSpeaking = false; clearSpeaking(utter); pumpSynth(); };
    try { synthesis.speak(utter); noteSpeaking(item.seat, 'backup', item.ref, utter); }
    catch { synthSpeaking = false; }
  }
  function enqueueSynth(entries, { interrupt = true } = {}) {
    if (!canSpeak || !entries.length) return false;
    let wasSpeaking = false;
    if (interrupt) {
      try { wasSpeaking = !!synthesis.speaking; } catch {}
      try { synthesis.cancel(); } catch {}
      synthQueue.length = 0;
      synthSpeaking = false;
    }
    synthQueue.push(...entries);
    // Chrome quirk: cancel() takes effect asynchronously, so a speak()
    // issued in the same tick can be swallowed. Only delay when we actually
    // interrupted playing audio; the common case stays synchronous.
    if (interrupt && wasSpeaking) setTimeout(pumpSynth, 150);
    else pumpSynth();
    return true;
  }
  const synthEngine = {
    // Speak queue entries ({ text, seat, ref }). interrupt=false
    // appends without silencing what is playing (used when Kokoro
    // hands a reply over mid-stream).
    enqueue: enqueueSynth,
    // Speak pre-chunked text for one seat. interrupt=false appends
    // without silencing what is playing.
    speakChunks(chunks, { interrupt = true, seat = null, ref = null } = {}) {
      return enqueueSynth(chunks.map((text) => ({ text, seat, ref })), { interrupt });
    },
    cancel() {
      synthQueue.length = 0;
      synthSpeaking = false;
      clearSpeaking();
      if (!canSpeak) return;
      try { synthesis.cancel(); } catch {}
    },
  };

  // ---- Kokoro engine (primary where Web Audio exists) ----
  let kokoro = null;          // loaded KokoroTTS instance
  let kokoroPromise = null;   // in-flight load, shared by warmup + speaks
  let kokoroState = 'idle';   // load state: idle | loading | ready | failed
  let kokoroFailedAt = 0;     // timestamp of last Kokoro failure; retry after 60s
  const KOKORO_RETRY_MS = 60000;
  // Bounded-wait law (voice-silence fix): a reply waits at most
  // KOKORO_SPEAK_WAIT_MS — measured from when the load STARTED, so a
  // load that has been in flight since voice-enable does not get a
  // fresh budget per reply — then the labelled backup voice speaks it
  // while the load keeps running in the background. A load still
  // pending past KOKORO_LOAD_ABANDON_MS is treated as stuck (a hung
  // import/fetch/GPU session never settles, so it can never reject
  // into the fallback) and is retried fresh.
  const KOKORO_SPEAK_WAIT_MS = 15000;
  const KOKORO_LOAD_ABANDON_MS = 60000;
  const KOKORO_WAIT_POLL_MS = 250;
  // One generate gets the same budget family as the wait: a generate
  // still running KOKORO_GENERATE_MS after the call is treated as a
  // generate failure — the backup voice speaks the chunk and the queue
  // moves on. A generate is a promise that may never settle (a wedged
  // worker behind a cold incognito model); unbounded, it held
  // kokoroPlaying — and with it the reply queue and the mic — forever
  // (mic-hostage fix).
  const KOKORO_GENERATE_MS = 15000;
  let kokoroLoadStartedAt = 0; // when the current load attempt began
  let kokoroLoadGen = 0;       // generation of the current load attempt
  let kokoroLastError = null;  // last load failure, kept for the console proof point
  let kokoroBackupWhileLoading = false; // bounded wait expired: backup speaks until the load lands
  let kokoroRetryTimer = null;
  let playToken = 0;          // cancel() bumps it; late audio is ignored
  let activeSource = null;    // currently playing AudioBufferSourceNode
  let audioCtx = null;
  const kokoroQueue = [];     // [{ text, token, voice }]
  let kokoroPlaying = false;

  // Engine status, shown next to the voice controls on every surface
  // (all .voice-engine elements: the console composer and both room
  // composers). This is what makes the backup voice honest: whenever
  // speechSynthesis is what will actually speak, the status says so.
  function setVoiceStatus(text, cls) {
    if (typeof document === 'undefined' || !document.querySelectorAll) return;
    for (const el of document.querySelectorAll('.voice-engine')) {
      el.textContent = text;
      el.className = 'voice-engine ' + (cls || '');
    }
  }

  function canTryKokoro() {
    if (kokoro) return true;
    // Allow retry 60s after a failure (transient: network, phone sleep, memory)
    if (kokoroFailedAt && Date.now() - kokoroFailedAt < KOKORO_RETRY_MS) return false;
    if (kokoroLoader) return true; // injected (tests) -> environment is faked too
    try {
      const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      return typeof AC === 'function';
    } catch { return false; }
  }

  // Where the Kokoro runtime comes from. The vendored copy under the
  // site's own /kokoro-js/ is tried first — same origin, so no
  // third-party module host can fail the load — and the esm.sh CDN is
  // the fallback if the vendored copy is missing from a deploy. Either
  // way the model is pointed at the same-origin /kokoro-model/ tree
  // through the transformers.js env kokoro-js re-exports; if those
  // files are absent, the library still falls back to the HuggingFace
  // originals on its own. (The bare 'kokoro-js' specifier this loader
  // used before resolved only where an import map existed — the app
  // page has none, one of the ways the two copies had diverged.)
  // KOKORO_GRAPH_VERSION stamps the vendored graph: bump it whenever
  // anything under /kokoro-js/ changes. It rides the import as a query,
  // so a browser holding a cached answer for the bare path — including
  // a cached 404, which is what left a tab importing a missing runtime
  // all evening on 2026-11-08 — asks for a new URL instead of reusing
  // the dead one.
  const KOKORO_GRAPH_VERSION = '2026-11-09.1';
  const KOKORO_LOCAL_URL = `/kokoro-js/kokoro-js@1.2.1.mjs?v=${KOKORO_GRAPH_VERSION}`;
  const KOKORO_CDN_URL = 'https://esm.sh/kokoro-js@1.2.1';
  const KOKORO_MODEL_PATH = '/kokoro-model/';

  async function importKokoro() {
    let mod;
    try {
      mod = await import(KOKORO_LOCAL_URL);
    } catch (localErr) {
      console.warn('[voice] Local Kokoro runtime unavailable, trying the CDN copy:', localErr?.message ?? localErr);
      mod = await import(KOKORO_CDN_URL);
    }
    try {
      if (mod.env) {
        mod.env.allowLocalModels = true;
        mod.env.localModelPath = KOKORO_MODEL_PATH;
      }
    } catch { /* the env pointer is a nicety; the remote defaults still work */ }
    return mod;
  }

  function defaultKokoroLoader() {
    // The model downloads once, on first use, and is cached by the
    // browser afterwards. loadKokoroEngine always loads on WASM —
    // the WebGPU road is not taken (see its note for why).
    return importKokoro().then((mod) => loadKokoroEngine(mod));
  }

  // One load, shared: warmup and any number of queued speaks all await
  // the same promise, so the model is never downloaded twice. The load
  // rides the engine's own browser caching (transformers.js Cache
  // Storage) — warmup on a later visit resolves from that cache.
  function ensureKokoro() {
    if (kokoro) return Promise.resolve(kokoro);
    if (kokoroPromise && Date.now() - kokoroLoadStartedAt <= KOKORO_LOAD_ABANDON_MS) return kokoroPromise;
    // A load still pending past the abandon bound is treated as stuck
    // and a fresh attempt starts. The stale attempt cannot be cancelled
    // (a hung import/fetch keeps its promise), so it is superseded by
    // generation instead: a late success is still adopted (an engine is
    // an engine), a late failure is ignored so it cannot latch the
    // retry window or mislabel the state.
    const gen = ++kokoroLoadGen;
    kokoroLoadStartedAt = Date.now();
    kokoroState = 'loading';
    setVoiceStatus('Voice loading…', '');
    let self;
    self = (async () => {
      try {
        const engine = await (kokoroLoader ?? defaultKokoroLoader)();
        if (!kokoro) {
          kokoro = engine;
          kokoroBackupWhileLoading = false;
          if (gen === kokoroLoadGen || kokoroState === 'failed') {
            kokoroState = 'ready';
            setVoiceStatus('Kokoro', 'kokoro');
          }
        }
        return engine;
      } catch (err) {
        if (gen === kokoroLoadGen) {
          kokoroFailedAt = Date.now();
          kokoroState = 'failed';
          kokoroLastError = err;
          kokoroBackupWhileLoading = false;
          setVoiceStatus('Backup voice — Kokoro could not load', 'fallback');
        }
        throw err;
      } finally {
        if (kokoroPromise === self) kokoroPromise = null;
      }
    })();
    kokoroPromise = self;
    return self;
  }

  // The engine a reply may wait for, bounded: resolves the engine, or
  // null when the load has failed or KOKORO_SPEAK_WAIT_MS has elapsed
  // since the load started. The load itself is never cancelled by the
  // wait — it keeps running in the background, and Kokoro takes over
  // for later replies when it lands.
  async function kokoroEngineForSpeak() {
    if (kokoro) return kokoro;
    ensureKokoro().catch(() => {});
    const deadline = kokoroLoadStartedAt + KOKORO_SPEAK_WAIT_MS;
    for (;;) {
      if (kokoro) return kokoro;
      if (kokoroState === 'failed') return null;
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, KOKORO_WAIT_POLL_MS));
    }
  }

  // After a stuck load blows the bounded wait, keep retrying in the
  // background: once the pending load crosses the abandon bound, the
  // timer's ensureKokoro starts a fresh attempt on its own — no user
  // action needed. A failed load is left to the normal retry window.
  function scheduleKokoroRetry() {
    if (kokoroRetryTimer) return;
    kokoroRetryTimer = setTimeout(() => {
      kokoroRetryTimer = null;
      if (!kokoro && kokoroState !== 'failed') ensureKokoro().catch(() => {});
    }, KOKORO_LOAD_ABANDON_MS);
  }

  // Start the Kokoro load ahead of the first reply. Called when voice
  // chat is enabled; also safe to call any time. Respects the post-
  // failure retry window so a dead network is not hammered. Returns
  // true when a load is in flight or the model is already warm.
  function warmup() {
    // Served road first (lag bite 1): while served synthesis is
    // available there is nothing to warm in the tab — in particular
    // the ~300MB in-tab model download never starts.
    if (!servedBroken && servedAvailable()) return false;
    if (kokoro) return true;
    if (!canSpeak || !canTryKokoro()) return false;
    // ensureKokoro itself decides whether the in-flight load is still
    // usable or has crossed the abandon bound and must start fresh.
    ensureKokoro().catch(() => {}); // failure surfaces via status + fallback
    return true;
  }

  function ensureAudioCtx() {
    if (audioCtx) return audioCtx;
    if (makeAudioContext) { audioCtx = makeAudioContext(); return audioCtx; }
    const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (typeof AC !== 'function') throw new Error('Web Audio is not available');
    audioCtx = new AC();
    return audioCtx;
  }

  function playPcm(pcm, sampleRate) {
    const ctx = ensureAudioCtx();
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      try { const r = ctx.resume(); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch {}
    }
    const buf = ctx.createBuffer(1, pcm.length, sampleRate);
    buf.getChannelData(0).set(pcm);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    return src;
  }

  // A Kokoro failure hands the failed chunk and everything still queued to
  // speechSynthesis instead — under the backup-voice status, never quietly.
  function kokoroFallback(failedItem, reason = 'unavailable') {
    if (reason === 'loading') setVoiceStatus('Backup voice — Kokoro still loading', 'fallback');
    else if (reason === 'failed') setVoiceStatus('Backup voice — Kokoro could not load', 'fallback');
    else setVoiceStatus('Backup voice — Kokoro unavailable', 'fallback');
    const entries = [];
    if (failedItem) entries.push({ text: failedItem.text, seat: failedItem.seat, ref: failedItem.ref });
    for (const item of kokoroQueue.splice(0)) entries.push({ text: item.text, seat: item.seat, ref: item.ref });
    if (entries.length) synthEngine.enqueue(entries, { interrupt: false });
  }

  // engine.generate with a hard bound, in the load wait's own idiom:
  // a deadline on Date.now, polled on KOKORO_WAIT_POLL_MS. Past the
  // deadline the race resolves null and the caller treats the chunk
  // exactly like a generate failure. The underlying generate promise
  // is left to settle or hang on its own: its late result is never
  // used, and a late rejection stays handled by the race.
  async function kokoroGenerateBounded(engine, item) {
    let settled = false;
    const gen = Promise.resolve(engine.generate(item.text, { voice: item.voice ?? KOKORO_VOICE }))
      .then((out) => { settled = true; return out; }, (err) => { settled = true; throw err; });
    const deadline = Date.now() + KOKORO_GENERATE_MS;
    const bound = (async () => {
      while (!settled && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, KOKORO_WAIT_POLL_MS));
      }
      return null;
    })();
    const out = await Promise.race([gen, bound]);
    if (out === null) throw new Error(`Kokoro generate passed the ${KOKORO_GENERATE_MS}ms bound`);
    return out;
  }

  async function pumpKokoro() {
    if (kokoroPlaying || kokoroQueue.length === 0) return;
    const item = kokoroQueue.shift();
    kokoroPlaying = true;
    let engine;
    try {
      engine = await kokoroEngineForSpeak();
    } catch { engine = null; }
    if (item.token !== playToken) { kokoroPlaying = false; pumpKokoro(); return; } // cancelled while waiting
    if (!engine) {
      kokoroPlaying = false;
      if (kokoroState === 'failed') {
        console.warn('[voice] Kokoro load failed, falling back:', kokoroLastError?.message ?? kokoroLastError);
        kokoroFallback(item, 'failed');
      } else {
        // The load is still running past the bounded wait. The backup
        // voice speaks this reply — and, via kokoroBackupWhileLoading,
        // the replies behind it — while the load continues in the
        // background; Kokoro takes over when it lands, and the retry
        // timer starts a fresh attempt once the stuck load crosses
        // the abandon bound. The room never goes silent.
        kokoroBackupWhileLoading = true;
        scheduleKokoroRetry();
        kokoroFallback(item, 'loading');
      }
      return;
    }
    let out;
    try {
      out = await kokoroGenerateBounded(engine, item);
    } catch (err) {
      if (item.token !== playToken) { kokoroPlaying = false; pumpKokoro(); return; } // cancelled mid-generate
      kokoroPlaying = false;
      kokoroFailedAt = Date.now();
      console.warn('[voice] Kokoro generate failed, falling back:', err?.message ?? err);
      kokoroFallback(item);
      return;
    }
    if (item.token !== playToken) { kokoroPlaying = false; pumpKokoro(); return; } // cancelled mid-generate
    let src;
    try {
      const pcm = out?.audio ?? out?.data;
      if (!pcm || !pcm.length) throw new Error('Kokoro returned no audio');
      src = playPcm(pcm, out?.sampling_rate ?? KOKORO_SAMPLE_RATE);
    } catch (err) {
      kokoroPlaying = false;
      kokoroFailedAt = Date.now();
      console.warn('[voice] Kokoro playback failed, falling back:', err?.message ?? err);
      kokoroFallback(item);
      return;
    }
    activeSource = src;
    setVoiceStatus('Kokoro', 'kokoro');
    src.onended = () => {
      kokoroPlaying = false;
      if (activeSource === src) activeSource = null;
      clearSpeaking(src);
      pumpKokoro();
    };
    try { src.start(); noteSpeaking(item.seat, 'kokoro', item.ref, src); }
    catch { kokoroPlaying = false; if (activeSource === src) activeSource = null; pumpKokoro(); }
  }

  function kokoroCancel() {
    playToken += 1; // orphan any in-flight generation
    kokoroQueue.length = 0;
    kokoroPlaying = false;
    clearSpeaking();
    if (activeSource) {
      try { activeSource.stop(); } catch {}
      activeSource = null;
    }
  }

  // ---- Served engine (lag bite 1): the ONE playback queue ----
  // Every reply spoken on the served road appends its chunks here, in
  // the order the replies arrived (message order), and pumpServed
  // plays them strictly head to tail: a new reply NEVER interrupts a
  // reply already playing or queued. That is a deliberate change from
  // the legacy engines below (a new reply replaces anything in
  // progress): with ten seats answering one prompt, interrupt-on-each
  // meant only the last reply was ever heard whole, while each
  // interrupted reply still burned a full in-tab generate. Explicit
  // stops still clear everything: voice-off, cancelSpeech(), and a
  // new dictation turn (startTurn) all call tts.cancel().
  // Fetch-ahead: a chunk's synthesis request starts when the chunk
  // reaches the head of the queue (at enqueue for the first chunk),
  // and the next SERVED_FETCH_AHEAD chunks of the same answer start
  // the moment the current one is taken up for playback, so the
  // server synthesizes ahead on ITS CPU while chunk N plays in the
  // tab. At most SERVED_FETCH_AHEAD fetches are ever outstanding
  // beyond the playing chunk. Prefetch only starts fetches: it
  // never marks an answer voiced (marking rides actual playback,
  // at the surface's speaking report), and a cancel orphans the
  // prefetched promises with the queue, so audio fetched for a
  // moved-on answer is simply never played.
  const servedQueue = []; // [{ text, voice, seat, ref, token, audioPromise }]
  let servedPlaying = false;
  let servedToken = 0; // cancel() bumps it; late fetches are ignored
  let servedBroken = false; // latched on the first served failure: the rest of the session uses the legacy road, so a dead service is not retried per reply
  function servedAvailable() {
    if (typeof servedTts === 'function') return true;
    return Boolean(SERVED_TTS_URL && SERVED_TTS_TOKEN && typeof globalThis.fetch === 'function');
  }
  async function defaultServedTts(text, { voice } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), SERVED_TTS_TIMEOUT_MS);
    try {
      const res = await fetch(`${SERVED_TTS_URL}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVED_TTS_TOKEN}` },
        body: JSON.stringify({ text, voice }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`served voice answered ${res.status}`);
      const buf = await res.arrayBuffer();
      // decodeAudioData is native and off the synthesis path: the tab
      // pays a WAV decode (milliseconds), never the WASM inference.
      const decoded = await ensureAudioCtx().decodeAudioData(buf);
      return { audio: decoded.getChannelData(0), sampling_rate: decoded.sampleRate };
    } finally { clearTimeout(timer); }
  }
  function servedFetch(item) {
    if (!item.audioPromise) {
      const fn = servedTts ?? defaultServedTts;
      item.audioPromise = Promise.resolve().then(() => fn(item.text, { voice: item.voice, seat: item.seat, ref: item.ref }));
      item.audioPromise.catch(() => {}); // pumpServed owns the failure; never leave it unhandled
    }
    return item.audioPromise;
  }
  // A served failure hands the failed chunk and everything still
  // queued to the legacy engines IN ORDER (the kokoroFallback pattern,
  // reversed): chunks already carry their per-seat voice, so the
  // in-tab Kokoro queue takes them whole when it can run, and the
  // backup voice takes them when it cannot.
  function servedFallback(failedItem) {
    const items = [];
    if (failedItem) items.push(failedItem);
    for (const item of servedQueue.splice(0)) items.push(item);
    if (!items.length) return;
    if (kokoro || kokoroPromise || canTryKokoro()) {
      for (const item of items) kokoroQueue.push({ text: item.text, token: playToken, voice: item.voice, seat: item.seat ?? null, ref: item.ref ?? null });
      void pumpKokoro();
      return;
    }
    if (kokoroState === 'failed') setVoiceStatus('Backup voice — Kokoro could not load', 'fallback');
    else setVoiceStatus('Backup voice — Kokoro unavailable', 'fallback');
    synthEngine.enqueue(items.map((item) => ({ text: item.text, seat: item.seat, ref: item.ref })), { interrupt: false });
  }
  const SERVED_FETCH_AHEAD = 2;
  // Start fetches for up to SERVED_FETCH_AHEAD queued chunks of the
  // answer item belongs to (the ref groups an answer's chunks; the
  // walk stops at the first chunk of a different answer, whose
  // chunks wait for their own head turn). servedFetch is idempotent
  // per item and already swallows its own rejection: the pump owns
  // a failure when that chunk reaches the head.
  function servedPrefetchAhead(item) {
    for (let i = 0; i < SERVED_FETCH_AHEAD && i < servedQueue.length; i += 1) {
      if (servedQueue[i].ref !== item.ref) break;
      servedFetch(servedQueue[i]);
    }
  }
  async function pumpServed() {
    if (servedPlaying || servedQueue.length === 0) return;
    const item = servedQueue.shift();
    servedPlaying = true;
    servedPrefetchAhead(item); // synthesize this answer's next chunks while this one plays
    let out;
    try {
      out = await servedFetch(item);
    } catch (err) {
      if (item.token !== servedToken) { servedPlaying = false; pumpServed(); return; } // cancelled while fetching
      servedPlaying = false;
      servedBroken = true;
      console.warn('[voice] Served voice failed, falling back to the in-tab engines:', err?.message ?? err);
      servedFallback(item);
      return;
    }
    if (item.token !== servedToken) { servedPlaying = false; pumpServed(); return; } // cancelled while fetching
    let src;
    try {
      const pcm = out?.audio ?? out?.data;
      if (!pcm || !pcm.length) throw new Error('Served voice returned no audio');
      src = playPcm(pcm, out?.sampling_rate ?? KOKORO_SAMPLE_RATE);
    } catch (err) {
      servedPlaying = false;
      servedBroken = true;
      console.warn('[voice] Served playback failed, falling back to the in-tab engines:', err?.message ?? err);
      servedFallback(item);
      return;
    }
    activeSource = src;
    setVoiceStatus('Server voice', 'kokoro');
    src.onended = () => {
      servedPlaying = false;
      if (activeSource === src) activeSource = null;
      clearSpeaking(src);
      pumpServed();
    };
    try { src.start(); noteSpeaking(item.seat, 'served', item.ref, src); }
    catch { servedPlaying = false; if (activeSource === src) activeSource = null; pumpServed(); }
  }
  function servedCancel() {
    servedToken += 1; // orphan any in-flight fetch: its audio is never played
    servedQueue.length = 0;
    servedPlaying = false;
    // The playing buffer source is the shared activeSource; kokoroCancel
    // stops it (tts.cancel calls both).
  }

  // The legacy in-tab road (Kokoro in the tab, speechSynthesis backup),
  // unchanged from the pre-bite controller: it is now the FALLBACK,
  // reached when the served road is unavailable or has failed.
  function speakLegacyChunks(chunks, seat, ref) {
      // A new reply replaces anything in progress, on either engine.
      synthEngine.cancel();
      kokoroCancel();
      // Bounded-wait law: while a load that already blew its wait is
      // still running in the background, replies go straight to the
      // labelled backup instead of queueing behind a load that may
      // never land.
      if (!kokoro && kokoroBackupWhileLoading) {
        setVoiceStatus('Backup voice — Kokoro still loading', 'fallback');
        return synthEngine.speakChunks(chunks, { seat, ref });
      }
      // Kokoro road whenever the model is warm, loading, or loadable:
      // queued chunks wait behind an in-flight warmup (bounded — see
      // kokoroEngineForSpeak) instead of dropping to the backup voice
      // just because they arrived early.
      if (kokoro || kokoroPromise || canTryKokoro()) {
        const voice = voiceForSeat(seat);
        for (const c of chunks) kokoroQueue.push({ text: c, token: playToken, voice, seat: seat ?? null, ref: ref ?? null });
        void pumpKokoro();
        return true;
      }
      // Backup voice: Kokoro cannot run here, or it failed and the
      // retry window is still open. It speaks — labelled as the backup,
      // and when the load itself is what failed the label keeps saying
      // so instead of erasing it with the generic wording (the owner's
      // live session flipped "could not load" → "unavailable" on the
      // first reply exactly here).
      if (kokoroState === 'failed') setVoiceStatus('Backup voice — Kokoro could not load', 'fallback');
      else setVoiceStatus('Backup voice — Kokoro unavailable', 'fallback');
      return synthEngine.speakChunks(chunks, { seat, ref });
  }

  const tts = {
    speak(text, seat, ref) {
      const clean = stripSpeechMarkup(text);
      if (!clean) return false;
      const chunks = chunkForSpeech(clean);
      if (!chunks.length) return false;
      // Served road (lag bite 1): synthesis happens on the server, the
      // tab only plays — chunks APPEND to the one served queue in
      // arrival (message) order and nothing here cancels a reply
      // already playing or queued on that road.
      if (!servedBroken && servedAvailable()) {
        const voice = voiceForSeat(seat);
        for (const c of chunks) servedQueue.push({ text: c, voice, seat: seat ?? null, ref: ref ?? null, token: servedToken, audioPromise: null });
        if (servedQueue[0]) servedFetch(servedQueue[0]); // first synthesis starts now, on the server's CPU
        void pumpServed();
        return true;
      }
      return speakLegacyChunks(chunks, seat, ref);
    },
    cancel() {
      servedCancel();
      synthEngine.cancel();
      kokoroCancel();
    },
  };

  function speak(text, seat, ref) {
    if (!voiceMode || voiceKind !== 'voice') return false; // dictate mode never speaks
    return tts.speak(text, seat, ref);
  }

  function cancelSpeech() {
    tts.cancel();
  }

  return {
    get supported() { return supported; },
    get canSpeak() { return canSpeak; },
    get voiceMode() { return voiceMode; },
    get mode() { return voiceKind; },
    get listening() { return listening; },
    get engineState() { return kokoroState; },
    get servedBroken() { return servedBroken; },
    get speakingNow() { return speakingNow; },
    setSpeakingListener,
    setVoiceMode,
    speak,
    cancelSpeech,
    warmup,
  };
}

// Spoken mentions (mention-buttons bite, 2026-11-08): dictation turns
// "at Grok" into plain words, which the room's mention parser
// (envoy-workspace.js mentions(): (^|[^\w@])@([a-z][a-z0-9_-]{1,20})\b,
// resolved through its ALIAS map) cannot see — the owner dictated
// "at Grok… send it" and no mention formed. This pure mapper rewrites a
// dictated "at <name>" into "@<Name>", but ONLY where "at" opens the
// dictated text (and the insert point is itself a message start or a
// sentence boundary — see leadingBoundary) or follows a sentence
// boundary inside the text, so ordinary speech is never rewritten:
// "at the store" (no seat named) and "look at Grok's answer"
// (mid-sentence) pass through untouched. It is applied ONLY on the
// dictation insert path (app.js insertMaestroDictation and its inline
// copy of this function) — typed text never passes through it.
//
// The tag table mirrors the room's seat registry the way SEAT_VOICES
// mirrors the seat list for voices: keys are the spoken words the
// room's ALIAS map accepts (plus the display names themselves), values
// are the NAMES display forms insertMention() writes, which mentions()
// resolves back to the same providers. 'muse' is a server provider
// (src/cloud/envoy-agents.mjs AGENT_NAMES) the client mirror's ALIAS
// does not carry yet; 'helm' rides as a custom-seat handle.
export const SPOKEN_MENTION_TAGS = Object.freeze({
  all: 'all', everyone: 'all', here: 'all',
  claude: 'Claude', chatgpt: 'ChatGPT', gpt: 'ChatGPT', openai: 'ChatGPT',
  grok: 'Grok', gemini: 'Gemini', mistral: 'Mistral', lechat: 'Mistral',
  groq: 'Groq', qwen: 'Qwen', ollama: 'Qwen', muse: 'Muse',
  maestro: 'Maestro', manager: 'Maestro', helm: 'Helm',
  nvidia: 'NVIDIA', nim: 'NVIDIA', cloudflare: 'Cloudflare',
  openrouter: 'OpenRouter',
});
export function mapSpokenMentions(text, tags = SPOKEN_MENTION_TAGS, { leadingBoundary = true } = {}) {
  const src = String(text ?? '');
  if (!src || !tags) return src;
  const words = Object.keys(tags).filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return src;
  const re = new RegExp(`(^|[.!?…]\\s+|\\n\\s*)at\\s+(${words.join('|')})(?=[\\s,.!?…;:]|$)`, 'gi');
  return src.replace(re, (whole, boundary, word) => {
    if (boundary === '' && !leadingBoundary) return whole;
    const tag = tags[String(word).toLowerCase()];
    return tag ? `${boundary}@${tag}` : whole;
  });
}

// Light markdown stripping so spoken replies sound natural. Kept simple.
export function stripSpeechMarkup(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Split a reply into sentence-sized speakable chunks (browser TTS truncates
// long utterances). Overlong single sentences are hard-split.
export function chunkForSpeech(text, maxLen = 180) {
  const chunks = [];
  for (const sentence of String(text ?? '').split(/(?<=[.!?])\s+/)) {
    const piece = sentence.trim();
    if (!piece) continue;
    if (piece.length <= maxLen) chunks.push(piece);
    else for (let i = 0; i < piece.length; i += maxLen) chunks.push(piece.slice(i, i + maxLen).trim());
  }
  return chunks;
}
