# HELMION — ON-CAMERA DEMO SCRIPT

**The Execution Guard, filmed live.** Four beats, ~2:40 total.
Written to be read off a second monitor while recording.

Every beat in this script was **actually run on this machine on 2026-07-30** and the
output below is copied from the real run, not written from memory. Where something
could not be verified it is labelled **[UNVERIFIED]** in red text. Where a beat has a
known risk on camera, it says so and gives the recovery line.

---

## READ THIS FIRST — three things that will bite you

### 1. Film in a plain PowerShell window, NOT inside Claude Code.

Your own personal PreToolUse hooks (`hook_block_destructive.ps1`,
`hook_block_commit_qa.ps1`, `hook_autonomy_boundary.ps1`, registered in
`C:\Users\troyh\.claude\settings.json`) fire on every Bash/PowerShell call **inside a
Claude Code session**. They blocked three of my own rehearsal commands tonight. They do
**not** apply to a plain terminal. Open Windows Terminal → PowerShell, and none of them
will interrupt the take.

### 2. Gemini is DOWN right now, and it is not your key.

Measured tonight against the live Gemini MCP server:

```
ERROR 429: { "error": { "code": 429,
  "message": "Your prepayment credits are depleted. Please go to AI Studio at
  https://ai.studio/projects to manage your project and billing.",
  "status": "RESOURCE_EXHAUSTED" } }
```

So Gemini will show `no verdict` in **every** beat, whether you want it to or not.
This turns out to be a gift for Beat C — see that beat for how to narrate it honestly.
**Do not say "watch, I'm unplugging Gemini" unless you actually pull the key on camera**
(Beat C Option 2), because Gemini being quiet is currently true regardless.

### 3. Use a SHORT working path.

The ledger prints the workspace in its `source:` field. Film from `C:\helmion-demo`, not
a deep temp path, or that line wraps ugly on screen.

---

## SETUP — do this BEFORE you hit record (about 60 seconds)

Paste this whole block into PowerShell once. It creates the demo folder, some sacrificial
"customer invoices," and a tiny git repo with one correct file committed.

```powershell
$d = "C:\helmion-demo"
New-Item -ItemType Directory -Force -Path "$d\customer-invoices" | Out-Null
1..3 | ForEach-Object {
  "INVOICE 000$_ - Chobani Twin Falls - 48,200 lb" |
    Set-Content "$d\customer-invoices\invoice-000$_.txt"
}
Set-Location $d
git init -q
git config core.autocrlf false          # stops git printing a CRLF warning mid-take
git config user.email demo@dairyforge.local
git config user.name Demo
@"
// dispatch.mjs - split the day's loads into batches for the carrier API.
export function batchLoads(loads, size) {
  const batches = [];
  for (let i = 0; i < loads.length; i += size) {
    batches.push(loads.slice(i, i + size));
  }
  return batches;
}
"@ | Set-Content dispatch.mjs
git add dispatch.mjs
git commit -q -m "baseline batching"
Clear-Host
```

**Pre-flight check (run it, then clear the screen again):**

```powershell
helmion audit summary
```

You want to see `0 event(s)` or `No block events`. An empty ledger at the start is what
makes Beat D land — the entries appear *while the camera is rolling*.

Have `dispatch.mjs` open in your editor on a second window, ready for Beat B.

---

# BEAT A — A HARMFUL COMMAND, STOPPED BEFORE IT RUNS
**Runtime: ~45 seconds.** This is the strongest beat. Lead with it.

## A1 — the self-proving probe (~15s)

The guard proves itself in front of the viewer: the same tool, asked twice, answers
differently. This mirrors the liveness probe on the Pilot's guard card.

**Type:**
```powershell
'{"tool_name":"Bash","tool_input":{"command":"rm -rf /helmion-liveness-probe-not-a-real-path"}}' | helmion guard
```

**Real output (verified):**
```
{"allowed":false,"destructive":{"blocked":true,"hits":["recursive/forced rm"],...
```
Exit code `2`.

