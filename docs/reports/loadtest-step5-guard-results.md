# Step 5 results — Guard in the loop, measured

Bite 3 of the Helmian hardening plan (`HARDENING-PLAN-1000.md` step 5, design in
`STEP5-6-AUDIT.md` Half B). Measurement only: nothing was tuned, no Guard decision
was cached, no evaluation was moved, and production was never touched. Everything
ran on the twin (Hetzner loopback, port 8901, FREE-org loadtest-twin database,
test tenant `b92f61d3-247f-4b89-80e1-d2160f1d54c5`) in the verified tree at
bite-2 head (37c07a5 + 8505c11 on production 7e80ca5).

Run: 2026-11-23 evening MT (box clock 2026-11-24 ~03:5x–04:5x UTC).

## Refusal correctness — the headline verdict

**Held in every stage. Zero failures across 152 typed asks and 7,010 verified
seat replies.**

- 2,075 refusal replies (T0 20, T1 5, stage-50 850, stage-200 1,200), each one
  checked in the database: `metadata.guard` action type, verdict `refuse`, and
  tier match all equal to what the plan expected for that ask, and the body
  carries the Guard refusal text.
- Every refused ask dispatched **zero** work: not one non-refusal reply exists
  for any refused ask in any stage.
- Every allowed ask (chat control, file.write, send, both adversarial controls)
  got exactly one reply per seat from distinct authors — no duplicates, no
  missing seats, no unexpected refusals.
- Runner timing logs: zero job errors and zero poll errors in stages 50 and 200.
- Credential-vault invariants (approval stage): every approved resolve returned
  exactly the seeded password; every denied resolve returned HTTP 403 with
  `secretMaterial: 'not_returned'` and no credential field. Zero violations in
  80 sequential resolves plus the concurrency and instant-deny batches.

One ask was answered by a different layer before the Guard ever saw it — see
"Finding: the Helm KB answers ahead of the Guard" below. It is an ordering fact,
not a refusal failure: no work was dispatched and no credential existed or moved.

## (a) In-process kernel evaluation latency (microbenchmark)

Method: the real `classifySeatAsk` (src/cloud/envoy-actions.mjs) and
`evaluateSeatAction` → kernel `evaluateToolCall` (src/core/governance-gate.mjs),
imported from the twin's own tree, 300 warmup + 3,000 iterations per corpus
variant, on the box. Corpus: 9 entries covering all six action classes plus the
audit's two adversarial controls, 3 phrasing variants each (2 for the controls).
Every variant typed and decided exactly as the audit predicts, in both
conditions — the classifier's adversarial behaviour held (a credential noun
without an intent verb stays chat; "drop" without a destructible object stays
chat).

Condition A is the twin's real configuration (no promoted-rules file; the mesh
passes no workspace, so the rules tier is the empty set). Condition B adds a
synthetic workspace holding 12 promoted rules, one of which blocks.

| Class (variant range) | Classify p50 | Evaluate p50, A | Evaluate p95, A | Evaluate p50, B (12 rules) | Evaluate p95, B |
|---|---|---|---|---|---|
| chat (control) | 2.7–3.6 µs | 0.1 µs (never evaluated) | 0.2 µs | 0.1 µs | 0.1 µs |
| file.write → allow | 2.5–3.3 µs | 7.3–9.1 µs | 8.4–14.4 µs | 22.1–23.2 µs | 45.6–58.8 µs |
| send → allow | 2.8–3.6 µs | 7.3 µs | 22.6–29.0 µs | 21.2–23.6 µs | 30.8–45.8 µs |
| shell → refuse (write-lease tier) | 1.8–2.5 µs | 7.3–7.8 µs | 8.0–14.7 µs | 23.7–24.1 µs | 45.4–49.0 µs |
| file.delete, literal → refuse (destructive-pattern tier) | 0.6–1.7 µs | 3.8–5.9 µs | 4.1–10.6 µs | 3.7–6.0 µs | 3.9–10.4 µs |
| file.delete, plain → refuse (write-lease tier) | 1.7–2.2 µs | 7.3–7.7 µs | 7.8–15.7 µs | 23.7–24.4 µs | 44.2–49.0 µs |
| credential.resolve → refuse (vault posture, after gate allow) | 0.3–0.4 µs | 7.2–7.4 µs | 8.3–14.8 µs | 21.5–24.8 µs | 31.3–47.3 µs |
| adversarial controls (×2) → stay chat | 2.3–3.1 µs | 0.1 µs (never evaluated) | 0.1 µs | 0.1 µs | 0.1 µs |
| file.write naming the blocked target → refuse (promoted-rules tier, B only) | 2.7 µs | — | — | 23.0 µs | 48.8 µs |

