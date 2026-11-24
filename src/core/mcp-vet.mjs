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
 */
export async function submitCandidateToVet({
  root,
  vetUrl = DEFAULT_VET_URL,
  vetToken,
  fetchImpl = globalThis.fetch,
  deadlineMs = DEFAULT_DEADLINE_MS,
  candidateKind = VET_CANDIDATE_KIND,
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
        { skipped: packed.skipped },
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
    note: 'Verdict of the cloud vet service (disposable container, network none, verified destruction). The service never approves and never installs; a clean verdict means "vetted-clean-awaiting-human", and the local observer run remains a second, independent layer.',
  };
}
