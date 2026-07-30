# Reference — Overstory / Jaymin West (prior art, NOT a plan)

**Status: KNOWLEDGE ONLY. Nothing here has been built, and nothing here is a
decision.** Troy's instruction, 2026-07-30, verbatim: *"I'm not wanting you to
build anything. I'm wanting to have it as knowledge for if and when we need it.
Okay? Don't switch. Don't pivot. Don't build anything. That is all for knowledge
and not for right now."*

If a future session reads this and starts implementing from it, that session has
misread the file. This is a filing cabinet, not a backlog.

Captured 2026-07-30. Every claim below carries its source; anything uncited is
marked so.

---

## What it is

**Overstory** — https://github.com/jayminwest/overstory — MIT, ~1.3k stars.

README, quoted: *"Multi-agent orchestration for AI coding agents"* that *"turns a
single coding session into a multi-agent team by spawning worker agents in
isolated git worktrees, coordinating them through a custom SQLite mail system,
and merging their work back with tiered conflict resolution."*

**CORRECTED 2026-07-30 after a deeper read.** An earlier draft of this file
guessed that Warren might be Overstory's predecessor. It is not. They are **two
separate, concurrent projects by the same author, doing different jobs**:

| | Warren | Overstory |
|---|---|---|
| What | *"a self-hostable control plane for ephemeral coding agents"* | *"Multi-agent orchestration for AI coding agents"* |
| Shape | one run, sandboxed, pushes a branch, exits | many agents, coordinated, worktrees + mail bus |
| Tagline | *"The Coolify of coding agents"* | — |

Warren is the **run substrate**. Overstory is the **manager**. Reading either as
the other's replacement is a mistake this file made once already.

## The demo that prompted this

Video: *"I Built a Self-Improving Agent Swarm. It Rewrote Its Own Code."*
https://youtu.be/97irLVqYJCI · 14.5 minutes · channel https://youtube.com/@jaymin-west

Description, quoted verbatim:

> I turned my AI agent swarm, "Overstory," inward to code on itself. The results?
> In just one hour, 21 different agents—coordinated by a single orchestrator—
> completed 9 issues and merged 26 commits into the main branch.
>
> I only sent one prompt.
>
> ... You'll see the Coordinator agent delegate tasks to Team Leads, who spawn
> Builders and Reviewers. You'll even watch the system "wake up" to a new review
> protocol it implemented during the run, effectively improving its own code in
> real-time.

Also linked from that description:
- Beads (issue tracking built for agents) — https://github.com/steveyegge/beads
- Free "Agentic Engineering" book — https://jayminwest.com/agentic-engineering-book
- Newsletter — https://jaymin-west.beehiiv.com

## The hierarchy

| Tier | What it does |
|---|---|
| Orchestrator | multi-repo coordinator of coordinators |
| Coordinator | persistent, at project root; decomposes objectives and dispatches |
| Supervisor / Lead | manages worker lifecycle |
| Workers | Scout (read-only exploration), Builder (implementation), Reviewer (validation), Merger (branch specialist) |

## The four mechanisms

1. **One isolated git worktree per agent** — *"no file conflicts between agents."*
   Conflict prevention at the filesystem level rather than by convention.
2. **A custom SQLite mail system** — WAL mode, *"~1-5ms per query"*, typed
   protocol messages, for inter-agent communication.
3. **A FIFO merge queue with 4-tier conflict resolution** — work returns in
   order.
4. **Tool-call guards and instruction overlays**, mechanically enforced:
   *"Guards block file modifications for non-implementation agents and dangerous
   git operations for all agents."*

## His own warning, quoted

> Do not deploy Overstory without understanding the risks of multi-agent
> orchestration — compounding error rates, cost amplification, debugging
> complexity, and merge conflicts are the normal case.

Worth more than the architecture. An author with 1.3k stars saying the failure
modes are *the normal case* is the most useful sentence in the repo.

## How this sits next to Helmion — observation only, not a plan

Overstory has worktree isolation, a mail bus, a merge queue and tool guards.

