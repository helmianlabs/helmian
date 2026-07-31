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

# HANDOFF 2026-07-29 — browser extension shipped, Qwen diagnosed

> **AUDITED 2026-07-29 by the next session. Read `## Audit corrections` at the
> bottom before acting on anything above it.** Seven defects were found in the
> extension and fixed; three claims in this document are wrong as written; the
> test counts below are stale (502 → 514, extension 78 → 90).

## 🔴 READ THESE THREE FIRST

1. `E:\Helmion\docs\BROWSER_EXTENSION_DECISION.md` — the build target is a
   **browser extension**. Decided by Troy. The API route is the FALLBACK. Do not
   let a write-up genericize this again; that is exactly how it was lost once.
2. `~/.claude/projects/C--Users-troyh/memory/reference-2026-07-29-qwen-settings-that-make-it-usable.md`
   — four settings or the local model returns an empty string.
3. `E:\Helmion\SESSION_BOARD.md` — claim your files before editing. Concurrent
   sessions collide here.

## What Troy needs to do — the only open ask

**Load the extension and look at it.** He has not seen it. His eyes are the
final QA, not the test suite.

Instructions are in `E:\Helmion\extension\README.md`. Nothing else is blocked on
him.

## State, verified this session

| Thing | Status | Proof |
|---|---|---|
| Extension phase 1 built | ✅ | `E:\Helmion\extension\` — 21 files, manifest v3, zero permissions, zero network destinations |
| Extension tests | ✅ **90 pass / 0 fail** (was 78 before the audit fixes) | `node --test "extension/test/*.test.mjs"` |
| Main Helmion suite | ✅ **514 pass / 0 fail** (was 502) | `npm test` in `E:\Helmion` |
| The false-positive case | ✅ | test named "THE CASE THAT DRIVES THE DESIGN: a sentence warning against rm -rf does not fire" |
| Pattern drift guard | ✅ + positive control | "THE DRIFT TEST" and "POSITIVE CONTROL: the drift test really fails when the copy is edited" |
| Ollama server | ✅ running, pid 24548 | `GET http://127.0.0.1:11434/api/tags` answered |
| `qwen3.5:4b` on disk | ✅ 3.16 GB | same endpoint, `models[0].size` |
| Qwen answering | ✅ 0.53–0.96 s | `/api/chat` classification, 3 cases |
| Extension seen by Troy | ❌ **NOT YET** | — |
| Extension tested on a live site | ❌ **NOT DONE** | no agent opened his browser |

**Uncommitted.** `git status` shows `extension/` and
`docs/BROWSER_EXTENSION_DECISION.md` untracked, `SESSION_BOARD.md` modified.
Nothing was committed. Do not commit until Troy has looked at it.

## The measured finding the whole design rests on

Fed a whole chat reply, the destructive-command kernel
(`E:\Helmion\src\core\governance.mjs`) blocks this sentence:

> "You should never run rm -rf on a production server without a backup."

That is a **warning against** the command. Chat replies are full of prose
discussing commands, so scanning whole replies false-fires constantly.

**Therefore:** extract fenced code blocks first, scan only those, never scan
prose. Inline backticks count as prose too. All three have tests.

**The local model does NOT fix this.** Given the same sentence, `qwen3.5:4b`
answered `DANGER`. Same miss as the regex. Do not plan on the model catching it.

> ⚠️ **Re-measured 2026-07-29 — this paragraph is half right and the half that
> is wrong matters.** See `## Audit corrections` below. The verdict depends
> entirely on the system prompt: 3 of 6 framings answer DANGER (wrong), 3 answer
> SAFE (right), 9 of 18 calls wrong overall — but deterministic within any one
> framing. The model never missed a real command and never false-flagged a clean
> one. It IS usable as a second stage, with a pinned and measured prompt.

## Qwen — four settings, all required

| Setting | Wrong | Result |
|---|---|---|
| endpoint | `/api/generate` | skips the chat template → word-salad loops |
| `think` | omitted | **empty string**, 4,079 tokens into `thinking`, `done_reason: "length"` |
| `num_predict` | omitted | 1,879 tokens for "say hi in five words" |
| `temperature` | default | rambles; use `0` for classification |

