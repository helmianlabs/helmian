// The cloud vet client: stage 3's first layer for `helmion mcp-install`.
//
// The local stage 3 (mcp-sandbox.mjs) runs the candidate on THIS machine, as
// the invoking user, watched by an in-process observer. Its own header says
// what that is not: containment. The vet service on the Hetzner box runs the
// same stages 1–3 inside a disposable container (network none, read-only
// rootfs, cap-drop ALL, verified destruction) — the OS boundary the local
// run never had. This module submits the candidate to that service and
// returns its verdict as a pipeline stage.
//
// The vet service NEVER approves and NEVER installs; its strongest positive
// verdict is "vetted-clean-awaiting-human". Symmetrically, this client never
// manufactures a verdict: any failure to obtain one — service unreachable,
// busy past the deadline, refused, malformed answer — is reported as
// `evidence-missing`, and the pipeline treats that as a halt, never as a
// clean run. Missing evidence is not innocence; that rule is the desktop
// design's ("unknown never means safe") applied to the wire.
//
// Wire contract (the same one the Author lane's client uses):
//   POST {vetUrl}/vet   Authorization: Bearer <token>
//                       X-Vet-Intent: execute-foreign-code
//                       X-Vet-Candidate-Kind: mcp-server
//                       Content-Type: application/gzip   (raw .tar.gz body)
//   A 409 means a run is already in progress; retry with backoff inside the
//   deadline. GET {vetUrl}/runs/<runId> (Bearer) returns the full report.
//
// Guard decision (wiring bite 4b): when the requester is configured with an
// Executive Guard (HELMION_GUARD_URL + HELMION_GUARD_DEVICE_TOKEN), the
// submission ALSO carries
//                       X-Vet-Guard-Decision: base64 of the decision envelope
// — a per-run Executive Guard decision, recorded by the Auto Approver,
// bound to this candidate's fingerprint, obtained through the Guard client
// flow below BEFORE the candidate is submitted. Troy's ruling (2026-11-23,
// corrected 22:37 MT): these decisions are the Auto Approver's, acting under
// his standing owner authority — never a standing token alone, and never a
// human tap per run. The service verifies the envelope against its pinned
// Guard key and burns it single-use (bite 4a); this client checks the
// claims it can (audience, verdict, the recorded decider, the action hash,
// the nonce, expiry) before presenting it, so a Guard answer that is not an
// Auto Approver decision for THIS candidate never reaches the service. A
// denial, an expiry, or an unanswered ask is a hard stop reported as
// evidence-missing: the candidate is not submitted at all.

import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

export const DEFAULT_VET_URL = 'http://127.0.0.1:8197';
export const VET_CANDIDATE_KIND = 'mcp-server';
// The service's own upload cap (server.mjs readBody limit for /vet uploads).
export const VET_MAX_TARBALL_BYTES = 25 * 1024 * 1024;
const DEFAULT_DEADLINE_MS = 5 * 60 * 1000;

// The same directories the code read refuses to scan as first-party source
// (mcp-code-audit.mjs SKIPPED_DIRECTORIES). Shipping them to the vet would
// add megabytes the service's own stages would skip anyway.
const SKIPPED_DIRECTORIES = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'coverage', '.cache',
]);

// ── Tarball ─────────────────────────────────────────────────────────────────
// The repo carries no tar dependency, so this is a minimal ustar writer:
// regular files and directories, POSIX prefix splitting for long paths.
// Symlinks are never shipped as links — one that resolves INSIDE the
// candidate is shipped as the content it points at; one that points outside
// is skipped and recorded, because a link out of the tree is exactly the
// shape a tarball must not smuggle into the vet's extraction.

