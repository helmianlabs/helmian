# Four always-on local jobs

Background work that runs on the local model (Ollama + `qwen3.5:4b`) instead of
a paid API. Zero API cost, silent, **off by default**.

They are built against `LOCAL_JOB_CONTRACT` (`src/agent/local-provider.mjs:336-342`),
which is the seam the local-routing work left for exactly this.

| Job | What it does | Entry point |
|---|---|---|
| triage | Labels an item "handle-locally" or "escalate" | `src/jobs/triage.mjs` |
| commit-message | Writes the *what changed* half of a commit message from a real diff | `src/jobs/commit-message.mjs` |
| log-monitor | Flags known Unity / session-log error patterns | `src/jobs/log-monitor.mjs` |
| dictation-summary | Compresses long voice dictation into a short note | `src/jobs/dictation-summary.mjs` |

## Turning them on and off

```
npm run jobs:start     # on  — detached, no console window, no notifications
npm run jobs:stop      # off
npm run jobs:status    # running? how many findings so far?
```

Nothing else starts them. There is no autostart entry, no service registration,
no login hook. `start` is the only thing that begins the loop.

Requires `HELMION_LOCAL_ENABLED=1` and Ollama listening on `127.0.0.1:11434`.
Both are read the same way the agent reads them (`loadHelmionEnv`, `env.mjs:93`).
To watch Unity projects, set `HELMION_UNITY_PROJECTS` to a semicolon-separated
list of project roots.

Findings are appended to `.helmion/jobs/findings.jsonl`. Nothing is printed, and
nothing pops up. Read the file when you want to; it will wait.

### One-shot, without the loop

```
node bin/helmion-jobs.mjs run triage    --input "fix the typo in the readme"
node bin/helmion-jobs.mjs run dictation --file  transcript.txt
node bin/helmion-jobs.mjs run log       --file  Editor.log
node bin/helmion-jobs.mjs run commit    --file  changes.diff --verification "npm test 346 pass 0 fail"
node bin/helmion-jobs.mjs once          # one full cycle in the foreground
```

## The three rules everything here is built around

**1. A 4B model is not smart, so nothing trusts its prose.** Every job declares a
schema. The reply is parsed (`extractJson`) and validated (`validateAgainstSchema`)
and anything that does not fit is discarded. There are only ever two outcomes: a
valid object, or nothing. Unknown keys the model invents are dropped rather than
rejected — a small model decorates its answers, and throwing away an otherwise
perfect result over an extra `confidence` field would be silly.

**2. Nothing can block.** Every call carries an `AbortSignal` built from
`provider.timeoutMs` (45 s, `local-provider.mjs:59`). No job throws at its caller;
every path returns a result object. If Ollama is off, every job returns
`{ok: false, skippedReason: 'local provider not configured'}` and the loop keeps
ticking at the same rate. No retry storm — each cycle tries once.

**3. The deny-list is reused, never re-typed.** `LOCAL_SAFETY_DENY`
(`local-provider.mjs:93-113`) is imported. Input matching money / credentials /
deletion / deploys / schema / governance is never sent anywhere — the fetch is
not even called (proven in `test/local-jobs.test.mjs`).

## Per-job notes worth knowing

### triage — the bias is one-directional
The two errors are not equal: wrongly escalating something trivial costs a few
tokens; wrongly keeping something hard costs a wrong answer on real work. So
**every** failure — no model, timeout, garbage JSON, deny-listed input — produces
`escalate`. There is no path through `triage.mjs` that turns "I don't know" into
"handle locally".

The verdict is a **label**, not an action. Nothing downstream dispatches on it
without a human or a frontier model in the loop.

### commit-message — the model cannot satisfy the QA gate
`hook_block_commit_qa.ps1:158` gates commits on the message containing
`qa|tested|verified|proof`, and the hook says it must "state what was actually
run and what it returned - not that it 'should' work" (`:176`).

A model reading a diff does not know what was run. If it were allowed to write
that line it would write a plausible one and the gate would from then on be
measuring nothing. So **`verification` is a required argument** and
`formatCommitMessage` throws without it. The model writes what changed; a caller
with real evidence writes what was proven.

