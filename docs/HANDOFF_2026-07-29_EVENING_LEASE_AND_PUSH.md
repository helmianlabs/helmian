````
════════════════════════════════════════════════════════════════════════
RULE 0.001 — SOURCE OF TRUTH + FULL TRACING (quoted verbatim, read first)

  GATE 1 — SOURCE OF TRUTH. Cite the primary source where the claim lives.
  Code → file:line. API → response body + endpoint hit. Vendor docs → URL +
  quoted sentence. DB → query + row. NOT "memory says," NOT "the handoff
  says," NOT "I recall." Memory and prior handoffs are SECONDARY — every
  claim starts [UNVERIFIED] until the primary source confirms it THIS session.

  GATE 2 — FULL TRACING. For any multi-stage claim ("X causes Y," "feature is
  wired," "demo works"), draw the chain explicitly with a citation on EVERY
  link. Stage A → B → C → ... → N. Each arrow proven with file:line /
  endpoint / log line. A chain with one uncited link IS the lie. The gap with
  no citation IS the gap.

RULE 0.002 — CITE OR SHUT UP. If I cannot cite a primary source for a claim
right now, I do not make the claim.

RULE 0.13 — RETIRED 2026-05-29. There is NO 45/60-minute handoff cap. Do not
schedule a ScheduleWakeup checkpoint. Discipline, not a clock.

EVERY CLAIM BELOW IS [UNVERIFIED] FOR YOU UNTIL YOU RE-CHECK IT THIS SESSION.
════════════════════════════════════════════════════════════════════════
````

# HANDOFF 2026-07-29 evening — pushed to GitHub, lease built, 4 of 6 batch items open

## The one thing to know first

**`origin/main` is now public-ish reality.** 14 commits were pushed to the
PRIVATE repo `github.com/troy83352/helmion` at `607eddc..2af76af`. Troy is
putting this on GitHub tonight under BUSL and starting to sell it. Every claim
in `README.md` is now a claim to a customer, not a note to himself.

**One `README.md` claim is still overstated.** `README.md:19` advertises "a
database-enforced single active write lease per project." The mechanism now
exists (`src/core/lease.mjs`, committed `0bb4404`) and is proven, but **nothing
calls it**. Verified this session: `grep -c lease src/core/governance-gate.mjs
src/agent/tools.mjs` → **0 and 0**. Wiring it is the top open task.

## Troy's directive that governs everything here

His words, 2026-07-29 evening: build it out, **"we're not faking anything"**,
everything has to be real because it goes on GitHub tonight with a BUSL license
and he is trying to sell it and get attention on it.

Read that before deciding any tradeoff. Aspirational UI text and unenforced
README claims are the specific thing he is objecting to.

## State, verified this session

| Thing | State | Proof |
|---|---|---|
| Branch | `main`, **0 ahead of origin** | `git rev-list --count origin/main..HEAD` |
| Last pushed | `2af76af` | `git push` output `607eddc..2af76af main -> main` |
| Unpushed | **1 commit — `0bb4404`** (the lease module) | committed, deliberately not pushed |
| Full suite | **533 pass / 0 fail** | `npm test` |
| `npm run check` | exit 0 | run this session |
| Push payload after binary strip | **3.92 MB / 397 objects** (was 340.57 MB) | `git rev-list --objects \| cat-file --batch-check` |
| Backups of pre-rewrite history | tag `backup/pre-binary-strip-20260729` + `refs/original/` | `git tag -l 'backup/*'` |
| `.git` on disk | ~210 MB, deliberately — those backups hold the stripped objects | dropping them + `gc` reclaims ~206 MB |

## What landed today

### The history rewrite (done, pushed)

Exactly **one** of the 13 commits carried binaries: `bf85fe4`, 667 artifact
files, 343.74 MB of the 344.44 MB it added. The other 12 carried zero — an
earlier pass flagged tiny "artifacts" in four of them and that was a
**classifier false positive**: they were `bin/helmion.mjs` and
`bin/helmion-jobs.mjs`, which are source.

`git filter-branch --index-filter --prune-empty` over `origin/main..HEAD`
stripping `tools/voice-dictation/*/{bin,obj}`. Result: 14 → 13 commits (the
pure-deletion commit `bcd7690` correctly vanished as empty) and
`git diff backup/pre-binary-strip-20260729 HEAD` returns **zero paths** — the
final tree is byte-identical, only history shrank.

`.gitignore` was also narrowed. It said `tools/**/bin/`, which is a trap in
this repo because **`bin/` is a source directory here** — six tracked `.mjs`
live in it, so `tools/newtool/bin/cli.mjs` would have been silently untracked.
Now scoped to `bin/Debug/`, `bin/Release/`, `obj/` and framework folders, and
verified both directions with `git check-ignore`.

### Guard detection widened (done, pushed)

Language-API destruction is now caught, not just shell syntax: Python
(`shutil.rmtree`, `os.remove/unlink/rmdir`), C# (`Directory.Delete`,
`File.Delete`), Ruby (`File.delete`, `FileUtils.rm_rf`), Node
(`fs.rm/rmSync/unlink/unlinkSync/rmdir/rmdirSync`, `fs.promises`,
`recursive:true`), broader SQL `TRUNCATE`. All in `src/core/governance.mjs`, so
`extension/tools/sync-kernel.mjs` gives the browser extension the same list and
the drift test keeps them identical.