Readings:

- The kernel is **microseconds** — three orders of magnitude below the poll
  path's per-cycle cost (121–179 ms median, below). Per-evaluation CPU is not a
  bottleneck at any measured scale.
- The destructive-pattern tier exits before the rules load, so literal deletes
  cost the same with or without a rules file (~4–6 µs). Everything that reaches
  the rules tier pays the per-call rules load: with 12 rules the evaluate p50
  roughly triples (7–9 µs → 21–25 µs). The kernel re-reads and re-parses
  `autonomy_rules.json` and compiles every rule's RegExp twice on **every**
  evaluation (code-confirmed in `loadPromotedRules` /
  `evaluateToolCall`). Still microseconds — the cost only matters multiplied by
  the re-evaluation counts in section (c).

## (b) Turn latency — typed asks vs the chat control

Method: asks posted through the owner's session road into real channels; seats
served by the bite-1/2 harness runner with synthetic lognormal reply delays;
latency measured from the driver's post timestamp to reply rows in
`envoy_messages` (first reply, and last reply = turn completion). Chat asks are
the control: identical path, never Guard-evaluated.

### Stage T0 — typing verification at the surface (5 seats, 1 ask per corpus entry)

9/9 asks complete, zero assertion failures; live read-back of refusal metadata
matched the plan for every refused ask. Refusals landed in ~1.3 s (first poll
cycle). This stage gated all later stages.

### Stage 50 — one channel, 50 seats, 60 asks in the audit mix

Reply delay median 2 s, poll cadence 4 s. 60/60 complete, zero failures.

| Class | Asks | Turn (last reply) p50 | Turn p95 | First reply p50 |
|---|---|---|---|---|
| chat (control) | 24 | 12.58 s | 23.71 s | 3.08 s |
| file.write | 9 | 12.20 s | 17.14 s | 4.36 s |
| send | 6 | 10.90 s | 17.44 s | 2.87 s |
| adv-credential (typed chat) | 2 | 8.98 s | 13.09 s | 0.62 s |
| adv-drop (typed chat) | 1 | 17.94 s | 17.94 s | 4.70 s |
| shell → refused | 6 | 1.97 s | 3.83 s | = turn (one cycle) |
| file.delete-literal → refused | 6 | 0.49 s | 1.78 s | = turn |
| file.delete-plain → refused | 3 | 0.40 s | 0.51 s | = turn |
| credential.resolve → refused | 2 evaluated (+1 KB-answered) | 0.34 s | 2.19 s | = turn |

### Stage 200 — four channels, 200 seats, 80 asks in the audit mix

Reply delay median 2 s, poll cadence 4 s. 80/80 complete, zero failures. The
twin held 200 seats without breaking.

| Class | Asks | Turn (last reply) p50 | Turn p95 | First reply p50 |
|---|---|---|---|---|
| chat (control) | 32 | 12.89 s | 20.95 s | 2.96 s |
| file.write | 12 | 13.53 s | 20.05 s | 2.67 s |
| send | 8 | 11.58 s | 21.13 s | 2.35 s |
| adv-credential (typed chat) | 4 | 11.46 s | 15.57 s | 1.87 s |
| shell → refused | 8 | 2.45 s | 4.35 s | = turn |
| file.delete-literal → refused | 8 | 1.62 s | 3.51 s | = turn |
| file.delete-plain → refused | 4 | 1.47 s | 4.11 s | = turn |
| credential.resolve → refused | 4 | 1.37 s | 4.01 s | = turn |

Readings:

- **Allowed typed asks are indistinguishable from the chat control at both
  scales.** Guard overhead per allowed class (class turn p95 − chat turn p95):
  stage 50, file.write −6.6 s, send −6.3 s; stage 200, file.write −0.9 s,
  send +0.2 s. All inside the synthetic-delay noise. The Guard adds no
  measurable turn latency to allowed work at 50 or 200 seats.
