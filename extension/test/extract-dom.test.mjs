// Extraction against a real element tree.
//
// On the live sites the reply is not markdown by the time the extension sees it
// — it is rendered HTML. A fenced block becomes <pre><code>. Inline backticks
// become a bare <code> with no <pre> around it, and that is prose, so it must
// never be collected. These tests run the extension's real selector strings
// against a real tree to prove that line holds.

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadContentScript } from '../test-support/load-content-script.mjs';
import { element, documentWith } from '../test-support/mini-dom.mjs';

const { HelmionExtract } = await loadContentScript('content/extract.js');

test('a fenced block rendered as <pre><code> is collected', () => {
  const doc = documentWith([
    element('div', {}, [
      element('p', {}, ['Clear the build output:']),
      element('pre', {}, [element('code', { class: 'language-bash' }, ['rm -rf html/*'])]),
    ]),
  ]);

  const collected = HelmionExtract.collectCodeBlocks(doc);
  assert.equal(collected.tier, 1);
  assert.equal(collected.blocks.length, 1);
  assert.equal(collected.blocks[0].text, 'rm -rf html/*');
});

test('inline backticks rendered as a bare <code> are NOT collected', () => {
  const doc = documentWith([
    element('p', {}, [
      'Never run ',
      element('code', {}, ['rm -rf /']),
      ' on a production box.',
    ]),
  ]);

  const collected = HelmionExtract.collectCodeBlocks(doc);
  assert.equal(collected.blocks.length, 0, 'inline code was collected and it must not be');
  assert.equal(collected.tier, 0);
});

test('a page with both collects only the block, not the inline mention', () => {
  const doc = documentWith([
    element('p', {}, ['Never run ', element('code', {}, ['rm -rf /']), ' by hand.']),
    element('pre', {}, [element('code', {}, ['npm run build'])]),
  ]);

  const collected = HelmionExtract.collectCodeBlocks(doc);
  assert.equal(collected.blocks.length, 1);
  assert.equal(collected.blocks[0].text, 'npm run build');
});

test('the site\'s own Copy button inside the <pre> is left out of the scanned text', () => {
  // ChatGPT and Claude both put a language label and a Copy button in the same
  // <pre> as the code. Reading the inner <code> keeps that furniture out.
  const doc = documentWith([
    element('pre', {}, [
      element('div', { class: 'code-header' }, ['bash', element('button', {}, ['Copy'])]),
      element('code', {}, ['git status']),
    ]),
  ]);

  const collected = HelmionExtract.collectCodeBlocks(doc);
  assert.equal(collected.blocks[0].text, 'git status');
});

test('a <pre> with no inner <code> still yields its text', () => {
  const doc = documentWith([element('pre', {}, ['git status'])]);
  const collected = HelmionExtract.collectCodeBlocks(doc);
  assert.equal(collected.blocks.length, 1);
  assert.equal(collected.blocks[0].text, 'git status');
});

test('when <pre> stops matching, a lower tier answers and reports itself as degraded', () => {
  // This is the silent-break case. A redesign that drops <pre> would otherwise
  // make the extension find nothing, which looks exactly like a clean page.
  // Tier 2 answering is the signal guard.js turns into a visible banner.
  const doc = documentWith([
    element('div', { 'data-testid': 'code-block-2' }, [
      element('code', {}, ['rm -rf /']),
    ]),
  ]);

  const collected = HelmionExtract.collectCodeBlocks(doc);
  assert.equal(collected.tier, 2);
  assert.equal(collected.blocks.length, 1);
  assert.equal(collected.blocks[0].text, 'rm -rf /');
});

test('a custom code-block element is found at tier 3', () => {
  const doc = documentWith([
    element('code-block', {}, [element('code', {}, ['DROP TABLE loads;'])]),
  ]);

  const collected = HelmionExtract.collectCodeBlocks(doc);
  assert.equal(collected.tier, 3);
  assert.equal(collected.blocks[0].text, 'DROP TABLE loads;');
});

test('an empty page is tier 0 with no blocks, and that is not a failure', () => {
  const collected = HelmionExtract.collectCodeBlocks(documentWith([]));
  assert.equal(collected.tier, 0);
  assert.equal(collected.blocks.length, 0);
});

test('collectCodeBlocks refuses a non-DOM argument instead of quietly finding nothing', () => {
  assert.throws(() => HelmionExtract.collectCodeBlocks({}), /needs a DOM node/);
});

test('the tier 1 selector is the <pre> element, not a CSS class', () => {
  // Pinned deliberately. A Tailwind utility class like pt-6 changes the day a
  // designer nudges the padding; <pre> is what the element IS.
  assert.equal(HelmionExtract.BLOCK_SELECTORS[0].selector, 'pre');
});