function ustarHeader({ name, mode, size, mtime, typeflag }) {
  let prefix = '';
  let shortName = name;
  if (Buffer.byteLength(name) > 100) {
    // Find the rightmost '/' that leaves name ≤100 and prefix ≤155.
    let splitAt = -1;
    for (let i = name.length - 1; i > 0; i--) {
      if (name[i] !== '/') continue;
      const tail = name.slice(i + 1);
      const head = name.slice(0, i);
      if (Buffer.byteLength(tail) <= 100 && Buffer.byteLength(head) <= 155) { splitAt = i; break; }
    }
    if (splitAt === -1) return null; // unrepresentable path — caller records it
    prefix = name.slice(0, splitAt);
    shortName = name.slice(splitAt + 1);
  }
  const header = Buffer.alloc(512, 0);
  const write = (offset, length, value) => header.write(value, offset, length, 'utf8');
  const octal = (offset, length, value) => {
    const text = value.toString(8).padStart(length - 1, '0');
    write(offset, length - 1, text);
    header[offset + length - 1] = 0;
  };
  write(0, 100, shortName);
  octal(100, 8, mode);
  octal(108, 8, 0); // uid
  octal(116, 8, 0); // gid
  octal(124, 12, size);
  octal(136, 12, mtime);
  header.fill(0x20, 148, 156); // checksum field counts as spaces
  write(156, 1, typeflag);
  write(257, 6, 'ustar\0');
  write(263, 2, '00');
  octal(329, 8, 0); // devmajor
  octal(337, 8, 0); // devminor
  if (prefix) write(345, 155, prefix);
  let sum = 0;
  for (const byte of header) sum += byte;
  write(148, 6, sum.toString(8).padStart(6, '0'));
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

async function collectEntries(root) {
  const entries = [];
  const skipped = [];
  async function walk(dir, prefix) {
    const items = await readdir(dir, { withFileTypes: true });
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      const abs = join(dir, item.name);
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isSymbolicLink()) {
        const target = await realpath(abs).catch(() => null);
        if (target === null || (target !== root && !target.startsWith(root + sep))) {
          skipped.push({ path: rel, reason: 'symlink points outside the candidate (or is dangling); not shipped' });
          continue;
        }
        const targetStat = await stat(target);
        if (targetStat.isDirectory()) {
          skipped.push({ path: rel, reason: 'symlink to a directory; not shipped' });
          continue;
        }
        entries.push({ abs: target, rel, mode: targetStat.mode & 0o777, size: targetStat.size, mtime: Math.floor(targetStat.mtimeMs / 1000) });
        continue;
      }
      if (item.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(item.name)) {
          skipped.push({ path: rel, reason: `directory ${item.name} is outside the code read's scope; not shipped` });
          continue;
        }
        entries.push({ abs, rel: `${rel}/`, mode: 0o755, size: 0, mtime: 0, directory: true });
        await walk(abs, rel);
        continue;
      }
      if (item.isFile()) {
        const info = await stat(abs);
        entries.push({ abs, rel, mode: info.mode & 0o777, size: info.size, mtime: Math.floor(info.mtimeMs / 1000) });
      }
    }
  }
  await walk(root, '');
  return { entries, skipped };
}

/**
 * Pack a candidate directory into the .tar.gz the vet service accepts.
 * Returns the gzipped bytes plus an honest account of what was left out.
 */
