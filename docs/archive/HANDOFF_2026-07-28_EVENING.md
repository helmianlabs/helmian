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

## Final numbers (orchestrator's own runs, after ALL agents landed)
dotnet build 0W/0E · SmokeTests **8 suites** all pass (incl. workspace guard 10, voice 39 + round-trip) · npm test **171 pass / 0 fail**.
Baseline at session start was 0W/0E · 6 suites · 71/71. Nothing regressed, all adds.

## COMMITTED — `1bdd392` (98 files, 16,102 insertions, 862 deletions)
Local commit only, **NOT pushed** — pushing to github.com/troy83352/helmion is
outward-facing and is Troy's call. Revert point: `607eddc`.
Only `_review_export_primary_providers_2026-07-28/` left untracked (deliberate:
review artifact, verified free of secrets, not repo content).

## Flywheel: audited AND repaired this session
- **THE CORE BREAK, now fixed:** `distill.mjs:36` wrote `~/.claude/LESSONS.md` and
  **nothing ever read it** — `session_start_inject.sh` listed the `lessons/`
  DIRECTORY instead. Every distilled lesson landed where no session could load it.
  Fixed by adding a `LESSONS_FILE` block; verified by running the hook and
  grepping stdout: **29,202 bytes** now inject with full ROOT CAUSE / LESSON /
  RULE / CITATION / SNIPPET per entry, exit 0. Backup: `.20260728-163616.bak`.
- **DATA LOSS found and RECOVERED:** ProfileSyncEngine's hardcoded approval set +
  ClaudeProfileInstaller's blind write truncated LESSONS.md/LEARNINGS.md to
  templates at 15:34:58. No .bak, no git (`~/.claude` is NOT a repo), no OneDrive,
  no shadow copies. **Recovered anyway** by re-running `distill.mjs - 240` —
  the lessons were DERIVED and their source rows were untouched in Neon
  (dedup marker at `distill.mjs:199` reads FROM the wiped file, so the wipe made
  regeneration possible). LESSONS.md restored to 7,799 bytes / 8 entries.
  Installer fixed: `overwriteExisting=false` default + timestamped .bak.
- Tier-B consensus gate (FK to a table nothing wrote → every review raised 23503):
  writer added, positive-controlled (4 failed before, 7 pass after).
- Advisory lane read path shipped: `helmion advisory list|show|promote|reject`,
  human approval mandatory per Rule 0.27, proven against the live bigsister endpoint.
- `bigsister_neon_log.mjs` malformed payload no longer exits 0 having written nothing.

## Agent OS package — SHIPPED
`helmion agent-os install --target claude|codex|gemini|all [--dir] [--yes] [--json]`.
Orchestrator-verified: dry-run (default) provably writes nothing; `--yes` generates
all three trees. Anonymization enforced by a denylist test with a positive control.
Hooks are deliberately NOT auto-wired — snippet + MERGE_HOOKS.md.

