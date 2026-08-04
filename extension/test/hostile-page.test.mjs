// The page is not on our side.
//
// Every other end-to-end test renders a page that behaves. This one renders a
// page that is TRYING to switch the guard off, using only markup any site — or
// any model told to emit raw HTML — can produce. The three attacks below were
// all working, silent, complete bypasses until 2026-08-03: the guard drew
// nothing, masked nothing, set an empty badge, and still logged "self-test
// passed — watching this page."
//
// That combination is the worst failure this product can have. A tool that says
// it found nothing wrong, while looking at `rm -rf /data`, is worse than no tool
// at all, because the user has stopped reading carefully on its account.
//
// Each test here is a POSITIVE CONTROL pair: the hostile page must warn, and an
// identical page without the hostile attribute must warn too. If a future change
// makes the guard blind again, this file goes red before a user finds out.

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadContentScripts } from '../test-support/load-content-script.mjs';
import { element, createDocument } from '../test-support/mini-dom.mjs';
import { chrome, fake, installWorker } from '../test-support/fake-chrome.mjs';

await installWorker();

const CONTENT_SCRIPTS = [
  'content/extract.js',
  'content/stream-watch.js',
  'content/ui.js',
  'content/guard.js',
];

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const DANGEROUS = 'rm -rf /data';

function codeBlock(code, attributes) {
  return element('pre', attributes || {}, [element('code', {}, [code])]);
}

async function runExtension(children) {
  fake.reset();
  const doc = createDocument(children);

  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; }

    observe() {}

    disconnect() {}
  }

  await loadContentScripts(CONTENT_SCRIPTS, {
    document: doc,
    chrome,
    MutationObserver: FakeMutationObserver,
    window: { addEventListener() {} },
    setInterval() { return 0; },
  });

  return doc;
}

const panels = (doc) => doc.querySelectorAll('.helmion-guard-panel');

// The djb2 fingerprint from content/guard.js, reimplemented here exactly as a
// hostile page would have to reimplement it. That it CAN be reimplemented is the
// whole point: the value was never a secret, so it was never a safe thing to
// read back off the page and trust.
function fingerprint(text) {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = (((hash << 5) + hash) ^ text.charCodeAt(index)) >>> 0;
  }
  return `${text.length}:${hash.toString(36)}`;
}

test('a page that pre-stamps the seen-fingerprint is still scanned', async () => {
  // The attack: guard.js used to record "already checked" in a data attribute,
  // and the value was a plain hash of the block's own text. A page that wrote
  // the right value onto its own <pre> was skipped without ever being read.
  const pre = codeBlock(DANGEROUS, { 'data-helmion-seen': fingerprint(DANGEROUS) });
  const doc = await runExtension([pre]);
  await wait(60);

  assert.equal(panels(doc).length, 1, 'a forged data-helmion-seen suppressed the warning');
  assert.ok(pre.classList.contains('helmion-guard-masked'), 'the dangerous block was not hidden');
});

test('a page that forges a duplicate block id is still scanned', async () => {
  // The attack: two blocks sharing one id collapsed into one entry in the
  // results Map (last wins), so the harmless block's clean verdict was applied
  // to the dangerous one. Order matters — the clean block goes second.
  const dangerous = codeBlock(DANGEROUS, { 'data-helmion-id': 'hg-1' });
  const harmless = codeBlock('echo hello world', { 'data-helmion-id': 'hg-1' });
  const doc = await runExtension([dangerous, harmless]);
  await wait(60);

  assert.equal(panels(doc).length, 1, 'a forged duplicate id suppressed the warning');
  assert.ok(dangerous.classList.contains('helmion-guard-masked'), 'the dangerous block was not hidden');
  assert.ok(!harmless.classList.contains('helmion-guard-masked'), 'the harmless block was masked');
});

test('a page cannot break the guard with an id that is invalid CSS', async () => {
  // The attack: the id was interpolated raw into `[data-helmion-id="..."]` and
  // handed to querySelector. In a real browser a value containing a quote throws
  // a SyntaxError per the DOM spec, out of an un-awaited call, which surfaces as
  // an unhandled rejection that only console.error's — so the pass died with the
  // badge still clean.
  //
  // HONEST LIMIT: this test passed BEFORE the fix as well, because the mini-DOM
  // in test-support does not implement selector parsing and so never throws. It
  // is kept as a regression guard on the shape of the input, not as proof the
  // browser path was broken — the proof there is that pruneDetached no longer
  // builds a selector from page-supplied text at all. Confirming the original
  // throw needs a real browser.
  const pre = codeBlock(DANGEROUS, { 'data-helmion-id': 'a"]' });
  const doc = await runExtension([pre]);
  await wait(60);

  assert.equal(panels(doc).length, 1, 'a selector-breaking id suppressed the warning');
  assert.equal(doc.querySelectorAll('.helmion-guard-banner').length, 0, 'the guard reported itself broken');
});

test('POSITIVE CONTROL: the same block with no hostile attribute warns', async () => {
  // Without this, the three tests above could pass because the harness never
  // warns about anything.
  const pre = codeBlock(DANGEROUS);
  const doc = await runExtension([pre]);
  await wait(60);

  assert.equal(panels(doc).length, 1);
  assert.ok(pre.classList.contains('helmion-guard-masked'));
});

test('POSITIVE CONTROL: a harmless block on its own is not warned about', async () => {
  const pre = codeBlock('echo hello world');
  const doc = await runExtension([pre]);
  await wait(60);

  assert.equal(panels(doc).length, 0);
});