export async function buildCandidateTarball({ root } = {}) {
  const candidateRoot = resolve(root);
  const { entries, skipped } = await collectEntries(candidateRoot);
  const chunks = [];
  let fileCount = 0;
  for (const entry of entries) {
    const header = ustarHeader({
      name: entry.rel,
      mode: entry.mode,
      size: entry.directory ? 0 : entry.size,
      mtime: entry.mtime,
      typeflag: entry.directory ? '5' : '0',
    });
    if (header === null) {
      skipped.push({ path: entry.rel, reason: 'path too long for ustar; not shipped' });
      continue;
    }
    chunks.push(header);
    if (!entry.directory) {
      fileCount += 1;
      const body = await readFile(entry.abs);
      chunks.push(body);
      const remainder = body.length % 512;
      if (remainder) chunks.push(Buffer.alloc(512 - remainder, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0)); // end-of-archive marker
  const tarball = gzipSync(Buffer.concat(chunks));
  return { tarball, fileCount, skipped };
}

// ── Guard decision (wiring bite 4b) ─────────────────────────────────────────
// The requester side of the vet service's Guard gate (bite 4a). The action
// descriptor, the canonicalisation, and the hash recipe are byte-identical
// to the service's copies (app/guard-decision.mjs in the vet tree) and to
// the fleet's (hands-mcp/src/shared/protocol.mjs): the Guard signs
// canonical JSON, so any drift between the sides is a refused run.

export const VET_DECISION_AUDIENCE = 'helmian-executive-guard-decision-v1';
export const VET_GUARD_SITE = 'helmian-vet-sandbox';
export const VET_ACTION_KIND = 'vet-submission';
export const DEFAULT_VET_GUARD_DECIDER = 'auto-approve';
// The credential gate's wait (createGuardApprovalGate) is the fleet's
// precedent for waiting on a Guard decision: 15 minutes, polled every 2s.
const DEFAULT_GUARD_WAIT_MS = 15 * 60 * 1000;
const DEFAULT_GUARD_POLL_MS = 2000;
const DEFAULT_GUARD_REQUEST_TIMEOUT_MS = 5000;

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite numbers are not allowed');
    if (value === undefined) return 'null';
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export const sha256Hex = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');

/**
 * The action a vet requester asks the Executive Guard to decide.
 * contentHash binds exactly { fingerprint, candidateKind, source }.
 * The summary is what the approver sees; it is NOT part of the action hash
 * (guardActionHash's projection excludes it), so it can name the candidate
 * for a human reader without affecting verification.
 */
export function buildVetGuardAction({ fingerprint, candidateKind, source, candidateName = null }) {
  const sourceText = source === 'upload' ? 'an uploaded tarball' : source;
  return {
    kind: VET_ACTION_KIND,
    site: VET_GUARD_SITE,
    contentHash: sha256Hex(canonicalJson({ fingerprint, candidateKind, source })),
    // 'destructive-intent' routes the ask to the Guard's approval rule
    // (without it the Guard's default is deny); 'vet:execute-foreign-code'
    // is the class signal the Auto Approver's allowlist matches on, the
    // same shape as the credential class's 'credential:password_resolve'.
    riskSignals: ['destructive-intent', 'vet:execute-foreign-code'].sort(),
    summary: `Vet submission: run foreign code in the Helmian vet sandbox — candidate "${candidateName ?? 'unnamed'}" (${candidateKind}) from ${sourceText}. Fingerprint ${fingerprint}.`,
  };
}

/** Same projection as the fleet's guardActionHash. */
export function vetGuardActionHash(action) {
  const { kind, site, contentHash, riskSignals, target } = action;
  return sha256Hex(canonicalJson({ kind, site, contentHash, riskSignals, target }));
}

/** The wire shape: the X-Vet-Guard-Decision header is base64 of the JSON envelope. */
export function guardDecisionHeaderValue(envelope) {
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
}

/**
 * The client-side sanity check on a decision envelope the Guard hands back.
 * The SIGNATURE is not checked here: the client holds no pinned Guard key —
 * the vet service pins the key and verifies the signature before anything
 * runs (bite 4a). What is checked here is everything the ruling turns on
 * that a signature cannot say: the decision is for THIS candidate (action
 * hash), answers THIS ask (nonce), is unexpired, and records the Auto
 * Approver as its decider with an approval behind it.
 */
function inspectVetGuardEnvelope({ envelope, action, nonce, deciderPrincipal, now }) {
  if (!envelope || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') {
    return { ok: false, error: 'the Guard answer carried no decision envelope' };
  }
  let claims;
  try {
    claims = JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, error: 'the Guard decision envelope does not parse' };
  }
  if (claims.aud !== VET_DECISION_AUDIENCE) return { ok: false, error: 'the decision envelope names the wrong audience' };
  if (claims.verdict !== 'allow') return { ok: false, error: `the decision verdict is "${claims.verdict}", not allow` };
  if (!claims.approvalId || typeof claims.approvalId !== 'string') return { ok: false, error: 'the decision records no approval (approvalId missing)' };
  if (claims.decidedBy !== deciderPrincipal) {
    return { ok: false, error: `the decision was recorded by ${claims.decidedBy ? `"${claims.decidedBy}"` : 'nobody'} — vet decisions must be recorded by the Auto Approver ("${deciderPrincipal}")` };
  }
  if (claims.actionHash !== vetGuardActionHash(action)) return { ok: false, error: 'the decision is for a different candidate (action hash mismatch)' };
  if (nonce && claims.nonce !== nonce) return { ok: false, error: 'the decision answers a different ask (nonce mismatch)' };
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < now) return { ok: false, error: 'the decision has expired' };
  return { ok: true, claims };
}

