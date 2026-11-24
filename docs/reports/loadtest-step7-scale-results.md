# Step 7 — The 1,000-Agent Proof: Results

Run 2026-11-24, ~05:41–06:20 UTC (22:41–23:20 MST Nov 23), on the loadtest twin:
loopback app on the Hetzner box port 8901 against the FREE-org loadtest-twin Neon
DB (pooler endpoint for the app, direct endpoint for verification reads), code at
repo HEAD `d83764a` (bites 1–5 all in). One worker process per tenant (the proven
shape — see the standing constraint at the end).

## Verdict

| Stage | Seats | Result |
|---|---|---|
| 200 (4 tenants × 50) | 200 | **PASS** — every bar item met |
| 500 (10 tenants × 50) | 500 | **PASS** — every bar item met |
| 1,000 (20 tenants × 50) | 1,000 | **FAIL** — chat dispatch wedged; stopped here per the rule |
| 30-minute hold at 1,000 | — | **NOT RUN** — the stage in front of it went red |

Guard refusals were absolute at every stage including the failed one (2,000/2,000
at stage 1000). Tenant isolation was perfect at every stage including the failed
one (control md5 byte-identical, all cross-tenant checks passed, zero bleed).
Zero duplicate answers at every stage — bite 5's dispatch fix held even inside
the failure. What failed is narrower and more useful than a collapse: at 1,000
seats, reply posts began timing out on database connections, and a second
defect — the dispatch read only looks at a channel's latest 40 messages — made
those transient failures permanent. Details and code citations below.

## Stage 200 — PASS (window from 2026-11-24T05:45:05Z)

Per tenant: 3 chat asks + 1 credential probe + 1 shell probe, 50 seats each.

- Asks complete: **20/20**. Replies: **1,000** = 600 chat (exactly 50 per ask,
  50 distinct authors per ask) + **400 Guard refusals** (50 per probe, refusal
  metadata verified per reply: Guard record present, verdict `refuse`,
  action class and match exact — `credential.resolve`/`password` and
  `shell`/`run`).
- Duplicates: **0** (600 dispatch events, max 1 per provider|message).
- Job errors: **0**. Poll errors: **0**.
- Poll latency (164 polls): p50 **105 ms**, p95 175 ms, p99 864 ms, max 928 ms.
- Isolation: control tenant n=3, md5 **b53f6dcb99baa2177c739934b9409321** —
  byte-identical to the standing value. Cross-tenant set all-pass: every
  tenant's device token → next tenant's channel 404 `ENVOY_CHANNEL_NOT_FOUND`;
  every device token → control channel 404; member-bearer road sampled 403/404;
  control token → tenant 01 refused (see harness note 3).
- DB connections (pg_stat_activity sampler, direct endpoint): max **15** total,
  max 2 active, 0 idle-in-transaction.

## Stage 500 — PASS (window 2026-11-24T05:48:40Z–05:53:40Z)

Runners 1–4 kept running; runners 5–10 added. Fresh asks for all 10 tenants.

- Asks complete: **50/50**. Replies: **2,500** = 1,500 chat (50 per ask, 50
  distinct authors) + **1,000 Guard refusals** (metadata-verified as above).
- Duplicates: **0** (1,450 dispatch events inside the tight window, max 1 per
  key; the database proof covers all 1,500 dispatches exactly).
- Job errors: **0**. Poll errors: **0** in-window.
- Poll latency (593 polls): p50 **1,061 ms**, p95 1,420 ms, p99 3,210 ms,
  max 4,739 ms. The p50 rose ~10× against stage 200 — the poll is the scaling
  pressure point (each agent-work poll runs a dispatch transaction over 50
  providers; 10 tenants poll every ~4 s through the pooler).
- Isolation: control md5 byte-identical; cross-tenant set all-pass.
- DB connections: max **18** total, max 2 active, max **10 idle-in-transaction**
  during reply bursts (settles back after).
