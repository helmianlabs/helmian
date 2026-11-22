import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import pg from 'pg';

import { evaluateToolCall } from '../src/core/governance-gate.mjs';
import { acquireLease, releaseLease, verifyLeaseHeld } from '../src/core/lease.mjs';
import { LAYER, recordBlockEvent } from '../src/core/audit-log.mjs';
import { startGuard, action, nonce, DEVICE_TOKEN } from '../executive-guard/test-support/helpers.mjs';
import { authorizeTenantAction, persistTenantActionDecision } from '../src/cloud/tenant-action-authorization.mjs';

const RUNS = 200;
const HELMIAN_ROOT = path.resolve(import.meta.dirname, '..');
const HELMIAN_BIN = path.join(HELMIAN_ROOT, 'bin', 'helmion.mjs');
const HELMION_DATABASE_URL = process.env.HELMION_DATABASE_URL
  || 'postgresql://neondb_owner:npg_kAJDnzPv7K4E@ep-divine-leaf-ay38p1af.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  return { min, max, mean, p50, p95, count: samples.length };
}

function fmt(n) {
  return n.toFixed(3);
}

// ── (a) Full `helmion guard` hook round trip (process start + stdin/stdout) ──
async function benchGuardHook(runs) {
  process.stdout.write(`Benchmarking (a) helmion guard hook round trip (${runs} runs)... `);
  const payload = JSON.stringify({ tool_name: 'read_file', tool_input: { path: 'README.md' } });
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [HELMIAN_BIN, 'guard'], {
        cwd: HELMIAN_ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.write(payload);
      child.stdin.end();
      child.on('close', (code) => {
        const t1 = performance.now();
        samples.push(t1 - t0);
        resolve(code);
      });
      child.on('error', reject);
    });
  }
  console.log('done.');
  return stats(samples);
}

// ── (b) Governance gate in-process ──────────────────────────────────────────
async function benchGovernanceGate(runs) {
  process.stdout.write(`Benchmarking (b) governance gate in-process (${runs} runs)... `);
  const samples = [];
  const args = { path: 'README.md' };
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    evaluateToolCall({
      tool: 'read_file',
      args,
      workspace: HELMIAN_ROOT,
    });
    const t1 = performance.now();
    samples.push(t1 - t0);
  }
  console.log('done.');
  return stats(samples);
}

