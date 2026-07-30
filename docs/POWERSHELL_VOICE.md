# Helmion voice from PowerShell

Whisper in, Kokoro out, from any PowerShell session. The same two model files
the desktop app uses, driven by a console host instead of the WPF window.

Everything here runs offline against `desktop/models/`. There is no edge-tts, no
`speak.ps1`, no SAPI, no `SoundPlayer`, and nothing on this path opens a socket.

## Why this exists

The local voice stack was already built and proven — `LocalVoiceEngine`,
`WhisperSpeechRecognizer`, `KokoroSpeechSynthesizer` — but it was reachable from
exactly one place: `MainWindow.xaml.cs`, inside the window. It was not exposed on
the local-service named pipe either. So the models were locked in the GUI.

`desktop/Helmion.Voice.Host` is a console front end over the same engine. It has
no WPF reference and no window, ever.

## Setup

```powershell
dotnet build desktop\Helmion.Desktop.slnx -c Release
Import-Module E:\Helmion\desktop\powershell\Helmion.Voice
```

To load it in every session, add that `Import-Module` line to `$PROFILE`.

Check it before trusting it. `Get-HelmionVoiceStatus` makes no sound and opens no
microphone:

```powershell
Get-HelmionVoiceStatus
Test-HelmionVoice          # synthesize -> transcribe -> compare, silently
```

## The commands

| Command | What it does |
| --- | --- |
| `Invoke-HelmionSpeak "text"` | Says it through Kokoro. Blocks until the audio finishes. |
| `Start-HelmionDictation` | Listens and types what you say into the focused window. |
| `Stop-HelmionDictation` | Stops listening, releases the microphone. |
| `Register-HelmionVoiceHotkey` | Arms a global hotkey that toggles dictation. |
| `Unregister-HelmionVoiceHotkey` | Releases the hotkey and stops the host. |
| `Get-HelmionVoiceStatus` | Models, devices, mic state. Silent. |
| `Test-HelmionVoice` | Round-trip proof. Silent. |

Examples:

```powershell
Invoke-HelmionSpeak "The build is green."
Get-Content .\reply.md -Raw | Invoke-HelmionSpeak
Invoke-HelmionSpeak "asterisks *stay* in" -Raw
```

By default the text is cleaned for the ear — markdown, code fences and tool
chrome are stripped, and the result is capped at 1,200 characters
(`SpeechTextCleaner.MaxSpokenLength`) so one reply cannot monologue. `-Raw` opts
out of both.

## Dictation types; it does not send

This is the line `DictationCommands` already drew, and the host keeps it. Speech
becomes **typed text** at your cursor. The only utterance that presses Enter is
"send it".

Spoken commands must be the entire utterance:

| Say | Effect |
| --- | --- |
| `new line` | Shift+Enter — a line break, not a submit |
| `scratch that` | Erases the last thing dictation typed |
| `send it` | Enter |
| `stop dictation` | Stops listening |

"send it to the vendor tomorrow" is typed as text. Only the bare command matches.

**`scratch that` can only erase what dictation itself typed.** `DictationTypist`
counts the characters it emitted and will never emit more backspaces than that,
so it cannot chew backwards into something you typed by hand. After a send, a
line break, or a change of focused window, the count resets to zero and
`scratch that` does nothing at all.

## The hotkey: Ctrl+Shift+Alt+H

Troy remembered Ctrl+Shift+C. **Do not use it.** Here is the measurement.

A global `RegisterHotKey` is *exclusive machine-wide*: while it is held, the
combination is taken away from every other application. Probing which chords
another process already owns (2026-07-30, this machine):

| Chord | Global owner? | Verdict |
| --- | --- | --- |
| `Ctrl+Shift+C` | none — registration succeeds | **Rejected.** See below. |
| `Ctrl+Alt+Space` | taken (`ERROR_HOTKEY_ALREADY_REGISTERED`, 1409) | Unavailable |
| `Win+H` | taken (1409) — Windows voice typing | Unavailable |
| `Win+Alt+D` | taken (1409) | Unavailable |
| `Ctrl+Win+V` | taken (1409) | Unavailable |
| `Win+Alt+H` | free | Rejected — Game Bar neighbourhood |
| `Ctrl+Shift+Alt+H` | free | **Chosen** |

Ctrl+Shift+C having no global owner is exactly why it is the wrong choice.
Registering it would **succeed**, and succeeding is the damage: it is an
application-level shortcut in several things Troy uses every day — copy in
Windows Terminal, the element picker in Chrome DevTools, "open external terminal"
in VS Code. A global registration would silently take it from all of them, and
the breakage would show up later as "copy stopped working" with nothing pointing
back here.

`Win+Alt+H` was free but rejected on adjacency: `Win+Alt+K` is Game Bar's **mute
microphone**. Given the 2026-07-25 incident where a voice attempt left the
microphone ducked, binding a voice feature one key away from a mic-mute shortcut
is the wrong place to sit.

