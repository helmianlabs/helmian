// Voice mode controller: a toggle that enables a full voice loop.
//
// - Toggle ON: dictation turns run in a loop; final transcripts are handed
//   to onTranscript for insertion into the visible composer.
// - "send it": a final transcript whose trimmed text ends with "send it"
//   (case-insensitive) strips those two words and fires onSubmit with the
//   remainder. "send it" alone (nothing left) does nothing. Only acts while
//   the toggle is actively listening — never from plain typing.
// - Agent replies: speak(text) reads aloud via speechSynthesis when voice
//   mode is on. Toggle OFF (or a new dictation turn) cancels speech.
// - Toggle OFF stops everything: recognition stops, speech cancels.
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
    const trimmed = String(text ?? '').trim();
    if (!/send it$/i.test(trimmed)) return undefined;
    const rest = trimmed.slice(0, -'send it'.length).trim();
    return rest || null;
  }

  function stopTurn() {
    if (!recognition || !listening) return false;
    recognition.stop();
    return true;
  }

  function cancelSpeech() {
    if (canSpeak) { try { synthesis.cancel(); } catch { /* ignore */ } }
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
      const text = Array.from(event.results ?? [])
        .filter((result) => result.isFinal)
        .map((result) => result?.[0]?.transcript ?? '')
        .join(' ')
        .trim();
      if (!text) return;
      const cmd = sendCommand(text);
      if (cmd === undefined) handlers.onTranscript?.(text);
      else if (cmd !== null) handlers.onSubmit?.(cmd);
      // cmd === null: "send it" alone — nothing to submit, stay silent.
    };
    recognition.onerror = (event) => {
      if (event?.error === 'aborted') return; // user tapped to stop; silent
      handlers.onError?.(ERROR_MESSAGES[event?.error] ?? 'Dictation stopped before a usable transcript was produced.');
    };
    recognition.onend = () => {
      listening = false;
      recognition = null;
      if (voiceMode) startTurn(); // next turn of the loop
      else handlers.onState?.('idle');
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
      handlers = next;
      startTurn();
      return true;
    }
    if (!on && voiceMode) {
      voiceMode = false;
      handlers = {};
      stopTurn();
      cancelSpeech();
      next.onState?.('idle');
      return true;
    }
    return false;
  }

  function speak(text) {
    if (!voiceMode || !canSpeak) return false;
    const clean = stripSpeechMarkup(text);
    if (!clean) return false;
    cancelSpeech();
    synthesis.speak(new Utterance(clean));
    return true;
  }

  return {
    get supported() { return supported; },
    get canSpeak() { return canSpeak; },
    get voiceMode() { return voiceMode; },
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