/**
 * Ask the Executive Guard to decide a vet action and wait for the decision.
 *
 * The wire is the fleet's existing one — the same flow hands-mcp's guard
 * client and the credential service's approval gate speak:
 *   POST {guardUrl}/v1/decisions  (Bearer device token) { nonce, action }
 *     → 200/202 immediate verdict, or 202 + approvalId for an ask
 *   GET  {guardUrl}/v1/approvals/<approvalId>  (Bearer device token)
 *     → { status: pending|approved|denied|expired, decision?, decidedBy? }
 *
 * Returns { ok: true, envelope, claims, approvalId } once the Auto Approver
 * has recorded an allow decision for this action. Every other ending —
 * denial, expiry, an immediate allow with no Auto Approver decision behind
 * it, an unreachable Guard, a wait that runs out — is { ok: false, outcome,
 * error }: a hard stop the caller reports, never a silent retry.
 */
export async function obtainVetGuardDecision({
  guardUrl,
  guardToken,
  action,
  fetchImpl = globalThis.fetch,
  waitMs = DEFAULT_GUARD_WAIT_MS,
  pollMs = DEFAULT_GUARD_POLL_MS,
  requestTimeoutMs = DEFAULT_GUARD_REQUEST_TIMEOUT_MS,
  deciderPrincipal = DEFAULT_VET_GUARD_DECIDER,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
} = {}) {
  if (!guardUrl) throw new TypeError('obtainVetGuardDecision requires a guardUrl');
  if (!guardToken) throw new TypeError('obtainVetGuardDecision requires a guardToken');
  if (!action) throw new TypeError('obtainVetGuardDecision requires an action');
  const base = String(guardUrl).replace(/\/+$/, '');
  const nonce = randomBytes(18).toString('base64url');

  async function call(path, init) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), requestTimeoutMs);
    try {
      const res = await fetchImpl(`${base}${path}`, {
        ...init,
        signal: ctrl.signal,
        headers: { ...(init?.headers || {}), authorization: `Bearer ${guardToken}` },
      });
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      return { status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  let r;
  try {
    r = await call('/v1/decisions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce, action }),
    });
  } catch (error) {
    return { ok: false, outcome: 'unreachable', error: `Executive Guard is unreachable (${error.name === 'AbortError' ? 'timeout' : error.message})` };
  }
  if (!r.body || (r.status !== 200 && r.status !== 202)) {
    return { ok: false, outcome: 'refused', error: `Executive Guard answered ${r.status} to the vet decision request` };
  }
  if (r.body.verdict === 'deny') {
    return { ok: false, outcome: 'denied', error: `Executive Guard denied the vet submission${r.body.reason ? `: ${r.body.reason}` : ''}` };
  }
  if (r.body.verdict === 'allow') {
    // An immediate policy allow is not enough: the ruling requires a
    // decision RECORDED by the Auto Approver, with an approval behind it.
    // If the Guard's immediate answer carries such an envelope it is
    // accepted; otherwise this is a hard stop, not a pass.
    const checked = inspectVetGuardEnvelope({ envelope: r.body.decision, action, nonce, deciderPrincipal, now: now() });
    if (!checked.ok) {
      return { ok: false, outcome: 'no-auto-approver-decision', error: `Executive Guard allowed the ask without an Auto Approver decision (${checked.error}); a vet run requires the recorded Auto Approver decision` };
    }
    return { ok: true, envelope: r.body.decision, claims: checked.claims, approvalId: checked.claims.approvalId };
  }
  if (r.body.verdict !== 'ask' || !r.body.approvalId) {
    return { ok: false, outcome: 'refused', error: `Executive Guard answered the vet decision request with an unrecognised verdict "${r.body.verdict}"` };
  }

  const approvalId = r.body.approvalId;
  const deadline = now() + waitMs;
  for (;;) {
    let p;
    try {
      p = await call(`/v1/approvals/${encodeURIComponent(approvalId)}`, { method: 'GET' });
    } catch (error) {
      return { ok: false, outcome: 'unreachable', approvalId, error: `Executive Guard is unreachable while the vet decision is pending (${error.name === 'AbortError' ? 'timeout' : error.message})` };
    }
    if (p.status !== 200 || !p.body) {
      return { ok: false, outcome: 'refused', approvalId, error: `Executive Guard answered ${p.status} while the vet decision was pending` };
    }
    const status = p.body.status;
    if (status === 'approved') {
      const checked = inspectVetGuardEnvelope({ envelope: p.body.decision, action, nonce, deciderPrincipal, now: now() });
      if (!checked.ok) {
        return { ok: false, outcome: 'invalid-decision', approvalId, error: `the approved Guard decision cannot authorise this vet run: ${checked.error}` };
      }
      return { ok: true, envelope: p.body.decision, claims: checked.claims, approvalId };
    }
    if (status === 'denied') {
      return { ok: false, outcome: 'denied', approvalId, error: `the vet submission was denied in Guard${p.body.decidedBy ? ` (decided by ${p.body.decidedBy})` : ''}` };
    }
    if (status === 'expired') {
      return { ok: false, outcome: 'expired', approvalId, error: 'the Guard approval expired before a decision was recorded' };
    }
    if (status !== 'pending') {
      return { ok: false, outcome: 'refused', approvalId, error: `unknown Guard approval state "${status}"` };
    }
    if (now() + pollMs > deadline) {
      return { ok: false, outcome: 'timeout', approvalId, error: `no Guard decision within ${waitMs}ms (approval ${approvalId} still pending)` };
    }
    await sleep(pollMs);
  }
}

