import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { buildDesktopParityManifest } from '../src/cloud/desktop-parity.mjs';

// A citation is a repo path with an optional locator after the first
// colon: a line (src/x.mjs:160), a line range (src/x.mjs:10-20), a
// symbol (src/cloud/live-admin.mjs:RELEASE_ROADMAP_PATH), or a section
// anchor (web/cloud-admin/index.html:section-release). Every cited file
// must exist, and a symbol or anchor locator must appear in its file.
function assertCitation(citation) {
  const colon = citation.indexOf(':');
  const path = colon < 0 ? citation : citation.slice(0, colon);
  const locator = colon < 0 ? null : citation.slice(colon + 1);
  const url = new URL(`../${path}`, import.meta.url);
  assert.ok(existsSync(url), `cited file does not exist: ${path}`);
  if (locator === null || /^\d+(?:-\d+)?$/.test(locator)) return;
  assert.ok(
    readFileSync(url, 'utf8').includes(locator),
    `cited locator not found in ${path}: ${locator}`,
  );
}

test('desktop/cloud parity manifest covers every declared desktop slice and stays honest', () => {
  const manifest = buildDesktopParityManifest();
  assert.equal(manifest.format, 'helmion.desktop-cloud-parity.v1');
  assert.equal(manifest.claim, 'inventory_only');
  assert.equal(manifest.parityComplete, false);
  assert.ok(manifest.entries.length >= 10);
  for (const entry of manifest.entries) {
    for (const citation of entry.desktopEvidence.split('; ')) assertCitation(citation);
    for (const citation of entry.cloudEvidence.split('; ')) assertCitation(citation);
    assert.deepEqual(entry.chain, [entry.desktopEvidence, entry.cloudEvidence]);
    assert.ok(['mapped', 'partial', 'not_wired'].includes(entry.status));
    assert.notEqual(entry.missing, '');
  }
});
