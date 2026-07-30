// Runs the Helmion destructive-command kernel over extracted code blocks.
//
// This is the only place the kernel is called. It is an ES module so both the
// extension's service worker and the Node tests load the exact same file.
//
// THE RULE THIS FILE ENFORCES
// Never hand the kernel a whole chat reply. Hand it one line of one code block
// at a time. Fed a whole reply, the sentence "You should never run rm -rf on a
// production server without a backup" is reported as destructive — which is a
// warning against the command, not the command. Measured, not assumed.
//
// Second measured fact: detectDestructiveOperation reads tool_input.command and
// nothing else (governance.mjs:51-53). Passing scraped text as tool_input.text
// returns blocked:false and the kernel silently sees nothing. The mapping to
// .command below is load-bearing; extension/test/scan.test.mjs pins it.

import { detectDestructiveOperation } from '../generated/helmion-governance.generated.js';

// A runaway guard, and nothing more.
//
// This cap used to be 4000, justified in this comment as "scanning a long line
// costs regex time and can only produce noise." Both halves were measured on
// 2026-07-29 and both were false:
//
//   line length   cost per call   destructive command still caught
//        4,000       0.048 ms                  yes
//      100,000       0.77  ms                  yes
//      500,000       3.6   ms                  yes
//   200,000 chars of pure filler -> 0.90 ms, and it comes back CLEAN, so the
//   feared "noise" does not happen either.
//
// A 4000-char cap therefore bought nothing and cost real protection: pad a
// destructive command past 4000 characters on one line and it sailed through
// unchecked. The cap now sits where a line has stopped being text a human will
// ever read and has become a denial-of-service risk instead.
export const MAX_LINE_LENGTH = 1000000;

export function scanLine(line) {
  const text = String(line ?? '').trim();
  if (!text) return { blocked: false, hits: [] };
  if (text.length > MAX_LINE_LENGTH) {
    return { blocked: false, hits: [], skipped: `line is ${text.length} characters, over the ${MAX_LINE_LENGTH} limit` };
  }
  const verdict = detectDestructiveOperation({ tool_input: { command: text } });
  return { blocked: verdict.blocked === true, hits: verdict.hits ?? [] };
}

// One code block in, one verdict out. Findings name the exact line, because
// that is what the on-page warning has to point at.
//
// `unchecked` carries every line scanLine refused to look at. It exists because
// this function used to drop that information on the floor: scanLine returned
// { skipped } and the loop below tested only `verdict.blocked`, so a line that
// was never examined was indistinguishable from a line that came back clean.
// Nothing upstream could tell the difference either. A safety tool is not
// allowed to have a category of input it silently ignores, so every skip now
// travels all the way to the page.
export function scanCodeBlock(code) {
  const lines = String(code ?? '').split(/\r?\n/);
  const findings = [];
  const unchecked = [];
  for (let index = 0; index < lines.length; index += 1) {
    const verdict = scanLine(lines[index]);
    if (verdict.skipped) {
      unchecked.push({ lineNumber: index + 1, reason: verdict.skipped });
      continue;
    }
    if (!verdict.blocked) continue;
    findings.push({
      lineNumber: index + 1,
      text: lines[index].trim(),
      hits: verdict.hits,
    });
  }
  const hits = [...new Set(findings.flatMap((finding) => finding.hits))];
  return { blocked: findings.length > 0, findings, hits, unchecked };
}

