#!/usr/bin/env node
// Auto-approve helper — FIXED BOUNDARY (FIX-A13; audit AT-1 test T4, 2026-11-16).
//
// This helper may decide exactly one class of Executive Guard approval:
//
//   device  credential-service
//   rule    credential-password-resolve-needs-approval
//   site    helmian-credential-service
//   signal  credential:password_resolve
//
// That is the vault's password-resolve ask during sign-in establishment —
// the one job the vault design says this helper exists for. Every other
// pending approval stays pending for a human, exactly as an undecided ask
// behaves: destructive file operations, credential replacements, asks
// carrying sensitive-content classes, every other device, everything else.
// All four fields of the class must match; any mismatch leaves the ask
// untouched (fail closed).
//
// It decides under its OWN approver principal (AUTO_APPROVE_PRINCIPAL,
// default "auto-approve") — never under a human's identity — so the
// Guard's audit trail distinguishes machine decisions from human ones by
// actor, not by a reason phrase. It reads that principal's token, and
// only that principal's token, from the live executive-guard container
// env. If the token is absent it refuses to run; it never falls back to
// a human's token.
//
// History: the previous version watched device hands-mcp with no class
// filter and decided under the `troy` identity (Troy's Nov 6 2026 order
// for Hands). AT-1 measured that boundary as device-shaped, class-blind
// and pointed at the wrong device: in the production trail it had decided
// 4,815 hands-mcp asks (destructive and sensitive-content asks included)
// and zero credential-service password resolves. The AUTO_APPROVE_DEVICE
// env the old service unit sets is therefore NOT honoured by this
// version; the class allowlist below is the only boundary. A startup
// warning names the env if it is set to anything else.
import { execFileSync } from "node:child_process";

const GUARD = process.env.GUARD_URL || "http://127.0.0.1:8787";
const POLL_MS = Number(process.env.AUTO_APPROVE_POLL_MS || 1500);
const PRINCIPAL = process.env.AUTO_APPROVE_PRINCIPAL || "auto-approve";
const REASON = process.env.AUTO_APPROVE_REASON || "auto-approve helper: credential-service password resolve (vault sign-in establishment)";

// The class allowlist. One entry: the vault's password-resolve ask.
// Adding a class is a deliberate code change to this list, reviewed like
// any other change to the approvals road — never an env edit.
const ALLOWLIST = [
  {
    deviceId: "credential-service",
    ruleId: "credential-password-resolve-needs-approval",
    site: "helmian-credential-service",
    signal: "credential:password_resolve",
  },
];

function inScope(approval) {
  const action = approval?.action || {};
  const signals = Array.isArray(action.riskSignals) ? action.riskSignals : [];
  return ALLOWLIST.some((cls) =>
    approval.deviceId === cls.deviceId &&
    approval.ruleId === cls.ruleId &&
    action.site === cls.site &&
    signals.includes(cls.signal)
  );
}

function helperToken() {
  const raw = execFileSync("docker", ["exec", "executive-guard", "printenv", "EXEC_GUARD_APPROVER_TOKENS"], { encoding: "utf8" }).trim();
  const row = raw.split(",").map((s) => s.trim()).find((s) => s.startsWith(`${PRINCIPAL}=`));
  if (!row) throw new Error(`approver token for this helper's own principal "${PRINCIPAL}" missing from executive-guard env — refusing to run rather than decide under a human's identity`);
  return row.slice(PRINCIPAL.length + 1);
}

async function listPending(token) {
  const r = await fetch(`${GUARD}/v1/approvals?status=pending`, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`list pending HTTP ${r.status}`);
  const body = await r.json();
  return Array.isArray(body.approvals) ? body.approvals : [];
}

async function decide(token, id) {
  const r = await fetch(`${GUARD}/v1/approvals/${encodeURIComponent(id)}/decide`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ approve: true, reason: REASON }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`decide ${id} HTTP ${r.status}: ${text.slice(0, 200)}`);
  return text;
}

if (process.env.AUTO_APPROVE_DEVICE && !ALLOWLIST.some((cls) => cls.deviceId === process.env.AUTO_APPROVE_DEVICE)) {
  console.error(JSON.stringify({ event: "auto-approve.warning", warning: `AUTO_APPROVE_DEVICE=${process.env.AUTO_APPROVE_DEVICE} is ignored: this helper's boundary is its class allowlist (${ALLOWLIST.map((c) => `${c.deviceId}/${c.ruleId}`).join(", ")}), not a device env`, at: new Date().toISOString() }));
}

let token = helperToken();
console.log(JSON.stringify({ event: "auto-approve.start", principal: PRINCIPAL, classes: ALLOWLIST.map((c) => `${c.deviceId}/${c.ruleId}`), guard: GUARD, pollMs: POLL_MS, at: new Date().toISOString() }));

const skipLogged = new Set();
for (;;) {
  try {
    const pending = await listPending(token);
    for (const a of pending) {
      if (!inScope(a)) {
        if (!skipLogged.has(a.id)) {
          skipLogged.add(a.id);
          console.log(JSON.stringify({ event: "auto-approve.skipped-out-of-scope", id: a.id, deviceId: a.deviceId || null, ruleId: a.ruleId || null, at: new Date().toISOString() }));
        }
        continue;
      }
      const summary = a.action?.summary || a.summary || "";
      try {
        await decide(token, a.id);
        console.log(JSON.stringify({ event: "auto-approve.approved", id: a.id, principal: PRINCIPAL, ruleId: a.ruleId, summary, at: new Date().toISOString() }));
      } catch (e) {
        console.error(JSON.stringify({ event: "auto-approve.decide-error", id: a.id, error: String(e.message || e), at: new Date().toISOString() }));
      }
    }
  } catch (e) {
    console.error(JSON.stringify({ event: "auto-approve.loop-error", error: String(e.message || e), at: new Date().toISOString() }));
    try { token = helperToken(); } catch (_) {}
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
