# Voice Stack Assessment — 2026-07-28

Report only. No voice implementation code was written in this session.
Every file:line below was read in this session from the working tree.

## a. Who owns speech-to-text today

**`desktop/Helmion.Desktop.Core/SpeechEngine.cs`** — the only STT owner.

- `SpeechEngine.cs:3` — `using System.Speech.Recognition;`
- `SpeechEngine.cs:69-80` — `StartDictation()` creates a `SpeechRecognitionEngine`,
  loads a `DictationGrammar` (line 70), sets end-silence timeouts (750 ms /
  1100 ms, lines 75-76), binds the default mic (line 79), and starts
  `RecognizeAsync(RecognizeMode.Multiple)` (line 80).
- `SpeechEngine.cs:520-535` — `OnSpeechRecognized` gates on confidence ≥ 0.25
  (line 523) and raises the `SpeechRecognized` event with final text only.
  There are no partial/interim results anywhere in the stack.

This confirms the established fact: the recognizer is `System.Speech`'s
`DictationGrammar` on the legacy SAPI desktop recognizer. That model is the
accuracy ceiling; no amount of Windows speech training changes it.

## b. Who owns text-to-speech today

Same file: **`desktop/Helmion.Desktop.Core/SpeechEngine.cs`**.

- `SpeechEngine.cs:4` — `using System.Speech.Synthesis;`
- `SpeechEngine.cs:141-241` — `Speak(text)`: probes endpoints first
  (lines 151-167), then blocking `synth.Speak(text)` inside `SpeakOnce`
  (line 347). On device faults (the 0x2 family) it re-creates the
  synthesizer (`RecreateSynthesizer`, lines 379-409) and retries once.
- `desktop/Helmion.Desktop.Core/AudioEndpointProbe.cs:12-233` — the
  pre-flight probe (waveOut + MMDevice COM enumeration) plus
  `IsAudioDeviceFailure` (lines 116-158), which pattern-matches the SAPI
  0x2 / 0x80045xxx / 0x8889xxxx HRESULT families. This entire file exists
  only because `System.Speech.Synthesis` faults on missing devices and
  sticks in a bad state — it is workaround mass, not product logic.

## c. The interface boundary — what gets swapped

Two layers sit between the UI and SAPI:

```
MainWindow.xaml.cs  →  VoiceSession  →  SpeechEngine  →  System.Speech (SAPI)
```

**The UI only ever touches `VoiceSession`'s public surface:**

- `MainWindow.xaml.cs:480-481` — constructs `VoiceSession`, subscribes
  `OnSpeechRecognized`.
- `MainWindow.xaml.cs:1374-1405` — mic button calls `StartVoiceMode()` /
  `StopVoiceMode()` / reads `IsVoiceModeActive`.
- `MainWindow.xaml.cs:1324-1335, 1343-1354` — after a chat/agent turn,
  calls `await _voiceSession.SpeakAsync(text)`.
- `MainWindow.xaml.cs:1407+` — recognized text is fed into the normal chat
  pipeline (same path as typed text).

**The engine seam is `SpeechEngine`'s public surface**, consumed only by
`VoiceSession` (`VoiceSession.cs:11` — `private readonly SpeechEngine _engine = new();`):

| Member | Cite | Contract |
|---|---|---|
| `StartDictation()` / `StopDictation()` / `PauseDictation()` | SpeechEngine.cs:55, 99, 111 | continuous mic on/off/soft-pause |
| `Speak(text, ct)` (blocking) / `CancelSpeak()` | SpeechEngine.cs:141, 243 | blocking is load-bearing — `VoiceSession.SpeakAsync` resumes the mic when `Speak` returns (VoiceSession.cs:220-232, 253-264) |
| `ProbeAudioEndpoints()` | SpeechEngine.cs:45 | TTS readiness pre-flight |
| events `SpeechRecognized`, `SpeechDetected`, `Error`, `DictationStopped` | SpeechEngine.cs:24-27 | final-text recognition, VAD-onset, faults, engine stop |
| `IsDictationRunning`, `IsSpeaking` | SpeechEngine.cs:34-39 | state reads |

**The swap:** `SpeechEngine` is concrete and `new`-ed directly — there is no
interface today. Extracting `ISpeechEngine` from the table above and injecting
it into `VoiceSession` (constructor parameter, default = current SAPI
implementation) replaces the engine without touching `MainWindow` at all and
without touching `VoiceSession`'s turn-taking logic (pause-mic-during-TTS,
speak-generation counter, auto-restart). That is the entire boundary:
**one interface, one constructor change.**

STT and TTS are independently swappable behind that same interface — nothing
in `VoiceSession` couples the recognizer to the synthesizer except that both
live in one class today.

## d. Local Whisper / Parakeet STT behind that interface

What the replacement engine must supply (System.Speech does these internally
today, so they become our code):

1. **Mic capture** — NAudio `WaveInEvent`/WASAPI, 16 kHz mono 16-bit PCM.
   (~1 NuGet, no native service).