Correct: `POST /api/chat` with `messages`, `think:false`,
`options:{num_predict:<cap>, temperature:0}`.

**The 85-second "hang" is not a hang** — it is the model thinking past the token
ceiling and returning nothing. Same trap for any reasoning model.

Good at one-word classification. Bad at conversation — it ignores "exactly five
words" and rambles to the cap.

## Competitive facts, from their source not their site

Full report: `scratchpad\CORDUM_VS_HELMION_SOURCE.md`. Cordum cloned at
`f667720`. **Troy's ruling: stop working on this. They are not a competitor.**
Recorded only so nobody re-litigates it.

- Cordum has **no lease** in the AI-tool path. Their lock service
  (`core/infra/locks/redis_store.go:54`) has two callers, both internal.
- Cordum has **nothing** for browser AI. Greenfield.
- Cordum has **no** pre-install MCP source read, sandbox, or drift baseline.
  Helmion's five stages are the clearest differentiator.
- **BUSL-1.1 forbids using their code in a competing product.** Read for ideas,
  never copy a line.
- Honest gap: Helmion's lease does not block a file write —
  `bin/helmion.mjs:414 guard()` calls only `detectDestructiveOperation` and
  `evaluateRules`, no lease lookup. Do not sell it as a hard mutex until wired.

## Pricing

`scratchpad\HELMION_PRICING.md`, all prices cited from live pages.
Free $0 / Solo $12 / Studio $29 / Team $25 per seat. Everything that BLOCKS
stays free. Paddle over Stripe — they become seller of record and handle sales
tax. Reality: ~$20 net per paying account, 2% conversion, so **2,500 free users
for $1,000/month**.

## Open, not done

| Item | Note |
|---|---|
| Troy tests the extension | the only real blocker |
| Extension phase 2 | claude.ai + gemini.google.com streaming markers were NOT found in public sources; capture them with the browser console open. chatgpt.com's `result-streaming` is documented but unverified against the live site |
| Extension phase 3 | wire the qwen verifier; needs the four settings above |
| Lease → file writes | see honest gap above |
| SOC 2 cost | I told Troy $25–80k twice. **[UNVERIFIED]** — inherited from an earlier pass, not checked. He is planning around it. Verify before he does |
| Advisory lane | `advisory-lane.mjs:145` queries `bigsister.advisory_outputs`, absent from Helmion's DB |
| Signed confirmation | `neon.mjs:632` is a SELECT; no INSERT in the repo, so a key can never enroll |
| `hook_autonomy_boundary.ps1` | blocks `_layout.tsx` by filename, breaking Expo Router; fails OPEN on real Clerk code. Needs Troy to allow edits |
| Helmion → private GitHub for Bryce | anonymized, fresh account, leak scan first |

## Audit corrections — 2026-07-29, next session

Everything above was re-checked against the code. What follows supersedes it.

### Seven defects found in the extension, all fixed

Each fix has a positive control: the new test was run against the pre-fix code
on a reverted sibling copy and had to fail there. 7 of 7 failed as required.