**Type:**
```powershell
'{"tool_name":"Bash","tool_input":{"command":"echo helmion-liveness-probe"}}' | helmion guard
```

**Real output (verified):**
```
{"allowed":true,"destructive":{"blocked":false,"hits":[],...
```
Exit code `0`.

**You say:**
> "Same guard, two commands. It refused the delete and it allowed the echo — so it's
> reading the command, not just saying no to everything."

## A2 — the real one, against real files (~30s)

This is the money shot. The guard sits in front of an actual delete. If the guard fails,
the files die — so the files surviving *is* the proof.

**Type:**
```powershell
Get-ChildItem .\customer-invoices
```
Three invoices on screen.

**Then type this — one line. The command appears TWICE on purpose: once as what the
guard is asked about, once as what would actually run.**

```powershell
'{"tool_name":"Bash","tool_input":{"command":"Remove-Item -Recurse -Force .\\customer-invoices"}}' | helmion guard && Remove-Item -Recurse -Force .\customer-invoices
```

**Real output (verified — this exact run happened tonight):**
```
{"allowed":false,"destructive":{"blocked":true,"hits":["Remove-Item -Recurse/-Force"],
"approved":false,"reason":""},"rules":{...},"audit":{"logged":true,
"file":"C:\\helmion-demo\\.helmion\\audit\\blocks-2026-07-30.jsonl","reason":""}}
```
Chain exit code `2`. **The `&&` short-circuits, so the delete never executes.**

**Type:**
```powershell
Get-ChildItem .\customer-invoices
```
**All three invoices are still there.**

**You say:**
> "I just ran a real recursive delete against real files. The guard refused it, the
> shell stopped, and the invoices are still on disk. Nothing was staged — if the guard
> had failed, those files would be gone."

> **Why the `&&` matters, if a technical viewer asks:** `helmion guard` exits `2` on a
> refusal and `0` when it allows (`bin/helmion.mjs:748`). That exit code is the whole
> contract — a shell `&&`, a git hook, or a Claude Code PreToolUse hook all stop on it.

---

# BEAT B — A REAL MISTAKE, CAUGHT BY ANOTHER AI
**Runtime: ~40 seconds.** Verified live 4 separate times tonight; caught every time.

**In your editor**, change exactly one thing in `dispatch.mjs` line 4 — add `- size`:

```diff
-  for (let i = 0; i < loads.length; i += size) {
+  for (let i = 0; i < loads.length - size; i += size) {
```

Save it. That is eleven characters, and it silently drops the last partial batch of
loads. **Measured: with 10 loads at size 4, it delivers 8 and loses 2.**

**Type:**
```powershell
git diff | helmion review --summary "batch the day's loads before posting them to the carrier API"
```

**Real output (verified, 5.4 seconds):**
```
ADVISORY REVIEW — batch the day's loads before posting them to the carrier API
Tier A: scoped code change without a protected boundary

  [FLAG] grok     BLOCK
         Loop condition change i < length-size skips final batch when length is not
         multiple of size, breaking batching entirely.
         cite: dispatch.mjs:4
  [ -- ] gemini   no verdict
         "undefined" is not one of APPROVED, CONCERN, BLOCK
  [FLAG] chatgpt  CONCERN
         The loop condition in the change appears incorrect. It should be
         'i < loads.length' rather than 'i < loads.length - size' ...
         cite: dispatch.mjs:5

REFUSED — CAUGHT by grok, chatgpt: ...
```
Exit code `2`.

**You say:**
> "I just made an eleven-character mistake. It compiles, it passes a smoke test, and it
> quietly drops two loads out of every ten. Grok caught it and pointed at line four.
> ChatGPT caught it independently. I never asked either of them — that happened on the
> push path, in five seconds."

> **Freight translation, if you want one line for that audience:** "Two loads a day that
> never get dispatched, and nothing errors out. That's the kind of bug you find in a
> billing dispute three weeks later."

**⚠ Camera risk and recovery:** the advisors are live models, so the exact wording
changes run to run. Across four runs tonight Grok returned `BLOCK` every time and
ChatGPT returned `CONCERN` twice and `BLOCK` twice — **`REFUSED` on all four.** If for
some reason only one catches it, that is still the correct result and your line is:
*"One of them caught it. One is all it takes — that's the design."*