Comments are stripped before matching (`/* */`, `<!-- -->`, `#`, `//`). **Two
comment styles are deliberately NOT stripped and both would be holes:**

- `--` — because `--force`, `--recursive`, `--no-preserve-root` are CLI flags,
  and `git checkout -- path` is itself a destructive pattern keyed on `\s--\s`.
- `//` preceded by `:` — so `curl https://host && rm -rf /` cannot lose
  everything after `https:`.

Both traps have tests in `test/governance.test.mjs`.

### Sync Profile stopped resetting Troy's own files (done, pushed)

His instruction: *"No deletion, no reset, just a straight copy."*
`BASE_RULES.md`, `LEARNINGS.md`, `LESSONS.md` are LIVING DOCUMENTS with **no
overwrite path at all** — `ClaudeProfileInstaller.cs:146`, the
`overwriteExisting` flag cannot reach them. Installing into a NEW profile
copies his accumulated content forward byte-for-byte
(`carryForwardFrom`), template only as fallback. `GEMINI.md` had the identical
bug and never got the 2026-07-28 preserve fix; now created-if-absent,
left-alone-if-present.

Positive control: removed `isLiving ||`, rebuilt, the suite failed with
*"BASE_RULES.md survived even overwriteExisting:true"*. Restored. Guard checks
went 9 → 18.

### The lease (committed `0bb4404`, NOT pushed, NOT wired)

`src/core/lease.mjs`. Local, file-based, no database — because a Postgres lease
cannot back the README promise for anyone who clones the repo.

- Mutual exclusion is `open(path, 'wx')`. The OS picks the winner in one
  syscall; there is no read-then-write window.
- Stale takeover on expiry **or** a dead holder pid, so a hard crash frees the
  project instead of parking it for the full TTL.
- Fails **closed** on unreadable/incomplete lease files.
- `inspectLease` returns four states and **UNREADABLE is not laundered into
  NONE**.

`test/lease.test.mjs`, 15 tests. **THE RACE** spawns twelve real OS processes
contending for one lease and asserts exactly one wins — and on its first run it
found a real bug in the module: on Windows `rename()` over a file another
process holds open fails `EPERM`, so two sessions both claiming the same stale
lease crashed rather than one losing cleanly. Now `writeRecordAtomically`
returns false on `EPERM/EACCES/EBUSY` and the loser gets `LeaseHeldError`.

Two harness bugs are documented inside the test because both produced
convincing false results: a bare Windows path in a generated ESM import (killed
all twelve children silently, read as "nobody won") and a synchronous cleanup
that deleted the temp workspace mid-race.

## Troy's rule files were destroyed today and are restored

`Helmion Pilot` PID 35736, started 14:49:01, rewrote ten files under
`C:\Users\troyh\.claude` at **14:49:24**. The running exe was built 07-28
15:47:14; the preserve fix landed 54 minutes later, so every source guard was
inert in it.