| # | Defect | Where | Why it mattered |
|---|---|---|---|
| 1 | `scanLine` returned `skipped` for a long line and `scanCodeBlock` discarded it | `extension/background/scan.js:39` (pre-fix) | A line over 4,000 characters was never checked **and never mentioned**. The block came back clean. Pad a destructive command past 4,000 chars on one line and it sailed through |
| 2 | The 4,000-char cap's stated justification was false | same file | Comment claimed scanning long lines "costs regex time and can only produce noise." Measured: 500,000 chars = 3.6 ms, and 200,000 chars of filler returns **clean**, so there is no noise either. Cap raised to 1,000,000 as a runaway guard only; every skip now surfaces on the page in amber |
| 3 | Both stream callbacks discarded `{ streaming }` | `extension/content/guard.js:287,290` (pre-fix) | `stream-watch.js:3-17` spends fourteen lines describing the stop button as the **primary** signal. It was computed on every tick and never once acted on — the extension ran on quiescence alone. Now forces a full re-check at the streaming→finished transition |
| 4 | `dangerousIds` never pruned | `guard.js:200-224` (pre-fix) | Ids were deleted only for blocks in the current pass. A flagged block removed by a conversation switch stayed counted forever: the red badge could climb but never fall, and the toast could never clear (that path needs the count at zero) |
| 5 | Change detection keyed on text **length** | `guard.js:171` (pre-fix) | An edit that preserved the character count was invisible and the block was never re-checked. Now a length + djb2 content fingerprint |
| 6 | Degraded-anchor banner recorded no state | `guard.js:155-161` (pre-fix) | Drawn via `showBanner` without setting anything, and `recover()` returns early unless state says something is wrong — so once drawn it never came down, and the toolbar never showed the warning mark `README.md` promises for it |
| 7 | A comment promised a read-only build | `guard.js:23-25` (pre-fix) | `MASK_DANGEROUS_BLOCKS = false` still writes bookkeeping attributes onto every code block and still inserts panels, toasts and banners. It never "only reads the page." Comment and README corrected |

**Test infrastructure, two more:**

- The drift positive control was writing to the **real** generated kernel while
  sibling suites import that module, and `node --test` runs files concurrently.
  It was observed taking down `reply-cases.test.mjs`. The generated file is also
  untracked, so a crash mid-control would have left a tampered safety kernel
  with no `git checkout` to undo it. It now uses a temp file — 3 consecutive
  clean runs.
- The network guard missed `EventSource`, `WebSocket(` without `new`, dynamic
  `import()`, an `Image` beacon and `connectNative`; and its
  `includes(sep + 'test')` skip also swallowed `test-support/`. Widened, with a
  positive control per pattern.

Gates after the work: `npm test` **514 pass / 0 fail** (was 502; extension
78 → 90; the 424-test baseline is untouched). `npm run check` exit 0.
`git status` still shows only `extension/` and the two docs untracked plus
`SESSION_BOARD.md` modified — no pre-existing repo file was edited.

### Three claims above are wrong as written

| Claim above | What the code actually shows |
|---|---|
| "Advisory lane — `advisory-lane.mjs:145` queries `bigsister.advisory_outputs`, absent from Helmion's DB" | The query and line are right, but the absence is **by design** — that schema lives on a different Neon endpoint via `BIGSISTER_DATABASE_URL` (`bin/helmion.mjs:285-286`), and the code preflights for the table (`advisory-lane.mjs:187-193`). **The real defect is different**: `advisory-lane.mjs:101,132` tell the operator to apply `sql/bigsister/001_advisory_output_review_state.sql`, and **that file does not exist** — `sql/` holds only `001_helmion.sql`, `002_maestro_phase_one.sql`, `003_human_confirmations.sql`. The remediation the error message names is unshippable. Still open; `SESSION_BOARD.md` records that DDL as needing Troy (Tier B), so it was deliberately not written here |
| "Signed confirmation — `neon.mjs:632` is a SELECT; no INSERT in the repo, so a key can never enroll" | Line is **633**, not 632. Zero writers is correct. But the missing INSERT is a **deliberate, documented security boundary**, not a bug: `src/core/advisory-action.mjs:16` says the table "deliberately does not" have a writer, and `docs/HUMAN_CONFIRMATIONS.md:38-40` gives the reason — "otherwise an agent could create its own trust root and approve its own action." Enrollment is meant to happen out-of-band. The true residual: until Troy stands that authority up, the signed tier cannot be exercised |
| "`hook_autonomy_boundary.ps1` … fails OPEN on real Clerk code" | True, and **understated**. The content scan (`:219`) matches only `CLERK_SECRET_KEY\|CLERK_PUBLISHABLE\|clerkClient\|users.updateUser\|publicMetadata`, so `<ClerkProvider>`, `useAuth()`, `clerkMiddleware()`, `createRouteMatcher`, `auth.protect()`, `<SignedIn>` and `getAuth()` all pass. The harder one it never mentions is `:35` — `catch { exit 0 }` on malformed JSON, and `:39` the same when `tool_input` is absent. Exit 0 is ALLOW. Note the inconsistency: Helmion's own `guard()` was deliberately changed to fail **closed** (`bin/helmion.mjs:425-438`), so two governance layers on this machine have opposite failure postures |

