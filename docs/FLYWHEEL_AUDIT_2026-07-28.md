# FLYWHEEL AUDIT — 2026-07-28

**Gate 1 — SOURCE OF TRUTH.** Every claim below cites the primary source where it
lives: `file:line`, a live SQL result, or a `stat`/`grep` run THIS session. No
claim rests on a prior handoff or a memory file.

**Gate 2 — FULL TRACING.** Every multi-stage claim is drawn A→B→C with a citation
on each arrow. A chain with one uncited arrow IS the lie. Where an arrow has no
citation it is stamped 🔴 GAP rather than assumed.

Scope: read-only. Agent `f3673e34/agent-E-flywheel-audit`. Two Neon endpoints
probed SELECT-only. No file outside this report and the SESSION_BOARD row was
modified.

---

## 0. The one-line answer

The self-improvement system is **half alive**. The *governance* half (Helmion MCP
kernel, PreToolUse guards, Neon writes) is genuinely wired end-to-end. The
*learning* half — capture → propose → promote → inject — is broken at the promote
and inject arrows, and a desktop sync routine is actively **truncating the
accumulated-lesson files** on every run.

---

## 1. Severity-ranked findings

| # | Component | Claimed | Actual (primary source, gathered this run) | Verdict |
|---|---|---|---|---|
| 1 | `ProfileSyncEngine` → `~/.claude/*.md` | "Never overwrites an existing file without explicit user consent" (`ClaudeProfileInstaller.cs:8`) | Its **only** caller hardcodes the consent set — `ProfileSyncEngine.cs:196-208` builds `approvedClaudeFiles` as a literal `HashSet` containing `HELMION_CLAUDE.md`, `BASE_RULES.md`, `LEARNINGS.md`, `LESSONS.md`, never calls `GetPreview()` (`ClaudeProfileInstaller.cs:27`), never inspects `InstallAction.WouldOverwrite` (`:37`). `InstallAsync` then does a truncating `File.WriteAllTextAsync` (`:75`). Observed effect: all four files carry mtime `2026-07-28 15:34:58` (`stat`), and `LESSONS.md` is back to the 612-byte template — the 2 real entries `distill.mjs` appended on 2026-07-26T16:51:06 (`_distill.log:1-6`) are **gone**. | ✗ **DATA LOSS, ACTIVE** |
| 2 | Advisory lane "Claude reviews and promotes" | Rule 0.27: advisors write low-trust rows; Claude Code reviews and promotes | Write side real: `bigsister_neon_log.mjs:43-51` INSERTs to `bigsister.advisory_outputs` (6 rows, latest 2026-07-26). Read side: the only reader is `scripts/neon/_verify_advisory.mjs:7-11`, and `grep -rn "_verify_advisory"` across hooks/scripts/settings.json returns **nothing** — it has no caller. No code path turns an advisory row into a promoted decision. | 🔴 **GAP — write-only store** |
| 3 | `helmion_record_review` / Tier-B consensus gate | Advisory consensus authorizes Tier-B operations | `neon.mjs:407-429` INSERTs into `helmion.advisory_reviews`, whose `action_hash` is `not null references helmion.governance_actions(action_hash)` (`sql/001_helmion.sql:83`). Repo-wide grep for `governance_actions`: the **only** match is its own `CREATE TABLE`. Nothing ever inserts a parent row, so every real call raises an FK violation and rolls back (`neon.mjs:88-96`). Downstream, `governance.mjs:165-196` requires 4 APPROVED rows before `advisory_complete` — structurally unreachable. Untested: `test/neon-governance.test.mjs` mocks `pool.query` and never exercises this path. | ✗ **CANNOT EVER PASS** |
| 4 | `.claude.json` PreToolUse hook | A global guard fires `hooks/pretooluse.ps1` on every tool call | Written by `ProfileSyncEngine.cs:186` as a **bare string**: `codeHooks["PreToolUse"] = "powershell.exe ... pretooluse.ps1"`. The real schema is an array of `{matcher, hooks:[{type,command}]}` (see every entry in `settings.json:54-169`). `~/.claude.json` is also not a documented hook-config surface. `grep helmion` over `settings.json` + `settings.local.json`: **zero matches**. The script itself is fine and `helmion` resolves on PATH (`AppData/Roaming/npm/helmion.cmd`) — it simply never fires. | 🔴 **GAP — orphaned config** |
| 5 | Top-level `LEARNINGS.md` / `BASE_RULES.md` / `HELMION_CLAUDE.md` | Canonical rule + learning documents | `grep -ril` over `scripts/`, `manager/`, `Helmion/{src,bin,hooks}` for `BASE_RULES` → empty; for `HELMION_CLAUDE` → empty; the top-level `LEARNINGS.md` path is never read (`session_start_inject.sh:6-7,12-15` reads `./planning/LEARNINGS.md` and `$HOME/.claude/planning/LEARNINGS.md` — different files). `CLAUDE.md` never names any of them. | 🔴 **ORPHANED — nothing reads them** |
| 6 | `BIG_SISTER_UNIFIED_SETUP_FINAL.md` | Cited as primary source by `CLAUDE.md:19` and the Rule 0.27 block | `find /c/Users/troyh /e -iname "*BIG_SISTER*"` and `-iname "*UNIFIED_SETUP*"` (depth 6-10) → **file does not exist anywhere on disk**. | 🔴 **DANGLING CITATION** |
| 7 | The "5-point flywheel" | A canonical 5-point definition exists | Exactly one file on disk states 5 numbered points: `HELMION_CLAUDE.md:43-50` (Identify → Name → Log → Propose → Verify). Its origin is a C# template literal, `ClaudeProfileInstaller.cs:146`. That file is orphaned (finding #5), so the definition is **not loaded into any session**. A *different* 4-stage loop is named in `distill.mjs:2`. `E:\Helmion\README.md` (read in full) describes neither — it describes the Maestro/Codex governance kernel. | ⚠ **Definition exists but is inert; two rival loops** |
| 8 | Skill promotion (`manager_skill_from_learning.mjs`) | Successful learnings become skills | `manager_skill_from_learning.mjs:41-54` really does write `~/.claude/skills/*/SKILL.md`, but it is absent from the hooks block of `settings.json` — manual CLI only. Per `planning/LEARNINGS.md`'s own dated entry it has fired **once ever** (ids 1-4, 2026-07-05). | ⚠ **DORMANT** |
| 9 | `planning/LEARNINGS.md` injection | SessionStart injects a 237-byte boilerplate stub (prior finding) | **REFUTED as stated.** `wc -c` = **18,829 bytes**, 39 dated entries (`grep -c '^- \['` = 39). The 237-byte stub survives only as the inert backup `planning/LEARNINGS.md.stub-bak`. However the file is **frozen at 2026-07-16** — nothing has been added in 12 days. | ✓ wired / ⚠ stale |
| 10 | `bigsister.context` / `decisions` / `sprints` | High-trust tier mirroring on-disk planning files | Live SELECT: **0 rows each**, `max(ts)` null — never written. `bigsister_neon_read.mjs:19-28` reads them at SessionStart, so the injection arrow is real but carries nothing. | 🔴 **EMPTY — high-trust tier unused** |
| 11 | Rule 0.28 "every session pushes failures and successes" | Every session logs outcomes with `file:line` + a number | `bigsister.agent_logs` = 385 rows. GROUP BY source: `session_end_safe.sh` 287 (latest 2026-07-28 02:07), `claude-code` **96, latest 2026-07-26 18:25**. The 5 most recent rows are all `session_end_safe.sh` / `event=session_ended` with **empty detail**. No session has pushed a Rule-0.29-shaped lesson in 2 days. | ✗ **NOT HAPPENING** |
| 12 | `parsedDetail is not defined` collision defect | Known bug in `bigsister_neon_log.mjs` | **FIXED.** `grep -r parsedDetail scripts/neon/` → zero matches. The `resolve` branch uses `parsed`, declared `bigsister_neon_log.mjs:115`, assigned `:116-121`, used `:122-135` — declare-before-use is correct. An in-code note at `:138-142` documents the duplicate implementation being removed. Caveat: `~/.claude` is not a git repo, so this is a current-state verdict, not a git-blame one. | ✓ **FIXED** |
| 13 | Adjacent defect, same file | — | `bigsister_neon_log.mjs:38,44` call `JSON.parse(detailJson)` with no try/catch. A malformed payload throws, is caught by `main().catch` (`:246-250`), printed to stderr, and **exits 0** — the write silently never happens and the caller sees success. | ✗ **SILENT WRITE LOSS** |
| 14 | Stop hook (voice) | Speaks after each reply | Chain is correct end-to-end: `python.exe` exists (605,016 B), `stop_hook_speak.py` (7,332 B) reads the transcript and gates on `voice_enabled.txt` (`:139-144`), `speak.py` exists. But `voice_enabled.txt` = `off` (3 bytes, mtime 2026-07-04) and **no script in the tree ever writes it back to `on`** (grepped; only `stop_hook_speak.py` even reads it). | ⚠ **Wired but deliberately silent** |
| 15 | `hook_screenshot_on_edit.ps1` | Screenshots on edit | Takes no screenshot. Writes one log line to `edit_log.txt` (`:16-17`) whose own text says no auto-screenshot is taken. Deliberate no-op; the name lies. | ⚠ **NAME LIES (intentional)** |
| 16 | `hook_app_screenshot_verification.ps1` | Verifies edits visually | Real capture, but only for `.cs/.unity/.blend/Dockerfile` (`:55-67`), and it **forcibly steals foreground focus** via `SetForegroundWindow` + `AttachThreadInput` + a synthetic Alt keypress (`:78-96`) on every matching edit. | ⚠ **Works; interrupts the user** |
| 17 | `.sh` hooks on Windows | Suspected dead (no interpreter prefix) | **NOT a defect.** Shell-form hooks spawn Git Bash on Windows by default (docs, `code.claude.com/docs/en/hooks-guide`). `where bash` → `C:\Program Files\Git\usr\bin\bash.exe`; both `.sh` files are `-rwxr-xr-x` with `#!/bin/bash`. Confirmed by durable side effect: `_session_hooks_debug.log` last line `2026-07-28T18:19:57Z SessionStart fired, cwd=/c/Users/troyh, learnings_exists=yes` — matches this session's 12:20 MDT start. | ✓ **RUNS** |
| 18 | Helmion MCP kernel (12 tools) | Real implementations | 11 of 12 trace cleanly to real, transaction-safe Postgres operations: `helmion_get_context` (`server.mjs:90` → `neon.mjs:348-371`), `helmion_list_blockers` (`:91` → `neon.mjs:373-382`), `helmion_resolve_blocker` (`:92` → `neon.mjs:384-405`, evidence-gated by `governance.mjs:148-152`), and the 8 Maestro tools (`codex-server.mjs:217-228` → `neon.mjs:439-958`) with row locks, idempotency keys and real Ed25519 confirmation verification. The 12th is finding #3. All four registered in `~/.claude.json` `mcpServers`. | ✓ **REAL** |
| 19 | Two Neon databases, not one | Assumed single DB | **Distinct endpoints, measured this run.** bigsister → `ep-dry-fog-aku9i5gq.c-3.us-west-2`; all four Helmion MCP servers → `ep-divine-leaf-ay38p1af.c-5.us-east-2`. The `helmion` schema **does not exist** in the bigsister DB (`information_schema.schemata` → 0 rows) — which is correct, not a defect, but means the two lanes share no data whatsoever. | ✓ correct / ⚠ **no bridge** |
| 20 | Dead schema | — | `helmion.governance_actions` (`sql/001_helmion.sql:69-79`) and `helmion.as2_outbound` + `stale_as2_blockers` view (`:93-121`) are declared with **zero code references** repo-wide. | ⚠ **SCHEMA-VS-CODE DRIFT** |
| 21 | Secrets in plaintext config | — | `~/.claude.json` carries `HELMION_DATABASE_URL` (`postgr…`) and `GROK_API_KEY` (`xai-6O…`) inline in four `mcpServers` env blocks. Masked here. Not a flywheel defect; flagged because the audit touched the file. | ⚠ **EXPOSURE** |

