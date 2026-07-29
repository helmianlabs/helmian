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

// blocks: [{ id, text }]  ->  [{ id, blocked, findings, hits }]
export function scanBlocks(blocks) {
  if (!Array.isArray(blocks)) throw new TypeError('scanBlocks expects an array of blocks');
  return blocks.map((block) => {
    const result = scanCodeBlock(block?.text);
    return { id: block?.id ?? null, ...result };
  });
}