| File | Was | Now | Proof |
|---|---|---|---|
| `BASE_RULES.md` | 1,635 B stub | **5,512 B restored** | sha256 `cff8481e…` matches the backup |
| `LESSONS.md` | 612 B stub | **7,799 B restored, 11 entries** | sha256 `4d002346…` matches |
| `LEARNINGS.md` | 361 B | still 361 B | **no larger backup exists anywhere** |
| `CLAUDE.md` | untouched | untouched | 35,900 B, mtime Jul 25 |

Stubs preserved as `.STUB-20260729-*.bak`. The self-contained artifact has been
republished (17:45:05, from `2af76af`) so the stale exe is gone.

**A prior audit claimed six `skills/*/SKILL.md` were destroyed with nothing
recoverable. That is WRONG — I checked.** All six have
`SKILL.md.20260728-212459.bak` and each is byte-identical to the live file.
Whether longer versions ever existed cannot be determined from disk.

## Corrections to earlier claims — do not re-inherit the wrong ones

| Earlier claim | Truth |
|---|---|
| "The local Qwen model can't catch the prose false positive — it answers DANGER" | **The system prompt decides.** 6 framings × 3 repeats: 9/18 calls wrong, 3/6 framings wrong, **0/6 inconsistent with themselves**, 0/18 real commands missed, 0/18 clean commands false-flagged. The naive framings are the wrong ones. It IS viable as a second stage with a pinned, measured prompt |
| "Four Qwen settings, all required" | Only the endpoint and `think:false` are load-bearing. `/api/chat` + `think:false` with **no** `num_predict`: `eval_count 10`, `done_reason stop`, 734 ms |
| "advisory-lane's missing table is a gap" | By design — different Neon endpoint via `BIGSISTER_DATABASE_URL`. **The real defect**: `advisory-lane.mjs:101,132` name a remediation file `sql/bigsister/001_advisory_output_review_state.sql` that **does not exist** |
| "`neon.mjs:632` SELECT, no INSERT, so a key can never enroll" | Line is **633**. Zero writers is right, but it is a **documented security boundary** (`docs/HUMAN_CONFIRMATIONS.md:38-40`), not a bug |
| "SESSION_BOARD documents live vulns in Helmion" | **Not Helmion.** Row 54 is `agent-AH-spec-sheets`, auditing *other* apps — heartbeat-voice, ThinkinBuddy, the Memory Vault kit. Tracked in `memory/audit-2026-07-29-security-findings-spec-sheets.md` |
| "The DFA file leaks customer data" | **Overstated.** `docs/APP_INVENTORY_2026-07-28.md:51-59` contains folder paths, two filenames, the org name DFA, and one public URL. It says "Not opened". **No customer names, no contacts, no IDs, no data** |
| "SOC 2 costs $25–80k" | **[UNVERIFIED]**, never sourced. Now stamped in `memory/project-2026-07-29-helmion-gtm-verdict.md` |

## Open work — Troy's batch of 6, items 4/5/6 plus the lease wiring

### 0. WIRE THE LEASE (highest value — it makes a sold claim true)

`src/core/governance-gate.mjs:109` `evaluateToolCall({tool, args, workspace,
projectSlug})` already runs before every tool call and already fails closed.
That is the insertion point. Add a lease check for **mutating** tools only
(`write_file`, edits, `run_command`); reads must not need a lease. Acquire at
session start, renew per mutating call, release on exit.

Watch out: the agent must acquire automatically or single-session use breaks.
And a missing lease must refuse a mutation, not allow it — that is the whole
point.

### 4. Persistent audit log for block events (NOT STARTED)

Troy's schema: `timestamp`, `layer` (browser | execution), matched pattern,
full triggering text, source (app/file/session), outcome. Durable file or local
table. He explicitly framed this as a shippable product feature, not just
evidence for us. Both layers must write to it: the extension's
`background/scan.js` path and the `governance-gate` path.

### 5. Hedge-language detection (NOT STARTED — spec is his, verbatim intent)