### Live Neon state (SELECT-only, both endpoints)

| Table | Rows | Latest | Verdict |
|---|---|---|---|
| `bigsister.session_snapshots` | 3,952 | 2026-07-28 15:36 | live |
| `bigsister.watcher_state` | 14 | 2026-07-28 15:47 | live |
| `bigsister.alerts` | 162 | 2026-07-28 13:36 | live |
| `bigsister.agent_logs` | 385 | 2026-07-28 02:07 | live, but see #11 |
| `bigsister.pattern_library` | 2,480 | 2026-07-26 19:07 | stale 2d |
| `bigsister.learnings` | 204 | 2026-07-26 18:36 | stale 2d |
| `bigsister.failure_logs` | 1,752 | 2026-07-26 18:56 | stale 2d |
| `bigsister.advisory_outputs` | 6 | 2026-07-26 16:34 | stale 2d, no reader |
| `bigsister.blockers` | 8 | 2026-07-26 16:10 | stale 2d |
| `bigsister.context` / `decisions` / `sprints` | **0 / 0 / 0** | null | never written |
| `helmion.*` (separate endpoint) | — | — | schema absent from bigsister DB by design |

---

## 2. The loop, drawn arrow by arrow

```
CAPTURE   watcher/extract_patterns.mjs:14-34  →  bigsister.pattern_library (2,480 rows)   ✓ cited
          watcher/extract_patterns.mjs:19     →  manager/proposed_learnings/<slug>.md     ✓ cited
          blocker resolve gate                →  bigsister.blockers root_cause/lesson/    ✓ bigsister_neon_log.mjs:114-136
                                                 citation fields (enforced, exit 2)

PROPOSE   proposed_learnings/*.md  ─────────────────────────────────────────────  🔴 GAP
            no consumer; grep finds the writer only. Raw TODO/heading noise.
          manager_skill_proposer.mjs:41-46 → proposed_skill_updates/*.md          ✓ cited
            but :3 states "Manager does NOT auto-write" — human-only by design.

PROMOTE   distill.mjs:233  →  ~/.claude/LESSONS.md          ✓ ran once, 2026-07-26T16:51:06
            └─ output DESTROYED 2026-07-28 15:34:58 by ProfileSyncEngine.cs:196-208  ✗
          distill.mjs:213-223 → autonomy_rules.json.promoted_rules  ✓ 1-2 rules, severity 'flag'
          manager_skill_from_learning.mjs:41-54 → skills/*/SKILL.md  ⚠ manual, fired once ever
          planning/LEARNINGS.md's 39 entries   ─────────────────────  🔴 GAP: hand-written by a
            human session on 2026-07-16. extract_learnings.sh:7-8 says outright
            "This script never writes LEARNINGS.md directly."

INJECT    session_start_inject.sh:12-15  → tail -50 planning/LEARNINGS.md (18,829 B)   ✓ live, stale 12d
          session_start_inject.sh:39     → bigsister_neon_read.mjs → context/decisions/
                                            blockers/sprints/pattern_library/alerts     ✓ live
                                            └─ context/decisions/sprints are EMPTY       🔴
          hook_autonomy_boundary.ps1:295-300 → autonomy_rules.json (PreToolUse)          ✓ live
          inject_core_directive.ps1:4    → hardcoded literal string that NAMES
                                            LESSONS.md/MEMORY.md but reads neither       ⚠
          ~/.claude/LEARNINGS.md, BASE_RULES.md, HELMION_CLAUDE.md  ─────────────  🔴 GAP: no reader
```

