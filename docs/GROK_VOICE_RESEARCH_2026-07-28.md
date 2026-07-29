# Grok Build — native voice / microphone research

**Date:** 2026-07-28
**Agent:** f3673e34/agent-S-grok-voice-research
**Mode:** RESEARCH ONLY. Nothing was built, installed, or configured. One read-only
`grok --help` was run; no credential file was opened or printed.

**Question:** Does Grok Build (xAI's coding-agent CLI, authenticated via SuperGrok /
X Premium+) have NATIVE microphone / speech-to-text, so Troy does not need a second
Whisper+Kokoro pipeline built for it?

---

## Answer table

| Question | Answer | Source |
|---|---|---|
| 1. Does the Grok Build CLI have a native mic / dictation mode? | **YES.** Built in, toggled with **Ctrl+Space** or **F8**. Not a plugin, not an add-on. | Troy's own installed copy: `C:\Users\troyh\.grok\CHANGELOG.md:17` — *"**Voice shortcut** toggle in settings can disable the Ctrl+Space/F8 keybind without disabling voice entirely."* |
| 1b. Is it a real, maintained feature or a stub? | Actively maintained — four voice fixes shipped in the single version he already has. | `CHANGELOG.md:36,39,46` — *"Linux voice dictation now works on PipeWire versions before 1.6"*, *"Voice mode now lets you edit already-dictated text without closing the microphone"*, *"Voice dictation text is no longer dropped when pressing Enter to send"* |
| 1c. Is it documented, with troubleshooting? | Yes — a dedicated section, plus `grok doctor` reports which microphone it would use and emits `voice.no-input-device`. | `C:\Users\troyh\.grok\docs\user-guide\21-terminal-support.md:210-228` |
| 2. Does the xAI API expose speech-to-text? | **YES.** `https://api.x.ai/v1/stt` (batch REST) and `wss://api.x.ai/v1/stt` (streaming). 25 languages, word-level timestamps, diarization. No model ID required. | https://docs.x.ai/developers/model-capabilities/audio/speech-to-text |
| 2b. STT pricing | **$0.10 / hr (REST), $0.20 / hr (Streaming)**. TTS is $15.00 / 1M chars. | https://docs.x.ai/developers/pricing |
| 2c. Does a SuperGrok / Premium+ subscription cover STT, or is it metered API? | **AMBIGUOUS — see the open question below.** xAI's pricing and STT docs never mention subscription tiers at all. | https://docs.x.ai/developers/pricing (silent on subscriptions), https://docs.x.ai/developers/model-capabilities/audio/speech-to-text (silent) |
| 3. Is the mobile/desktop app's voice mode reachable programmatically? | The app feature itself, no. But its **equivalent** is a public API: Speech-to-Speech over WebSocket at `wss://api.x.ai/v1/realtime?model=…`, models `grok-voice-latest` and `grok-voice-think-fast-1.0`. Docs give Python and Node examples, so it is callable from a terminal or server — it is metered API, not the app. | https://docs.x.ai/developers/model-capabilities/audio/voice-agent |
| 4. If no native path, what is the minimal bridge? | **Not needed for dictation.** See "Bridge" below for the one real gap (spoken replies). | — |
| 5. Is a grok CLI installed on this machine? | **YES.** `C:\Users\troyh\.grok\bin\grok.exe`, version **0.2.112 (2026-07-24)**. Auth is **configured** (`~/.grok/auth.json` present — not opened, not read). | `Get-Command grok`; `C:\Users\troyh\.grok\CHANGELOG.md:1` |
| 5b. Does `grok --help` list audio/voice flags? | No — and that is expected, not a contradiction. Voice is a **TUI keybind**, not a command-line flag. The help output is agent/session flags only. | `grok --help` (run once, read-only) |

---

## VERDICT: **USE NATIVE**

Grok Build already does this. Troy presses **Ctrl+Space** (or **F8**) inside any Grok
session, talks, and the transcript lands in the prompt composer — where he can edit it
before pressing Enter. Building a Whisper front-end for Grok would be duplicated work
against a feature that shipped in the version already on his disk.

---

## Cost — one honest open question

I can prove the feature exists. I **cannot** prove, from a primary source, whether the
CLI's dictation bills his **subscription** or his **metered API balance**. This matters
specifically because his API balance is negative.

**What points to subscription-covered (the likelier answer):**

- The CLI's own auth doc sets the precedence: an active session token from browser OAuth
  **outranks** `XAI_API_KEY`, which is described as a *fallback*
  (`~/.grok/docs/user-guide/02-authentication.md:259-260`).
- The CLI's shipped docs describe voice dictation with **no key-setup step anywhere** —
  no voice API key appears in the authentication doc or the configuration doc.

**What points to metered (and why it is weaker than it first looked):**

- The claim that dictation needs "a separate xAI Speech-to-Text key" traces to the README
  of **phuryn/grok-build-vscode**, which states plainly it is *"not affiliated with or
  endorsed by xAI"* — a third-party VS Code extension, whose microphone button is **the
  extension's own feature**, not the CLI's. Its `GROK_VOICE_API_KEY` variable is the
  extension's, not xAI's. That same README also says the `grok login` token *"is reused
  automatically"*.

**Discarded evidence (recording this so nobody re-uses it):** I grepped the `grok.exe`
binary for `GROK_VOICE_API_KEY` and got "no matches." That result is **worthless** — a
positive control for a string the docs prove is in the product (`GROK_VOICE_CAPTURE`)
also returned nothing, and reported **0 files searched**. Ripgrep skipped the binary
entirely. The negative proves nothing and was not used to reach any conclusion above.

**What settles it, in ten seconds and at zero cost:** open a Grok session, press
Ctrl+Space, say one sentence. If dictation is metered against a negative-balance API
account it will fail with a billing or auth error. If the text appears, it is riding his
subscription session token. A single live attempt answers what the documentation does not.

---

## Bridge — the one thing that genuinely is missing

No bridge is needed for **input**. Speech-to-text into Grok is native.

The real gap is **output**: across all 22 shipped user-guide docs and the installed
changelog, voice appears **only** as dictation — text going in. There is no native
spoken reply. So if Troy wants Grok to talk *back*, that half does not exist in the CLI
and is where his existing local stack has a role: keep Grok's native Ctrl+Space for
input, and point **Kokoro** at Grok's output for speech. Whisper is not needed for Grok
at all. This is a description of the gap, not a recommendation to build anything now.