**Two signals, never fires on one alone.** (a) a hedge marker (probably, should
be, generally, I believe, from what I recall) AND (b) attached to a specific
checkable factual claim — menu location, function name, file path, command
syntax, version-specific behavior — **not** an open judgment or subjective
question.

Two stages: **stage 1 always on**, local Qwen scans for the two-signal pattern
at near-zero added latency; **stage 2 only on a stage-1 flag**, a real lookup
against docs for that claim only. Output flags, never blocks: "unverified claim
detected, consider requesting a source check."

Note his earlier correction: the feature is misnamed. Hedge language expresses
uncertainty; what this detects is **unsupported confidence / unverified factual
claims**. Extract individual claims and track evidence status — phrase matching
alone will be noisy.

### 6. Project structure + side panel redesign (NOT STARTED)

Inspired by 120x.ai's Project Launcher (Architect/Builder — structured project
folder with planning files, sprint area, docs, handoff prompts, built *before*
Claude Code or Cursor touches anything), plus a side panel of escalating status
cards: grey/yellow/red, flashing before escalating past yellow, cards that grow
when they carry A/B/C/D or numbered options, clickable inline without leaving
the CLI.

His accessibility corrections apply: do not rely on colour or continuous
flashing alone — text labels, icons, reduced-motion behaviour,
acknowledgement states, dedup, grouping, retention limits, and a stated rule
for when yellow escalates.

### Also open, smaller

- **The lease UI still lies.** `WorkspaceInspector.cs:56-60` hardcodes
  `Status: "UNAVAILABLE"`. Point it at `inspectLease` and stop painting an
  unknown state green.
- `advisory-lane.mjs:101,132` name a SQL file that does not exist.
- `hook_autonomy_boundary.ps1:35` — `catch { exit 0 }` on malformed JSON. Exit
  0 is ALLOW. I hit this accidentally: a BOM on stdin silently disarms the gate.
  Note the inconsistency — Helmion's own `guard()` was deliberately made to
  fail **closed** (`bin/helmion.mjs:425-438`).
- `.git` is ~210 MB until the two backup refs are dropped. Troy's call.
- One test run reported `fail 2` immediately after the rewrite; **six runs
  since are clean** and the two tests were never captured. Unexplained.

## Things that will bite you

- **`npm run desktop:test` used to open a real command prompt on his desktop
  every run** — `SmokeTests/Program.cs` called `LaunchProcess("cmd.exe")` with
  `CreateNoWindow=false` and never killed it. Fixed, but he is extremely
  sensitive to console windows. Do not spawn one.
- The **playwright plugin** was the popup source (`npx @playwright/mcp@latest`
  through `cmd.exe`). Set to `false` in `settings.json:176`; **needs a Claude
  Code restart** to take effect. He also stated on 07-11 he never wants
  isolated Playwright — he wants his real logged-in browser.
- **String-searching a single-file .NET publish proves nothing.** The managed
  assemblies are compressed; `BASE_RULES.md`, present in both old and new
  builds, was not findable either. Do not report that as evidence.
- **Your own test labels can trip his hooks.** `hook_autonomy_boundary.ps1:205`
  matches `drop\s+table`, and a test case *named* "SQL drop table" blocked the
  run. `hook_block_commit_qa.ps1` also could not read a **quoted** `-F "path"`
  until I fixed it — its pattern excluded quote characters, and its heredoc
  reader needed the opener alone at end of line.
- **The browser extension is live and works.** Troy verified it on claude.ai:
  red panel, matched pattern named, exact line quoted, second-click reveal.
  **The "stays quiet on prose" half has never been checked in a browser.**
  Also: the site's own Copy button still works on a hidden block — he has seen
  this and it is undecided.

## How to talk to Troy

Short, plain sentences. Tables for lists, sentences for explanation. Define
jargon in the same sentence. Never mention the hour or tell him to sleep. Never
start voice — text only until he types the literal word "voice." His dictation
garbles words; use context, never quiz him on one odd word.

Do not narrate your own corrections at length. Fix it, say the one sentence
that changes what he'd do, move on.
