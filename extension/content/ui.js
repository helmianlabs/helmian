// Everything the extension draws on the page.
//
// Three things, and only three:
//
//   1. A warning attached to a code block that matched a destructive pattern.
//      Red, named pattern, exact offending line quoted. The block itself is
//      hidden behind it, so copying it takes a second deliberate click.
//   2. A toast pinned to the corner, so a warning further up the page is still
//      noticed when he has already scrolled past it.
//   3. A broken banner across the top of the page. This is the important one.
//      A safety tool that quietly stops working looks exactly like one that
//      found nothing wrong. When anything in this extension fails, the page
//      says so.
//
// Every element carries data-helmion-ui, which is how stream-watch.js tells our
// own page changes apart from the site's and does not re-trigger itself.
//
// Plain script: content scripts cannot be ES modules. Publishes
// globalThis.HelmionUI.

(function attachHelmionUI(root) {
  'use strict';

  var PREFIX = 'helmion-guard';
  var MASK_CLASS = PREFIX + '-masked';

  function host() {
    if (typeof document === 'undefined') return null;
    return document.body || document.documentElement;
  }

  function make(tag, className, text) {
    var element = document.createElement(tag);
    element.setAttribute('data-helmion-ui', '1');
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  // ---------------------------------------------------------------- warnings

  function clearWarning(blockElement) {
    if (!blockElement) return;
    var id = blockElement.getAttribute('data-helmion-warning-id');
    if (id) {
      var panel = document.querySelector('[data-helmion-warning-for="' + id + '"]');
      if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
      blockElement.removeAttribute('data-helmion-warning-id');
    }
    clearUnchecked(blockElement);
    blockElement.classList.remove(MASK_CLASS);
  }

  // ------------------------------------------------------- unchecked notice

  // Some lines can be too long for the scanner to examine. That is neither a
  // match nor a clean result, and showing nothing would let a partly-checked
  // block look exactly like a fully-checked one. This says which lines were
  // skipped and why, in the same place the warning would appear.

  function clearUnchecked(blockElement) {
    if (!blockElement) return;
    var id = blockElement.getAttribute('data-helmion-unchecked-id');
    if (!id) return;
    var existing = document.querySelector('[data-helmion-unchecked-for="' + id + '"]');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    blockElement.removeAttribute('data-helmion-unchecked-id');
  }

  // unchecked: [{ lineNumber, reason }]
  function noteUnchecked(blockElement, unchecked) {
    if (!blockElement) return null;
    var lines = unchecked || [];
    clearUnchecked(blockElement);
    if (lines.length === 0) return null;

    var id = blockElement.getAttribute('data-helmion-id') || ('helmion-u-' + Date.now());
    blockElement.setAttribute('data-helmion-unchecked-id', id);

    var notice = make('div', PREFIX + '-unchecked');
    notice.setAttribute('data-helmion-unchecked-for', id);
    notice.setAttribute('role', 'status');
    notice.appendChild(make(
      'span',
      PREFIX + '-unchecked-title',
      lines.length === 1
        ? 'Helmion Guard did not check line ' + lines[0].lineNumber + ' of this block.'
        : 'Helmion Guard did not check ' + lines.length + ' lines of this block.',
    ));
    notice.appendChild(make('span', PREFIX + '-unchecked-detail', lines[0].reason));

    var anchor = blockElement.parentNode;
    if (anchor) anchor.insertBefore(notice, blockElement);
    return notice;
  }

  // finding: { id, hits: [patternName], findings: [{ lineNumber, text, hits }] }
  function warnBlock(blockElement, finding, options) {
    if (!blockElement) return null;
    var settings = options || {};
    var mask = settings.mask !== false;

    clearWarning(blockElement);

    var id = finding && finding.id ? String(finding.id) : ('helmion-' + Date.now());
    blockElement.setAttribute('data-helmion-warning-id', id);

    var panel = make('div', PREFIX + '-panel');
    panel.setAttribute('data-helmion-warning-for', id);
    panel.setAttribute('role', 'alert');

    var header = make('div', PREFIX + '-panel-header');
    header.appendChild(make('span', PREFIX + '-badge', 'HELMION GUARD'));
    header.appendChild(make(
      'span',
      PREFIX + '-headline',
      'This code block contains a destructive command.',
    ));
    panel.appendChild(header);

    var reasons = (finding && finding.hits) || [];
    if (reasons.length > 0) {
      panel.appendChild(make(
        'div',
        PREFIX + '-reason',
        'Matched: ' + reasons.join(', '),
      ));
    }

    var lines = (finding && finding.findings) || [];
    if (lines.length > 0) {
      var list = make('ul', PREFIX + '-lines');
      for (var i = 0; i < lines.length; i += 1) {
        var item = make('li', PREFIX + '-line');
        item.appendChild(make('span', PREFIX + '-line-number', 'line ' + lines[i].lineNumber));
        item.appendChild(make('code', PREFIX + '-line-text', lines[i].text));
        list.appendChild(item);
      }
      panel.appendChild(list);
    }

    if (mask) {
      blockElement.classList.add(MASK_CLASS);
      var reveal = make('button', PREFIX + '-reveal', 'Show the code anyway');
      reveal.type = 'button';
      reveal.addEventListener('click', function onReveal() {
        blockElement.classList.remove(MASK_CLASS);
        reveal.parentNode.removeChild(reveal);
        panel.appendChild(make(
          'div',
          PREFIX + '-revealed',
          'Shown at your request. The warning above still stands.',
        ));
      });
      panel.appendChild(reveal);
    }

    var anchor = blockElement.parentNode;
    if (anchor) anchor.insertBefore(panel, blockElement);
    return panel;
  }

  // ------------------------------------------------------------------- toast

  var toastElement = null;

  function hideToast() {
    if (toastElement && toastElement.parentNode) toastElement.parentNode.removeChild(toastElement);
    toastElement = null;
  }

  function showToast(message, detail) {
    var parent = host();
    if (!parent) return null;
    hideToast();

    toastElement = make('div', PREFIX + '-toast');
    toastElement.setAttribute('role', 'alert');
    toastElement.appendChild(make('div', PREFIX + '-toast-title', message));
    if (detail) toastElement.appendChild(make('div', PREFIX + '-toast-detail', detail));

    var close = make('button', PREFIX + '-toast-close', 'Dismiss');
    close.type = 'button';
    close.addEventListener('click', hideToast);
    toastElement.appendChild(close);

    parent.appendChild(toastElement);
    return toastElement;
  }

  // ------------------------------------------------------------------ banner

  var bannerElement = null;

  function hideBanner() {
    if (bannerElement && bannerElement.parentNode) {
      bannerElement.parentNode.removeChild(bannerElement);
    }
    bannerElement = null;
  }

  // Loud by design. This is what makes a silent failure impossible.
  function showBanner(message, detail) {
    var parent = host();
    if (!parent) return null;
    hideBanner();

    bannerElement = make('div', PREFIX + '-banner');
    bannerElement.setAttribute('role', 'alert');
    bannerElement.appendChild(make(
      'strong',
      PREFIX + '-banner-title',
      'HELMION GUARD IS NOT WATCHING THIS PAGE',
    ));
    bannerElement.appendChild(make('span', PREFIX + '-banner-message', message));
    if (detail) bannerElement.appendChild(make('span', PREFIX + '-banner-detail', detail));

    parent.appendChild(bannerElement);
    return bannerElement;
  }

  root.HelmionUI = {
    PREFIX: PREFIX,
    MASK_CLASS: MASK_CLASS,
    warnBlock: warnBlock,
    clearWarning: clearWarning,
    noteUnchecked: noteUnchecked,
    clearUnchecked: clearUnchecked,
    showToast: showToast,
    hideToast: hideToast,
    showBanner: showBanner,
    hideBanner: hideBanner,
  };
}(typeof globalThis !== 'undefined' ? globalThis : this));
