# Helmion Local Voice

Talk to any AI in a terminal instead of typing, and have it talk back. Press a
key, say your piece, press it again — the text lands in whatever window has
focus, with your own vocabulary already loaded so it stops turning **Helmion**
into "Helmand" and **Moshi** into "Moshe". Anything that can write a file can
speak back through the same stack.

Runs entirely on this machine. No network call, no API key, no audio leaves the
box.

**It is not tied to Claude Code.** Dictation types into the focused window using
`SendInput`, and the only thing it asks Windows is "which window is in front"
(`TextInjector.cs:334`). There is no process-name check anywhere in the injector.
Claude Code, Grok Build, Codex, a plain PowerShell prompt, Notepad — if it takes
keyboard input and it is in front, it gets the text.

---

## Use it — one command

| Do this | What happens |
|---|---|
| `.\voice.ps1 -Start` | Starts both halves. No window appears — that is correct. |
| `.\voice.ps1 -Status` | Says what is running, and what to press. |
| `.\voice.ps1 -Say "text"` | Reads that text aloud. Starts the speaker if it is not up. |
| `.\voice.ps1 -Stop` | Stops both cleanly. |

### Talking to it

| Key | What happens |
|---|---|
| **Ctrl+Alt+Space** | Start talking. Tray dot turns **red**. |
| **Ctrl+Alt+Space** again | Stops, transcribes (**amber**), types the text into the focused window. |
| **Ctrl+Alt+X** | Throws the current recording away. Nothing is typed. |
| Right-click the tray dot | "Open log" or "Quit dictation". |

The text is **not** submitted for you. It lands in the prompt, you read it, you
press Enter. That is deliberate — a mis-heard word should never reach Claude
before you have seen it.

### It talking to you

Any program, in any language, can speak by dropping a UTF-8 `.txt` file into
`%LOCALAPPDATA%\Helmion\speak-queue`. That is the whole interface — no SDK, no
port, no import. `voice.ps1 -Say` is just a two-line wrapper around it.

**The stop button silences it.** `~/.claude/scripts/stop_voice.ps1` already runs
on every prompt submit and stamps `~/.claude/_voice/STOP`; the speaker watches
that file and cuts the current sentence **and drops everything still queued**.
Measured 2026-07-29: press to silence in 16 ms, with two queued utterances
discarded rather than played on. It had to be built in explicitly — that hook
silences the older Edge-TTS path by killing `ffplay`, and this speaker is not
ffplay, so nothing would have stopped it otherwise.

**Never pass the text as a PowerShell argument.** `-ArgumentList 'x y z'` splits
on spaces, so only the first word arrives. Measured 2026-07-29: an 85-character
sentence arrived as 7 characters and produced 1.45 s of audio instead of 6.78 s,
which looks exactly like a broken model and is not one. Use `-Say`, the queue
folder, or `--file`.

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

**Why the local Kokoro speaker did not replace `~/.claude/speak.ps1`.** That
script maps a name to a specific Edge-TTS voice — `bigsister` to Emma,
`clyde` to Andrew (`speak.ps1:8-13`) — and `CLAUDE.md` rule 0.26 locks that map
by name, marks it "DO NOT FLIP", and names the script itself as the source of
truth. Kokoro cannot produce Emma or Andrew; its voices are a different set
entirely (`af_heart` and 53 others). Repointing `speak.ps1` at Kokoro would have
silently re-voiced both identities and destroyed the by-ear distinction that map
exists to create. So the local speaker is a **second, additive** path: no
network and no cost when you want that, with the locked identity untouched.

---

## Who owns which key

Nothing here collides. `RegisterHotKey` is exclusive machine-wide — a second
registrant gets Win32 error 1409 — so a successful registration *is* the proof
that nothing else holds the combination. Verified 2026-07-29 00:29:01 with
Unity, VS Code, Cursor and Grok Build all running at the time.

| Combination | Owner | Verified |
|---|---|---|
| **Ctrl+Alt+Space** | Helmion dictation (global) | Registered clean, log 00:29:01.046 |
| **Ctrl+Alt+X** | Helmion dictation (global) | Registered clean, log 00:29:01.047 |
| **Ctrl+Space** | Grok Build dictation | Untouched — modifiers are matched exactly, so Ctrl+Alt+Space is a different registration |
| **F8** | Grok Build | Untouched — never registered here |
| **Ctrl+V** | Windows Terminal paste | Used by the injector, deliberately |

One consequence worth knowing: a global hotkey is consumed by Windows before the
focused app sees it, so while dictation runs, no application receives
Ctrl+Alt+Space at all. Windows Terminal's settings bind neither combination, and
neither VS Code nor Cursor has a `keybindings.json` — so nothing on this machine
loses a shortcut it was using. Change either key in the config if that ever
stops being true.

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