Helmion has a **database-enforced single-writer lease** (`src/core/lease.mjs`,
maestro leases) and an approval / stoplight layer. A prior competitive audit in
this repo recorded that no product in its comparison set had that lease.

These are different layers: a mail bus is *coordination*; a lease is
*enforcement*. Nothing follows from that observation — it is written down so a
future session does not have to rediscover it.

Helmion's `SESSION_BOARD.md` currently prevents collisions by asking agents to
claim files in a markdown table. Overstory prevents them with a worktree per
agent. That contrast is the single most transferable idea here.

## Not established

- Whether Overstory replaced Warren, or they coexist.
- How one prompt is decomposed into nine issues.
- Whether Beads is the work queue, or something else is.
- What the isolation boundary actually is beyond the worktree (network,
  credentials, env vars).
- Whether it has approvals, an audit log, MCP support, or named/resumable
  sessions.

A deeper read was in flight when this was filed; if it landed, its findings
belong appended below rather than replacing anything above.

---

# APPENDED 2026-07-30 — Warren, deep read

**Sourcing caveat, carried forward honestly:** README and the release JSON were
read raw (`raw.githubusercontent.com`, `api.github.com`). Quotes from `SPEC.md`
and `ROADMAP.md` came back through a fetch-extraction model rather than eyes on
raw bytes — treat those as **one-source-verified, not double-checked**.

## What Warren is

README, verbatim: *"Warren is a self-hostable control plane for ephemeral coding
agents. It is harness-agnostic — run pi, Claude Code, and other agents behind one
interface — on your own infrastructure with your own API keys. Every run is
short-lived and sandboxed. A run completes a task, validates the changes, pushes
a branch, and exits. One container, one volume, one HTTP API, one UI."*

MIT · 180 stars · 49 forks · 1,776 commits · latest **v0.12.2**, published
2026-07-28. Status: *"Stable (0.12.2), running on GKE in continuous use against
real GitHub repos."* 37 acceptance scenarios in `scripts/acceptance/`.

Its own release notes are unusually candid: *"This is the first buildable 0.12
release. v0.12.0 and v0.12.1 are tagged but have no container image — each hit a
different build failure."*

## The run lifecycle — six stages

`resolve agent → provision burrow → seed the burrow → dispatch → stream → reap`

*"the agent commits inside the sandbox; reap pushes from the host."* Output to
the user is **a pushed git branch**, then a generated PR body.

Components: `src/supervisor/main.ts` (container entrypoint), `src/runs/`,
`src/runtime/` (a `RuntimeProvider` contract with local and k8s implementations),
`src/burrow-client/`, `src/server/`, `src/db/` (drizzle + bun:sqlite), `src/ui/`.

## Isolation, and what crosses the boundary

Two stories. Local: *"every run gets a fresh `bwrap`-isolated workspace… The host
is unreachable."* k8s: *"the pod boundary is the sandbox instead."* Sandboxing is
delegated, not owned — SPEC non-goal: *"Not a sandbox. The runtime owns
isolation."*

Two things worth knowing before admiring it:

- The **outer container is deliberately weakened** — `apparmor=unconfined`,
  `seccomp=unconfined`, `systempaths=unconfined`, `--cap-add SYS_ADMIN`, and
  *"Remove any one of them and sandbox provisioning fails."*
- **Credentials cross into every run**: `ANTHROPIC_API_KEY` and a shared,
  long-lived `GITHUB_TOKEN`. Per-run GitHub App tokens are roadmap item R-18,
  unshipped. Warren↔runtime is *"Trust-the-socket… burrow's unix socket has no
  auth."*

## Multi-agent: concurrent but UNCOORDINATED

*"Each run gets its own burrow"*, and there is **no shared state, no lease, no
lock between runs**, and no global queue or admission control in the local V1.
The only cross-run coordination is plan-runs: *"Warren walks the plan's children
one at a time, spawns one run per child, and gates each on the previous PR
merging."* The supervisor is a process babysitter, not a semantic orchestrator.

## What Warren deliberately does NOT do

