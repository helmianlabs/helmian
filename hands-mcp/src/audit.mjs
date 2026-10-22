// Append-only, hash-chained local audit of every hands call (allowed, denied,
// refused, executed). Guard keeps its own trail; this one also covers read-only
// calls and calls Guard never saw (kill switch, scope, routing, Guard down).

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function createAudit(file) {
  let prev = 'genesis';
  let seq = 0;
  const memory = [];
  if (file && existsSync(file)) {
    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length) {
      const last = JSON.parse(lines[lines.length - 1]);
      prev = last.hash; seq = last.seq;
    }
  }
  if (file) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  return {
    append(event) {
      seq += 1;
      const row = { seq, at: new Date().toISOString(), prev, ...event };
      row.hash = createHash('sha256').update(JSON.stringify(row)).digest('hex');
      prev = row.hash;
      if (file) appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      else memory.push(row);
      return row;
    },
    rows: () => memory,
  };
}
