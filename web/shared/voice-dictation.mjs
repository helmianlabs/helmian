// Voice mode controller: a toggle that enables a voice loop, in one of two
// modes:
//
// - "dictate": speech-to-text only. Final transcripts go to onTranscript for
//   insertion into the visible composer; "send it" submits. Replies are
//   never spoken aloud — the user reads them.
// - "voice": full two-way voice chat. Dictation and "send it" as above, plus
//   speak(text) reads agent replies aloud.
//
// - "send it": a final transcript whose trimmed text ends with "send it"
//   (case-insensitive, trailing punctuation ignored) strips those two words
//   and fires onSubmit with the remainder. "send it" alone (nothing left)
//   does nothing. Only acts while the toggle is actively listening — never
//   from plain typing, never from a hidden tab.
// - Toggle OFF stops everything: recognition stops, speech cancels.
// - The mic pauses while the tab is hidden and resumes when visible.
//
// TTS ENGINE SEAM: the controller only calls tts.speak(text) / tts.cancel().
//
// Primary engine is Kokoro (kokoro-js, fully local, Apache 2.0): the ~300MB
// model lazy-loads on the first spoken reply (dynamic import via the import
// map in index.html) and is cached by the browser afterwards. Fallback is the
// browser's speechSynthesis, which also covers environments without Web Audio.
//
// Recognition and speech are dependency-injected for tests. Defaults use
// the browser's SpeechRecognition (Chrome/Edge; Firefox has neither, so
// `supported` is false), speechSynthesis, and AudioContext.

// Default Kokoro voice preset (a voice setting UI comes later).
export const KOKORO_VOICE = 'af_heart';
export const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const KOKORO_SAMPLE_RATE = 24000;

