// The audit trail: append-only and hash-chained. Every entry carries the hash
// of the entry before it, so deleting or editing any line breaks verifyChain()
// from that point on. Two backends with one interface: memory (tests) and a
// JSONL file (the dev server). sql/schema.sql has the Postgres table for a
// hosted deployment; it is NOT applied anywhere by this change.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson } from './canonical.mjs';

export const GENESIS_HASH = '0'.repeat(64);

function entryHash(entry) {
  const { hash, ...rest } = entry;
  return createHash('sha256').update(canonicalJson(rest)).digest('hex');
}

function buildEntry(previous, event, now) {
  const entry = {
    seq: previous ? previous.seq + 1 : 1,
    at: new Date(now()).toISOString(),
    prevHash: previous ? previous.hash : GENESIS_HASH,
    ...event,
  };
  entry.hash = entryHash(entry);
  return entry;
}

export function verifyChain(entries) {
  let previous = null;
  for (const entry of entries) {
    const expectedPrev = previous ? previous.hash : GENESIS_HASH;
    if (entry.prevHash !== expectedPrev) return { ok: false, brokenAt: entry.seq, error: 'chain link mismatch' };
    if (entry.seq !== (previous ? previous.seq + 1 : 1)) return { ok: false, brokenAt: entry.seq, error: 'sequence gap' };
    if (entryHash(entry) !== entry.hash) return { ok: false, brokenAt: entry.seq, error: 'entry was altered' };
    previous = entry;
  }
  return { ok: true, count: entries.length, head: previous ? previous.hash : GENESIS_HASH };
}

export function memoryAudit({ now = Date.now } = {}) {
  const entries = [];
  return {
    append(event) {
      const entry = buildEntry(entries[entries.length - 1], event, now);
      entries.push(entry);
      return entry;
    },
    list({ limit = 100, sinceSeq = 0 } = {}) {
      return entries.filter((e) => e.seq > sinceSeq).slice(-limit);
    },
    all() { return entries.slice(); },
    verify() { return verifyChain(entries); },
  };
}

export function fileAudit(path, { now = Date.now } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const entries = existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const check = verifyChain(entries);
  if (!check.ok) throw new Error(`audit file ${path} failed verification at seq ${check.brokenAt}: ${check.error}`);
  return {
    append(event) {
      const entry = buildEntry(entries[entries.length - 1], event, now);
      appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      entries.push(entry);
      return entry;
    },
    list({ limit = 100, sinceSeq = 0 } = {}) {
      return entries.filter((e) => e.seq > sinceSeq).slice(-limit);
    },
    all() { return entries.slice(); },
    verify() {
      const onDisk = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
      return verifyChain(onDisk);
    },
  };
}