## Two guardrail findings about Troy's OWN hooks
- `hook_block_destructive.ps1` correctly blocked the orchestrator's `Remove-Item -Recurse -Force`. Works.
- 🔴 `hook_block_commit_qa.ps1:117` — the `-F <file>` regex is `([^\s"']+)`, which
  EXCLUDES quote characters, so a **quoted** `-F` path is never matched and the
  message is never read. It false-blocked a fully-documented commit twice.
  Passing the path unquoted works. NOT fixed (Troy's live config).
- Agent G self-reported that 7 of its own file:line citations were wrong (written
  from memory of where code was inserted, before the edits settled). Findings and
  test results all stand; the corrected citations are in audit §6.2.

## Open gates (in order)
1. **Troy's live verdict on the 15:47 build**: workspace line = E:\Helmion, mic hears, **speakers answer in Kokoro voice** (WASAPI fix `KokoroSpeechSynthesizer.CreateOutputDevice`). Awaiting his report.
2. **Agent E in flight**: forensic flywheel/self-improvement audit → docs/FLYWHEEL_AUDIT_2026-07-28.md. MCP probes already live-verified by orchestrator: flywheel + context servers answer (content EMPTY — `[]` rules/blockers/context for slug helmion — E must explain), Grok advisory answers.
3. **Agent F in flight**: anonymized one-button `helmion agent-os install` package (claude/codex/gemini targets, denylist anonymization test).
4. **Troy decision STILL PENDING**: CLI defaults to FULL tools incl. shell (session.mjs:50). Recommendation on file: read-tools default + --full flag.
5. Anthropic credits exhausted (Claude Maestro dead); Gemini returned 429 on live test; xAI works; OpenAI untested.
6. Next builds queued: dictate-mode UI wiring (spec: docs/VOICE_PHASE1_WIRING_TODO.md), voice host ws://127.0.0.1:8765 (Phase 2), Moshi duplex (Phase 3 — check GPU first).

## LATE SESSION — work AFTER commit 1bdd392 (all UNCOMMITTED as of this line)

| Item | State | Proof |
|---|---|---|
| **Secrets out of `~/.claude.json`** | DONE | 12 literals → `${VAR}`; **0 plaintext remain**; JSON valid; keys now in HKCU\Environment. Docs: expansion incl. `env` per code.claude.com/docs/en/mcp. Rollback: `~/.claude/ROLLBACK_claude_json_secrets_2026-07-28.ps1` (backup `.claude.json.20260728-175718.bak`). **Not yet proven across a Claude Code restart — if an MCP tool fails to connect, run the rollback.** |
| **Lessons topic split** | DONE | 11 `lessons-<topic>.md` + INDEX.md routes; session start 29,202 → **26,509 bytes**, lessons section 4,167 → **1,474**; `hook_topic_lessons.ps1` on UserPromptSubmit, 10 test cases all exit 0 + positive control. **Confirmed firing in a live session** (orchestrator observed the injected block on a real prompt). |
| **MCP install security layer** | DONE | 5 gates. Orchestrator's own run: poisoned candidate → **BLOCKED**, 8 critical. Benign → CLEAN. Sandbox withheld 62 real env vars. Non-TTY approval → exit 2, nothing installed. Audit trail → high-trust `helmion.telemetry_events`, never the low-trust lane. Install never edits `~/.claude.json`. |
| **Gemini-doc verification** | DONE, no code changed | `docs/GEMINI_DOC_VERIFICATION_2026-07-28.md` — 15 items: 9 VERIFIED-DONE, 3 GENUINELY-OPEN, 4 PARTIAL |
| Ask-permission mode (4th tier) | IN FLIGHT (agent-J) | — |
| Slash commands + plugins/connectors | IN FLIGHT (agent-K) | — |

### 🔴 REAL BUG FOUND, FIX NOT YET APPLIED — stale API key mid-session (the 401)
Fix a bad `XAI_API_KEY` in `.env` while the app is running, resubmit → **still 401**.
Half works: `MainWindow.xaml.cs:1418` reloads every submit; `ReadEnvDictionary:401`
re-reads uncached; stamps the parent env (`EnvironmentSettingsStore.cs:141`).
Breaks at: `AgentBridge.EnsureStartedAsync:46-52` early-returns when the Node child
is alive, so the reload (:58) + `SetChildEnv` (:80) run ONLY at spawn — and a Windows
child's env is FIXED AT SPAWN. Then `TurnAsync:147-157` sends `turn` only, never
`configure`, and `bridge.mjs:221` gates on `needsFullReset || !provider?.key` —
both false for a stale-but-non-empty key, so `reconfigure()` (:93-103, the only
caller of `loadHelmionEnv`) never runs. Cold start works, which is why it reads as
intermittent. **Fix:** at `bridge.mjs:221` call `loadHelmionEnv(workspace)` every
turn, rebuild the provider ONLY when the resolved key differs — do NOT always call
`reconfigure()`, it fires `resetSessionState(:102)` and would wipe history each turn.

### 🔴 ALSO OPEN — paste lock
`ConsoleInputBox_PreviewKeyDown:1299-1302` returns for any non-Enter key so Ctrl+V is
never inspected; `OnPaste:1318` never consults `_agentBusy` (which guards only sending,
:1366). ~4 lines.

### Verified-done, do NOT rebuild (agent-L, cited)
Maestro router really swaps endpoint+client+key (`ConsoleSession.cs:77-140`). The
`StartsWith("open")` intercept is GONE — real tool calling lives in the Node bridge
(`MainWindow.xaml.cs:1439`). `ToolDispatcher.cs` has real handlers but is DEAD CODE
(only reachable via `LocalAgentToolExecutor.cs:15`, which has zero callers). Execution
badge is real state. `ProfileSyncService` does genuine Npgsql SELECT/UPSERT against
`helmion.autonomy_rules`. Voice device-fault handling is stronger than the old ask
(shared `IsDeviceFault` at `WhisperSpeechRecognizer.cs:592` used as an exception filter
across Kokoro). Mic has NO session timer. Hook gates: long-form `rm --recursive --force`
blocked 4/4; the claimed `TROY-APPROVED`-on-Edit gap is CLOSED (`hook_autonomy_boundary.ps1:189`).

### SiteVector (SEPARATE project, C:\Users\troyh\sitevector — state only, untouched)
`stops_from_samples` (`app/stops.py:85`) has zero non-test callers; routes at
`app/main.py:115-147` take a precomputed `duration_s` and call `engine.ingest()`.
The ms-vs-seconds blind spot is LIVE: `validate.py:67 MAX_DURATION_S=86400` is a pure
range bound so 45,000 passes as 12.5h and collects an unguarded long-dwell bonus
(`engine.py:265,292`). Pin test alive (`test_validation.py:132-150`). Suite is 37/37,
not the doc's stale 32/32; `-m pytest` fails (pytest not in .venv) — use the project runner.

## Traps for the next session
- `dotnet test` finds nothing; real harness = `dotnet run --project desktop/Helmion.Desktop.SmokeTests`.
- **Run smoke tests from `E:\Helmion`, never from `E:\Helmion\desktop`** — `Program.cs:342`
  resolves a relative csproj path, so the wrong CWD throws DirectoryNotFoundException on a
  doubled path and reads exactly like a real break.
- **npm baseline moves fast.** 71 at session start → 122 → 171 → 275. Re-measure before
  quoting it; several agents added suites concurrently.
- Troy's own guardrails produced TWO false blocks tonight, both worth fixing:
  `hook_block_commit_qa.ps1:117` — the `-F <file>` regex `([^\s"']+)` excludes quote
  characters, so a QUOTED -F path is never read and a fully-documented commit is blocked
  (pass the path UNQUOTED); and a destructive-op guard fired on a command containing no
  deletion at all (a `Set-Location` + three `node` calls). Neither is fixed — Troy's config.
- `npm run desktop:package` runs under Windows PowerShell 5.1 — ASCII only in .ps1.
- KokoroSharp.CPU, never plain KokoroSharp.
- SESSION_BOARD.md claims are mandatory; an unregistered concurrent session collided here earlier today.
- Published exe needs runtimes/models/voices/espeak BESIDE it (publish.ps1 does this now).
- desktop-settings.json may still hold LastWorkspacePath=.grok — inert (guard rejects), self-heals on a good launch.