export function createVoiceController({
  Recognition = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition,
  synthesis = globalThis.speechSynthesis,
  Utterance = globalThis.SpeechSynthesisUtterance,
  // Kokoro injection for tests: kokoroLoader() resolves to a KokoroTTS-like
  // ({ generate(text, { voice }) -> { audio, sampling_rate } }),
  // makeAudioContext() resolves to an AudioContext-like.
  kokoroLoader = null,
  makeAudioContext = null,
} = {}) {
  const supported = typeof Recognition === 'function';
  const canSpeak = typeof synthesis?.speak === 'function' && typeof Utterance === 'function';
  let recognition = null;
  let listening = false; // a recognition turn is currently active
  let voiceMode = false; // the toggle
  let voiceKind = 'dictate'; // 'dictate' (text only) or 'voice' (two-way)
  let handlers = {};

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
      const text = Array.from(event.results ?? [])
        .filter((result) => result.isFinal)
        .map((result) => result?.[0]?.transcript ?? '')
        .join(' ')
        .trim();
      if (!text) return;
      const cmd = sendCommand(text);
      if (cmd === undefined) handlers.onTranscript?.(text);
      else handlers.onSubmit?.(cmd ?? ''); // null = bare "send it": submit the composer as-is
    };
    recognition.onerror = (event) => {
      if (event?.error === 'aborted') return; // user tapped to stop; silent
      handlers.onError?.(ERROR_MESSAGES[event?.error] ?? 'Dictation stopped before a usable transcript was produced.');
    };
    recognition.onend = () => {
      listening = false;
      recognition = null;
      const hidden = typeof document !== 'undefined' && document.hidden;
      if (voiceMode && !hidden) startTurn(); // next turn of the loop
      else if (!voiceMode) handlers.onState?.('idle');
    };
    recognition.start();
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
      return true;
    }
    if (!on && voiceMode) {
      voiceMode = false;
      voiceKind = 'dictate';
      handlers = {};
      stopTurn();
      cancelSpeech();
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
        if (document.hidden) { stopTurn(); cancelSpeech(); }
        else if (voiceMode && !listening) { startTurn(); }
      } catch {}
    });
  }

  // ---- Legacy speechSynthesis engine (fallback) ----
  // Long replies are chunked: Chrome's speechSynthesis truncates long
  // utterances, so a reply goes out as sentence-sized pieces chained via
  // onend. A new reply clears the queue; toggle-off cancels everything.
  const synthQueue = [];
  let synthSpeaking = false;
  function pumpSynth() {
    if (synthSpeaking || synthQueue.length === 0 || !canSpeak) return;
    const utter = new Utterance(synthQueue.shift());
    synthSpeaking = true;
    utter.onend = () => { synthSpeaking = false; pumpSynth(); };
    utter.onerror = () => { synthSpeaking = false; pumpSynth(); };
    try { synthesis.speak(utter); }
    catch { synthSpeaking = false; }
  }
  const synthEngine = {
    // Speak pre-chunked text. interrupt=false appends without silencing
    // what is playing (used when Kokoro hands a reply over mid-stream).
    speakChunks(chunks, { interrupt = true } = {}) {
      if (!canSpeak || !chunks.length) return false;
      let wasSpeaking = false;
      if (interrupt) {
        try { wasSpeaking = !!synthesis.speaking; } catch {}
        try { synthesis.cancel(); } catch {}
        synthQueue.length = 0;
        synthSpeaking = false;
      }
      synthQueue.push(...chunks);
      // Chrome quirk: cancel() takes effect asynchronously, so a speak()
      // issued in the same tick can be swallowed. Only delay when we actually
      // interrupted playing audio; the common case stays synchronous.
      if (interrupt && wasSpeaking) setTimeout(pumpSynth, 150);
      else pumpSynth();
      return true;
    },
    cancel() {
      synthQueue.length = 0;
      synthSpeaking = false;
      if (!canSpeak) return;
      try { synthesis.cancel(); } catch {}
    },
  };

  // ---- Kokoro engine (primary where Web Audio exists) ----
  let kokoro = null;          // loaded KokoroTTS instance
  let kokoroFailedAt = 0;     // timestamp of last Kokoro failure; retry after 60s
  const KOKORO_RETRY_MS = 60000;
  let playToken = 0;          // cancel() bumps it; late audio is ignored
  let activeSource = null;    // currently playing AudioBufferSourceNode
  let audioCtx = null;
  const kokoroQueue = [];     // [{ text, token }]
  let kokoroPlaying = false;

  function canTryKokoro() {
    if (kokoro) return true;
    if (kokoroLoader) return true; // injected (tests) -> environment is faked too
    // Allow retry 60s after a failure (transient: network, phone sleep, memory)
    if (kokoroFailedAt && Date.now() - kokoroFailedAt < KOKORO_RETRY_MS) return false;
    try {
      const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      return typeof AC === 'function';
    } catch { return false; }
  }

  function defaultKokoroLoader() {
    // Resolves via the import map in index.html; the ~300MB model downloads
    // once, on first use, and is cached by the browser afterwards.
    return import('kokoro-js').then((mod) => mod.KokoroTTS.from_pretrained(KOKORO_MODEL, {
      dtype: 'q8',
      device: (typeof navigator !== 'undefined' && navigator.gpu) ? 'webgpu' : 'wasm',
    }));
  }

  async function ensureKokoro() {
    if (kokoro) return kokoro;
    kokoro = await (kokoroLoader ?? defaultKokoroLoader)();
    return kokoro;
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
  // speechSynthesis instead.
  function kokoroFallback(failedItem) {
    const chunks = [];
    if (failedItem) chunks.push(failedItem.text);
    for (const item of kokoroQueue.splice(0)) chunks.push(item.text);
    if (chunks.length) synthEngine.speakChunks(chunks, { interrupt: false });
  }

  async function pumpKokoro() {
    if (kokoroPlaying || kokoroQueue.length === 0) return;
    const item = kokoroQueue.shift();
    kokoroPlaying = true;
    let out;
    try {
      const engine = await ensureKokoro();
      out = await engine.generate(item.text, { voice: KOKORO_VOICE });
    } catch (err) {
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
    src.onended = () => {
      kokoroPlaying = false;
      if (activeSource === src) activeSource = null;
      pumpKokoro();
    };
    try { src.start(); }
    catch { kokoroPlaying = false; if (activeSource === src) activeSource = null; pumpKokoro(); }
  }

  function kokoroCancel() {
    playToken += 1; // orphan any in-flight generation
    kokoroQueue.length = 0;
    kokoroPlaying = false;
    if (activeSource) {
      try { activeSource.stop(); } catch {}
      activeSource = null;
    }
  }

  const tts = {
    speak(text) {
      const clean = stripSpeechMarkup(text);
      if (!clean) return false;
      const chunks = chunkForSpeech(clean);
      if (!chunks.length) return false;
      // A new reply replaces anything in progress, on either engine.
      synthEngine.cancel();
      kokoroCancel();
      if (canTryKokoro()) {
        for (const c of chunks) kokoroQueue.push({ text: c, token: playToken });
        void pumpKokoro();
        return true;
      }
      return synthEngine.speakChunks(chunks);
    },
    cancel() {
      synthEngine.cancel();
      kokoroCancel();
    },
  };

  function speak(text) {
    if (!voiceMode || voiceKind !== 'voice') return false; // dictate mode never speaks
    return tts.speak(text);
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
    setVoiceMode,
    speak,
    cancelSpeech,
  };
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