---

# BEAT C — SILENCE DOES NOT BLOCK
**Runtime: ~35 seconds.** The most sophisticated beat. This is the thesis.

**In your editor**, put line 4 back the way it was and add the helper below it:

```javascript
  for (let i = 0; i < loads.length; i += size) {     // <-- restored

// Total net weight of a list of loads, in pounds.
// Returns 0 for an empty list. A load with no numeric weightLb counts as 0.
export function totalWeightLb(loads) {
  if (!Array.isArray(loads)) return 0;
  return loads.reduce((sum, load) => {
    const lb = Number(load?.weightLb);
    return Number.isFinite(lb) ? sum + lb : sum;
  }, 0);
}
```

**Type:**
```powershell
git diff | helmion review --summary "add totalWeightLb, a pure helper that sums weightLb across a list of loads and ignores non-numeric weights"
```

**Real output (verified, 3.8 seconds — this exact result reproduced 4 times tonight):**
```
  [ ok ] grok     APPROVED
         Implementation matches the summary exactly and contains no bugs,
         hallucinations, or unsupported claims.
  [ -- ] gemini   no verdict
         "undefined" is not one of APPROVED, CONCERN, BLOCK
  [ ok ] chatgpt  APPROVED
         The proposed change adds a helper function `totalWeightLb` that correctly
         sums numeric weights ...

ALLOWED — 2 advisor(s) looked and caught nothing. NOT CHECKED BY: gemini —
coverage was 2/3, not full.
```
Exit code `0`.

**Point at the last line. That line is the product.**

**You say (Option 1 — recommended, requires nothing, and it is true):**
> "Gemini is down right now — its API credits ran out this week. Watch what Helmion did
> with that. It did **not** block me. Nobody caught anything, so the work goes through.
> But it also refused to tell me three AIs checked this, because they didn't. Two did.
> It named the one that didn't and it printed the coverage. Most tools would either hang
> waiting for a vote, or quietly pretend they got a full review. This does neither."

**Option 2 — if you top up Gemini billing first and want the sharper contrast:**
Run Beat B with all three answering, then before Beat C type:
```powershell
$saved = $env:GEMINI_API_KEY; $env:GEMINI_API_KEY = ""
```
run the review, then restore with `$env:GEMINI_API_KEY = $saved`.
**Verified:** with the key pulled, the journal records the advisor's literal reply as
`ERROR: GEMINI_API_KEY not set`, it is not counted, and the gate still returns `ALLOWED`
with the same `NOT CHECKED BY: gemini` line. Narrate it as *"I'm pulling one advisor's
credentials on camera."*

---

# BEAT D — THE LEDGER
**Runtime: ~20 seconds.** Close on this. It is what a compliance buyer wants.

**Type:**
```powershell
helmion audit list
```

**Real output (verified — both Beat A refusals, read back):**
```
Block ledger — C:\helmion-demo
2 event(s), both layers, 1 file(s), 942 bytes

  2026-07-30T23:55:38  execution Remove-Item -Recurse/-Force
      outcome: blocked
      source:  guard-hook:Bash:C:\helmion-demo
      text:    Remove-Item -Recurse -Force .\customer-invoices
  2026-07-30T23:55:26  execution recursive/forced rm
      outcome: blocked
      source:  guard-hook:Bash:C:\helmion-demo
      text:    rm -rf /helmion-liveness-probe-not-a-real-path

By layer:   execution 2
By pattern: Remove-Item -Recurse/-Force 1, recursive/forced rm 1
Newest:     2026-07-30T23:55:38.082Z
Oldest:     2026-07-30T23:55:26.793Z
```

**You say:**
> "That ledger was empty when I started recording. Every refusal you just watched wrote
> itself down — timestamp, which layer stopped it, which pattern matched, and the full
> text of what somebody was about to run. Not a screenshot. Not chat history. A file on
> disk you can hand to an auditor."