// ── (c) Write lease check ──────────────────────────────────────────────────
async function benchLeaseCheck(runs) {
  process.stdout.write(`Benchmarking (c) write lease check (${runs} runs)... `);
  const tmp = mkdtempSync(path.join(tmpdir(), 'helmion-lease-bench-'));
  let leaseToken;
  try {
    const acquired = acquireLease(tmp, {
      projectSlug: 'benchmark-project',
      coordinatorId: 'bench-agent',
      instanceId: 'bench-instance',
      durationSeconds: 300,
    });
    leaseToken = acquired.record.leaseToken;
    const samples = [];
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      const res = verifyLeaseHeld(tmp, { leaseToken });
      const t1 = performance.now();
      if (!res.held) throw new Error('Lease unexpectedly not held: ' + res.reason);
      samples.push(t1 - t0);
    }
    console.log('done.');
    return stats(samples);
  } finally {
    try { releaseLease(tmp, { leaseToken }); } catch {}
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── (d) Block log append ───────────────────────────────────────────────────
async function benchBlockLogAppend(runs) {
  process.stdout.write(`Benchmarking (d) block log append (${runs} runs)... `);
  const tmp = mkdtempSync(path.join(tmpdir(), 'helmion-audit-bench-'));
  try {
    const samples = [];
    const event = {
      layer: LAYER.EXECUTION,
      tool: 'run_command',
      workspace: tmp,
      payload: { command: 'rm -rf /' },
      matchedPattern: 'destructive-rm',
      reason: 'destructive pattern blocked',
      hits: ['rm -rf'],
      source: 'benchmark-runner',
    };
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      const res = recordBlockEvent(tmp, event);
      const t1 = performance.now();
      if (!res.logged) throw new Error('Block event failed to log: ' + res.reason);
      samples.push(t1 - t0);
    }
    console.log('done.');
    return stats(samples);
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// ── (e) Executive Guard decision on localhost, including signing ──────────
async function benchExecutiveGuard(runs) {
  process.stdout.write(`Benchmarking (e) Executive Guard decision on localhost (${runs} runs)... `);
  const guard = await startGuard();
  try {
    const samples = [];
    for (let i = 0; i < runs; i++) {
      const act = action({ summary: `bench action #${i}` });
      const n = nonce();
      const t0 = performance.now();
      const res = await guard.call('POST', '/v1/decisions', {
        token: DEVICE_TOKEN,
        body: { action: act, nonce: n },
      });
      const t1 = performance.now();
      if (res.status !== 200 || !res.body?.decision) {
        throw new Error(`Decision call failed: status ${res.status}`);
      }
      samples.push(t1 - t0);
    }
    console.log('done.');
    return stats(samples);
  } finally {
    await guard.close();
  }
}

// ── (f) One ABAC check against the server ─────────────────────────────────
async function benchAbacServer(runs) {
  process.stdout.write(`Benchmarking (f) ABAC check against server (${runs} runs)... `);
  const pool = new pg.Pool({
    connectionString: HELMION_DATABASE_URL,
    max: 5,
  });

  try {
    const actor = {
      tenantId: 'helmian-platform',
      subject: 'user_troy:desktop',
      role: 'owner',
      sessionId: `bench-session-${randomUUID()}`,
      requestId: `bench-req-${randomUUID()}`,
    };

    // Warmup query
    await pool.query('SELECT 1');

    const samples = [];
    for (let i = 0; i < runs; i++) {
      actor.requestId = `bench-req-${i}-${randomUUID()}`;
      const t0 = performance.now();
      const auth = authorizeTenantAction(actor, {
        action: 'workspace.project.write',
        tenantId: 'helmian-platform',
      });
      const receipt = await persistTenantActionDecision(pool, actor, auth);
      const t1 = performance.now();
      if (!receipt.durable) throw new Error('ABAC receipt not durable');
      samples.push(t1 - t0);
    }
    console.log('done.');

    // Note: helmion.audit_events is strictly append-only (reject_audit_event_mutation trigger enforces this).
    // Audit rows are preserved as valid benchmark proof receipts.

    return stats(samples);
  } finally {
    await pool.end();
  }
}

async function main() {
  console.log(`=== Helmian Latency Benchmark (${RUNS} runs per benchmark) ===\n`);
  const tStart = Date.now();

  const results = {
    guardHook: await benchGuardHook(RUNS),
    governanceGate: await benchGovernanceGate(RUNS),
    leaseCheck: await benchLeaseCheck(RUNS),
    auditAppend: await benchBlockLogAppend(RUNS),
    executiveGuard: await benchExecutiveGuard(RUNS),
    abacServer: await benchAbacServer(RUNS),
  };

  const totalSec = ((Date.now() - tStart) / 1000).toFixed(1);
  console.log(`\nCompleted all benchmarks in ${totalSec}s.\n`);

  console.log('┌────────────────────────────────────────────────────────┬───────────┬───────────┬───────────┬───────────┐');
  console.log('│ Benchmark Component                                    │ Median ms │   p95 ms  │   Min ms  │   Max ms  │');
  console.log('├────────────────────────────────────────────────────────┼───────────┼───────────┼───────────┼───────────┤');
  console.log(`│ (a) helmion guard hook round trip (process start)       │ ${fmt(results.guardHook.p50).padStart(9)} │ ${fmt(results.guardHook.p95).padStart(9)} │ ${fmt(results.guardHook.min).padStart(9)} │ ${fmt(results.guardHook.max).padStart(9)} │`);
  console.log(`│ (b) governance gate (in-process)                       │ ${fmt(results.governanceGate.p50).padStart(9)} │ ${fmt(results.governanceGate.p95).padStart(9)} │ ${fmt(results.governanceGate.min).padStart(9)} │ ${fmt(results.governanceGate.max).padStart(9)} │`);
  console.log(`│ (c) write lease check (local lockfile)                 │ ${fmt(results.leaseCheck.p50).padStart(9)} │ ${fmt(results.leaseCheck.p95).padStart(9)} │ ${fmt(results.leaseCheck.min).padStart(9)} │ ${fmt(results.leaseCheck.max).padStart(9)} │`);
  console.log(`│ (d) block log append (JSONL sync append)               │ ${fmt(results.auditAppend.p50).padStart(9)} │ ${fmt(results.auditAppend.p95).padStart(9)} │ ${fmt(results.auditAppend.min).padStart(9)} │ ${fmt(results.auditAppend.max).padStart(9)} │`);
  console.log(`│ (e) Executive Guard decision + Ed25519 signing (local) │ ${fmt(results.executiveGuard.p50).padStart(9)} │ ${fmt(results.executiveGuard.p95).padStart(9)} │ ${fmt(results.executiveGuard.min).padStart(9)} │ ${fmt(results.executiveGuard.max).padStart(9)} │`);
  console.log(`│ (f) ABAC authorization check + server DB persist       │ ${fmt(results.abacServer.p50).padStart(9)} │ ${fmt(results.abacServer.p95).padStart(9)} │ ${fmt(results.abacServer.min).padStart(9)} │ ${fmt(results.abacServer.max).padStart(9)} │`);
  console.log('└────────────────────────────────────────────────────────┴───────────┴───────────┴───────────┴───────────┘');

  // Output JSON for docs generation
  console.log('\nJSON_OUTPUT_START');
  console.log(JSON.stringify(results, null, 2));
  console.log('JSON_OUTPUT_END');
}

main().catch((err) => {
  console.error('\nBenchmark failed:', err);
  process.exit(1);
});