// ── Submission ──────────────────────────────────────────────────────────────

const VERDICT_BY_DECISION = Object.freeze({
  'vetted-clean-awaiting-human': 'clean',
  'blocked-by-code-read': 'blocked',
  'flagged-in-sandbox': 'flagged',
});

function evidenceMissing(error, extra = {}) {
  return {
    stage: 'vet',
    status: 'evidence-missing',
    verdict: 'evidence-missing',
    runId: null,
    finalDecision: null,
    fingerprint: null,
    report: null,
    error,
    note: 'No vet verdict was obtained. Under the pipeline\'s rules this is a halt, never a clean run: missing evidence is not innocence.',
    ...extra,
  };
}

/**
 * Submit a candidate directory to the cloud vet service and fold its answer
 * into a pipeline stage object. Never throws for a service-side problem —
 * every failure is an `evidence-missing` stage. Throws TypeError only for a
 * caller error (no URL or no token), the same contract as the Author lane's
 * client.
 *
 * When `guard` ({ guardUrl, guardToken, ... }) is supplied, the submission
 * is Guard-gated (wiring bite 4b): the caller must also supply the
 * candidate's `fingerprint` (the pipeline's computeCandidateFingerprint —
 * the decision binds it), and an Auto Approver decision envelope for this
 * exact candidate is obtained BEFORE the candidate is submitted and
 * presented in the X-Vet-Guard-Decision header. No envelope, no submission:
 * a Guard denial, timeout, or refusal is an evidence-missing halt, exactly
 * like a missing vet verdict. Without `guard`, behaviour is exactly as
 * before this bite.
 */