**The two arrows that carry real value today** are `planning/LEARNINGS.md →
session_start_inject.sh` (frozen 12 days) and `bigsister_neon_read.mjs → session
context` (live, but its three richest tables are empty). Everything between
capture and inject is either orphaned or requires a human to open a file and
paste.

---

## 3. Root cause of the pattern

Findings #1, #4 and #5 are one defect wearing three hats. `ProfileSyncEngine`
treats `~/.claude` as a **deployment target for templates** while the flywheel
treats it as an **accumulating store of earned lessons**. Those two models are
incompatible, and the template writer wins because it truncates.

The safety comment at `ClaudeProfileInstaller.cs:8` is true at the letter — the
method *does* accept a consent set — and false at the intent, because the only
caller hardcodes that set to "everything" (`ProfileSyncEngine.cs:196-208`) and
never shows the preview the class was built to produce. A reviewer reading the
installer alone would conclude it is safe.

### Minimum fixes, in order

1. `ProfileSyncEngine.cs:196` — remove `LEARNINGS.md` and `LESSONS.md` from the
   hardcoded approval set, or make the installer skip any target where
   `GetPreview()` reports `WouldOverwrite`. These two files exist to accumulate;
   they must never be template-written.
2. `ProfileSyncEngine.cs:186` — emit the array hook schema into the correct
   settings file, or delete the write. As it stands it produces config that
   cannot parse in a location that is not read.
