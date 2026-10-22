// Restart-safe state for the things the audit trail cannot rebuild on its own:
// pending approvals (they hold the device's nonce and the full action, which
// the audit deliberately does not), the signed decision issued for an approval,
// and the replay cache of used nonces (stored as SHA-256 only).
//
// Append-only JSONL next to the audit file (same volume). Each line is one
// record; the latest record for an approval wins. On load the file is compacted:
// expired nonces and long-finished approvals are dropped and the file is
// rewritten atomically (write tmp, fsync, rename). The audit trail stays the
// source of truth for an approval's status; createExecutiveGuard reconciles the
// two on start.
//
// Records:
//   { t: 'nonce', h: <sha256 hex>, exp: <ms> }
//   { t: 'approval', approval: { id, status, createdAt, expiresAt, deviceId, nonce, actionHash, action, ruleId, reason, decidedBy?, decidedAt?, decisionReason?, issued? } }

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export function memoryState() {
  let records = [];
  return {
    load() { return records.slice(); },
    append(record) { records.push(JSON.parse(JSON.stringify(record))); },
    compact(keep) { records = keep.map((r) => JSON.parse(JSON.stringify(r))); },
    get records() { return records; },
  };
}

function writeDurably(path, text, flags) {
  const fd = openSync(path, flags, 0o600);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
}

export function fileState(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return {
    load() {
      if (!existsSync(path)) return [];
      const out = [];
      const lines = readFileSync(path, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i]) continue;
        try { out.push(JSON.parse(lines[i])); }
        catch {
          // Only a torn LAST line (crash mid-append) is tolerated.
          if (lines.slice(i + 1).some(Boolean)) throw new Error(`state file ${path} is corrupt at line ${i + 1}`);
        }
      }
      return out;
    },
    append(record) { writeDurably(path, `${JSON.stringify(record)}\n`, 'a'); },
    compact(keep) {
      const tmp = `${path}.tmp`;
      writeDurably(tmp, keep.map((r) => `${JSON.stringify(r)}\n`).join(''), 'w');
      renameSync(tmp, path);
    },
  };
}
