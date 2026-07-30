// Pulls an assistant reply apart into its two halves: code blocks, and prose.
//
// THIS FILE IS THE WHOLE REASON THE TOOL DOES NOT CRY WOLF.
//
// The destructive-command kernel is correct for its own job — checking a command
// an agent is about to run. Point it at an English sentence and it does the
// wrong thing, because an English sentence is not a command. The sentence
//
//     "You should never run rm -rf on a production server without a backup."
//
// is reported as destructive. That is advice against the command, not the
// command. Chat replies are full of sentences like it.
//
// So: prose is never scanned. Only fenced code blocks are scanned. This file is
// the step that separates the two, and every check downstream depends on it. If
// a warning ever fires on ordinary prose, this file was bypassed — look here
// before touching src/core/governance.mjs, which is right as written.
//
// Inline backticks count as prose. `rm -rf /` written mid-sentence is somebody
// naming a command, not offering one to copy, and it is deliberately not
// scanned. That is a stated limitation, not an oversight — see extension/README.md.
//
// Plain script on purpose: Chrome content scripts cannot be ES modules. It
// publishes itself on globalThis.HelmionExtract, and the Node tests load this
// exact file into a sandbox so the tests and the browser run the same code.

(function attachHelmionExtract(root) {
  'use strict';

  // Ranked, meaning-first. A redesign renames CSS classes; it does not rename
  // the <pre> element, because <pre> is what "preformatted block" IS in HTML.
  // Lower tiers exist only so a break is visible: if tier 1 finds nothing and a
  // lower tier finds something, the primary anchor has stopped working and the
  // extension says so out loud instead of going quiet.
  var BLOCK_SELECTORS = [
    { tier: 1, name: 'pre element', selector: 'pre' },
    { tier: 2, name: 'code-block test id', selector: '[data-testid*="code-block" i], [data-testid*="code_block" i]' },
    { tier: 3, name: 'code-block custom element or class', selector: 'code-block, .code-block, .code-block__code' },
  ];

  // Fenced-block scanner for raw markdown text. Used by the tests, and by any
  // future path that gets markdown rather than rendered HTML.
  //
  // A fence is three or more backticks or tildes. One backtick is inline code,
  // which is prose, which is never returned.
  //
  // An unterminated block is still returned, with closed:false — that is what a
  // reply looks like while it is still streaming, and it should be checked then,
  // not only once the model finishes typing.
  function extractFencedBlocks(markdown) {
    var lines = String(markdown == null ? '' : markdown).split(/\r?\n/);
    var blocks = [];
    var open = null;

    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];
      var fence = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*(.*)$/.exec(line);

      if (open === null) {
        if (fence) {
          open = {
            marker: fence[1].charAt(0),
            length: fence[1].length,
            lang: fence[2].trim(),
            lines: [],
          };
        }
        continue;
      }

      var closes = fence
        && fence[1].charAt(0) === open.marker
        && fence[1].length >= open.length
        && fence[2].trim() === '';

      if (closes) {
        blocks.push({ lang: open.lang, code: open.lines.join('\n'), closed: true });
        open = null;
        continue;
      }

      open.lines.push(line);
    }

    if (open !== null) {
      blocks.push({ lang: open.lang, code: open.lines.join('\n'), closed: false });
    }

    return blocks;
  }

  // Text of one rendered code block. Prefer the inner <code>, because some sites
  // put a language label and a Copy button inside the <pre> alongside the code.
  function blockText(element) {
    var inner = element.querySelector ? element.querySelector('code') : null;
    var target = inner || element;
    return String(target.textContent == null ? '' : target.textContent);
  }

  // Rendered-DOM scanner. Returns { tier, tierName, blocks }.
  //
  // Only block-level code is collected. A bare <code> that is not inside a <pre>
  // is inline code, which is prose, and is never collected — the selectors below
  // start at <pre> for exactly that reason.
  function collectCodeBlocks(root) {
    var scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope || typeof scope.querySelectorAll !== 'function') {
      throw new Error('HelmionExtract.collectCodeBlocks needs a DOM node to search');
    }

    for (var i = 0; i < BLOCK_SELECTORS.length; i += 1) {
      var entry = BLOCK_SELECTORS[i];
      var found = scope.querySelectorAll(entry.selector);
      var elements = Array.prototype.slice.call(found);
      if (elements.length === 0) continue;

      var blocks = [];
      for (var j = 0; j < elements.length; j += 1) {
        var element = elements[j];
        blocks.push({ element: element, text: blockText(element) });
      }
      return { tier: entry.tier, tierName: entry.name, blocks: blocks };
    }

    return { tier: 0, tierName: 'nothing matched', blocks: [] };
  }

  // ─── PROSE, WHICH IS THE OTHER LANE'S ENTIRE INPUT ────────────────────────
  //
  // Everything above exists to keep prose AWAY from the destructive-command
  // kernel. Everything below exists to hand prose, and only prose, to the
  // unsourced-claim detector. The two lanes read the same page and must never
  // read the same text.
  //
  // Semantic, meaning-first, for the same reason the code selectors start at
  // <pre>: a redesign renames CSS classes, it does not stop rendering a
  // paragraph as <p>. Markdown — which is what all three sites render a reply
  // from — produces exactly these elements.

  var PROSE_SELECTORS = [
    {
      tier: 1,
      name: 'semantic prose elements',
      selector: 'p, li, blockquote, h1, h2, h3, h4, h5, h6, dd, td',
      // A candidate that contains another candidate is a wrapper, not a
      // passage. Taking both would report the same sentence twice.
      nesting: 'p, li, blockquote, h1, h2, h3, h4, h5, h6, dd, td',
    },
    {
      tier: 2,
      name: 'block-level text leaves',
      // Only reached when a site stops using semantic markup altogether. A
      // <div> holding text and nothing block-level is that site's paragraph.
      selector: 'div',
      nesting: 'div, p, li, blockquote, pre, table, ul, ol',
    },
  ];

  // Never read from, in either tier.
  //
  //   pre   rendered fenced code. The other lane owns it.
  //   code  inline code. src/core/unverified-claims.mjs strips inline spans in
  //         its own stripCode, so leaving them in here would make the extension
  //         disagree with the module it copies — and the module is the source
  //         of truth. It is stated as a limitation, not hidden: "it's called
  //         `flushSync()` I think" carries its referent inside the span and is
  //         therefore not flagged, in the CLI and here alike.
  //   textarea / script / style   not reply text at all.
  //   [data-helmion-ui]  our own notes. Reading them would let the extension
  //         flag its own output and then flag that.
  var PROSE_SKIP_TAGS = ['PRE', 'CODE', 'SCRIPT', 'STYLE', 'TEXTAREA', 'NOSCRIPT'];

  function isSkippedForProse(node) {
    if (PROSE_SKIP_TAGS.indexOf(String(node.tagName || '').toUpperCase()) !== -1) return true;
    return Boolean(node.getAttribute && node.getAttribute('data-helmion-ui'));
  }

  // Mirrors src/core/unverified-claims.mjs stripCode against a rendered tree
  // rather than raw markdown: a fenced block becomes a newline, an inline span
  // becomes a space. Same substitutions, so sentence splitting downstream lands
  // in the same places for the same reply.
  function proseText(element) {
    var out = '';
    var children = element.childNodes || [];
    for (var i = 0; i < children.length; i += 1) {
      var node = children[i];
      if (node.nodeType === 3) {
        out += String(node.data == null ? '' : node.data);
        continue;
      }
      if (node.nodeType !== 1) continue;
      var tag = String(node.tagName || '').toUpperCase();
      if (tag === 'PRE') { out += '\n'; continue; }
      if (isSkippedForProse(node)) { out += ' '; continue; }
      out += proseText(node);
    }
    return out;
  }

  function insideSkippedRegion(element) {
    if (typeof element.closest !== 'function') return false;
    return Boolean(element.closest('pre, code, textarea, [data-helmion-ui]'));
  }

  function hasNestedCandidate(element, nestingSelector) {
    if (typeof element.querySelector !== 'function') return false;
    return Boolean(element.querySelector(nestingSelector));
  }

  // Rendered-DOM prose scanner. Returns { tier, tierName, passages }, shaped
  // like collectCodeBlocks so guard.js can treat a broken anchor the same way in
  // both lanes.
  function collectProse(root) {
    var scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope || typeof scope.querySelectorAll !== 'function') {
      throw new Error('HelmionExtract.collectProse needs a DOM node to search');
    }

    for (var i = 0; i < PROSE_SELECTORS.length; i += 1) {
      var entry = PROSE_SELECTORS[i];
      var found = Array.prototype.slice.call(scope.querySelectorAll(entry.selector));
      var passages = [];

      for (var j = 0; j < found.length; j += 1) {
        var element = found[j];
        if (insideSkippedRegion(element)) continue;
        if (hasNestedCandidate(element, entry.nesting)) continue;
        var value = proseText(element).replace(/[ \t]+/g, ' ').trim();
        if (!value) continue;
        passages.push({ element: element, text: value });
      }

      if (passages.length > 0) {
        return { tier: entry.tier, tierName: entry.name, passages: passages };
      }
    }

    return { tier: 0, tierName: 'nothing matched', passages: [] };
  }

  var api = {
    BLOCK_SELECTORS: BLOCK_SELECTORS,
    PROSE_SELECTORS: PROSE_SELECTORS,
    extractFencedBlocks: extractFencedBlocks,
    collectCodeBlocks: collectCodeBlocks,
    collectProse: collectProse,
    proseText: proseText,
    blockText: blockText,
  };

  root.HelmionExtract = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