3. `sql/001_helmion.sql:83` — either populate `governance_actions` or drop the FK,
   and add one integration test that runs `recordReview` against real constraints.
4. `bigsister_neon_log.mjs:38,44` — wrap `JSON.parse` so a malformed payload fails
   loudly instead of exiting 0.
5. Give `bigsister.advisory_outputs` a reader, or retire the lane. A store nothing
   reads is a diary.

---

## 4. What a new-user package must include

Structural only — file names, hook events, loop shape. No project content, no
rules text, no credentials, no identities.

**Rule layer (loaded automatically by the agent, not by a script)**
- `CLAUDE.md` — the single auto-loaded instruction file. Everything a session must
  obey belongs here or in a file this one explicitly imports. A rule file nothing
  imports is decoration (finding #5).

**Accumulating layer (append-only; a template installer must never overwrite these)**
- `LEARNINGS.md` — discoveries, newest first.
- `LESSONS.md` — corrections, newest first.
- `BLOCKERS.md` — open impediments.
- `MEMORY.md` — index of durable facts, one line per entry.
- `SESSION_BOARD.md` — concurrency registry: one row per agent, claimed file
  paths, status. Required the moment two agents can run at once.

**Generated layer (machine-written, human-reviewed, never trusted directly)**
- `proposed_learnings/` — raw capture output.
- `proposed_rules.json` — promoted enforcement rules, each with a severity.

**Hook events and what belongs on each**
| Event | Purpose | Must be |
|---|---|---|
| `SessionStart` | inject the accumulating layer + any live store into context | best-effort, self-timeout < 15 s, never blocks start |
| `UserPromptSubmit` | inject standing directives; gate against open blockers | fails **open** |
| `PreToolUse` | enforce promoted rules; block destructive ops behind an explicit escape token | fails **closed** |
| `PostToolUse` | record durable side effects | async, non-blocking |
| `SessionEnd` | capture the session's outcomes; run distillation under a single-writer lock | idempotent, always exits 0 |

**Loop shape — each arrow needs a named writer and a named reader before it counts**

```
capture ──▶ propose ──▶ promote ──▶ inject ──▶ (enforced at PreToolUse)
                                                        │
                                        outcomes ◀──────┘
```

Non-negotiable properties, each of which this audit found violated somewhere:
1. **Every arrow names its writer and its reader.** An arrow with a writer and no
   reader is a dead lane, not a pipeline (#2).
2. **Accumulating files are append-only.** Any installer that writes them must
   diff-and-skip, never truncate (#1).
3. **Every promoted entry carries a trigger, a citation, and a number.** Narrative
   entries do not change behavior (#11).
4. **Every constraint the schema declares has a code path that satisfies it,** and
   one integration test that proves it against the real constraint, not a mock (#3).
5. **Hook config lives only in documented locations, in the documented shape** —
   validate on write (#4).
6. **A gate whose enable-flag no code path can set is off forever.** Ship the
   writer alongside the reader (#14).

---

## 5. Method and limits

Five parallel read-only subagents plus direct verification by the orchestrating
agent. Both Neon endpoints probed SELECT-only with 15-second self-timeouts. Two
throwaway probe scripts remain in the session scratchpad; nothing else was
written outside this file and the SESSION_BOARD row.

Stated limits: `~/.claude` is not a git repository, so #12 is a current-state
verdict rather than a git-blame one. `helmion_record_review` (#3) was proven
unsatisfiable by reading the constraint and grepping for its parent writer, not by
executing it — executing it would have been a write. No claim in this document
rests on a prior handoff.

---

## 6. Repair pass — `f3673e34/agent-G-flywheel-repair`, 2026-07-28 ~16:40–17:05 -06:00

Written by the repair agent, not the audit agent. Every claim below was
re-verified this run against the primary source; nothing was inherited from
section 1 on trust (Stamp Rule). Where this pass **contradicts or extends** the
audit, it says so explicitly.

### 6.1 What was repaired

| # | Finding | Fix | Proof |
|---|---|---|---|
Line numbers below are the **definition line of each symbol**, re-verified by grep
after every edit landed (see §6.2, last bullet — the first draft of this table had
them wrong).

| # | Finding | Fix | Proof |
|---|---|---|---|
| 3 | Tier-B gate could never pass | `src/core/advisory-action.mjs` (NEW) derives `action_hash` from canonical operation JSON; `insertGovernanceAction` (`src/adapters/neon.mjs:181`) is the missing parent writer; `registerGovernanceAction` (`neon.mjs:451`); `recordReview` (`neon.mjs:471`) now requires a registered action; `getConsensus` (`neon.mjs:516`) treats the stored operation as authoritative; `helmion_register_action` declared `src/mcp/server.mjs:42`, dispatched `:113` | `test/advisory-consensus-gate.test.mjs` — **4 failing before the fix, 7 passing after** |
| 2 | Advisory lane write-only | `src/core/advisory-lane.mjs` (NEW) + `helmion advisory list/show/promote/reject` — `advisory()` at `bin/helmion.mjs:284` (comment block from `:278`, ends `:399`), dispatched `:542` | Live run against the bigsister endpoint listed all **6 rows**; `promote` without a TTY exits 1 and writes nothing |
| 13 | `JSON.parse` silent write loss | `MalformedDetailError` (`bigsister_neon_log.mjs:42`) + `parseDetail` (`:60`); `main().catch` now exits 2 for caller errors, still 0 for infrastructure | Before: `EXIT CODE = 0`, no row. After: `EXIT CODE = 2` and the payload echoed |
| 11 | SessionEnd rows carried empty detail | `scripts/neon/session_end_detail.mjs` (NEW) + `session_end_safe.sh:38-45` (`SESSION_DETAIL` at `:38`) | `agent_logs` #395/#396 carry 573–576 chars vs **287 of 289** prior rows with `detail IS NULL` |

### 6.2 Corrections to section 1

- **Finding #13's line numbers are wrong.** The unguarded `JSON.parse` calls were
  at `:38` (event) and **`:86` (blocker)**, not `:44` — `:44` is a destructuring
  assignment. `:117` was already guarded and exits 2; `:152` is only reachable
  after `:117` succeeds.
- **Finding #13 understated the blast radius.** In `blocker` mode the parse ran
  *after* the `bigsister.blockers` row was already inserted, so a malformed
  payload left a tracked blocker with **no evidence row pointing back at it**,
  and still exited 0. The parse now runs before any write.
- **Finding #2's migration cannot live in `sql/`.** `loadMigrations`
  (`neon.mjs:173-175`) runs every `^\d+_….sql` file in `E:\Helmion\sql` against
  `HELMION_DATABASE_URL`. `bigsister` is a **different Neon endpoint** (audit
  finding #19). A bigsister migration placed there would be applied to the wrong
  database. A `sql/bigsister/` subdirectory is invisible to that filter.
- **`bigsister.advisory_outputs` already has a `promoted` column.** Verified
  against `information_schema` this run: `promoted boolean not null default
  false`, 6 rows, all false. The audit did not mention it. The lane therefore
  works **today** against the existing schema; the review-state migration only
  enriches it.
- **Correction to §6.1 itself — my own first draft cited wrong line numbers.**
  Caught by `agent-F-agent-os-package` on review. I wrote `bin/helmion.mjs:278-401`
  (401 is `loadRules()`, not my code), `neon.mjs:172-200`, `:437-484`, `:486-527`,
  `server.mjs:41-56,110`, `bigsister_neon_log.mjs:31-60`, and
  `session_end_safe.sh:29-42` — **every one of them off**, because I wrote them
  from my mental model of where I had inserted code instead of grepping after the
  edits landed. Insertions shift every line below them, so a citation written
  before the edit settles is a guess wearing a citation's clothes. This is the
  exact failure Gate 1 of this document forbids, committed inside the document.
  All are now definition-line citations re-verified by grep. **A line number is
  only a citation if it was read back after the last edit.**

### 6.3 NEW finding — `~/.claude/LESSONS.md` is also write-only

Section 2 draws `distill.mjs:233 → ~/.claude/LESSONS.md` as the PROMOTE arrow and
treats the destroyed content as the problem. The deeper problem is that **the
arrow has no reader even when the file is intact**:

- `distill.mjs:36` sets `LESSONS = join(HOME, '.claude', 'LESSONS.md')` and writes it.
- `session_start_inject.sh:8,24-26` reads `LESSONS_DIR="$HOME/.claude/lessons"` —
  a **directory** of topic documents (`INDEX.md`, `blender-documentation.md`,
  `meshy-pipeline-documentation.md`), not the file.
- `inject_core_directive.ps1:4` *names* `LESSONS.md` inside a hardcoded literal
  string but never opens it.
- No other reader exists under `scripts/` or `hooks/`.

So every lesson distillation has been landing in a file no session start has ever
read. Restoring the file's contents would not have made the loop work.

### 6.4 Reconciliation plan for the orphaned files

Re-verified on disk this run. `BASE_RULES.md` (1,635 B), `HELMION_CLAUDE.md`
(1,828 B) and top-level `LEARNINGS.md` (361 B) all carry mtime **2026-07-28
15:34:58** — the truncation timestamp. `~/.claude/MEMORY.md` **does not exist**
at top level (the real index is `projects/C--Users-troyh/memory/MEMORY.md`).
`~/.claude/planning/LEARNINGS.md` (18,829 B, mtime 2026-07-16 15:50) was **not**
touched by the truncation and is still the live injected file.

**`CLAUDE.md` contains zero `@` imports.** Verified this run. Since `@path` is the
only mechanism that auto-loads a second file, every "Canonical: …" line in
`CLAUDE.md` is prose. A rule reaches a session only if it is written inline in
`CLAUDE.md` itself.

| File | Verdict | Action | Who |
|---|---|---|---|
| `~/.claude/planning/LEARNINGS.md` | **LIVE — keep** | None. Read by `session_start_inject.sh:19-21`. Survived the truncation. | — |
| `~/.claude/LEARNINGS.md` (top level, 361 B) | **RETIRE** | Two files with one name, one live and one dead, is the trap that made a template installer look harmless. Replace its body with a single pointer line to `planning/LEARNINGS.md`, or delete it. | Troy |
| `~/.claude/LESSONS.md` | **MAKE LIVE — highest-value single change** | Add to `session_start_inject.sh` beside the existing LEARNINGS block: `[ -f "$HOME/.claude/LESSONS.md" ] && { echo "## Recent LESSONS.md entries:"; tail -n 40 "$HOME/.claude/LESSONS.md"; }`. This alone reconnects capture→promote→inject. | Troy to approve; additive, one hook script |
| `~/.claude/BASE_RULES.md` | **MAKE LIVE or RETIRE** | `CLAUDE.md:29` calls it canonical but nothing loads it. Either add `@BASE_RULES.md` to `CLAUDE.md` so it is really loaded, or delete the file and keep the rules inline where they already work. Do not leave it half-cited. | Troy — `CLAUDE.md` is off-limits to agents |
| `~/.claude/HELMION_CLAUDE.md` | **RETIRE from `~/.claude`** | It is a product template emitted by `ClaudeProfileInstaller.cs:146`, not one of Troy's rule files. Its home is `E:\Helmion\templates\`. Deployed into `~/.claude` it looks like a live rule file and is not one — and it is the only place the 5-point flywheel is written down (finding #7), which is why that definition is inert. | Helmion side |
| `BIG_SISTER_UNIFIED_SETUP_FINAL.md` | **DANGLING** | Confirmed absent from `C:\Users\troyh` and `E:\` at depth 5. Cited by `CLAUDE.md:19` and the Rule 0.27 block. Either restore it from wherever it was authored or drop the citation — a rule whose stated source does not exist cannot be checked. | Troy |

### 6.5 Proposed DDL — BLOCKED, needs Troy (Tier B)

`hook_autonomy_boundary.ps1` blocked writing this as a migration file:
`BLOCKED - TIER B action, needs Troy before it proceeds — edits a
schema/migration file`. It was **not** bypassed and the file was **not** written.
Logged for review as `bigsister.agent_logs#394`,
`event='needs-review: bigsister.advisory_outputs review-state DDL'`,
`outcome=blocked`.

The advisory lane does not need this to work. It adds durable review state on the
row itself, and makes CLAUDE.md Rule 0.27 structural rather than advisory — a row
cannot be marked promoted without a named human and a written reason:

```sql
alter table bigsister.advisory_outputs add column if not exists reviewed_at timestamptz;
alter table bigsister.advisory_outputs add column if not exists reviewed_by text;
alter table bigsister.advisory_outputs add column if not exists review_decision text;
alter table bigsister.advisory_outputs add column if not exists review_note text;
alter table bigsister.advisory_outputs add column if not exists promoted_at timestamptz;

alter table bigsister.advisory_outputs
  drop constraint if exists advisory_outputs_review_decision_check;
alter table bigsister.advisory_outputs
  add constraint advisory_outputs_review_decision_check check (
    review_decision is null or review_decision in ('PROMOTED', 'REJECTED')
  );

alter table bigsister.advisory_outputs
  drop constraint if exists advisory_outputs_promotion_requires_human;
alter table bigsister.advisory_outputs
  add constraint advisory_outputs_promotion_requires_human check (
    promoted = false or (
      review_decision = 'PROMOTED'
      and nullif(trim(reviewed_by), '') is not null
      and nullif(trim(review_note), '') is not null
      and reviewed_at is not null
      and promoted_at is not null
    )
  );

create index if not exists advisory_outputs_unreviewed_idx
  on bigsister.advisory_outputs(created_at) where review_decision is null;
```

Every statement is `if not exists` / `if exists` guarded, so it is re-runnable.
It targets the **bigsister** endpoint (`ep-dry-fog-aku9i5gq`), never the helmion
one. It has **not been executed anywhere** — no server has parsed it, so "it
parses" is unproven and must not be claimed. `helmion advisory` works without it
and prints a note saying the columns are absent.

**Known divergence — decide at approval time, do not silently pick one.**
`templates/agent-os/core/ADVISORY.md:47-71` (shipped by `agent-F-agent-os-package`)
documents the generic contract as a single `review_state` column with
`unreviewed | verified | rejected`. The DDL above instead uses `review_decision`
with `PROMOTED | REJECTED` and null for unreviewed, because it has to sit beside
the `promoted boolean` column that **already exists** on the live table and
because "promote" is the verb CLAUDE.md Rule 0.27 actually uses. Both are
defensible; shipping both is not. Whoever approves the DDL should pick one and
make the other follow. Note that `templates/` is deliberately anonymized and
`test/agent-os.test.mjs` fails on real endpoint, schema, or project names — so
the alignment moves the *shape*, never the names, into the template.

Command for Troy, once approved, run from `C:\Users\troyh\.claude\scripts\neon`
(that directory's `.env` holds the bigsister URL; do not point this at
`HELMION_DATABASE_URL`):

```
psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f <path to the file>
```

### 6.6 Not touched, deliberately

`CLAUDE.md`, `settings.json`, `LESSONS.md`, `LEARNINGS.md`, `MEMORY.md`,
`memory/*`, `.env`, `~/.claude.json` (still carries the plaintext
`HELMION_DATABASE_URL` and `GROK_API_KEY` of finding #21 — flagged, not edited),
`ClaudeProfileInstaller.cs`, `ProfileSyncEngine.cs`, and every file claimed by
another `SESSION_BOARD.md` row. Findings #4, #14, #15, #16, #21 are untouched and
remain open.