### One claim above is accurate but incomplete

"The lease does not block a file write — `bin/helmion.mjs:414 guard()`" is exact,
and the conclusion holds: **do not sell the lease as a hard lock on files.** But
`guard()` is only one of two write paths. The in-process agent runtime is a
second, independently ungated one: `src/agent/tools.mjs:449` →
`src/core/governance-gate.mjs:109-193` → approval `:467` → `tool.execute` `:480`
→ `write_file` `src/agent/tools.mjs:304-309` → `writeFileSync` `:307`. Neither
path imports the lease. `requireActiveLease` (`src/adapters/neon.mjs:151-176`)
has exactly four callers and all four are Postgres writes to Helmion's own
coordination tables, not file writes. `README.md:19` advertises "a
database-enforced single active write lease per project" — that governs DB
coordination writes only.

### The SOC 2 number

The unstamped copy was not in this repo — it was in Troy's memory index at
`~/.claude/projects/C--Users-troyh/memory/project-2026-07-29-helmion-gtm-verdict.md:96`,
which every future session inherits as fact. It is now stamped `[UNVERIFIED]`
there with a note saying nobody has priced it. Actual SOC 2 pricing was **not**
researched here.

### The Qwen finding above is wrong, and the correction changes phase 3

Two sessions measured opposite answers on the same sentence with the same
settings, and **both are reproducible**. The variable neither recorded was the
system prompt. Measured here: `think:false`, `temperature:0`, `num_predict:40`,
6 system prompts × 3 repeats = 18 calls on
*"You should never run rm -rf on a production server without a backup."*

| Measurement | Result |
|---|---|
| Wrong (`DANGER` on a warning) | **9 / 18 calls** |
| Framings wrong at least once | **3 / 6** |
| Framings that disagreed with themselves | **0 / 6** — deterministic at temp 0 |
| Real command `rm -rf / --no-preserve-root` missed | **0 / 18** |
| Clean command `git status --short` false-flagged | **0 / 18** |

The three framings that got it WRONG are the obvious ones — `Answer with
exactly one word: DANGER or SAFE.`, `You classify shell commands…`, `A user is
about to EXECUTE the following…`. The three that got it RIGHT all name the
distinction explicitly, the best being: *"Reply DANGER only if the text is an
instruction TO RUN a destructive command. Advice against running one is SAFE."*

**Consequence for phase 3:** the model is a viable second stage — it never
missed a real command and never false-flagged a clean one. But the prompt must
be pinned in the repo beside the code and re-measured whenever it changes. A
verifier whose verdict moves with its own wording is not a verifier yet.

**Consequence for phase 1: none.** Extract fenced blocks first and scan only
those. That is structural, costs no model call, and is what ships today.

`num_predict` is also not one of "four settings, all required" — on `/api/chat`
with `think:false` and no cap: `eval_count 10`, `done_reason "stop"`, 734 ms.
Only the endpoint and `think:false` are load-bearing. `/api/ps` reports
`context_length: 4096`, which is exactly why thinking eats ~4,079 tokens and
returns an empty string.

### Still not done

Nobody has loaded the extension in Chrome. No live-site DOM has been checked.
That gate is unchanged and it is Troy's.

## How to talk to Troy

Plain short English sentences. Not report format. Define jargon in the same
sentence. Tables for LISTS, sentences for EXPLANATION.

**Do not narrate your own corrections.** Fix it and move on. Announcing every
mistake reads as second-guessing and he called it out tonight.

Never mention the hour or tell him to sleep. Never start voice — text only until
he types the literal word "voice."