2. **Endpointing/VAD** — replicate the 750 ms end-silence semantics
   (SpeechEngine.cs:75-76). Silero VAD (tiny ONNX, CPU) or energy-based.
   VAD onset fires `SpeechDetected`; VAD close ends the utterance.
3. **Inference**
   - **Whisper**: Whisper.net (whisper.cpp bindings, ggml model file;
     `base`/`small` run CPU-realtime for short utterances). Utterance-batch
     model — feed the VAD-closed segment, get final text, fire
     `SpeechRecognized`. Matches the existing final-text-only contract
     exactly (no partials to plumb).
   - **Parakeet**: sherpa-onnx C# bindings run NVIDIA NeMo transducer
     models (Parakeet ONNX exports) with true streaming partials on CPU.
     Better latency and dictation accuracy than SAPI by a wide margin;
     partials would be a *new* capability the current interface simply
     wouldn't expose (or expose later via one added event).
4. **Mapping** — `StartDictation` = start capture+VAD loop;
   `PauseDictation`/`StopDictation` = stop capture; `DictationStopped` =
   capture loop exit; the 0.25 confidence gate (SpeechEngine.cs:523)
   disappears or maps to model avg-logprob.

Cost: a model file on disk (~75 MB–500 MB), ONNX Runtime / whisper.cpp
native binaries added to packaging (`desktop/scripts/publish.ps1`
single-file Pilot must carry them), and the capture/VAD code (~200-400
lines). No cloud, no keys — consistent with the "local desktop only" note
at SpeechEngine.cs:11. Not verified against live vendor docs this session;
library names and CPU-viability are from training knowledge and should get
a 10-minute docs check before the implementation session.

## e. Kokoro v1.0 TTS behind the same interface

`Speak(text, ct)` becomes: phonemize (espeak-ng G2P — Kokoro takes
phonemes; the packaged .NET bindings bundle this) → Kokoro 82M ONNX
inference on CPU → 24 kHz PCM → NAudio `WaveOutEvent` playback, blocking
until playback completes so `VoiceSession`'s resume-mic-after-TTS logic
(VoiceSession.cs:253-264) works unchanged. `CancelSpeak` = stop playback +
cancel inference.

Big side-benefit: **the entire SAPI-fault apparatus becomes deletable.**
`AudioEndpointProbe`'s HRESULT taxonomy, the recreate-and-retry ladder in
`Speak` (SpeechEngine.cs:180-236), and the "synthesizer locked in faulted
state" failure mode all exist because of `System.Speech.Synthesis`. NAudio
playback fails with an ordinary catchable exception and holds no sticky
state; the probe shrinks to a render-device count check. The 0x2 problem
is not fixed by Kokoro — it is *removed*.

Cost: ~330 MB model + voices on disk, ONNX Runtime (shared with d if both
land), packaging update. CPU synthesis of a 1-2 sentence reply is
~real-time on a modern desktop core. Same caveat as (d): confirm current
binding/package names against live docs before implementing.

## f. Full-duplex (Kyutai Moshi over WebSocket) — different boundary

**It does not fit behind `ISpeechEngine`, and the reason is architectural,
not cosmetic.**

The current pipeline is half-duplex and text-mediated by design:
mic → text → *the app's selected Maestro LLM + tool loop* → text → TTS,
with the mic deliberately paused during playback
(`VoiceSession.PauseListeningForTts`, VoiceSession.cs:116-129;
`MainWindow.xaml.cs:1407+` feeds recognized text into the same chat path
as typed text). The engine interface in (c) is exactly the STT/TTS halves
of that turn structure.

Moshi is not an STT engine or a TTS engine — it is a speech-to-speech
conversational model behind `moshi-server`: the client streams mic audio
up a WebSocket continuously and receives generated speech (plus a text
transcript side-channel) continuously, with barge-in native because both
directions are always open. There is no seam in that loop where Helmion's
Maestro LLM, permission dropdown, or tool dispatcher can sit — Moshi
generates the *reply itself*. Bolting it behind `SpeakAsync(text)` is a
category error: you cannot hand it your LLM's text to speak.

So a full-duplex path needs a **second boundary**, peer to `VoiceSession`,
not inside it — roughly:

```
IDuplexVoiceSession: Start/Stop, mic-stream pump, playback pump,
  TranscriptReceived (their words + its words), Interrupted, Error
```

with an explicit product decision attached: in duplex mode the voice brain
is Moshi (or a successor), *not* the session's Maestro — or Moshi's
transcript is bridged into the chat log as a record only. It also brings a
real deployment cost: `moshi-server` is a separate process and effectively
wants a GPU.

**Pragmatic note:** ~90 % of the felt benefit (fast turn-taking + barge-in)
is reachable inside the *existing* boundary by (d)+(e) plus keeping VAD
listening during playback with echo cancellation — `VoiceSession` already
sketches barge-in (`Engine_SpeechDetected`, VoiceSession.cs:327-336); it is
dead today only because the mic is paused during TTS. Recommendation:
land (d)+(e) behind `ISpeechEngine` first; treat Moshi as a separate,
later track with its own boundary.
