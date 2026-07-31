# HANDOFF — 2026-07-28 Serial Work Order session

> **Rule 0.001 — SOURCE OF TRUTH + FULL TRACING (verbatim):** "Every factual
> claim I make to Troy must satisfy BOTH gates. No exceptions. Rule 0 says 'do
> not lie.' Rule 0.001 says HOW: prove every claim with primary-source citation
> AND trace every chain end-to-end with a citation on every link."
> **Rule 0.13 (verbatim status):** "NO time-cap handoff. Stick to the rules
> instead. (RETIRED 2026-05-29)" — no 45/60-minute clock applies; discipline,
> not a timer.
>
> Every claim below was verified THIS session with the cited command output or
> file:line. Anything a future session inherits from here is [UNVERIFIED] until
> re-checked.

## What shipped

| Item | Where | Proof |
|---|---|---|
| Baseline + close-out: `dotnet build` | E:\Helmion, `dotnet build desktop/Helmion.Desktop.slnx` | 0 warnings / 0 errors, both runs |
| Baseline + close-out: `dotnet test` | same slnx | **discovers zero VSTest projects** (only restore output, exit 0). Real .NET harness is `dotnet run` on Helmion.Desktop.SmokeTests: all 6 suites passed both runs (23+9+10+7 counted checks + Maestro router + WORKSPACE_PATH), exit 0 |
| Baseline + close-out: `npm test` | `node --test` | 71 pass / 0 fail / 0 skipped, both runs. **No regressions — every number identical.** |
| Task 1: `fix-voice-and-github.ps1` removed | repo root | `Test-Path` → False. **NOT deleted by this session** — it vanished between this session's first directory listing and its delete attempt; a concurrent session removed it (see below) |
| Task 2: voice stack assessment | `docs/VOICE_STACK_ASSESSMENT.md` | report only; no voice code written. STT+TTS both live in `desktop/Helmion.Desktop.Core/SpeechEngine.cs`; swap seam = extract interface from SpeechEngine's public surface, inject into VoiceSession (VoiceSession.cs:11) |
| Task 3: custom LLM endpoint trace | reported in session, summary below | **NOT wired.** Settings-only |
| Task 4: `SESSION_BOARD.md` | repo root | created, 2 rows (this session + the observed unregistered concurrent session) |

## Task 3 verdict (for the next session)

Custom endpoint field (MainWindow.xaml:2354) → saved to
`DesktopSettings.CustomProviders` (MainWindow.xaml.cs:703-704) → consumed ONLY
by the display-row builder (ProviderProfiles.cs:192-211). The Maestro dropdown
is four fixed items (MainWindow.xaml:2287-2290); `ConsoleSession.ConfigureMaestro`
routes to four hardcoded endpoint constants (ConsoleSession.cs:13-17, 58-106);
the Node agent throws on any provider not in {openai, claude, gemini, grok}
(src/agent/env.mjs:81-98) with hardcoded URLs (src/agent/providers.mjs:8-10).
Bonus defect: custom rows display "API profile active / Configured · active"
(ProviderProfiles.cs:201-202) — false on its face. `http://localhost:11434/v1`
appears nowhere in the live tree. Not fixed — work order said report only.

## Unverified / open

- **A concurrent unregistered session was active in this tree at ~12:43 PM**:
  it deleted `fix-voice-and-github.ps1` and wrote `SECURITY_FIX_REPORT.md`
  claiming edits to `src/agent/tools.mjs` + new `src/agent/redact.mjs`.
  [UNVERIFIED — this session did not audit those edits; npm test's 71/71 pass
  at close-out is the only evidence they didn't break the suite.]
  `test-redaction.mjs` / `test-tool-direct.mjs` named in that report were not
  found at repo root by this session's listings — [SUSPECT].
- The git tree was already dirty before this session (bin/helmion.mjs + ~10
  desktop files modified, branch `main`). Nothing was committed this session.
- VOICE_STACK_ASSESSMENT.md sections d/e (Whisper.net, sherpa-onnx, Kokoro
  bindings) are design assessments from training knowledge, flagged as such in
  the doc — 10-minute live-docs check needed before implementation.

## Next session picks up

1. CSI-audit the concurrent session's redaction changes (`src/agent/redact.mjs`,
   `src/agent/tools.mjs`) before trusting SECURITY_FIX_REPORT.md.
2. If the local-model path should be real: wire `CustomProviders` through
   Maestro selection + `resolveProvider`/`providers.mjs` (add base-URL support),
   or delete the dead settings card. Fix the false "active" status label either way.
3. Voice: land `ISpeechEngine` extraction + Whisper/Parakeet STT + Kokoro TTS
   per docs/VOICE_STACK_ASSESSMENT.md; Moshi is a separate track with its own
   boundary.
4. Enforce SESSION_BOARD.md: every session adds its row before touching files.
