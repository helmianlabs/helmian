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

The same author's earlier/related repo is **Warren**
(https://github.com/jayminwest/warren). Whether Overstory supersedes it is
**UNCONFIRMED** at time of writing.

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
