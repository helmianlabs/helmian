import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryAudit, fileAudit, verifyChain, GENESIS_HASH } from '../src/audit.mjs';

test('entries chain from the genesis hash and verify', () => {
  const audit = memoryAudit();
  const first = audit.append({ event: 'a' });
  const second = audit.append({ event: 'b' });
  assert.equal(first.prevHash, GENESIS_HASH);
  assert.equal(second.prevHash, first.hash);
  assert.deepEqual(audit.verify(), { ok: true, count: 2, head: second.hash });
});

test('editing any entry breaks the chain at that entry', () => {
  const audit = memoryAudit();
  audit.append({ event: 'a', verdict: 'deny' });
  audit.append({ event: 'b' });
  const entries = audit.all().map((e) => ({ ...e }));
  entries[0].verdict = 'allow';
  const result = verifyChain(entries);
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, 1);
});

test('deleting an entry breaks the chain', () => {
  const audit = memoryAudit();
  audit.append({ event: 'a' });
  audit.append({ event: 'b' });
  audit.append({ event: 'c' });
  const entries = audit.all();
  entries.splice(1, 1);
  assert.equal(verifyChain(entries).ok, false);
});

test('the file audit persists, reloads and refuses a tampered file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eg-audit-'));
  const path = join(dir, 'audit.jsonl');
  const audit = fileAudit(path);
  audit.append({ event: 'decision.issued', verdict: 'deny' });
  audit.append({ event: 'decision.issued', verdict: 'allow' });
  assert.equal(audit.verify().ok, true);

  const reloaded = fileAudit(path);
  assert.equal(reloaded.all().length, 2);
  reloaded.append({ event: 'third' });
  assert.equal(fileAudit(path).all().length, 3);

  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  lines[0] = lines[0].replace('"deny"', '"allow"');
  writeFileSync(path, `${lines.join('\n')}\n`);
  assert.throws(() => fileAudit(path), /failed verification at seq 1/);
});