- **Refusals close the whole ask in the first poll cycle that sees it** — all
  50 seats refused at once, turn p50 0.3–2.5 s across classes and stages,
  roughly 10–25× faster than an allowed turn, because no seat work is waited
  on. Refusal fan-out did not degrade at 200 seats (p95 ≤ 4.35 s).
- Poll cost (the runner's agent-work HTTP call): stage 50 p50 121 ms /
  p95 463 ms / max 505 ms over 170 polls; stage 200 p50 179 ms / p95 833 ms /
  max 887 ms over 80 polls. Growth with seats and channels is real but stays
  far under the 4 s cadence. (Stage-200 poll count is lower because four
  channels' work returns in the same calls.)
- Database pressure stayed flat: pg_stat_activity sampled every 2 s —
  stage 50 max 15 total connections / 2 active / 4 idle-in-transaction;
  stage 200 max 20 / 3 / 6. No pool distress at either scale.

## (c) Evaluations per message, and findings writes

Method: `guard_findings` sighting counts snapshotted before/after each stage.
One finding ingest happens per evaluation per due seat; re-sightings bump the
count on the seat's fingerprint row, so sighting deltas count evaluations
exactly.

- **Refusals: exactly 1 evaluation per message.** Every refused class in every
  stage measured 1.000 evaluations/message (e.g. stage 50: shell 300 sightings
  = 6 asks × 50 seats; deletes 450 = 9 × 50). The refusal replies answer the
  ask in the same cycle, so it never comes due again.
- **Allowed asks re-evaluate on every poll cycle until each seat answers.**
  Stage T1 isolated this: one file.write ask, 5 seats, reply delays ~45 s
  against a 4 s poll cadence. Per-seat evaluations: 10, 14, 12, 5, 15 —
  **56 evaluations (and 56 finding writes) for a single message, 11.2
  evaluations per message**, each seat's count tracking how long that seat
  stayed unanswered. The shell refusal posted in the same stage: exactly 1.
  At production-like reply speeds the effect nearly vanishes (stage 50:
  1.000 evaluations/message for every class; stage 200: 1.000 except
  file.write at 1.025 — 15 extra evaluations across 12 asks). The multiplier
  is a function of reply latency ÷ poll interval, measured at both ends:
  ~1.0 when seats answer within a cycle, ~11× when they take ~11 cycles.
- **Findings writes: one per evaluation per seat — 50 DB writes per typed ask
  at 50 seats**, before any re-evaluation multiplier. Across this bite the
  test tenant's findings grew 0 → 3,907 sightings (stage 50 +1,600, stage 200
  +2,215). Chat asks write none. The findings tail is also asynchronous: a
  snapshot taken the moment a stage's replies completed undercounted
  sightings that a later snapshot caught (T0 pre-report vs final), so the
  write load lands after the dispatch commit, spread over the following
  seconds.

## (d) Approval-path cost — credential vault with a synthetic approver

Method: the real credential service (`bin/helmion-credential-service.mjs`,
copied byte-identical into the twin tree, md5 557d9aa220242eea34803861cf8aabf5)
backed by the twin DB, its Guard gate pointed at a synthetic approver
implementing the gate's own protocol (POST /v1/decisions, GET
/v1/approvals/:id) with fixed delays and every 10th decision denied. One
password credential seeded in the test tenant (first store is ungated);
resolves driven with reason class `browser_sign_in` — the Guard-gated
password path. The service ran on port 8893 (8891 was already held by a
credential-service process that predates this bite and is not ours; left
untouched).

| Batch | Approver | Resolves | Approved | Denied | Approved latency p50 | p95 | Max |
|---|---|---|---|---|---|---|---|
| A | immediate (0 s) | 30 sequential | 27 | 3 | 80 ms | 89 ms | 112 ms |
| B | delayed 5 s | 30 sequential | 27 | 3 | 6,087 ms | 6,094 ms | 6,160 ms |
| C | delayed 30 s | 20 sequential | 18 | 2 | 30,166 ms | 30,411 ms | 30,411 ms |
| D | delayed 30 s, 20 concurrent | 20 | 20 | 0 (denials off) | 30,364 ms | 30,468 ms | 30,494 ms |
| E | immediate, deny-all | 3 sequential | 0 | 3 | — (all denied in 37–150 ms) | | |

