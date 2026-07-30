// Everything the extension draws on the page.
//
// Two channels, kept apart on purpose.
//
// RED — a destructive command. Somebody handed you something that deletes.
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
// QUIET — an unsourced claim. Somebody stated a checkable fact and did not say
// where it came from. It is a reading aid, it is wrong often enough that its own
// source file lists the ways, and it is never allowed to borrow the red channel:
//
//   4. A note beside the paragraph, and a dotted underline on the paragraph.
//      Nothing is hidden, nothing is masked, and it never touches the badge.
//   5. Its own banner, saying only that the reading aid stopped — never that the
//      guard stopped watching, because that would be false.
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
  // Marks a paragraph that carries an unsourced claim. A dotted underline and
  // nothing else — it is deliberately NOT MASK_CLASS, and the two must never be
  // used interchangeably.
  var CLAIM_CLASS = PREFIX + '-claim-marked';

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

  // Clears the RED WARNING and nothing else.
  //
  // It used to clear the amber "part of this block was not checked" notice as
  // well, and that made the two impossible to have at once. warnBlock starts by
  // calling this, so on a block that was both dangerous AND part-unchecked the
  // notice was drawn by guard.js and then destroyed a line later, inside the
  // same pass. The page showed a red panel, which reads as "I examined this
  // block", over a block part of which nobody had examined.
  //
  // The two states are independent — a block can be either, both or neither —
  // so their teardown is independent too. That is stronger than fixing the call
  // order, which the next person to touch applyResults could undo without
  // noticing. Whoever resets a block resets both, explicitly.
  function clearWarning(blockElement) {
    if (!blockElement) return;
    var id = blockElement.getAttribute('data-helmion-warning-id');
    if (id) {
      var panel = document.querySelector('[data-helmion-warning-for="' + id + '"]');
      if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
      blockElement.removeAttribute('data-helmion-warning-id');
    }
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

  // ------------------------------------------------------- unverified claims

  // The advisory lane's only visible output.
  //
  // IT NEVER MASKS AND IT NEVER HIDES ANYTHING. warnBlock above puts a code
  // block behind a cover because a destructive command is worth an extra
  // deliberate click. A sentence is not: the finding here is "this fact was
  // stated without a source", the detector's own source file lists four ways it
  // can be wrong, and covering a paragraph over a machine's opinion about
  // English would make the tool something Troy switches off. There is no mask
  // class in this section and there must never be one.
  //
  // It is also kept out of the red channel entirely — no toast, no badge count.
  // Red means somebody handed you a command that destroys something.

  function clearClaims(element) {
    if (!element) return;
    var id = element.getAttribute('data-helmion-claims-id');
    if (!id) return;
    var existing = document.querySelector('[data-helmion-claims-for="' + id + '"]');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    element.removeAttribute('data-helmion-claims-id');
    element.classList.remove(CLAIM_CLASS);
  }

  // result: { claims: [{ sentence, marker, referentKind, referent, reason }] }
  function noteClaims(element, result) {
    if (!element) return null;
    var claims = (result && result.claims) || [];
    clearClaims(element);
    if (claims.length === 0) return null;

    var id = (result && result.id) ? String(result.id) : ('helmion-c-' + Date.now());
    element.setAttribute('data-helmion-claims-id', id);
    element.classList.add(CLAIM_CLASS);

    var note = make('div', PREFIX + '-claims');
    note.setAttribute('data-helmion-claims-for', id);
    // role=note, not role=alert. An alert interrupts a screen reader mid
    // sentence, and this is a footnote, not an emergency.
    note.setAttribute('role', 'note');

    var header = make('div', PREFIX + '-claims-header');
    header.appendChild(make('span', PREFIX + '-claims-badge', 'UNVERIFIED CLAIM'));
    header.appendChild(make(
      'span',
      PREFIX + '-claims-headline',
      claims.length === 1
        ? 'A fact here is stated without a source.'
        : claims.length + ' facts here are stated without a source.',
    ));
    note.appendChild(header);

    var list = make('ul', PREFIX + '-claims-list');
    for (var i = 0; i < claims.length; i += 1) {
      var item = make('li', PREFIX + '-claims-item', claims[i].reason);
      // The kind travels onto the element so a later phase can style or filter
      // by it without re-parsing the sentence.
      item.setAttribute('data-helmion-referent-kind', String(claims[i].referentKind || ''));
      list.appendChild(item);
    }
    note.appendChild(list);

    note.appendChild(make(
      'span',
      PREFIX + '-claims-footer',
      'Helmion checked whether this was sourced, not whether it is true.',
    ));

    var anchor = element.parentNode;
    if (anchor) anchor.insertBefore(note, element);
    return note;
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

  // ------------------------------------------------------- advisory banner

  // The claim lane's version of showBanner, and it says something different on
  // purpose. showBanner claims the guard is not watching the page, which is
  // about destructive commands and would be a lie if only the reading aid had
  // failed. Two lanes, two honest sentences.

  var advisoryBannerElement = null;

  function hideAdvisoryBanner() {
    if (advisoryBannerElement && advisoryBannerElement.parentNode) {
      advisoryBannerElement.parentNode.removeChild(advisoryBannerElement);
    }
    advisoryBannerElement = null;
  }

  function showAdvisoryBanner(message, detail) {
    var parent = host();
    if (!parent) return null;
    hideAdvisoryBanner();

    advisoryBannerElement = make('div', PREFIX + '-advisory-banner');
    advisoryBannerElement.setAttribute('role', 'status');
    advisoryBannerElement.appendChild(make(
      'strong',
      PREFIX + '-advisory-banner-title',
      'HELMION GUARD IS NOT READING THIS PAGE FOR UNSOURCED CLAIMS',
    ));
    advisoryBannerElement.appendChild(make('span', PREFIX + '-advisory-banner-message', message));
    if (detail) {
      advisoryBannerElement.appendChild(make('span', PREFIX + '-advisory-banner-detail', detail));
    }
    // Said plainly, because the two lanes fail independently and a reader who
    // sees this needs to know which half is still working.
    advisoryBannerElement.appendChild(make(
      'span',
      PREFIX + '-advisory-banner-detail',
      'Destructive-command checking is unaffected and still running.',
    ));

    parent.appendChild(advisoryBannerElement);
    return advisoryBannerElement;
  }

  root.HelmionUI = {
    PREFIX: PREFIX,
    MASK_CLASS: MASK_CLASS,
    CLAIM_CLASS: CLAIM_CLASS,
    warnBlock: warnBlock,
    clearWarning: clearWarning,
    noteUnchecked: noteUnchecked,
    clearUnchecked: clearUnchecked,
    noteClaims: noteClaims,
    clearClaims: clearClaims,
    showToast: showToast,
    hideToast: hideToast,
    showBanner: showBanner,
    hideBanner: hideBanner,
    showAdvisoryBanner: showAdvisoryBanner,
    hideAdvisoryBanner: hideAdvisoryBanner,
  };
}(typeof globalThis !== 'undefined' ? globalThis : this));
