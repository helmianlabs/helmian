import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDesktopParityManifest } from '../src/cloud/desktop-parity.mjs';

test('desktop/cloud parity manifest covers every declared desktop slice and stays honest', () => {
  const manifest = buildDesktopParityManifest();
  assert.equal(manifest.format, 'helmion.desktop-cloud-parity.v1');
  assert.equal(manifest.claim, 'inventory_only');
  assert.equal(manifest.parityComplete, false);
  assert.ok(manifest.entries.length >= 10);
  for (const entry of manifest.entries) {
    for (const citation of entry.desktopEvidence.split('; ')) assert.match(citation, /:\d+(?:-\d+)?$/u);
    for (const citation of entry.cloudEvidence.split('; ')) assert.match(citation, /:\d+(?:-\d+)?$/u);
    assert.deepEqual(entry.chain, [entry.desktopEvidence, entry.cloudEvidence]);
    assert.ok(['mapped', 'partial', 'not_wired'].includes(entry.status));
    assert.notEqual(entry.missing, '');
  }
});