Decomposition (batches A–D):

- **System cost with an instant approver: ~80 ms per gated resolve** (service +
  gate HTTP round trip + vault decrypt + DB). That is the floor the Guard's
  approval loop adds when the human is instant.
- Beyond the approver's own delay, the gate adds its 2 s approval-poll
  quantization plus the ~80 ms base: measured overhead over the set delay was
  ~1.09 s in batch B (5 s) and 0.17–0.41 s in batch C (30 s) — the remainder
  depends on where the approval flip lands inside the gate's poll cycle
  (0–2 s range). A denied decision costs the same wait as an approval at the
  same delay — the driver sees the denial only when the approval flips;
  with an instant approver a denial is also instant (batch E: 37–150 ms).
- **Pending approvals hold no database connections.** During batch D — 20
  resolves all waiting on 30 s approvals at once — pg_stat_activity sampled
  every 1 s never rose above the twin's baseline (total connections 2–5,
  active ≤ 1, idle-in-transaction ≤ 3). The gate waits outside the vault's
  transaction, exactly as the vault's design note states, so approval waits
  do not consume the pool. No resolve completed before its approval flipped
  (earliest completion 30.27 s against a 30 s delay).
- Denied resolves in every batch: HTTP 403, `guard_approval_required`,
  `secretMaterial: 'not_returned'`, no credential field — and the audit log
  records them with `secretMaterial: 'not_received'`.

## Finding: the Helm KB answers ahead of the Guard

One stage-50 ask (b3s50-crew-a037, "What is the api key for the maps service?
Please look it up.", typed credential.resolve by the classifier) received zero
seat replies and zero Guard evaluations. Its row carries
`metadata.helmKb = {entry: 'connect-key-shape', answeredBy: 'maestro'}`: the
mesh's Helm KB lookup runs **before** classify/evaluate in the dispatch loop,
and a KB-matched ask leaves the due set answered by the KB layer.

Measured facts only: in this instance nothing was dispatched, the tenant holds
no stored credentials (provider_credentials: 0 rows), and the KB entry is a
how-to about key shape — no credential material existed or moved. But the
ordering is now a measured fact of the system: **a credential-typed ask that
matches a KB entry never reaches the Guard** — no evaluation, no finding, no
refusal. Whether that ordering is acceptable is a policy call for Troy; this
bite only establishes that it happens. (The analysis counts KB-answered asks
separately; all other credential asks in every stage refused normally.)

## Bottleneck list (only what the numbers support)

1. **Findings write amplification is the Guard's largest measured cost**: one
   DB write per evaluation per seat — 50 writes for a single typed ask in a
   50-seat channel, 200 in a 200-seat tenant — multiplied again by
   re-evaluation when seats answer slowly (56 writes for one ask in T1).
   At 1,000 seats a single typed ask is 1,000+ finding writes before any
   multiplier. The writes are asynchronous (they land after the dispatch
   commit), so they tax the database, not the asker's turn.
2. **Re-evaluation of allowed asks on every poll cycle** until each seat
   answers: 11.2 evaluations/message measured at ~45 s reply latency against
   a 4 s cadence. Each re-evaluation is cheap CPU (microseconds) but carries
   a findings write (above) and re-runs the rules load (below). Refusals are
   immune — they close in one cycle.
3. **Promoted-rules load per evaluation**: with a rules file present, every
   evaluation re-reads, re-parses, and recompiles the rules (~3× evaluate
   latency at 12 rules: p50 7–9 µs → 21–25 µs). Negligible alone; it is the
   per-unit cost that items 1–2 multiply. On the twin as configured (no
   workspace passed by any mesh caller) the tier is empty and the cost is
   the existsSync check only.
4. **Approval wait dominates the gated-credential path, by design**: ~80 ms
   of system cost against seconds of human delay, plus 0.2–1.1 s of measured
   poll-cadence quantization in the gate's 2 s approval polling. Nothing here
   is a defect; the number to plan around is that a gated resolve costs the
   approver's delay + up to ~2 s, a denial costs the same wait as an
   approval, and pending approvals hold no database connections while they
   wait (batch D), so the wait does not tax the pool.
5. **Poll-cycle cost grows with scale** (p95 463 ms at 50 seats → 833 ms at
   200 seats for the agent-work call) but remains ~5× under the 4 s cadence;
   not a bottleneck at measured scale. Kernel evaluation CPU does not appear
   anywhere in the measured costs — it is microseconds against milliseconds
   everywhere else.

No tuning is proposed: per the bite's limits, any change (decision caching,
evaluation placement, rules loading, findings batching) is Troy's call per
action class, now that the numbers exist.

