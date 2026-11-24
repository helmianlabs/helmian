# Helmian Hardening Plan — 50 → 1,000 Concurrent Agents

Status: PLAN ONLY (bite 1 deliverable, per Troy 2026-11-23 19:41 MT). No
structural production changes are made in this bite. Sequencing belongs to
Main. Target: ~1,000 concurrent agents, enterprise scale (hundreds of
human users, AT&T/Verizon class), latency held EVEN WITH Guard checks and
the approval path in the loop.

Evidence base: the 50-agent twin run of 2026-11-23 (repo 7e80ca58) —
numbers in the bite-1 report. Items marked [MEASURED] rest on that run;
items marked [CODE] rest on reading the code at 7e80ca58; items marked
[UNVERIFIED] have neither yet and carry their own verification step.

## Findings the plan answers (from bite 1)

1. [CODE+MEASURED] Channel config hard cap: serializeConfig throws at
   4,000 chars (src/cloud/envoy-agents.mjs). A channel tops out at ~26
   agents with rich custom agents, ~29 with lean ones — the advertised
   MAX_CHANNEL_AGENTS=50 is unreachable in one channel.
2. [MEASURED] Worker poll loop serializes on the slowest job: the runner
   (mirroring the production worker) awaits every job in a poll batch
   before polling again, so new-ask dispatch latency inherits the
   slowest in-flight reply delay.
3. [MEASURED] Poll cost is roughly O(recent messages × due-seat checks)
   per poll (post-fix shape from the Nov 13 504 work); at 20× agents and
   hundreds of tenants the per-poll query count is the first wall.
4. [MEASURED] Runner presence rejects custom-agent handles ("unknown
   provider") — custom seats have no presence/health signal; they ride
   their engine's gate entry.
5. [CODE] DB pools are small and uneven: live-admin pool max 5,
   tenant-agent-state pool max 3 unbounded queue (known residue from the
   Nov 13 fixes), sibling pools at 5, mesh pool 10. Neon server-side
   limits sit above these; the app pools throttle first.
6. [UNVERIFIED] Guard/approval overhead in the turn loop: plain-chat asks
   only pay classifySeatAsk (cheap, in the poll path). Typed actions pay
   the governance-kernel evaluation before dispatch, and approval-gated
   actions pay a human round-trip. Neither was measured at load in bite 1.

## The plan, in order

### Step 1 — Config storage off the message body [answers F1]
Change: store channel config in a dedicated column/table (or raise the
serialization ceiling with a deliberate, larger bound) instead of a
4,000-char message body; keep serializeConfig's shape, move its store.
Risk: config read/write is on every dispatch; a bad migration breaks
every channel's roster. Mitigate: dual-read (new store, fall back to
latest config message) for one release.
Verify: unit suites (root + the envoy tests) green; twin re-run of bite
1's stage 50 in ONE channel of 50 rich customs; then a 100-agent single
channel twin run.
Rollback: flip the dual-read flag back to message-body reads; the old
config messages are still written during the dual-write window.

### Step 2 — Worker loop: decouple poll from job completion [answers F2]
Change: the worker polls on cadence and runs jobs on a bounded
concurrency pool instead of awaiting the whole batch; claims (sql/091)
already make re-poll safe.
Risk: double-answering if claim semantics differ under real provider
latency; ordering of replies within a round gets looser.
Verify: twin runs at 50/100/200 with the scoreboard's duplicate-author
check (distinct authors per round == replies per round, zero dupes);
poisoned-session count stays zero.
Rollback: single env flag restores batch-await behavior.

### Step 3 — Poll path budget [answers F3]
Change: finish the Nov 13 line of work — bound every pool's queue with
deadlines (tenant-agent-state first), cut remaining per-poll round
trips, and add a per-tenant poll budget so one hot tenant cannot starve
others. Index the claim/answered lookups the poll path scans.
Risk: bounded queues turn overload into visible errors instead of slow
success — clients must handle retry-after.
Verify: twin run with 10 tenants × 50 agents mixed hot/cold; p95 poll
latency and error mix reported per tenant.
Rollback: pool/timeout settings are env-tunable; revert values, no
deploy needed.

### Step 4 — Presence for custom seats [answers F4]
Change: presence accepts custom handles scoped to the tenant (validate
handle ∈ tenant's channel configs) so every seat gets a health signal.
Risk: presence table growth at 1,000 seats × heartbeat cadence; keep
TTL-based expiry, no per-heartbeat history writes.
Verify: twin run — every custom seat shows presence; gate decisions use
it; heartbeat write rate measured.
Rollback: revert the validation widening; standard seats unaffected.

### Step 5 — Guard in the loop, measured [answers F6]
Change: first MEASURE, then tune: extend the harness with typed-action
asks (the actions envoy-actions.mjs classifies) so a twin run can put
numbers on (a) kernel evaluation latency per ask at 50/200/1,000 seats,
(b) approval-gated flow with a synthetic approver at fixed delay, so
the approval path's cost is a number, not a fear. Only then tune:
cache stable Guard decisions per (tenant, action class) where the
kernel allows, and keep evaluation off the poll hot path (evaluate at
ask-post time, carry the record with the message — the refusal-record
mechanism already rides message metadata).
Risk: caching a governance decision is a safety change, not a perf
change — it needs Troy's explicit sign-off per action class, and
refusals are never cached.
Verify: twin A/B — same load with Guard evaluation on the post path vs
the poll path; refusal correctness suite (a refused action dispatches
zero work) at load.
Rollback: evaluation placement is a code path switch; decision caching
ships behind a per-tenant flag, default off.

### Step 6 — Database headroom [answers F5]
Change: size app pools from measured per-tenant demand (bite-1 metrics:
peak connections and waits at 50), put PgBouncer (or Neon pooler) in
transaction mode in front of the memory/envoy databases, and set
statement timeouts uniformly.
Risk: transaction pooling breaks session-level features (advisory
locks, SET LOCAL patterns) — audit the code for them first.
Verify: twin run at 500 agents against the pooled endpoint; connection
count flat while throughput scales; error rate zero.
Rollback: connection string switch back to direct endpoints.

### Step 7 — The 1,000-agent proof run
Change: none — this is the gate. Twin (or staging tenant set) run:
20 tenants × 50 agents, staged 200/500/1,000, hold 30 min at 1,000,
with the Guard typed-action mix from step 5 included and the recording
+ isolation proof repeated (control tenant hash unchanged, cross-token
polls empty).
Pass bar: zero poisoned sessions, zero cross-tenant bleed, p95 turn
dispatch latency within the budget set from bite-1 numbers, Guard
refusals still absolute.
Rollback: it is a test; production is untouched by construction.

## What this plan deliberately does NOT do
- No production structural changes in bite 1 (per Troy's direction).
- No new accounts, no public posts, no charges.
- No Scribe anything — Scribe is a separate product and stays separate.