- Post-stage transient (recorded, self-recovered): 05:54:03–05:54:30Z, every
  runner logged 4 poll errors (`ENVOY_MESH_FAILED`); cross-tenant reads briefly
  returned 400 during the burst and were back to 404 by ~05:58. This was after
  the stage's proof completed (cross set passed at 05:53). An early-warning
  tremor of the stage-1000 failure, ~90 seconds before it.

## Stage 1,000 — FAIL (asks posted 2026-11-24T05:55:37Z)

Runners 11–20 added (20 total, 1,000 seats). Fresh asks for all 20 tenants:
100 asks, 5,000 replies expected.

**What held:**

- **Guard refusals absolute: 40/40 probe asks complete, 2,000/2,000 refusal
  replies**, metadata correct. Refusals are written inside the dispatch
  transaction on first evaluation; they never depended on the failing post
  path.
- **Zero duplicates, zero poisoned sessions:** 3,000 dispatch events = every
  seat dispatched exactly once (max 1 per provider|message). In the final
  record, every ask's reply count equals its distinct-author count — no seat
  ever answered twice, despite 824 failed posts and continuous re-polling.
- **Zero cross-tenant bleed:** control md5 byte-identical at stage end
  (n=3, b53f6dcb99baa2177c739934b9409321); all **48** cross-tenant checks
  passed in the final verifier pass.
- DB connections stayed bounded: max **19** total backends behind the pooler,
  max 3 active, max 10 idle-in-transaction. The pooler did not melt down; the
  queue formed on the client side (pool acquire). Twin CPU ~7% — never
  CPU-bound.

**What failed:**

- **Chat: 0/60 asks complete. 2,176 of 3,000 chat replies landed** (per-ask
  25–46 of 50). Replies flowed from 05:55:40Z to **05:57:40Z, then froze
  fleet-wide**. Snapshots at 06:03:20Z and 06:07:27Z both read exactly 2,176 —
  a stall, not slowness. Polls continued (3,280 in-window) and returned no
  work for the stalled asks for the remaining ~20 minutes observed.
- **Job errors: 824** — reply posts failed with `ENVOY_MESH_FAILED`. The
  arithmetic closes exactly: 3,000 dispatched − 824 failed = 2,176 landed.
- **Poll errors: 142** in-window. Poll latency during the storm: p95
  **4,954 ms**, p99 5,046 ms, max 5,130 ms — polls were hitting the 5-second
  connection bound (the overall p50 of 114 ms is post-stall empty polls).
- Twin log: **631 Guard findings writes failed** with `timeout exceeded when
  trying to connect` (the pg pool acquire timeout). By design those writes
  are fail-soft — "the evaluation outcome stands unchanged" — so refusals
  were unaffected; the same timeout on the reply-post path is not fail-soft.

**The failure chain, with the code:**

1. **Trigger — one shared pool saturates.** The mesh pool
   (`src/cloud/envoy-mesh.mjs`, `getPool`: max 10, `connectionTimeoutMillis`
   5,000 — the bite-4 bounds) is shared by agent-work polls, agent-message
   posts, and Guard findings writes. At 20 tenants the combined demand —
   20 × 50-provider dispatch transactions polling every ~4 s, reply posts,
   and bite 3's measured write amplification (every typed evaluation writes
   findings; stage 1000 opened with 2,000 refusal evaluations plus per-poll
   re-evaluations of allowed asks) — pushed connection acquisition past the
   5 s bound. Posts and findings writes began timing out together at
   ~05:56–05:57Z. (The per-consumer share of the saturation is not
   instrumented; see UNVERIFIED.)
2. **Wedge — the dispatch read window.** `agentWork` reads each channel's
   **latest 40 messages** (`envoy-mesh.mjs`, the lateral join
   `order by created_at desc, id desc limit 40`), and builds its
   answered-set **only from replies inside that window**
   (`
...[truncated 6094 chars]