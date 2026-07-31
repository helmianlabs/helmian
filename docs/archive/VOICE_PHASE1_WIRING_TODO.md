# Voice Phase 1 — remaining MainWindow wiring

Phase 1 replaced the System.Speech (SAPI) voice stack with a fully local
Whisper + Kokoro engine behind `ISpeechEngine`. **The engine layer is done and
proven headlessly.** What remains is UI wiring, which was deliberately out of
scope because `MainWindow.xaml` / `MainWindow.xaml.cs` were owned by another
session.

Nothing below is required for the app to build or run today. The existing mic
button keeps working: `VoiceSession`'s public surface did not change, and
`MainWindow.xaml.cs:491` still constructs `new VoiceSession()`, which now
defaults to the local engine.

---

## What already works without any UI change

| Behaviour | Where |
|---|---|
| Mic button starts/stops two-way voice | `VoiceSession.StartVoiceMode` / `StopVoiceMode` (unchanged) |
| Transcripts reach the chat | `VoiceSession.OnSpeechRecognized` → `MainWindow.xaml.cs:1418` |
| Replies are spoken with Kokoro | `VoiceSession.SpeakAsync` |
| Mic no longer dies after a pause | `WhisperSpeechRecognizer` has no silence timeout |
| Device faults degrade instead of crashing | `VoiceState.Degraded`, never rethrown to the UI thread |

---

## 1. Status pill — surface `VoiceState`

`VoiceSession.EngineState` (new, read-only) returns `Idle`, `Listening`,
`Speaking`, or `Degraded`.

`ISpeechEngine.StateChanged` fires on every transition, but `VoiceSession` does
**not** currently re-raise it as its own event — adding one would have changed
`VoiceSession`'s frozen public surface. Two options for the follow-up session:

- **Poll** `EngineState` from the existing status refresh, or
- **Add** `public event EventHandler<VoiceState>? OnVoiceStateChanged` to
  `VoiceSession` and forward `_engine.StateChanged` to it. This is additive and
  safe now that the freeze is lifted; it is the better long-term shape.

Suggested pill mapping:

| State | Pill | Meaning |
|---|---|---|
| `Idle` | grey | voice mode off, or mic paused between turns |
| `Listening` | amber | microphone live |
| `Speaking` | blue | Kokoro audio playing |
| `Degraded` | red | no device or model — app continues text-only |

`Degraded` is the one that matters. It means the user gets no audio and needs to
be told why; the reason already arrives as text through
`VoiceSession.OnError`.

## 2. Mic button — reflect the persistent toggle

The microphone is now a genuine toggle: capture runs until `StopVoiceMode()`,
with no timeout that ends it on its own. The old engine self-terminated after
`InitialSilenceTimeout`, so the button could show "listening" while the mic was
already dead.

Bind the button's active look to `VoiceSession.IsListening` (already exists,
already correct) rather than to a local `_micOn` flag, so a degraded engine
cannot leave the button lit.

## 3. Dictate mode — route transcripts to the caret

The engine side is done; the UI side is not wired at all.

`DictationCommands.Detect(transcript)` is a pure function returning
`DictationCommand { Kind, Text }`:

| Kind | Utterance (whole utterance only) | UI should |
|---|---|---|
| `Newline` | "new line", "next line", "new paragraph" | insert `\n` at the caret |
| `Scratch` | "scratch that", "delete that", "undo that" | remove the last inserted chunk |
| `Send` | "send it", "send message", "submit" | submit the input box |
| `Stop` | "stop listening", "voice off" | exit dictate mode |
| `Literal` | anything else | insert `Text` at the caret |

Matching is strict by design — a command must be the entire utterance, so
"send it to the vendor tomorrow" inserts text rather than submitting. That
strictness is covered by checks in
`desktop/Helmion.Desktop.SmokeTests/VoiceSmokeChecks.cs`.

**Wiring needed:** a dictate toggle that switches
`VoiceSession.OnSpeechRecognized` between two consumers — the existing
"send to the model" path (`MainWindow.xaml.cs:1418`) and a new
"type into the focused control" path that runs transcripts through
`DictationCommands.Detect` first. To support `Scratch`, keep the length of the
last inserted chunk so it can be removed.

## 4. First-run model check

If the models are absent, `VoiceSession` starts in `Degraded` and every voice
action reports the reason through `OnError`. Nothing crashes, but the user only
finds out when they click the mic.

Better: call `VoiceModelPaths.DescribeMissingAssets()` at startup. It returns
null when everything is present, or a single sentence naming the missing files
and the script that fetches them. Show it once as a banner rather than letting
the user discover it mid-conversation.

---

## Setup for a fresh clone

```powershell
./desktop/scripts/get-voice-models.ps1
```

Downloads into `desktop/models/` (gitignored, ~470 MB total):

| File | Size | Source |
|---|---|---|
| `ggml-base.en.bin` | 147,964,211 bytes | huggingface.co/ggerganov/whisper.cpp |
| `kokoro.onnx` | 325,508,342 bytes | github.com/Lyrcaxis/KokoroSharpBinaries v2.0.0 |

Voices (`voices/*.npy`) and the espeak-ng phonemizer (`espeak/*.dll`) are **not**
downloaded — they ship inside the `KokoroSharp.CPU` NuGet package and are copied
to the build output automatically. Verified present in
`Helmion.Desktop/bin/.../voices` (54 files) and `.../espeak` (5 DLLs).

Override the model location with the `HELMION_VOICE_MODELS` environment variable.

---

## Known gaps, stated plainly

- **No human has spoken to this build yet.** Every proof so far is headless:
  Kokoro synthesizes a WAV, Whisper reads that same WAV back. Live microphone
  capture, endpointing against a real voice, and audible playback through real
  speakers are all unverified. That test is Troy's.
- **VAD is energy-based**, not Silero. It adapts to room tone and holds the
  ~750 ms end-of-phrase feel of the old engine, but it has not been tuned
  against a noisy room, background music, or a far-field mic. Whisper.net does
  expose a Silero VAD model (`WhisperGgmlDownloader.GetGgmlSileroVadModelAsync`)
  if the energy gate proves too eager.
- **First utterance is slow.** Cold-loading the 325 MB Kokoro ONNX costs about
  1.2 s. `LocalVoiceEngine` kicks off a background `Warmup()` at construction to
  hide it, but a reply that arrives within the first second still waits.
- **Barge-in is not implemented.** `VoiceSession.Engine_SpeechDetected` still
  sketches it, but the mic is paused during playback, so nothing can detect an
  interruption. Real barge-in needs the full-duplex path described in
  `VOICE_STACK_ASSESSMENT.md` section f, not a change here.
- **Playback tail is approximate.** `Speak` returns when the buffer drains plus
  one 150 ms latency window. It does not query the driver's exact play cursor,
  so the mic may resume a few tens of milliseconds early or late.