**Optional closing tap (adds ~8s):** `helmion audit list --json` — shows the raw records.
Worth it for a developer audience, skip it for a freight audience.

---

# TIMING

| Beat | What it shows | Command time | With narration |
|---|---|---|---|
| A1 | Guard proves itself both ways | 3s | 0:15 |
| A2 | Real delete refused, files survive | 4s | 0:30 |
| B | Grok + ChatGPT catch an off-by-one | 5.4s | 0:40 |
| C | Advisor down, work proceeds, gap named | 3.8s | 0:35 |
| D | Every refusal written down | 2s | 0:20 |
| | **Total** | **~18s** | **~2:20** |

Leaves 20–40 seconds of headroom for an intro and a close inside your 3:00 target —
under your DairyForge 3:45.

---

# OPTIONAL FIFTH BEAT — THE GOVERNANCE GATE
*Only if you have room. Verified tonight, 5.9 seconds. It is a strong beat but it is the
subtlest one, and Beat C already carries the "it tells you the truth" idea.*

**Type:**
```powershell
git diff | helmion review --summary "add totalWeightLb helper and a loads.weight_lb column" --schema
```

**Real output (verified):**
```
Tier B: schema/migration change

  [FLAG] grok     CONCERN
         Summary asserts a loads.weight_lb column addition but diff contains only
         the JS helper with no schema/migration changes
  [ -- ] gemini   no verdict
  [ ok ] chatgpt  APPROVED
         The code correctly adds a helper function ...
         cite: dispatch.mjs:8-14

REFUSED — TIER B — a human decides this one. Reasons: schema/migration change.
No advisor can clear a schema, production-data, authentication or cross-project change.
```

**You say:**
> "ChatGPT approved this one. It's still refused — because it touches the database
> schema, and no AI clears a schema change. A human does. And notice Grok caught
> something else: my summary claimed a database column that isn't in the diff. It called
> me on describing work I didn't do."

---

# FAILURE MODES — what to do if it goes wrong on camera