/* ─── THE BLOCK LEDGER, BROWSER HALF ─────────────────────────────────────────
 *
 * Troy's requirement, 2026-07-29: every time either layer blocks something it
 * gets written somewhere durable — "not screenshots, not chat history."
 * src/core/audit-log.mjs does exactly that for the execution layer, in
 * append-only JSONL on disk.
 *
 * RESOLVED 2026-07-30. THIS COMMENT USED TO SAY THE GAP COULD NOT BE CLOSED.
 *
 * It laid out the options — the storage permission, a local HTTP post, downloads,
 * IndexedDB — rejected each one, and ended: "Closing that gap needs a decision
 * from Troy… until he makes it, the browser layer's evidence is in-memory only."
 *
 * He made it: *"when any browser AI… flags anything harmful, a lie, a gaslight,
 * an omission… It needs to log it. Timestamp what the query was, what the
 * conversation was, all of it."* One permission — `storage` — and the durable
 * ledger now lives in background/ledger.js. The network objection still stands
 * and is still enforced by extension/test/package.test.mjs.
 *
 * WHAT THIS FILE STILL DOES, and why the queue below did not simply get deleted:
 *
 *   1. It SHAPES every browser block into the schema src/core/audit-log.mjs
 *      writes — Troy's six fields, layer 'browser'.
 *   2. It QUEUES them in the worker for anything running in-process, and hands
 *      the same data back on each scan result so the content script can decide
 *      what to draw.
 *
 * The queue is a per-session convenience, NOT the record. The record is the
 * ledger, and content/guard.js writes to it directly on every finding. If the
 * two ever disagree, the ledger is the one that survived a restart.
 *
 * `layer: 'browser'` is spelled literally rather than imported from
 * src/core/audit-log.mjs LAYER.BROWSER, because importing anything from src/
 * would pull node:fs into a file Chrome has to load. Source of truth for the
 * string: src/core/audit-log.mjs:46.
 */

/** Cap on the queue, so a long-lived worker cannot grow without bound. */
export const AUDIT_QUEUE_LIMIT = 500;

const auditQueue = [];
// Rows pushed out by the cap. Counted, never silently forgotten: a ledger that
// loses rows without saying so is not evidence.
let auditDropped = 0;

/**
 * One browser-layer block, in the schema src/core/audit-log.mjs writes.
 *
 * @param {{lineNumber: number, text: string, hits: string[]}} finding
 * @param {{source: string, now?: Date}} context  source = the site it came from
 */
export function browserBlockEvent(finding, { source, now = new Date() } = {}) {
  return {
    layer: 'browser',
    timestamp: new Date(now).toISOString(),
    matchedPattern: (finding?.hits ?? []).join(', '),
    text: String(finding?.text ?? ''),
    source: String(source ?? ''),
    // The block is masked behind a warning and takes a second deliberate click
    // to copy (content/guard.js MASK_DANGEROUS_BLOCKS). Nothing was executed
    // here — this layer warns, it does not run commands — so the outcome is what
    // actually happened to the code block, not a claim about a process.
    outcome: 'blocked',
    hits: finding?.hits ?? [],
    lineNumber: finding?.lineNumber ?? null,
  };
}

/** Everything queued since the worker started, oldest first. A copy. */
export function recordedBrowserBlocks() {
  return auditQueue.slice();
}

/** Queue depth plus the drop count, for anything reporting ledger health. */
export function browserAuditState() {
  return { queued: auditQueue.length, dropped: auditDropped, limit: AUDIT_QUEUE_LIMIT };
}

/** Empties the queue. For a drain-to-somewhere-durable path, and for tests. */
export function clearRecordedBrowserBlocks() {
  const drained = auditQueue.splice(0, auditQueue.length);
  auditDropped = 0;
  return drained;
}

function queueBrowserBlock(event) {
  auditQueue.push(event);
  while (auditQueue.length > AUDIT_QUEUE_LIMIT) {
    auditQueue.shift();
    auditDropped += 1;
  }
  return event;
}

// blocks: [{ id, text, source }]  ->  [{ id, blocked, findings, hits, unchecked, audit }]
//
// `source` is what makes a finding recordable. A block that names none produces
// no ledger row and SAYS SO in audit.reason rather than being quietly dropped —
// content/guard.js deliberately names none on its self-test probes, which run a
// known-destructive command through this chain on every page load and every 60
// seconds. Recording those would bury real evidence under thousands of rows
// about a string nobody ever typed.
export function scanBlocks(blocks) {
  if (!Array.isArray(blocks)) throw new TypeError('scanBlocks expects an array of blocks');
  return blocks.map((block) => {
    const result = scanCodeBlock(block?.text);
    const source = block?.source ? String(block.source) : '';
    const audit = { events: [], recorded: 0, reason: '' };

    if (result.findings.length > 0) {
      if (source) {
        audit.events = result.findings.map(
          (finding) => queueBrowserBlock(browserBlockEvent(finding, { source })),
        );
        audit.recorded = audit.events.length;
      } else {
        audit.reason = `${result.findings.length} block(s) were not recorded: this scan named no `
          + 'source, so no ledger row could identify where it came from (self-test probes '
          + 'deliberately name none)';
      }
    }

    return { id: block?.id ?? null, ...result, audit };
  });
}
