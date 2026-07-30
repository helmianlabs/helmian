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

/* ─── PROSE, THE OTHER LANE'S INPUT ─────────────────────────────────────────
 *
 * Everything above proves prose never reaches the destructive-command kernel.
 * Everything below proves the opposite direction: code never reaches the
 * unsourced-claim detector, and the extension reads prose the same way
 * src/core/unverified-claims.mjs does when it is handed raw markdown. */

test('a paragraph is collected as prose and the code block beside it is not', () => {
  const doc = documentWith([
    element('p', {}, ['The retry limit is probably set in config.json.']),
    element('pre', {}, [element('code', {}, ['rm -rf html/*'])]),
  ]);

  const prose = HelmionExtract.collectProse(doc);
  assert.equal(prose.tier, 1);
  assert.equal(prose.passages.length, 1);
  assert.equal(prose.passages[0].text, 'The retry limit is probably set in config.json.');
  assert.ok(
    !prose.passages.some((passage) => passage.text.includes('rm -rf')),
    'a destructive command reached the prose lane',
  );
});

test('THE TWO LANES DO NOT OVERLAP: nothing appears in both', () => {
  // The whole design rests on this. If a code block ever showed up in both, the
  // claim detector would flag comments inside it and the kernel would keep
  // seeing prose, and both halves would start crying wolf at once.
  const doc = documentWith([
    element('p', {}, ['Clear the build output, but check the path first:']),
    element('pre', {}, [element('code', {}, ['cd /var/www\nrm -rf html/*'])]),
    element('p', {}, ['That is usually safe on a staging box.']),
  ]);

  const code = HelmionExtract.collectCodeBlocks(doc).blocks.map((block) => block.text);
  const prose = HelmionExtract.collectProse(doc).passages.map((passage) => passage.text);

  assert.equal(code.length, 1);
  assert.equal(prose.length, 2);
  for (const codeText of code) {
    for (const proseText of prose) {
      assert.ok(!proseText.includes(codeText), `"${codeText}" appears in the prose lane too`);
      assert.ok(!codeText.includes(proseText), `"${proseText}" appears in the code lane too`);
    }
  }
});

test('a code block nested INSIDE a list item does not leak into that item\'s prose', () => {
  // The nasty case. The <li> is a prose passage and the <pre> inside it is a
  // code block, so one element belongs to both lanes and the text must not.
  const doc = documentWith([
    element('ul', {}, [
      element('li', {}, [
        'Run this, it is probably enough for config.json:',
        element('pre', {}, [element('code', {}, ['rm -rf /'])]),
      ]),
    ]),
  ]);

  const prose = HelmionExtract.collectProse(doc);
  assert.equal(prose.passages.length, 1);
  assert.ok(!prose.passages[0].text.includes('rm -rf'), 'the nested command leaked into the prose');
  assert.match(prose.passages[0].text, /probably enough for config\.json/);
});

test('inline <code> is dropped from prose, because the detector drops it too', () => {
  // src/core/unverified-claims.mjs stripCode replaces an inline span with a
  // space before it looks for anything. If the extension kept the span, the
  // same sentence would be flagged in the browser and not flagged in the CLI.
  // That disagreement is exactly what copying the module is meant to prevent.
  const doc = documentWith([
    element('p', {}, ['It is called ', element('code', {}, ['flushSync()']), ' I think.']),
  ]);

  const prose = HelmionExtract.collectProse(doc);
  assert.equal(prose.passages.length, 1);
  assert.ok(!prose.passages[0].text.includes('flushSync'), 'inline code survived into the prose');
  assert.equal(prose.passages[0].text, 'It is called I think.');
});

test('a wrapper that contains a paragraph is not reported alongside it', () => {
  const doc = documentWith([
    element('blockquote', {}, [element('p', {}, ['It should be under Settings > Advanced.'])]),
  ]);

  const prose = HelmionExtract.collectProse(doc);
  assert.equal(prose.passages.length, 1, 'the same sentence was reported twice');
  assert.equal(prose.passages[0].text, 'It should be under Settings > Advanced.');
});

test('the extension never reads its own notes back off the page', () => {
  // Every element HelmionUI draws carries data-helmion-ui. Without this the
  // guard would flag its own warning text, then flag the note about the note.
  const ours = element('div', { 'data-helmion-ui': '1', class: 'helmion-guard-claims' }, [
    element('ul', { 'data-helmion-ui': '1' }, [
      element('li', { 'data-helmion-ui': '1' }, ['"probably" is attached to a file path (config.json).']),
    ]),
  ]);
  const doc = documentWith([ours, element('p', {}, ['A real sentence from the reply.'])]);

  const prose = HelmionExtract.collectProse(doc);
  assert.equal(prose.passages.length, 1);
  assert.equal(prose.passages[0].text, 'A real sentence from the reply.');
});

test('when semantic markup disappears, prose falls back to tier 2 and says so', () => {
  const doc = documentWith([
    element('div', {}, [
      element('div', {}, ['The timeout is probably 30 seconds by default.']),
    ]),
  ]);

  const prose = HelmionExtract.collectProse(doc);
  assert.equal(prose.tier, 2);
  assert.equal(prose.passages.length, 1, 'the wrapper div was reported as well as the leaf');
  assert.equal(prose.passages[0].text, 'The timeout is probably 30 seconds by default.');
});

test('a page with no prose is tier 0, and that is not a failure', () => {
  const prose = HelmionExtract.collectProse(documentWith([]));
  assert.equal(prose.tier, 0);
  assert.equal(prose.passages.length, 0);
});

test('collectProse refuses a non-DOM argument instead of quietly finding nothing', () => {
  assert.throws(() => HelmionExtract.collectProse({}), /needs a DOM node/);
});

test('the tier 1 prose selector is semantic elements, not CSS classes', () => {
  assert.equal(
    HelmionExtract.PROSE_SELECTORS[0].selector,
    'p, li, blockquote, h1, h2, h3, h4, h5, h6, dd, td',
  );
});
