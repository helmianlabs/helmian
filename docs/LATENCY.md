# Helmian Governance & Security Latency Benchmarks

Measured on Troy's PC (`Windows 11`, Node.js `v24.14.1`, 200 runs per component, measured with high-resolution `performance.now()` timers). 

Date of Benchmark: **2026-11-22**

---

## 1. Measured Results (200 Runs)

| Component | Description | Median (p50) | p95 | Min | Max |
|---|---|---|---|---|---|
| **(a) `helmion guard` hook** | Full CLI round trip (spawns new Node process + stdin JSON pipe) | **69.750 ms** | **82.314 ms** | 62.719 ms | 94.047 ms |
| **(b) Governance gate** | In-process evaluator (`evaluateToolCall`, destructive rules + syntax) | **0.027 ms** | **0.053 ms** | 0.023 ms | 0.635 ms |
| **(c) Write lease check** | Local project mutual-exclusion check (`verifyLeaseHeld`) | **0.514 ms** | **0.898 ms** | 0.406 ms | 1.781 ms |
| **(d) Block log append** | Synchronous append to local JSONL ledger (`recordBlockEvent`) | **0.130 ms** | **0.201 ms** | 0.117 ms | 1.011 ms |
| **(e) Executive Guard** | Localhost HTTP decision with Ed25519 signature verification (`/v1/decisions`) | **0.831 ms** | **1.627 ms** | 0.635 ms | 23.788 ms |
| **(f) ABAC server check** | Cloud ABAC evaluation + Neon Postgres transaction & audit persistence | **409.204 ms** | **452.654 ms** | 378.248 ms | 536.991 ms |

---

## 2. Analysis & Bottleneck Identification

1. **Process Start Overhead Dominates Local PreToolUse Hooks (99.96% of time):**
   - The in-process governance evaluation is extraordinarily fast (**0.027 ms** median, or 27 microseconds).
   - In contrast, invoking `helmion guard` via Claude Code's PreToolUse hook (`hooks/pretooluse.ps1`) spawns a fresh Node.js instance on every single tool call, taking **69.75 ms** median.
   - V8 runtime boot, module resolution, and standard I/O pipe setup account for ~99.96% of the hook latency.

2. **Local Governance Primitives Are Under 1 Millisecond:**
   - Write lease inspection (`lease.json` lock check): **0.51 ms** median.
   - Audit append (`blocks-YYYY-MM-DD.jsonl` atomic append): **0.13 ms** median.
   - Executive Guard local decisioning and Ed25519 cryptographic signing: **0.83 ms** median.

3. **Cloud ABAC Persistence Overhead:**
   - Evaluating `authorizeTenantAction` in memory is sub-millisecond, but persisting an immutable receipt to `helmion.audit_events` with tenant membership validation across the network to Neon Postgres takes **409.20 ms** median.
   - This overhead is appropriate for server-side control-plane operations, but should remain asynchronous or cached for high-frequency interactive tool execution.

---

## 3. Fast-Path Proposal: Long-Running Local Guard Daemon

Because process boot time is the overwhelming bottleneck for `helmion guard` (70 ms vs. 0.027 ms), we propose introducing a lightweight, long-running local guard daemon.

### Architecture

```
[Claude Code / Agent Hook]
           │
           │ (1) Send tool JSON over local pipe (Named Pipe / Unix Domain Socket)
           ▼
[helmion-guard-daemon (Always-on Node worker)]
   ├── In-process rule compilation & cache (0.027 ms)
   ├── In-process write lease inspector (0.51 ms)
   └── Append-only block ledger sink (0.13 ms)
           │
           │ (2) Returns verdict: { allowed: true/false } (~1-2 ms total)
           ▼
[Hook resumes execution immediately]
```

### Protocol & Fallback
- **Transport:** Windows Named Pipe (`\\.\pipe\helmion-guard`) on Windows, Domain Socket (`/tmp/helmion-guard.sock`) on macOS/Linux.
- **Fail-Closed Fallback:** If the daemon is not running or fails to answer within 20 ms, the PreToolUse hook falls back to executing the standalone `helmion guard` process. Safety invariants are never compromised.
- **Projected Latency Reduction:** Drops hook latency from **~70 ms** down to **~1.5 ms** per tool call (a ~45x speedup for interactive coding sessions).