`ROADMAP.md` carries an explicit **"Deliberately Not In Core"** table:

| Item | Reason quoted |
|---|---|
| R-15 MCP server management | *"MCP servers are project tooling that the agent starts inside sandbox"* |
| R-16 Audit log | *"core table would duplicate data"* |
| R-17 Per-user spend budgets | per-run cost caps stay in core |
| R-14 Cross-project activity feed | not-in-core |
| R-04 Issues UI | *"Warren keeps no issues table"* |

Plus *"Not a multi-tenant SaaS"*, *"Not a coding agent"*.

Permissions today: *"Single bearer token. No rotation, no expiry, no
revocation."* SSO is R-09, planned only.

**Approvals, human-in-the-loop, policy engine, RBAC: no mention found in README,
SPEC or ROADMAP. Recorded as ABSENT, not as declined-in-writing** — the
difference matters and is not being smoothed over.

## ⚠️ Warren's README and ROADMAP contradict each other

The README's roadmap section sells R-15 (MCP), R-16 (audit) and R-12 (remote
workers) as *"active frontier"*. `ROADMAP.md` files R-15/R-16/R-17 under
**Deliberately Not In Core** and lists R-12 under **Removed** (*"Superseded by
k8s runtime"*, v0.10.0). ROADMAP.md is the more specific source. **Do not read
the README roadmap as intent.**

## Session model

Runs are **machine-IDed, not named** (`run_*`, `ag_*`, `prj_*`). You *can*
address one: `POST /runs/:id/steer` — *"lands a message in the agent's inbox, and
the next turn picks it up"* — plus `/cancel`. Runs are **not resumable**;
single-shot, states `queued | running | succeeded | failed | cancelled`. There is
**no single cross-agent feed** (that is R-14, not-in-core). Under k8s, steering
degrades to a 5-second poll.

## The five ideas worth remembering

1. Six-stage composition where **reap pushes from the host**, not the sandbox.
2. **One NDJSON event log** that the UI, the CLI and HTTP clients all tail —
   `GET /runs/:id/events?follow=1`. One stream, three consumers.
3. **Steer-as-inbox-message**, picked up on the agent's next turn.
4. A swappable `RuntimeProvider` behind one contract (local / k8s).
5. `warren doctor` as a pre-flight check.

## The observation that matters most

Warren leaves out **every governance surface** — approvals, audit, policy,
per-user identity, MCP, and the single cross-agent feed — and most of them by
written decision rather than by omission.

That is Helmion's entire territory. On this evidence Warren is not a competitor
to a governed manager; it is the **run substrate underneath one**. Recorded as an
observation. **No decision follows from it, and nothing is being built.**

## His videos (9 found; ordering unconfirmed)

Channel page would not render for automated fetch, so these came from search
listings — **dates are snippet-derived and unverified**, and this is not a
confirmed "most recent 10".

| Title | Link |
|---|---|
| Agents Are An Environment Problem | `watch?v=aUNSTO6rED0` |
| What Autonomous Software Development Looks Like — *the Warren demo the README links* | `watch?v=daa7y8g9BkM` |
| The Agentic Engineering Meta | `watch?v=K7nY3MUzDuk` |
| Context Management for Agents at Scale | `watch?v=sYxkPwct0Ek` |
| Six Levels of Agentic Engineering | `watch?v=njRAmppPvFk` |
| How Top Engineers Stop AI Agents From Writing Slop | `watch?v=88FC685v7ac` |
| I Built a Self-Improving Agent Swarm. It Rewrote Its Own Code. | `watch?v=97irLVqYJCI` |
| The Reality of Agent Swarms | `watch?v=iNOcmjsCKKc` |
| I'm Open Sourcing The Cutting Edge of Agentic Engineering | `watch?v=95TEFWdo6Mw` |

## Still not established, after both reads

- Overstory's internals beyond its README — the hierarchy's actual files, how one
  prompt becomes nine issues, whether Beads is the queue, what its isolation
  boundary is beyond the worktree.
- Whether Overstory has approvals, audit, MCP, or named/resumable sessions.