Two more facts, read out of the hook rather than assumed:

- **Do not quote the `-F` path.** The hook finds the file with
  `(?:-F|--file)\s+(?!-\s)([^\s"']+)` (`:117`) — the capture class excludes
  quotes, so `git commit -F "C:\path\msg.txt"` matches nothing, no message is
  read, and the commit is **blocked** (`:170-178`) even though the file it
  refused to open had perfect evidence in it. Verified both directions on
  2026-07-29: unquoted → exit 0, same message quoted → exit 2.
  `writeCommitMessageFile` refuses to return a path containing whitespace.
- **Deletions need their own line.** QA wording alone does not clear a commit
  that removes tracked files; it also needs a literal `DELETES-FILES:` line
  (`:168`). `formatCommitMessage` adds one when told about deletions and refuses
  to invent the reason.

**Known limit, stated plainly:** because the deny-list is applied to the diff
text, this job declines any commit whose diff mentions credentials, deletion,
deploys, production or schema. Measured against real Helmion history (commit
`2e05f2d`): 3 of 5 per-file diffs were refused — on the strings `.env` and
`Production`. That is the safe behaviour and it is the contract working as
designed, but it means the job will silently no-op on a meaningful share of real
commits. Those still need a human-written message.

### log-monitor — the model does not decide what counts as an error
A monitor that flags everything gets muted, and a muted monitor misses the one
that mattered. So the decision is **deterministic**: `scanLogLines` is a pure
regex matcher — no model, no network, same answer every time. The local model is
only asked to add a one-sentence summary to lines the matcher already flagged.
It can never create a flag, never suppress one, and never re-rank severity.

The patterns are anchored to failure *shapes*, not the word "error". `/error/i`
fires on `Assets/Scripts/ErrorHandler.cs`, on `-logFile unity-error.log`, and on
`0 errors, 3 warnings`. Each pattern was written against its counter-example, and
those counter-examples are pinned as tests.

Identical errors are collapsed — one compile error repeats across four import
workers, and four identical alerts is how a monitor gets muted.

**Where Unity writes logs on this machine** (found by listing the directories,
not by assuming): `%LOCALAPPDATA%\Unity\Editor\Editor.log`, `Editor-prev.log`,
and `<project>\Logs\AssetImportWorker0..3.log`.

### dictation-summary — the summary is a pointer, not a replacement
The runner writes the summary **and** keeps the raw file (renamed `.done`).
Nothing here deletes a transcript. Speech-to-text mangles words, so a compressed
note must stay re-checkable against what was actually said.

On failure it returns **no summary** rather than falling back to "the first 300
characters" — a truncation that looks like a summary is worse than no summary,
because the reader cannot tell which one they got.

## Measured on this box, 2026-07-29

Real inputs, real model, through `bin/helmion-jobs.mjs`:

| Job | Input | Result | Latency |
|---|---|---|---|
| triage | "fix the typo in the readme…" | `handle-locally` / `simple-fix` | 14.3 s (cold start) |
| triage | "bridge test times out only when three sessions run at once…" | `escalate` / `complex` | 1.9 s (warm) |
| dictation | a real 1,884-char dictation | 600-char summary + 5 actions + 1 question | 7.4 s |
| commit | real diff from `2e05f2d` | `fix: Update comment in ProfileInstallerGuardChecks.cs…` | 4.3 s |
| log | `Editor.log:3191` + 9 benign lines | flagged 1, ignored 9 | 2.1 s |

Two things the validator did on real output, both by design and both visible in
the result: the dictation summary hit the 600-char cap and was truncated with a
trailing `…`, and one generated commit subject hit the 72-char cap the same way.
The marker is deliberate — a reader can see that a cut happened.

## Test coverage

`test/local-jobs.test.mjs` — 56 tests, no network (fetch and provider are
injected, so the suite runs on a machine with no Ollama). Most of them are
adversarial: garbage replies, half a JSON object, the right shape with a wrong
enum value, a timeout, an HTTP 500, a deny-listed input, a model that tries to
downgrade a critical finding, and a model whose malformed reply contains the
words "handle-locally".
