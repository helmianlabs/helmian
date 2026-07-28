# HANDOFF — 2026-07-28 evening (supersedes HANDOFF_2026-07-28_SERIAL_WORK_ORDER.md)

> **Rule 0.001 — SOURCE OF TRUTH + FULL TRACING (verbatim):** "Every factual
> claim I make to Troy must satisfy BOTH gates. No exceptions. Rule 0 says 'do
> not lie.' Rule 0.001 says HOW: prove every claim with primary-source citation
> AND trace every chain end-to-end with a citation on every link."
> **Rule 0.13 (verbatim status):** "NO time-cap handoff. Stick to the rules
> instead. (RETIRED 2026-05-29)."
>
> Everything below marked ✓ was verified by the orchestrator's OWN command runs
> this session. Agent-reported-only claims are marked [agent]. Inherit nothing
> unstamped.

## Verified-shipped today (all in working tree, NOTHING COMMITTED — repo `main` was already dirty before this session)

| Item | Where | Proof |
|---|---|---|
| ✓ Two-layer secret redaction | tool layer (src/agent/tools.mjs, redact.mjs) + outbound boundary `redactOutboundBody` (providers.mjs:121/211/299) | 6/6 real .env secrets blocked in direct test; live Grok agent read .env → zero leaks in output |
| ✓ Custom OpenAI-compatible endpoints end-to-end | CustomChatSession.cs, ConsoleSession.cs:58-155, MainWindow dropdown repopulation, bridge/env/session/providers .mjs | orchestrator's own stub round-trip: prompt arrived in stub request log, reply streamed back |
| ✓ Honest status labels | ProviderProfiles.cs:203-226, PilotSnapshot.cs:140-165 | read post-fix: "verified" requires a live probe THIS run; config-existence never says active |
| ✓ Input clears at dispatch, all 3 submit paths | MainWindow.xaml.cs ~1382-1385 | [agent A] code-read; GUI never executed — Troy's eyes still owed |
| ✓ Voice stack: local Whisper STT + Kokoro TTS, System.Speech DELETED | ISpeechEngine/LocalVoiceEngine/WhisperSpeechRecognizer/KokoroSpeechSynthesizer/VoiceAudio/DictationCommands.cs; SpeechEngine.cs + AudioEndpointProbe.cs deleted | headless round-trip in orchestrator's own smoke run: Kokoro WAV → Whisper transcript character-identical |
| ✓ Live human proof of STT + switcher | Troy's own Pilot run | heard "Hello hello hello" clean; console showed `fast · grok-4.3` |
| ✓ Per-task model auto-switcher | src/agent/model-router.mjs + loop/session/env/bridge wiring | stub wire-proof 3 distinct models by difficulty; live xAI fast grok-4.3 vs deep grok-4.5; Fable never auto-selected |
| ✓ Workspace guard | EnvironmentSettingsStore.cs guards + AgentWorkspaceResolver.cs + 10 smoke checks | root cause was poisoned `.env` WORKSPACE_PATH=C:\Users\troyh\.grok (fixed in .env by orchestrator); negative control pasted by agent D |
| ✓ Publish pipeline carries voice assets | publish.ps1 asset block (ASCII only — em dash breaks WinPS 5.1) | fresh publish 15:47: runtimes/, models 141+310MB, 54 voices, 372 espeak, onnx DLLs all auto-present |
| ✓ Session lessons pushed to Neon | bigsister.agent_logs, 6 events | six OK writes, exit 0 |

## Final numbers (orchestrator's runs)
dotnet build 0W/0E · SmokeTests **8 suites** all pass (incl. workspace guard 10, voice 39 + round-trip) · npm test **122/122**.
Baseline at session start was 0W/0E · 6 suites · 71/71. Nothing regressed, all adds.

## Open gates (in order)
1. **Troy's live verdict on the 15:47 build**: workspace line = E:\Helmion, mic hears, **speakers answer in Kokoro voice** (WASAPI fix `KokoroSpeechSynthesizer.CreateOutputDevice`). Awaiting his report.
2. **Agent E in flight**: forensic flywheel/self-improvement audit → docs/FLYWHEEL_AUDIT_2026-07-28.md. MCP probes already live-verified by orchestrator: flywheel + context servers answer (content EMPTY — `[]` rules/blockers/context for slug helmion — E must explain), Grok advisory answers.
3. **Agent F in flight**: anonymized one-button `helmion agent-os install` package (claude/codex/gemini targets, denylist anonymization test).
4. **Troy decision STILL PENDING**: CLI defaults to FULL tools incl. shell (session.mjs:50). Recommendation on file: read-tools default + --full flag.
5. Anthropic credits exhausted (Claude Maestro dead); Gemini returned 429 on live test; xAI works; OpenAI untested.
6. Next builds queued: dictate-mode UI wiring (spec: docs/VOICE_PHASE1_WIRING_TODO.md), voice host ws://127.0.0.1:8765 (Phase 2), Moshi duplex (Phase 3 — check GPU first).

## Traps for the next session
- `dotnet test` finds nothing; real harness = `dotnet run --project desktop/Helmion.Desktop.SmokeTests`.
- `npm run desktop:package` runs under Windows PowerShell 5.1 — ASCII only in .ps1.
- KokoroSharp.CPU, never plain KokoroSharp.
- SESSION_BOARD.md claims are mandatory; an unregistered concurrent session collided here earlier today.
- Published exe needs runtimes/models/voices/espeak BESIDE it (publish.ps1 does this now).
- desktop-settings.json may still hold LastWorkspacePath=.grok — inert (guard rejects), self-heals on a good launch.