| What happens | Why | What you do |
|---|---|---|
| **Guard says `allowed:true` on the delete** | You typed the JSON wrong — most likely single `\` instead of `\\` inside the JSON string | **The files get deleted.** They are throwaway invoices in `C:\helmion-demo`, nothing real is lost. Re-run the SETUP block and go again. This is exactly why the demo folder is sacrificial. |
| **`helmion : command not found`** | npm link is not active | `cd E:\Helmion; npm link` then reopen the terminal. Verified path today: `C:\Users\troyh\AppData\Roaming\npm\helmion.ps1` |
| **Review hangs past ~20 seconds** | An MCP server is spawning slowly or a model is throttled | Let it run — the timeout is 120s per advisor and they run in parallel (`src/core/advisory-runner.mjs:176`). If you cut, say *"one of them is slow — and notice it isn't blocking me"*, which is the honest read. Ctrl-C and re-run; it was 3.4–11.0s on every run tonight. |
| **All three advisors return `no verdict`** | Network down, or all three keys exhausted | Output will read `ALLOWED — No advisor was reachable. Nothing was caught, and nothing was checked`. **That is a legitimate beat if you want it**: *"Nothing checked this, and it told me so in those words."* But Beat B is lost — reshoot later. |
| **Beat B: nobody catches the bug** | Model nondeterminism | Did not happen in 4 runs, but if it does: re-run the same command once. If it passes twice, cut Beat B and do not fake it. |
| **Beat C: an advisor flags the clean helper** | Model nondeterminism | Did not happen in 4 runs. If it does, you get `REFUSED` instead of `ALLOWED`. Say *"and there's the tripwire again"*, then re-run to get the clean take. |
| **Ledger prints `No block events`** | You are in the wrong directory | `Set-Location C:\helmion-demo`. The ledger is per-workspace at `<cwd>\.helmion\audit\` (`src/core/audit-log.mjs:124`). |
| **Ledger prints `! N UNREADABLE line(s)`** | A torn write | Exits non-zero by design — a ledger that can't be fully parsed is not clean evidence. Delete `.helmion\audit\` and redo Beat A. |
| **Your own hooks interrupt you** | You are filming inside Claude Code | Close it. Film in a plain PowerShell window. |

---

# WHAT IS REAL — the honesty ledger for this script

Everything in this table was checked tonight against the code and against a live run.
**Nothing in the four beats is staged.**

| Claim in the demo | Verified how | Status |
|---|---|---|
| Guard refuses destructive commands | Ran it; exit 2; `bin/helmion.mjs:748`, patterns at `src/core/governance.mjs:3-38` | ✓ |
| The delete genuinely does not execute | Ran the `&&` chain against 3 real files; all 3 present afterward | ✓ |
| Guard allows harmless commands | `echo` → `allowed:true`, exit 0 | ✓ |
| Every refusal is written to a durable ledger | `helmion audit list` read back both refusals with full text; `src/core/audit-log.mjs:124` | ✓ |
| One advisor catching a real bug stops the change | Grok `BLOCK` + ChatGPT `CONCERN`/`BLOCK` → `REFUSED`, 4/4 runs; `src/core/advisory-loop.mjs:285` | ✓ |
| The bug is real, not a strawman | Measured: 10 loads, size 4 → 8 delivered, 2 dropped | ✓ |
| Silence does not block | `ALLOWED` + `NOT CHECKED BY: gemini — coverage was 2/3`; `src/core/advisory-loop.mjs:298` | ✓ |
| Tier B refuses regardless of advisors | ChatGPT `APPROVED`, still `REFUSED`; `src/core/advisory-loop.mjs:273` | ✓ |
| Gemini's silence is a real outage, not staged | Direct MCP probe returned live `429 RESOURCE_EXHAUSTED` | ✓ |
| Pulling a key produces a real, recorded gap | Journal shows `ERROR: GEMINI_API_KEY not set`, uncounted | ✓ |
| Write lease refuses a second writer | Two separate node processes: `session-two: REFUSED — LeaseHeldError`; `src/core/lease.mjs:208` | ✓ (not filmed — see below) |

## Deliberately NOT in this script, and why

- **The Pilot's guard card.** You asked for nothing on your screen from me, so I never
  launched the desktop app. The card's self-proving probe is reproduced in Beat A1 as the
  same two commands through the same code path. **[UNVERIFIED]** that the card *renders*
  it correctly today — I did not run the WPF app.

- **The write lease, as a filmed beat.** It works — two processes, second one refused,
  proven above. But there is **no `helmion lease` CLI command** (checked every command in
  `bin/helmion.mjs:1311-1360`), and `LEASE_REQUIRED_TOOLS` is `{write_file, run_command}`
  — the *agent runtime's* tool names, not Claude Code's (`src/core/governance-gate.mjs:58`).
  Filming it means running a node script against `acquireLease`, which looks like a lab
  bench, not a product. **Cut deliberately.** Bring it back when there's a CLI verb.

- **The guard blocking Claude Code live, in-session.** This would be the single best
  demo — you type a delete in plain English and Helmion stops the agent. `hooks/pretooluse.ps1`
  exists and is correct. **But it is NOT installed in your settings.json today** — I read
  the file; your three personal hooks are registered, Helmion's is not. Installing and
  testing it is a real change to your config, so I did not make it. **If you want this beat,
  say so and test it off-camera first.**

## Two things that need a live API key

Beats **B**, **C** and the optional Tier B beat call Grok / ChatGPT / Gemini through the
MCP servers in `~/.claude.json`. `XAI_API_KEY` and `OPENAI_API_KEY` were present and
working tonight; `GEMINI_API_KEY` is present but the account is out of credit.

**Offline fallback:** Beats **A** and **D** need no network and no key at all. The guard
is pure local pattern matching and the ledger is a local file. If the internet dies at the
shoot, film A and D — that is still a complete, honest 1:05 demo of the Execution Guard.

---

*Script built and verified 2026-07-30. Demo fixtures live in `C:\helmion-demo` (created
by the SETUP block); nothing in this script writes to the Helmion repo.*