export async function submitCandidateToVet({
  root,
  vetUrl = DEFAULT_VET_URL,
  vetToken,
  fetchImpl = globalThis.fetch,
  deadlineMs = DEFAULT_DEADLINE_MS,
  candidateKind = VET_CANDIDATE_KIND,
  guard = null,
  fingerprint = null,
  candidateName = null,
  source = 'upload',
} = {}) {
  if (!vetUrl) throw new TypeError('submitCandidateToVet requires a vetUrl');
  if (!vetToken) throw new TypeError('submitCandidateToVet requires a vetToken');
  const base = String(vetUrl).replace(/\/+$/, '');
  const started = Date.now();
  const remaining = () => deadlineMs - (Date.now() - started);

  let packed;
  try {
    packed = await buildCandidateTarball({ root });
  } catch (error) {
    return evidenceMissing(`candidate could not be packed for submission: ${error.message}`);
  }
  if (packed.tarball.length > VET_MAX_TARBALL_BYTES) {
    return evidenceMissing(
      `candidate tarball is ${packed.tarball.length} bytes, over the vet service's ${VET_MAX_TARBALL_BYTES}-byte upload limit`,
      { skipped: packed.skipped },
    );
  }

  // Guard gate (bite 4b): the decision is obtained after the candidate is
  // packed (a candidate that cannot be packed is not worth a Guard ask) and
  // before it is submitted (a refused or unanswered ask means the candidate
  // never leaves this machine). The envelope is single-use on the service,
  // and the service's 409 busy answer precedes its decision check, so the
  // busy retries below never burn it.
  let guardDecision = null;
  let guardDecisionHeader = null;
  if (guard) {
    if (!fingerprint) {
      return evidenceMissing(
        'a Guard decision was configured for this vet submission but no candidate fingerprint was supplied; the decision binds the fingerprint, so the submission cannot proceed',
        { skipped: packed.skipped, guardOutcome: 'no-fingerprint' },
      );
    }
    const action = buildVetGuardAction({ fingerprint, candidateKind, source, candidateName });
    const decision = await obtainVetGuardDecision({
      guardUrl: guard.guardUrl,
      guardToken: guard.guardToken,
      action,
      fetchImpl: guard.fetchImpl ?? fetchImpl,
      waitMs: guard.waitMs,
      pollMs: guard.pollMs,
      requestTimeoutMs: guard.requestTimeoutMs,
      deciderPrincipal: guard.deciderPrincipal,
    });
    if (!decision.ok) {
      return evidenceMissing(`vet Guard decision not obtained: ${decision.error}`, {
        skipped: packed.skipped,
        guardOutcome: decision.outcome,
        guardApprovalId: decision.approvalId ?? null,
      });
    }
    guardDecision = {
      approvalId: decision.approvalId,
      decisionId: decision.claims.decisionId ?? null,
      decidedBy: decision.claims.decidedBy ?? null,
    };
    guardDecisionHeader = guardDecisionHeaderValue(decision.envelope);
  }
  const guardExtra = guardDecision ? { guardDecision } : {};

  let delay = 1000;
  let summary = null;
  for (;;) {
    if (remaining() <= 0) {
      return evidenceMissing(`vet service did not accept the submission within ${deadlineMs}ms`, { skipped: packed.skipped });
    }
    let res;
    try {
      res = await fetchImpl(`${base}/vet`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${vetToken}`,
          'x-vet-intent': 'execute-foreign-code',
          'x-vet-candidate-kind': candidateKind,
          'content-type': 'application/gzip',
          ...(guardDecisionHeader ? { 'x-vet-guard-decision': guardDecisionHeader } : {}),
        },
        body: packed.tarball,
        signal: AbortSignal.timeout(remaining()),
      });
    } catch (error) {
      return evidenceMissing(`vet service unreachable at ${base}: ${error.message}`, { skipped: packed.skipped });
    }
    if (res.status === 409) {
      // One run at a time on the service; wait inside the deadline.
      await new Promise((r) => setTimeout(r, Math.min(delay, Math.max(remaining(), 0))));
      delay = Math.min(delay * 2, 15000);
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (res.status !== 200 || data.error || !data.finalDecision) {
      return evidenceMissing(
        `vet service refused the submission: HTTP ${res.status}${data.error ? ` — ${data.error}` : ''}`,
        { skipped: packed.skipped, ...guardExtra },
      );
    }
    summary = data;
    break;
  }

  // Fold the full report in when it can be fetched; the summary stands on
  // its own if it cannot (the run id + decision are the load-bearing facts).
  let fullReport = null;
  let reportNote = null;
  try {
    const res = await fetchImpl(`${base}/runs/${encodeURIComponent(summary.runId)}`, {
      headers: { authorization: `Bearer ${vetToken}` },
      signal: AbortSignal.timeout(Math.max(remaining(), 1000)),
    });
    if (res.ok) fullReport = await res.json();
    else reportNote = `full vet report fetch returned HTTP ${res.status}; the submission summary is recorded instead`;
  } catch (error) {
    reportNote = `full vet report could not be fetched (${error.message}); the submission summary is recorded instead`;
  }

  return {
    stage: 'vet',
    status: 'completed',
    verdict: VERDICT_BY_DECISION[summary.finalDecision] ?? 'evidence-missing',
    runId: summary.runId,
    serverName: summary.serverName ?? null,
    finalDecision: summary.finalDecision,
    fingerprint: summary.fingerprint ?? null,
    exitCode: summary.exitCode ?? null,
    runContainerDestroyed: summary.runContainerDestroyed ?? null,
    codeRead: summary.codeRead ?? null,
    sandbox: summary.sandbox ?? null,
    report: fullReport,
    reportNote,
    skipped: packed.skipped,
    ...guardExtra,
    note: 'Verdict of the cloud vet service (disposable container, network none, verified destruction). The service never approves and never installs; a clean verdict means "vetted-clean-awaiting-human", and the local observer run remains a second, independent layer.',
  };
}
