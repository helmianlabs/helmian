# Helmion Voice Dictation

Talk to Claude Code instead of typing. Press a key, say your piece, press it
again — the text lands in whatever window has focus, with your own vocabulary
already loaded so it stops turning **Helmion** into "Helmand" and **Moshi** into
"Moshe".

Runs entirely on this machine. No network call, no API key, no audio leaves the
box.

---

## Use it

| Do this | What happens |
|---|---|
| `.\start-dictation.ps1` | Starts it. No window appears — that is correct. |
| **Ctrl+Alt+Space** | Start talking. Tray dot turns **red**. |
| **Ctrl+Alt+Space** again | Stops, transcribes (**amber**), types the text into the focused window. |
| **Ctrl+Alt+X** | Throws the current recording away. Nothing is typed. |
| `.\stop-dictation.ps1` | Stops it cleanly. |
| Right-click the tray dot | "Open log" or "Quit dictation". |

The text is **not** submitted for you. It lands in the prompt, you read it, you
press Enter. That is deliberate — a mis-heard word should never reach Claude
before you have seen it.

Auto-start at logon is **off**. Turn it on with
`.\autostart-dictation.ps1 -Enable` (writes one HKCU value, no admin needed),
off again with `-Disable`, check with `-Status`.

First run needs a build:

```powershell
dotnet build .\Helmion.VoiceDictation\Helmion.VoiceDictation.csproj -c Release
```

---

## Add your own words

Open **`Helmion.VoiceDictation\bin\Release\net10.0-windows\voice-dictation.config.json`**,
add strings to `vocabulary`, restart. That list is fed to Whisper as an initial
prompt, which biases the decoder toward those spellings.

It measurably works. The same Kokoro-synthesized sentence, decoded twice through
the same model — once with no prompt, once with the vocabulary:

| | Transcript |
|---|---|
| **Spoken** | Helmion runs Moshi and Kokoro locally, while Kyutai ships duplex LLMs for DairyForge. |
| **No vocabulary** | Hal­mian runs **Moshe** and **Kakaro** locally, while Cuteye ships duplex LLMs for **dairy forge**. |
| **With vocabulary** | **Helmion** runs **Moshi** and **Kokoro** locally, while Qdai ships duplex LLMs for **DairyForge**. |

2 of 7 terms correct without it, 6 of 7 with it. `Kyutai` is the one it still
misses — the prompt changed the error ("Cuteye" to "Qdai") without fixing it, so
that word is honestly not solved yet.

Two limits worth knowing. Whisper reads only the last ~224 tokens of the prompt
and weights later words more heavily, so if the list ever grows past ~700
characters it is trimmed from the front — put what matters most at the **end**.
And the prompt biases, it does not force: a word can still come out wrong.

---

## Why it is built this way

**Why a standalone project rather than reusing `Helmion.Desktop.Core`.** The
Pilot already has a working Whisper recogniser, and this reuses its stack — same
Whisper.net 1.9.1, same NAudio, the same `ggml-base.en.bin` — but not its
assembly, for three reasons. The vocabulary feature needs `WithPrompt(...)` at
processor-build time, and the Pilot builds its processor without one
(`WhisperSpeechRecognizer.cs:333-337`), in a file another session owns. Core also
pulls in Npgsql, KokoroSharp and the local-service protocol for what is a
microphone-to-text tool. And the Pilot's recogniser closes an utterance after 750
ms of silence (`WhisperSpeechRecognizer.cs:29`), which is right for conversation
and wrong for dictation — you pause mid-sentence to think, and that would cut you
off and inject half a thought. Here the hotkey is the only endpoint.

**Why the text is pasted rather than typed, by default.** Checked against this
machine rather than assumed: Windows Terminal's own settings bind `ctrl+v` to
`Terminal.PasteFromClipboard`, and `WT_SESSION` is set inside the shell Claude
Code runs in — so the terminal receiving the text is that Windows Terminal, and
one keystroke moves any length of text atomically. Synthetic typing is kept as
`"injectionMode": "type"` because paste depends on the target *having* a paste
binding; a raw conhost or an RDP session may not, and `KEYEVENTF_UNICODE` input
bypasses keybindings entirely. Two mechanisms were rejected: UI Automation
(a terminal exposes its buffer as read-only text, so there is nothing to set) and
posting `WM_CHAR` straight to the window (ConPTY-hosted terminals read from the
pseudoconsole, and posted messages get dropped; `SendInput` travels the same path
a real keyboard does).

**Why toggle and not push-to-talk.** `WM_HOTKEY` fires on key *down* only — the
API delivers no key-up — so hold-to-talk would need a `WH_KEYBOARD_LL` global
hook sitting in the path of every keystroke on the machine. If this process ever
stalled while holding that hook, your typing would stall with it. Not worth it.

**Why Ctrl+Alt+Space.** `RegisterHotKey` matches modifiers exactly, so it cannot
steal Grok Build's plain **Ctrl+Space** dictation or its **F8**. Both it and
Ctrl+Alt+X registered first try on this machine, which means nothing else owns
them. Change either in the config; a hotkey with no modifier is refused outright
rather than capturing that key everywhere.

**Why there is no console.** `OutputType` is `WinExe`, verified in the built
binary: the PE subsystem byte reads `2` (GUI), not `3` (console). Starting it
adds zero `conhost` processes and its `MainWindowHandle` is `0`. The tray dot is
the only thing it ever puts on screen. Everything else goes to
`%LOCALAPPDATA%\Helmion\voice-dictation.log`.

---

## When something goes wrong

Nothing here ever pops a dialog or blocks your keyboard. Failures are logged and
the tray dot goes dark red. Read `%LOCALAPPDATA%\Helmion\voice-dictation.log`
(right-click the tray dot, "Open log").

| Symptom | Cause |
|---|---|
| Hotkey does nothing, log says Win32 error 1409 | Another app already owns that combination. Change `hotkey` in the config. |
| Tray dot dark red on startup | `ggml-base.en.bin` missing. Run `desktop/scripts/get-voice-models.ps1`. |
| Recording starts, no text appears | Log names the window it injected into. If that window runs as administrator, injection is blocked by design — this process is `asInvoker` and Windows forbids input into a higher-integrity window. |
| Text appears in the wrong window | It goes wherever focus is at the moment you press the hotkey the second time. |
| Old clipboard text got pasted instead of the dictation | `clipboardRestoreDelayMs` is too low for that target. Raise it, or set `restoreClipboard` to `false`. |

---

## Testing it

```powershell
dotnet build .\Helmion.VoiceDictation.SelfTest\Helmion.VoiceDictation.SelfTest.csproj -c Release
.\Helmion.VoiceDictation.SelfTest\bin\Release\net10.0-windows\Helmion.VoiceDictation.SelfTest.exe
```

It synthesizes a sentence with Kokoro, decodes it with and without the
vocabulary prompt and compares them, then injects into an invisible test window
and reads back what arrived. `--no-injection` skips the part that briefly takes
keyboard focus.

This project is **not** in `desktop/Helmion.Desktop.slnx`, on purpose: running it
must never be able to drag in `Helmion.Desktop.SmokeTests`, which performs a real
sync against the live `~/.claude`.

The one thing the self-test cannot do is speak into your microphone. Whether
dictation is accurate on *your* voice through *your* mic is yours to judge.
