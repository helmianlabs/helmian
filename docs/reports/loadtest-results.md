# Helmian Load Test — Bite 1 Results (2026-11-23 evening MT)

Design: production code (helmianlabs/helmian @ 7e80ca58, the harness's
verified fresh pull) run as a loopback TWIN on the Hetzner box against
the FREE-org loadtest-twin Neon database. Production (helmian.cloud)
never touched — verified answering 200 after the run. Test tenant
2045ba19-674a-4e00-9409-093354ffc75a; control tenant
11463590-612d-49b8-8d72-f77c0cae860f. Harness:
~/workspace/helmian-room-build/loadtest-35/harness (Shape A synthetic
runner; one runner process serves all seats, production-shaped).

## Stage results

- Stage 10 (crew10, 10 seats, 1 round): 10/10 replies, DB-confirmed 10
  distinct authors. Poll p50 297 ms. Post p50 131 ms / max 214 ms.
- Stage 25 (crew25, 25 seats, 1 round): 24/25 in-round; the 25th seat
  (c25x03) was a slow-tail job still sleeping when the stage script
  stopped the runner (the script's reply counter included one stale
  crew10 reply — a leftover ask answered late by the muse seat, which
  also proved late answers land cleanly). The server still offered
  c25x03 its job afterward; no error anywhere. Counted as a
  test-harness timing artifact, not a product failure.
- Stage 50 (crew50 26 + crew50b 23 + crew50c 2 = 51 concurrent turns,
  50 distinct agent identities, 6 rounds): ALL 18 channel-rounds
  complete, 306/306 replies, DB per-ask check: distinct authors ==
  replies for every ask (zero duplicates, zero missing). Poll p50
  224 ms / p95 305 ms / max 305 ms, zero 504s, zero 5xx, zero network
  errors. Post p50 127 ms / p95 171 ms / max 262 ms. Zero job errors,
  zero poll errors → zero poisoned sessions.
- Round wall times 10–64 s per channel-round, set by the synthetic
  reply-delay distribution (lognormal median 8 s) and the worker's
  batch-await poll loop.
- Resources (44 samples, ~8 s cadence): twin cloud server RSS peaked
  ~105 MB; runner RSS ~91 MB; DB connections peaked at 8 total
  (sampler/driver connections included; the twin's own app pools cap
  at 5 + 3); active connections never sampled above 1 (short queries,
  sampling cadence caveat). Box load peaked 4.46 (shared box, includes
  production containers and the capture browser).

## Isolation proof
- Control tenant envoy_messages: 3 rows, md5 2c2cceb4584b6b5ed203237c4c459f4a
  BEFORE the runs and byte-identical AFTER.
- Control tenant's device token polling with test-tenant provider names
  returned work: [] before and after.
- Test tenant's owner token reading the control channel's config:
  ENVOY_CHANNEL_NOT_FOUND.
- No message in any test channel carries another tenant's data (all
  replies counted per-ask, per-channel, exact).

## Bottlenecks found (feed the 1,000-agent hardening plan)
1. Channel config 4,000-char cap (serializeConfig, envoy-agents.mjs):
   a channel holds at most ~26 rich custom agents (~29 lean) — the
   advertised MAX_CHANNEL_AGENTS=50 is unreachable in one channel.
   Stage 50 had to split across 3 channels for this reason.
2. Worker poll loop awaits the whole job batch before polling again:
   new-ask dispatch latency inherits the slowest in-flight reply
   (16 polls served 6 rounds × 3 channels at stage 50).
3. Presence endpoint rejects custom-agent handles ("unknown provider"):
   custom seats have no presence/health signal; 14 presence failures
   logged at stage 25, 50 at stage 50 (heartbeats for every custom).
4. Harness/API drift: the ask path now requires an idempotencyKey the
   harness's ask driver doesn't send (patched in the box copy only).
5. App DB pools are small and uneven (live-admin max 5, agent-state
   max 3 unbounded queue): at 50 agents they did not bind, but they
   are the first numbers that bind at 20× — see the plan.
6. Guard/approval overhead: NOT measured at load. Plain-chat asks pay
   only classifySeatAsk in the poll path; typed-action kernel
   evaluation and the human approval round-trip were not exercised
   by this harness. UNVERIFIED — the plan's step 5 measures it first.

## Cleanup
Both test tenants' operational data deleted from the twin database
(messages, channels, memberships, links, claims — verified 0 rows).
Two inert tenant shell rows remain because the append-only
audit_events table (5 rows) holds an FK to them and rejects mutation
by design; the audit guard was not bypassed. Twin server stopped.
Run artifacts kept: /opt/loadtest-twin/runs/ on the box and
~/workspace/helmian-loadtest/ here.

## Recording
~/workspace/helmian-loadtest/helmian-loadtest-50.mp4 — 22.3 s, 134
headless-Chrome frames of the live metrics dashboard captured during
stage 50, stitched at 6 fps. (Stitched stills, per the available
road — the browser-recording skill's live-browser path is not
available to a subagent.)
