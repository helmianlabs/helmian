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
// and the engine status reads "Voice loading…". The browser's
// speechSynthesis is the BACKUP voice only: it speaks when Kokoro truly
// cannot load (or in environments without Web Audio), and whenever it
// speaks the engine status says it is the backup voice — it is never
// substituted silently.
//
// Recognition and speech are dependency-injected for tests. Defaults use
// the browser's SpeechRecognition (Chrome/Edge; Firefox has neither, so
// `supported` is false), speechSynthesis, and AudioContext.

// Default Kokoro voice preset (a voice setting UI comes later).
export const KOKORO_VOICE = 'af_heart';
export const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const KOKORO_SAMPLE_RATE = 24000;

// Per-seat voices. Every id below is a voice the bundled model actually
// ships (onnx-community/Kokoro-82M-v1.0-ONNX, voices/<id>.bin — verified
// against the model repo's file list). af_heart stays the house voice:
// Maestro speaks with it, and so does anything unmapped that is not a
// custom seat. Named seats get their own voice so who's talking is
// audible; unmapped custom seats hash into a small pool so distinct
// seats usually sound distinct, stably across sessions.
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
};
const SEAT_VOICE_POOL = ['af_nicole', 'am_adam', 'bf_lily', 'am_liam', 'af_sarah', 'bm_daniel'];
export function voiceForSeat(seat) {
  const key = String(seat ?? '').trim().toLowerCase();
  if (!key) return KOKORO_VOICE;
  if (SEAT_VOICES[key]) return SEAT_VOICES[key];
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return SEAT_VOICE_POOL[hash % SEAT_VOICE_POOL.length];
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
} = {}) {
  const supported = typeof Recognition === 'function';
  const canSpeak = typeof synthesis?.speak === 'function' && typeof Utterance === 'function';
  let recognition = null;
  let listening = false; // a recognition turn is currently active
  let voiceMode = false; // the toggle
  let voiceKind = 'dictate'; // 'dictate' (text only) or 'voice' (two-way)
  let handlers = {};
  let restartTimer = null; // held mic restart while a reply is speaking (see restartTurn)

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
      if (!finalText) return;
      const cmd = sendCommand(finalText);
      if (cmd === undefined) handlers.onTranscript?.(finalText);
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
      if (voiceMode && !hidden) restartTurn(); // next turn of the loop, held while a reply is speaking
      else if (!voiceMode) handlers.onState?.('idle');
    };
    recognition.start();
  }

  // Whether a reply is currently being read aloud (either engine:
  // queued, generating, or playing). startTurn() cancels speech, so
  // the loop's automatic restart must not fire while a reply speaks —
  // it would cut the reply off, and the mic would transcribe the
  // speaker. restartTurn holds the next listening turn until speech
  // drains, then starts it.
  function speechActive() {
    if (kokoroPlaying || activeSource || kokoroQueue.length > 0) return true;
    if (synthSpeaking || synthQueue.length > 0) return true;
    try { return !!(synthesis?.speaking || synthesis?.pending); } catch { return false; }
  }

  function restartTurn() {
    if (!voiceMode) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    if (speechActive()) {
      if (!restartTimer) {
        restartTimer = setTimeout(() => { restartTimer = null; restartTurn(); }, 400);
      }
      return;
    }
    startTurn();
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
  let kokoroPromise = null;   // in-flight load, shared by warmup + speaks
  let kokoroState = 'idle';   // load state: idle | loading | ready | failed
  let kokoroFailedAt = 0;     // timestamp of last Kokoro failure; retry after 60s
  const KOKORO_RETRY_MS = 60000;
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

  function defaultKokoroLoader() {
    // Resolves via the import map in index.html; the ~300MB model downloads
    // once, on first use, and is cached by the browser afterwards.
    // Try WebGPU first (faster), fall back to WASM if it fails (mobile).
    return import('kokoro-js').then(async (mod) => {
      const opts = { dtype: 'q8' };
      const hasGpu = typeof navigator !== 'undefined' && navigator.gpu;
      if (hasGpu) {
        try {
          return await mod.KokoroTTS.from_pretrained(KOKORO_MODEL, { ...opts, device: 'webgpu' });
        } catch (err) {
          console.warn('[voice] WebGPU failed, falling back to WASM:', err?.message ?? err);
        }
      }
      return mod.KokoroTTS.from_pretrained(KOKORO_MODEL, { ...opts, device: 'wasm' });
    });
  }

  // One load, shared: warmup and any number of queued speaks all await
  // the same promise, so the model is never downloaded twice. The load
  // rides the engine's own browser caching (transformers.js Cache
  // Storage) — warmup on a later visit resolves from that cache.
  function ensureKokoro() {
    if (kokoro) return Promise.resolve(kokoro);
    if (kokoroPromise) return kokoroPromise;
    kokoroState = 'loading';
    setVoiceStatus('Voice loading…', '');
    kokoroPromise = (async () => {
      try {
        const engine = await (kokoroLoader ?? defaultKokoroLoader)();
        kokoro = engine;
        kokoroState = 'ready';
        setVoiceStatus('Kokoro', 'kokoro');
        return engine;
      } catch (err) {
        kokoroFailedAt = Date.now();
        kokoroState = 'failed';
        setVoiceStatus('Backup voice — Kokoro could not load', 'fallback');
        throw err;
      } finally {
        kokoroPromise = null;
      }
    })();
    return kokoroPromise;
  }

  // Start the Kokoro load ahead of the first reply. Called when voice
  // chat is enabled; also safe to call any time. Respects the post-
  // failure retry window so a dead network is not hammered. Returns
  // true when a load is in flight or the model is already warm.
  function warmup() {
    if (kokoro || kokoroPromise) return true;
    if (!canSpeak || !canTryKokoro()) return false;
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
  function kokoroFallback(failedItem) {
    setVoiceStatus('Backup voice — Kokoro unavailable', 'fallback');
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
      out = await engine.generate(item.text, { voice: item.voice ?? KOKORO_VOICE });
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
    setVoiceStatus('Kokoro', 'kokoro');
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
    speak(text, seat) {
      const clean = stripSpeechMarkup(text);
      if (!clean) return false;
      const chunks = chunkForSpeech(clean);
      if (!chunks.length) return false;
      // A new reply replaces anything in progress, on either engine.
      synthEngine.cancel();
      kokoroCancel();
      // Kokoro road whenever the model is warm, loading, or loadable:
      // queued chunks wait behind an in-flight warmup instead of
      // dropping to the backup voice just because they arrived early.
      if (kokoro || kokoroPromise || canTryKokoro()) {
        const voice = voiceForSeat(seat);
        for (const c of chunks) kokoroQueue.push({ text: c, token: playToken, voice });
        void pumpKokoro();
        return true;
      }
      // Backup voice: Kokoro cannot run here, or it failed and the
      // retry window is still open. It speaks — labelled as the backup.
      setVoiceStatus('Backup voice — Kokoro unavailable', 'fallback');
      return synthEngine.speakChunks(chunks);
    },
    cancel() {
      synthEngine.cancel();
      kokoroCancel();
    },
  };

  function speak(text, seat) {
    if (!voiceMode || voiceKind !== 'voice') return false; // dictate mode never speaks
    return tts.speak(text, seat);
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
    setVoiceMode,
    speak,
    cancelSpeech,
    warmup,
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
