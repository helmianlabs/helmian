// Explicit, turn-based phone voice for Herald.
// Recognition only fills the visible message box. It never sends, pairs,
// approves, or invokes the desktop by itself. Reply speech is separately
// enabled and reads only text already visible in the Herald transcript.

export function createTurnVoiceController({
  Recognition = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition,
  synthesis = globalThis.speechSynthesis,
  Utterance = globalThis.SpeechSynthesisUtterance,
} = {}) {
  let recognition = null;
  let listening = false;
  let readReplies = false;
  let lastSpokenOutputId = null;
  const supported = typeof Recognition === 'function';

  function stop() {
    if (!recognition || !listening) return false;
    recognition.stop();
    return true;
  }

  function start({ onTranscript, onState = () => {}, onError = () => {} } = {}) {
    if (!supported) {
      onError('Voice input is not supported by this phone browser. You can still type or paste a message.');
      return false;
    }
    if (listening) return stop();

    recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';
    recognition.onstart = () => {
      listening = true;
      onState('listening');
    };
    recognition.onresult = (event) => {
      const text = Array.from(event.results ?? [])
        .map((result) => result?.[0]?.transcript ?? '')
        .join(' ')
        .trim();
      if (text) onTranscript?.(text);
    };
    recognition.onerror = (event) => {
      const reason = event?.error === 'not-allowed'
        ? 'Microphone permission was not granted. Nothing was recorded or sent.'
        : 'Voice input stopped before a usable transcript was produced.';
      onError(reason);
    };
    recognition.onend = () => {
      listening = false;
      recognition = null;
      onState('idle');
    };
    recognition.start();
    return true;
  }

  function setReadReplies(value) {
    readReplies = value === true;
    if (!readReplies) synthesis?.cancel?.();
    return readReplies;
  }

  function speakVisibleOutput(output) {
    if (!readReplies || !output?.id || output.id === lastSpokenOutputId
      || typeof output.text !== 'string' || !output.text.trim()
      || !synthesis || typeof Utterance !== 'function') return false;
    lastSpokenOutputId = output.id;
    synthesis.cancel?.();
    synthesis.speak(new Utterance(output.text.trim()));
    return true;
  }

  return {
    supported,
    get listening() { return listening; },
    get readReplies() { return readReplies; },
    start,
    stop,
    setReadReplies,
    speakVisibleOutput,
  };
}