## What was NOT measured (UNVERIFIED)

- **500-seat and 1,000-seat stages.** The plan's staging rule was "200 if the
  twin holds 50 clean" — it did, and 200 is where this bite stops. The
  1,000-seat behaviour of every number above is UNVERIFIED; the findings-write
  and re-evaluation multipliers are the quantities that scale worst on paper.
- **Real promoted rules from a real tenant.** Condition B used a synthetic
  12-rule workspace; no production tenant's actual `autonomy_rules.json` was
  read or timed. UNVERIFIED for real rule counts and patterns.
- **Pool-internal wait time.** Only the agent-work HTTP duration and
  pg_stat_activity samples are observable from outside; how long individual
  mesh queries wait inside the server's pool is UNVERIFIED.
- **Real Guard approvals.** The approval path was driven by a synthetic
  approver implementing the gate protocol; the real Executive Guard's own
  decision latency (device push, human tap) is UNVERIFIED — batch A's 80 ms
  is the system floor under an instant approver, not a prediction of the
  real approval loop.
- **Real LLM seat latency.** Runner replies are synthetic lognormal delays;
  the re-evaluation multiplier at real model latencies (especially
  multi-minute first responses) is bounded by the T1 measurement (11.2× at
  ~45 s) but not measured at real-model values. UNVERIFIED beyond that.
- **The KB-matcher surface.** One KB collision was observed; how often real
  asks match KB entries ahead of the Guard was not measured. UNVERIFIED.
- **Worker-pool interaction.** Bite 2's bounded job pool serves the same
  channels; combined Guard + worker behaviour under the worker path (as
  opposed to the runner path used here) was not separately measured.

## Method notes

- Ask mix per stage follows the audit: chat 40%, file.write 15%, send 10%,
  shell 10%, file.delete-literal 10%, file.delete-plain 5%,
  credential.resolve 5%, adversarial 5% (mixSequence in the bite-3 corpus).
  Ask bodies are natural admin phrasings, each carrying the harness's
  `[loadtest-round:<id>]` marker; plans are generated by stamping every ask
  with the real classifier's output and failing the plan if it disagrees
  with the corpus table.
- Documented deviation: stage runners used a thin wrapper
  (`bite3/runner-wrap.mjs`) that forwards `jobConcurrency` to the harness
  runner core — `harness/runner.mjs` does not pass it, and its default of 8
  would have made the runner itself the bottleneck. Everything else (guard
  checks, timing log, reply path) is the harness's own code. Within-stage
  chat controls isolate the Guard's share regardless.
- Stage 50's driver lost its SSH session at ask 53 of 60 (the box and runner
  were unaffected; box load 0.07). The remaining asks were posted from the
  plan remainder; five asks were posted twice at the HTTP level, which the
  server's idempotency dedupe collapsed to the same message rows. Analysis
  ran on the deduplicated ask list (60 unique asks, first post timestamps).
- All bite-3 harness code lives in `~/workspace/helmian-loadtest/bite3/`
  (masters) and `/opt/loadtest-twin/bite3/` (box copies); stage artifacts
  (plans, ask lists, timing logs, findings snapshots, reports) are under
  `/opt/loadtest-twin/runs/bite3/{t0,t1,s50,s200,appr}/`.
- Cleanup: the twin server, runners, stand-ins, samplers, and this bite's
  credential service were stopped at the end of the bite. The substrate
  (test tenant, channels incl. the three new 50-seat channels, the seeded
  test credential, findings history) was left in the twin database, as
  bites 1–2 left theirs. The pre-existing credential-service process on
  port 8891 was not started by this bite and was left exactly as found.