`Ctrl+Shift+Alt+H` was chosen because three modifiers is outside the space
applications bind by default, it has no global owner, and `H` is for Helmion.
It also cannot be pressed by accident, which is the right property for a key that
opens a microphone.

Override it if you want something else:

```powershell
Register-HelmionVoiceHotkey -Chord 'ctrl+alt+f12'
```

**What the probe does and does not prove.** A successful `RegisterHotKey` proves
no other process holds a *global* registration at that moment. It does not prove
no application binds the combination internally — that is precisely the
Ctrl+Shift+C trap. The rejections above are reasoned from documented
application-level use, not from the probe.

The microphone stays **closed** until the hotkey is pressed the first time.
Arming the hotkey does not open a capture device.

## The microphone is never muted, ducked, or seized

On 2026-07-25 a previous voice attempt on this machine left Troy's microphone
ducked while it spoke, so he could not tell he was being heard and lost whole
sentences
(`~/.claude/projects/C--Users-troyh/memory/feedback-2026-07-25-voice-mutes-troys-mic.md`).

How this stack is different, and how each claim is checked:

| Claim | Evidence |
| --- | --- |
| Playback is shared-mode, so it cannot seize the output device | `KokoroSpeechSynthesizer.cs:488` — `new WasapiOut(AudioClientShareMode.Shared, …)`; the fallback is `WaveOutEvent` with `DeviceNumber = -1` (waveOut, shared by construction) |
| Capture cannot take the mic exclusively | `WhisperSpeechRecognizer.cs:115` uses NAudio `WaveInEvent` — the winmm `waveIn` API has no exclusive mode to ask for |
| No code writes a mute flag or a volume level | Source scan in `VoiceHostSmokeChecks.CheckVoiceStackCannotMuteTheMicrophone` fails the suite on `.Mute =`, `MasterVolumeLevelScalar =`, `AudioClientShareMode.Exclusive`, `AudioCategory_Communications`, `SAPI.SpVoice`, `SoundPlayer`, `edge-tts`, `speak.ps1` |
| Measured, not just argued | The same check fingerprints the default capture device (name + mute + level) before and after building the engine and fails if anything moved; `helmion-voice selftest` repeats it around a full synth + transcribe |

`AudioDevicePosture` has getters only. There is no setter anywhere in it.

Measured on 2026-07-30: `Microphone (K66)|muted=False|volume=0.9373`, identical
before and after a full round trip.

## No window, ever

- The host project has no `UseWPF`, no `UseWindowsForms`, and no reference to
  `Helmion.Desktop`.
- Background modes are launched from the module with `UseShellExecute = $false`
  and `CreateNoWindow = $true`, which is `CREATE_NO_WINDOW`: the process is given
  **no console at all**, not a hidden one. There is no window to flash.
- The global hotkey is registered with a NULL window handle, so `WM_HOTKEY` goes
  to the thread's message queue. The usual technique — a hidden message window —
  is still a window, and is not used here.
- Status from a background host goes to `%TEMP%\helmion-voice-host.log`, not to
  your terminal, so it cannot interleave with a conversation.

## One host at a time

Two hosts capturing simultaneously would transcribe the same speech twice and
type it twice. A machine-wide mutex (`Local\Helmion.Voice.Host.SingleInstance`)
makes the second one refuse to start and name the process holding the microphone.

`Stop-HelmionDictation` signals `Local\Helmion.Voice.Host.Stop`, so the running
host closes the capture device cleanly; it only falls back to ending the process
if that is not acknowledged within the timeout.

## Verifying it

```powershell
dotnet build desktop\Helmion.Desktop.slnx -c Release
dotnet run --project desktop\Helmion.Desktop.SmokeTests\Helmion.Desktop.SmokeTests.csproj -c Release
```

Both are console-only. The suite runs `helmion-voice selftest` as a child process
with `CREATE_NO_WINDOW` and asserts the round trip, so the console host is proven
in the same run as the engine.

## What is NOT verified

**Keystroke injection has never been executed.** `KeyboardInjector` uses
`SendInput`, which types into whatever window currently has focus. There is no
way to exercise it in a test without typing into whatever the user is actually
looking at, so it is deliberately left unexercised. The logic that *decides* the
keystrokes (`DictationTypist`) is fully covered; the call that *delivers* them is
not.

Two consequences of that, both unverified:

1. **`new line` sends Shift+Enter.** Whether that inserts a line break rather
   than submitting depends on the focused application. It is right for most chat
   inputs and editors. If it submits in a particular terminal, that is the
   mapping to revisit.
2. **The first real dictation session is the first execution of `SendInput`
   in this codebase.** It compiles and the struct layout is correct by
   inspection, but it has not run.
