# Gemini Doc — Open-Item Verification (2026-07-28)

**Agent:** f3673e34/agent-L-gemini-doc-verify
**Source doc under test:** `D:\_Docs\helmion-gemini-parse-for-claude.md`
**Method:** every verdict traced against CODE in the live tree, never against the doc
or a handoff. Probes run where a claim was testable. Stamps:
`[VERIFIED-DONE | GENUINELY-OPEN | PARTIAL | CANNOT-DETERMINE]`.

**Code changed by this agent: NONE.** Every item that is genuinely open sits on a file
claimed by an ACTIVE agent (agent-J) or in an explicitly do-not-fix project. Exact
changes needed are written out below instead.

> **Tree note.** `E:\Helmion\_review_export_primary_providers_2026-07-28\` is a COPY of
> the desktop sources. Every citation below is from the live `E:\Helmion\desktop` /
> `E:\Helmion\src` tree, never the export.

---

## Section 2 — Helmion C# app (claimed "stubbed/mocked, not wired to real execution")

| # | Item | Claimed | Actual (file:line) | Verdict |
|---|---|---|---|---|
| 2.1 | Dynamic Maestro router | Selecting a provider only updates a setting variable; does not swap REST client/endpoint/key | `ConsoleSession.cs:77-140` `ConfigureMaestro` sets `ActiveEndpoint` + `HasActiveApiKey` per provider and calls `UpdateApiKey` on each session client (`:93-96`). Real distinct endpoints as constants at `:13-17`. Custom OpenAI-compatible providers resolved at `:127-140` via `CustomChatSession`. Called on every submit at `MainWindow.xaml.cs:1419`. | **VERIFIED-DONE** |
| 2.2 | Real function-calling dispatcher | Replace string-matching intercept `text.StartsWith("open")` in `MainWindow.xaml.cs` with a `ToolDispatcher` parsing structured JSON calls | **Intercept is GONE.** Grep for `StartsWith("` in `MainWindow.xaml.cs` returns only API-key prefix validation (`:610-625`) and the `/` shell escape (`:1388`). No `open`/`launch` verb intercept exists. Real tool calling now runs through the **Node agent bridge**, not C#: `MainWindow.xaml.cs:1439` `_agentBridge.TurnAsync(...)` streaming structured `tool` / `tool_result` events (`:1451-1455`). `ToolDispatcher.cs` exists with real handlers (`LaunchProcess:65`, `ExecutePowerShell:99`, `ReadWorkspaceFile:128`, `WriteWorkspaceFile:160`) and a workspace-escape guard (`:252-294`), but is **not on the live send path** — its only callers are `LocalAgentToolExecutor.cs:15` and the smoke tests. | **VERIFIED-DONE (by a different mechanism than the doc names)** |
| 2.2a | — dead code found | not claimed | `LocalAgentToolExecutor.cs:6` has **zero callers** in the live tree (repo-wide grep; only self-definition + the `_review_export` copy). Dead compatibility forwarder. | **GENUINELY-OPEN (cosmetic, no defect)** |
| 2.3 | Execution toggle wire | `FOUNDATION · EXECUTION OFF` badge is static display text | Badge is state-driven: `MainWindow.xaml.cs:74` `ConsoleExecutionBadgeText.Text = AgentPermission.BadgeLabel(mode)` where `mode = CurrentPermissionMode` (`:49-62`, reads `_consoleSession.PermissionMode`). `ConsoleSession.IsExecutionEnabled` is a REAL derived property, not a field: `ConsoleSession.cs:34-38` `get => AgentPermission.Normalize(PermissionMode) == AgentPermission.Full`. `ToolDispatcher` honors it at 6 separate call sites (`:30,67,101,130,162,210`). Badge colour also switches (`:75-77`). | **VERIFIED-DONE** |
| 2.4 | Sync Profile → real DB write | Prints a success message and writes static markdown instead of writing Neon | Real Npgsql against the real connection string. `ProfileSyncService.cs:41-42` opens `NpgsqlConnection(databaseUrl)`; `ReadActiveRulesAsync:123-128` SELECTs `helmion.autonomy_rules`; `UpsertRuleAsync:154-198` does a real SELECT-then-UPDATE/INSERT (deliberately avoiding `ON CONFLICT` because a NULL `project_slug` is distinct — `:152-153`). Called for real at `ProfileSyncEngine.cs:307`. Status string at `:116` reports actual counts, not a canned "success". | **VERIFIED-DONE** |

### 2.4 caution — the `~/.claude` destroy path is CLOSED (verified, not assumed)

The brief warned that `ProfileSyncEngine`'s blind overwrite destroyed user files earlier
today. Current state: `ProfileSyncEngine.cs:196-208` now passes an approved-file set into
`ClaudeProfileInstaller.InstallAsync(...)` at `:209` **without** the overwrite flag, and
`ClaudeProfileInstaller.cs:47-58` documents `overwriteExisting` defaulting to **false** —
"an existing file is NEVER replaced… Overwriting now requires an explicit opt-in AND
leaves a timestamped `.bak`". `LEARNINGS.md` / `LESSONS.md` are still in the approved set
but are now protected by that default. **I wrote nothing to `~/.claude`.**

---

## Section 3 — voice / 401 / UI

| # | Item | Claimed | Actual (file:line) | Verdict |
|---|---|---|---|---|
| 3.1 | 401 key loader — reload `XAI_API_KEY` from `.env` on every prompt submission | Stale cached in-memory value causes 401 | **Mostly wired, one live seam.** See full trace below. | **PARTIAL** |
| 3.2 | Voice exception handling — wrap `SetOutputToDefaultAudioDevice()` / `SpeakAsync()` for `AudioException` 0x2 | System.Speech try/catch needed | **Item is OBSOLETE.** System.Speech/SAPI was deleted today; `SpeechEngine.cs` and `AudioEndpointProbe.cs` no longer exist. The replacement stack has **stronger** device-fault handling than the item asks for: a shared classifier `WhisperSpeechRecognizer.IsDeviceFault(ex)` (`:592`) is used as an exception filter across Kokoro at `KokoroSpeechSynthesizer.cs:383, 403, 470, 490, 645`, with a dedicated `HandleDeviceFault` (`:523`) and device teardown/rebuild (`CreateOutputDevice:484`, `_transportStale` at `:434`). Capture side guards identically at `WhisperSpeechRecognizer.cs:140`. | **VERIFIED-DONE (old item obsolete)** |
| 3.3 | Persistent mic toggle, no time limit | Mic must stay on until manually toggled off | No session timer exists. Grep for `Timer` in `WhisperSpeechRecognizer.cs` returns nothing. The only time constants bound a single **utterance**, not the session: `EndSilenceMs = 750` (`:29`) and `MaxUtteranceMs = 25_000` (`:37`), and hitting the latter calls `CloseUtteranceLocked()` (`:420-423`) — flushing the phrase while capture continues. Stopping is manual only (`public void Stop()` at `:171`); `_suspended` (`:57`) pauses for TTS but "device stays open". No `InitialSilenceTimeout` equivalent. | **VERIFIED-DONE** |
| 3.4 | CLI paste/selection lock during active tool rounds | Intercept `PreviewKeyDown` to block accidental Ctrl+V / highlight while tools run | **No such lock exists.** `ConsoleInputBox_PreviewKeyDown` (`MainWindow.xaml.cs:1297-1312`) returns immediately for any key that is not `Enter` (`:1299-1302`) — Ctrl+V is never inspected. `ConsoleInputBox_OnPaste` (`:1318-1360`) always pastes and never consults `_agentBusy`. `_agentBusy` guards only *sending* (`:1366-1370`), not typing, pasting, or selecting. | **GENUINELY-OPEN** |

### 3.1 — full trace of the 401 key path (this is the one real finding)

Chain, one citation per arrow:

1. `MainWindow.xaml.cs:1418` — `EnvironmentSettingsStore.Load()` runs **inside** the submit handler, i.e. on every prompt. ✅
2. `EnvironmentSettingsStore.cs:70-73` → `FindEnvPath` (search roots include a hardcoded `E:\Helmion` at `:38`) → `ReadEnvDictionary:396-415`, which does `File.ReadAllLines(path)` at `:401` on **every call — no caching**. ✅
3. `EnvironmentSettingsStore.cs:96-100` reads `XAI_API_KEY` (falling back to `GROK_API_KEY`); `Load():127` → `ApplyToProcess():135-148` stamps it into the **parent** process env at `:141`. ✅
4. 🔴 **Seam.** `AgentBridge.EnsureStartedAsync:46-52` returns early when the Node child is already running. The `.env` reload (`:58`) and the explicit `SetChildEnv(start, "XAI_API_KEY", …)` (`:80`) therefore run **only at (re)spawn**. A Windows child's environment is fixed at spawn, so step 3 never reaches an already-running bridge.
5. 🔴 **Seam.** `AgentBridge.TurnAsync:147-157` sends `cmd = "turn"` only — it never sends `configure`. On the Node side, `bridge.mjs:221` reads `if (needsFullReset || !provider?.key) reconfigure();`, and `reconfigure()` (`:93-103`) is the only thing that calls `loadHelmionEnv` (`:94`). With an unchanged workspace/provider/permission/customProviders (`:195-219`) and a **non-empty but wrong** key already in memory, `needsFullReset` is false and `provider.key` is truthy → `.env` is **not** re-read for that turn.

**Net effect:** the fix works on a cold start and whenever the provider, workspace,
permission or custom-endpoint set changes, or when the key is empty. It does **not**
cover the exact scenario the item describes — Troy fixes a bad `XAI_API_KEY` in `.env`
mid-session and resubmits without changing anything else; the running bridge keeps the
stale key and keeps returning 401.

Worth noting the design intent is already present and correct: `env.mjs:10-26`
`HELMION_ENV_OVERRIDE_KEYS` exists precisely so file values beat a stale inherited env,
and its comment (`:4-8`) names this 401 by name. The gap is only that on a plain turn
nothing calls the loader.

**Exact change needed (NOT APPLIED — `bridge.mjs` is claimed by ACTIVE agent-J):**
at `src/agent/bridge.mjs:221`, make the turn path re-read `.env` unconditionally, e.g.
replace the condition with an always-on `reconfigure()`, or cheaper and non-disruptive:
call `loadHelmionEnv(workspace)` every turn and only rebuild the provider when the
resolved key differs from `provider.key`. The latter keeps conversation state and avoids
`resetSessionState` (`:102`) firing on every message.

**Exact change needed for 3.4 (NOT APPLIED — `MainWindow.xaml.cs` claimed by ACTIVE agent-J):**
in `ConsoleInputBox_PreviewKeyDown` (`:1297`), before the `Enter` check, add a guard that
sets `e.Handled = true` when `_agentBusy` is true and the keystroke is a paste
(`Key.V` with `ModifierKeys.Control`) or a selection-modifying combo; and in
`ConsoleInputBox_OnPaste` (`:1318`) call `e.CancelCommand()` and return early when
`_agentBusy`. Both are ~4 lines and need no new state — `_agentBusy` (`:41`) already
tracks an active tool round.

---

## Section 5 — hook gate checklist (`C:\Users\troyh\.claude`, READ-ONLY, nothing edited)

Verified by reading the hooks and by feeding crafted JSON on stdin. **No `rm` or other
destructive command was ever actually executed — only strings were passed to the hooks.**

| # | Item | Claimed | Actual (file:line / probe) | Verdict |
|---|---|---|---|---|
| 5.1 | `hook_block_destructive.ps1` on both Bash and PowerShell matchers | Two matchers registered | `settings.json:66,70` — ONE combined entry, `"matcher": "Bash\|PowerShell"`. Per Claude Code hook docs, a matcher of letters/`\|` is an exact-string list, so it matches tool_name `Bash` OR `PowerShell` exactly. Functionally both are covered; structurally it is one registration, not two. | **PARTIAL (covered in practice)** |
| 5.2 | Long-form flag variants caught | `rm --recursive --force` must block, not only `-rf` | Regex `hook_block_destructive.ps1:93` includes `--(recursive\|force\|dir)`. Probes: `rm -rf C:/tmp/x` → **exit 2**; `rm --recursive --force C:/tmp/x` → **exit 2**; `rm --force --recursive C:/tmp/x` → **exit 2**; negative control `ls` → **exit 0** (not blocked). 4/4 as expected. | **VERIFIED-DONE** |
| 5.3 | Autonomy boundary scopes quoted-literal inspection to SQL executors only | Inspection limited to psql/neon/etc | **Claim is FALSE as stated — and that appears deliberate.** `hook_autonomy_boundary.ps1:70-73` does scope `$sqlContext` (psql/sqlite3/mysql/…/`--command`) for choosing raw vs skeleton text. But `:164-173` runs a **second, unconditional** `$sqlLiterals` pass over **every** command, keeping any quoted literal starting with `alter\|drop\|create\|truncate\|insert\|update\|delete\|grant\|revoke`. The in-file comment at `:132-163` states the intent: "The precise discriminator is not WHERE the text is, it is WHAT THE LITERAL IS… Receiver-agnostic." Probe: `node -e "myClient.query('DROP TABLE loads')"` (not a recognized executor) → **exit 2**. Negative control (DROP TABLE mid-prose, not at literal start) → **exit 0**. | **PARTIAL — scoping is intentionally broader than the doc claims; blocks more, not less** |
| 5.4 | `TROY-APPROVED:` matches on `$ti.new_string` for Edit calls | Real gap: an Edit carries neither `$cmd` nor `$ti.content` | **Gap is closed.** `hook_autonomy_boundary.ps1:189` — `$approvalHaystack = @($cmd, $content, [string]$ti.new_string, [string]$ti.old_string) -join ' '`. `new_string` IS inspected. Probe pair: Edit to `schema.ts` with no approval → **exit 2** ("edits a schema/migration file"); same Edit with `TROY-APPROVED: …` inside `new_string` only → **exit 0** ("TIER B allowed by explicit approval"). | **VERIFIED-DONE** |

**Incidental (not asked, surfaced during 5.4 probing):** the approval-reason capture at
`:189` is greedy (`.{20,}`) across the `-join ' '` boundary, so a reason can bleed from
`new_string` into `old_string` text. Cosmetic — it does not weaken the gate. Not fixed
(hooks are read-only for this agent).

---

## Section 4 — DairyForge SiteVector (`C:\Users\troyh\sitevector`) — STATE ONLY, NOT FIXED

| # | Item | Claimed | Actual (file:line / output) | Verdict |
|---|---|---|---|---|
| 4.1 | `stops.py` wired into a real ingest route | Exists and tested, but nothing in production calls it | `stops_from_samples` defined `app/stops.py:85`. Every importer is under `tests/`: `tests/test_stops.py:18`, `tests/test_validation.py:32`, `tests/validate_real_gps.py:55`. The real ingest routes `POST /api/stops` (`app/main.py:115-142`) and `POST /api/stops/bulk` (`:145-147`) accept a `StopIn` with `duration_s` already computed and call `engine.ingest()` directly. `app/engine.py:26-28` imports `roads, store, config, geo` — not `stops`. **No non-test caller exists.** | **GENUINELY-OPEN** |
| 4.2 | ms-vs-seconds duration blind spot | 45 s sent as 45,000 reads as 12.5 h, passes the 24 h bound, wrongly earns long-dwell bonus | Still open. `app/validate.py:67` `MAX_DURATION_S = 86_400.0` is a pure range bound — 45,000 < 86,400, so it passes. The duration check block (`:156-166`) tests only `< 0` and `> MAX_DURATION_S`. By contrast `started_at` DOES have a `looks_ms` heuristic (`:141-150`), proving the pattern exists but was never applied to duration. Bonus still awarded unguarded at `app/engine.py:265, 292` (`max_dwell >= t.long_dwell_s`). No feed-level unit check anywhere in `app/`. | **GENUINELY-OPEN** |
| 4.3 | `case_duration_ms_blind_spot_is_pinned` still pins it | Pinned so it cannot be silently marked closed | Test exists `tests/test_validation.py:132-150`; asserts `not fatals(problems)` for `duration_s=45_000.0` — i.e. it pins the CURRENT (accepting) behaviour. Docstring `:144-145`: "asserts the CURRENT behaviour so the gap cannot be quietly assumed closed. If a feed-level check is added later, this pin should flip." Registered in the run list at `:238`. | **VERIFIED-DONE (pin is working as designed)** |
| 4.4 | Adversarial suite 32/32, 0 false sites | Expect 32/32 | `python -m pytest` is not available (`No module named pytest` in `.venv`, exit 1 — consistent with the project's own `CLAUDE.md` note). Project runner `.venv/Scripts/python.exe tests/test_adversarial.py` → **37/37 passed, 0 failing, exit 0**. Suite is green; the doc's "32" is stale, not a behavioural discrepancy. | **PARTIAL (green, count stale)** |
| 4.5 | Single-day never auto-promotes (`len(days) >= 2` gate) | Invariant holds | Present: `app/engine.py:290` `if len(days) >= 3: score += 35`; `:293` `elif len(days) == 2: score += 25`; `:295-297` same-day multi-visit caps at `+10` — far below `promote_score` 60. Pinned by `tests/test_adversarial.py:725`. | **VERIFIED-DONE** |

---

## Verification of the tree (no code changed by this agent)

| Gate | Result |
|---|---|
| `dotnet build desktop/Helmion.Desktop.slnx -c Debug` | **Build succeeded — 0 Warning(s), 0 Error(s)** |
| Smoke suites (`dotnet run --project desktop/Helmion.Desktop.SmokeTests`, run from repo root) | **All pass** — desktop 23 checks, local-service 9, ask-permission 58, voice engine 39, plus Kokoro→Whisper round-trip PASS (156,046-byte WAV, transcript exact) |
| `npm test` | **275 pass / 0 fail** (6 suites, 275 tests) |

Two notes on the gates, both honest caveats rather than clean results:

- The stated baseline in my brief was "171 pass". Actual is **275 pass / 0 fail** — agents
  F/G/I/J have landed tests since that number was written. Nothing is failing.
- The smoke suites are **CWD-sensitive**: `Program.cs:342` resolves
  `desktop\Helmion.Desktop\Helmion.Desktop.csproj` relative to the current directory, so
  running from `E:\Helmion\desktop` throws `DirectoryNotFoundException` on a doubled path.
  Must be run from `E:\Helmion`. Not a defect I introduced; flagging so the next session
  does not misread it as a break.
- On a first attempt the SmokeTests project failed to compile
  (`AskPermissionSmokeChecks.cs` calling a non-existent `ToolDispatcher.Execute`). It
  compiled and passed minutes later — that file belongs to **ACTIVE agent-J** and was
  mid-edit. Transient WIP, not a standing defect, and not mine to touch.
