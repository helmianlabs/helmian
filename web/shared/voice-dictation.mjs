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
// TTS ENGINE SEAM: v1 speaks via the browser's built-in speechSynthesis
// (zero backend, works everywhere). The Kokoro engine plugs in here later —
// either the browser WebGPU build or a runner-side endpoint — by replacing
// speakWithEngine; the controller only ever calls tts.speak(text).
//
// Recognition and speech are dependency-injected for tests. Defaults use
// the browser's SpeechRecognition (Chrome/Edge; Firefox has neither, so
// `supported` is false) and speechSynthesis.

export function createVoiceController({
  Recognition = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition,
  synthesis = globalThis.speechSynthesis,
  Utterance = globalThis.SpeechSynthesisUtterance,
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

  // TTS engine seam: the controller only calls tts.speak / tts.cancel.
  // v1 is the browser's speechSynthesis; the Kokoro engine replaces these
  // two functions when it lands (browser WebGPU build or runner endpoint).
  const tts = {
    speak(text) {
      if (!canSpeak) return false;
      const clean = stripSpeechMarkup(text);
      if (!clean) return false;
      try { synthesis.cancel(); } catch {}
      synthesis.speak(new Utterance(clean));
      return true;
    },
    cancel() {
      if (!canSpeak) return;
      try { synthesis.cancel(); } catch {}
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
