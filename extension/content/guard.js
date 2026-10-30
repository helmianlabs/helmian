// The content script that ties everything together.
//
// It runs on claude.ai, chatgpt.com and gemini.google.com, and it makes TWO
// passes over every settled change to the page.
//
//   THE CODE LANE, and it is the one that matters. Pulls the code blocks out of
//   the conversation, sends them to the background worker, and draws a red
//   warning on any block whose lines match Helmion's destructive-command
//   patterns. Prose is never sent to it.
//
//   THE CLAIM LANE, which is a reading aid. Pulls the PROSE out — never the code
//   — and notes any sentence that welds a hedge onto a checkable fact. It flags,
//   it never blocks, it never masks, and it never touches the red badge.
//
//   THE PROMPT LANE. Reads only the active chat composer at send time and stops
//   explicit requests to erase an entire machine, drive or data set before the
//   host page can submit them.
//
//   THE PRIVACY LANE (active interceptor). At send time and on paste, finds
//   keys, passwords, tokens, card numbers and personal details headed for the
//   AI (content/sanitize.js). Secrets pasted in are redacted before they land
//   in the composer. At send, the decision comes from Executive Guard when the
//   user paired one (signed, verified in background/executive.js) and from the
//   same policy run locally when not: deny (redact first), or ask (the person,
//   or an Executive Guard approver, decides).
//
//   THE FLAGS LANE. Reads the reply once streaming stops and raises a small
//   corner card for evasion, a privacy leak, or harmful code
//   (content/flags.js). It never hides anything. Each flag is logged and, if
//   the user opted in, reported to the Flags API by the worker.
//
// The two share a page and a worker and nothing else: separate state, separate
// self-tests, separate health state, separate failure counters. Either can be
// broken while the other keeps working, and the toolbar reports each honestly.
//
// It fails loud. Every path that can break — the worker not answering, the page
// never changing or an exception anywhere — produces a bounded plain-language
// alert and marks the toolbar. Compatibility paths stay off the page. A safety
// tool that goes quiet is indistinguishable from one that found nothing wrong,
// so a real protection failure is never allowed to go quiet.
//
// Load order is set in manifest.json: extract.js, stream-watch.js, ui.js, then
// this file.

(function helmionGuard() {
  'use strict';

  // ------------------------------------------------------------------ config

  // Hide a flagged code block behind its warning, so copying it needs a second
  // deliberate click. Set to false and the block stays visible while the
  // warning, the toast and the badge all still work. One word, nothing else to
  // change.
  //
  // It is NOT a read-only build. This comment used to claim that and it was
  // wrong: even with masking off, the extension still writes bookkeeping
  // attributes onto each code block (blockId, markSeen) and still inserts its
  // own warning, toast and banner elements into the page. Nothing here ever
  // "only reads the page."
  const MASK_DANGEROUS_BLOCKS = true;

  const WORKER_TIMEOUT_MS = 5000;
  const HEALTH_INTERVAL_MS = 60000;
  const FAILURES_BEFORE_BANNER = 3;
  // Below this much visible text the page is still loading, and an observer
  // that has not fired yet means nothing.
  const MIN_PAGE_TEXT_FOR_HEALTH = 2000;

  // Run through the real path on startup and prove the chain works. Anything
  // matching the first string must be reported destructive; the second must
  // come back clean. One catches a chain that has stopped detecting, the other
  // catches a chain stuck reporting everything.
  const PROBE_DANGEROUS = 'rm -rf /helmion-selftest-probe';
  const PROBE_CLEAN = 'echo helmion-selftest-probe';

  // The same idea for the claim lane, and it takes three probes rather than two
  // because that lane fires on TWO signals and either one missing must silence
  // it. One string proves it still detects; the other two prove it still
  // refuses, once for a missing marker and once for a missing referent. Two
  // probes could not tell "the detector is stuck flagging everything" apart
  // from "the two-signal rule is intact".
  const PROBE_UNSOURCED = 'The retry limit is probably set in helmion-selftest.json somewhere.';
  const PROBE_MARKER_ONLY = 'I think we should take the second route through the woods.';
  const PROBE_REFERENT_ONLY = 'The retry limit is set in helmion-selftest.json.';

  // Where a block came from, for the block ledger's `source` field. Every real
  // scan names it; the self-test probes above deliberately do NOT, which is what
  // keeps them out of the ledger — see background/scan.js scanBlocks. The
  // hostname is all that is sent: the conversation URL would put a page a user
  // may consider private into an audit record, and the site is the part that
  // matters for evidence.
  const SOURCE = (typeof window !== 'undefined' && window.location
    && window.location.hostname) || 'unknown-site';

  // ------------------------------------------------------------------- state

  const state = {
    broken: false,
    degraded: false,
    // id -> element, not a bare Set of ids. Pruning needs the element itself so
    // it can ask `isConnected` instead of looking the id up with a selector
    // built by string concatenation — see pruneDetached.
    dangerousIds: new Map(),
    promptRiskActive: false,
    lastPromptFingerprint: '',
    lastPromptBlockedAt: 0,
    // Privacy lane / Executive Guard loop. allowOnce is the fingerprint of the
    // ONE exact text the person (or an approver) said may go out; it is used up
    // by the next send of that text and by nothing else.
    allowOnce: null,
    privacyActiveFp: null,
    privacyShownAt: 0,
    approvalTimer: null,
    // Optional cross-check with the Flags scanner (POST /api/flags/scan), off
    // unless the person turned it on in the popup. Cached from the worker.
    flagsScan: false,
    scanActiveFp: null,
    scanShownAt: 0,
    // Flags lane: fingerprints already shown and reported on this page.
    flagsShown: new Set(),
    // Block-ledger tally for this tab. Counted separately from dangerousIds
    // because "we warned about it" and "it reached the ledger" are two different
    // facts, and a browser-layer event only reaches an in-worker QUEUE today —
    // see the long comment in background/scan.js. Nothing here claims the event
    // is durable, because it is not.
    auditRecorded: 0,
    auditUnrecorded: 0,
    healthFailures: 0,
    lastTier: null,
    lastStreaming: false,
    nextId: 1,

    // ─── the claim lane, tracked entirely separately ───────────────────────
    //
    // Not one shared "broken" flag, not one shared counter, not one shared
    // banner. The two lanes answer different questions and fail for different
    // reasons, and folding them together would mean either a dead reading aid
    // claiming the guard had stopped watching, or a dead guard hiding behind a
    // working reading aid. Both are lies, so the state is kept apart.
    claimIds: new Map(),
    claimsBroken: false,
    claimsDegraded: false,
    claimsHealthFailures: 0,
    lastProseTier: null,
    nextProseId: 1,
  };

  // ------------------------------------------------------------------- fatal

  function fail(message, detail) {
    state.broken = true;
    try {
      HelmionUI.showBanner(message, detail);
    } catch (uiError) {
      // Even the banner failed. The console is the last place left to say it.
      console.error('[Helmion Guard] could not draw its own failure banner:', uiError);
    }
    console.error('[Helmion Guard] NOT WATCHING:', message, detail || '');
    sendBadge();
    sendStatus();
  }

  function recover() {
    if (!state.broken) return;
    state.broken = false;
    state.healthFailures = 0;
    HelmionUI.hideBanner();
    sendBadge();
    sendStatus();
  }

  // ------------------------------------------------------------------ worker

  function askWorker(message) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`the background worker did not answer within ${WORKER_TIMEOUT_MS}ms`));
      }, WORKER_TIMEOUT_MS);

      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };

      try {
        chrome.runtime.sendMessage(message, (response) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            finish(new Error(`background worker unreachable: ${lastError.message}`));
            return;
          }
          if (!response) {
            finish(new Error('background worker answered with nothing'));
            return;
          }
          if (response.ok !== true) {
            finish(new Error(`background worker reported an error: ${response.error || 'unknown'}`));
            return;
          }
          finish(null, response);
        });
      } catch (error) {
        finish(new Error(`could not reach the background worker: ${error.message}`));
      }
    });
  }

  function sendBadge() {
    const message = {
      type: 'helmion:badge',
      dangerous: state.dangerousIds.size + (state.promptRiskActive ? 1 : 0),
      broken: state.broken,
      degraded: state.degraded,
    };
    try {
      chrome.runtime.sendMessage(message, () => {
        // Reading lastError stops Chrome logging an unchecked-error warning.
        void chrome.runtime.lastError;
      });
    } catch (error) {
      console.warn('[Helmion Guard] badge update failed:', error.message);
    }
  }

  // Plain, bounded state for the toolbar popup. Internal exception, parser and
  // anchor details remain in the console and never become user-facing text.
  function sendStatus() {
    const message = {
      type: 'helmion:status',
      protection: state.broken ? 'needs-attention' : (state.degraded ? 'limited' : 'active'),
      claims: state.claimsBroken ? 'unavailable' : (state.claimsDegraded ? 'limited' : 'active'),
    };
    try {
      chrome.runtime.sendMessage(message, () => { void chrome.runtime.lastError; });
    } catch (error) {
      console.warn('[Helmion Guard] status update failed:', error.message);
    }
  }

  // ------------------------------------------------------------------- scan

  // THE PAGE DOES NOT GET TO NAME ITS OWN BLOCKS.
  //
  // Until 2026-08-03 this read `data-helmion-id` back off the element and only
  // minted a new id when the attribute was absent — so a page could choose the
  // id, and choose the SAME id for two blocks. applyResults builds
  // `new Map(results.map(r => [r.id, r]))`, where last-wins, so a harmless block
  // sharing an id with a dangerous one handed its clean verdict to both and the
  // warning was never drawn. Reproduced against the real worker: a `rm -rf /data`
  // block followed by an `echo hello` block carrying the same forged id produced
  // zero panels, no mask, an empty badge — while the self-test still logged
  // "watching this page". That is exactly the silent-failure mode this file's
  // own header forbids.
  //
  // Identity now lives in a WeakMap, which is unreachable from page script and
  // dies with the element. The attribute is still WRITTEN, because ui.js and
  // guard.css key off it — but it is never READ as authority again.
  const blockIds = new WeakMap();

  function blockId(element) {
    let id = blockIds.get(element);
    if (!id) {
      id = `hg-${state.nextId}`;
      state.nextId += 1;
      blockIds.set(element, id);
      element.setAttribute('data-helmion-id', id);
    }
    return id;
  }

  // Identifies a block's CONTENT, so an unchanged block is not rescanned on
  // every mutation. This used to be the text's length alone, which meant any
  // edit that happened to preserve the character count was invisible and the
  // block was never checked again. Length is kept as the cheap first half and
  // a djb2 hash of the text as the second, because the failure mode of a
  // safety check is not "slightly slower", it is "silently stopped looking".
  function fingerprint(text) {
    let hash = 5381;
    for (let index = 0; index < text.length; index += 1) {
      hash = (((hash << 5) + hash) ^ text.charCodeAt(index)) >>> 0;
    }
    return `${text.length}:${hash.toString(36)}`;
  }

  // The seen-fingerprint is kept in a WeakMap per lane, NOT in a DOM attribute.
  //
  // It lived in `data-helmion-seen` until 2026-08-03. fingerprint() above is a
  // plain djb2 over the block's own text — fully deterministic, so any page can
  // compute it — and hasChanged() trusted whatever the attribute said. A page
  // that pre-stamped the correct fingerprint onto its own <pre> was recorded as
  // already-checked and never scanned once. Reproduced: zero panels, no mask,
  // empty badge, and the force rescan does not save it, because state.lastStreaming
  // starts false so `lastStreaming && !streaming` never fires on a freshly opened
  // conversation. A shared conversation link was a complete, silent bypass.
  //
  // Two maps, not one, for the reason the old comment gives: the two lanes read
  // DIFFERENT text off the same element and must not share a fingerprint, or one
  // lane marking an element seen stops the other from ever looking at it.
  const seenCode = new WeakMap();
  const seenProse = new WeakMap();
  const seenFlags = new WeakMap();

  const SEEN_ATTR = 'code';
  const PROSE_SEEN_ATTR = 'prose';
  const FLAGS_SEEN_ATTR = 'flags';

  function seenMapFor(lane) {
    if (lane === FLAGS_SEEN_ATTR) return seenFlags;
    return lane === PROSE_SEEN_ATTR ? seenProse : seenCode;
  }

  function hasChanged(element, text, lane) {
    return seenMapFor(lane).get(element) !== fingerprint(text);
  }

  function markSeen(element, text, lane) {
    seenMapFor(lane).set(element, fingerprint(text));
  }

  function forgetSeen(element, lane) {
    seenMapFor(lane).delete(element);
  }

  // A flagged block can leave the page without us ever seeing it again — the
  // site swaps conversations, or re-renders a message. Its id used to stay in
  // dangerousIds forever, so the red count only ever climbed and the toast
  // could never clear (that path needs size === 0). Drop ids whose element is
  // no longer in the document.
  // Asks the ELEMENT whether it is still in the document. This used to build
  // `[data-helmion-id="${id}"]` and hand it to querySelector — which, when the
  // page chose the id (it could, until 2026-08-03), let a value like `a"]` throw
  // a SyntaxError per the DOM spec. Nothing here is inside a try, and runPass is
  // called un-awaited, so the throw became an unhandled rejection that only
  // console.error'd: state.broken stayed false, no banner drew, the badge stayed
  // clean, and the whole pass died quietly. isConnected needs no selector at all.
  function pruneDetached() {
    const before = state.dangerousIds.size;
    for (const [id, element] of [...state.dangerousIds]) {
      if (!element || !element.isConnected) state.dangerousIds.delete(id);
    }
    if (state.dangerousIds.size === before) return false;
    if (state.dangerousIds.size === 0) HelmionUI.hideToast();
    sendBadge();
    return true;
  }

  // options.force rescans every block on the page even if its content has not
  // changed. Used when the reply has just finished streaming.
  async function runPass(options) {
    let collected;
    try {
      collected = HelmionExtract.collectCodeBlocks(document);
    } catch (error) {
      fail('the extension could not read this page.', error.message);
      return;
    }

    // Tier 1 is the <pre> element. A lower tier is still protected, but its
    // limited state is reported through the compact toolbar indicator/popup —
    // never through a page-covering diagnostic.
    if (collected.tier > 1 && collected.tier !== state.lastTier) {
      state.degraded = true;
      sendBadge();
      sendStatus();
    } else if (collected.tier === 1 && state.degraded) {
      state.degraded = false;
      HelmionUI.hideBanner();
      sendBadge();
      sendStatus();
    }
    state.lastTier = collected.tier;

    const force = Boolean(options && options.force);
    const pending = [];
    for (const block of collected.blocks) {
      const element = block.element;
      const id = blockId(element);
      // A block whose text has not changed since the last pass is not scanned
      // again. Without this, streaming would rescan every block on the page
      // several times a second.
      if (!force && !hasChanged(element, block.text)) continue;
      markSeen(element, block.text);
      pending.push({ id, element, text: block.text });
    }

    if (pending.length === 0) {
      pruneDetached();
      return;
    }

    let response;
    try {
      response = await askWorker({
        type: 'helmion:scan',
        // `source` travels per block because background/worker.js:53 hands
        // message.blocks straight to scanBlocks — a per-block field is the only
        // route to the scanner that does not need the worker changed.
        blocks: pending.map((block) => ({ id: block.id, text: block.text, source: SOURCE })),
      });
    } catch (error) {
      // Undo the seen markers so these blocks are retried on the next pass
      // rather than being skipped forever because of one failed round trip.
      pending.forEach((block) => forgetSeen(block.element));
      fail('the checks are not running.', error.message);
      return;
    }

    recover();
    applyResults(pending, response.results || []);
  }

  // Tally what reached the block ledger, and say so when something did not.
  //
  // A blocked code block that produced no ledger row is a gap in the evidence,
  // and the one thing this extension is never allowed to do is let a gap look
  // like a clean result. It is a console warning rather than a page banner
  // because the CHECK still worked and the user is still protected — the banner
  // is reserved for "the guard is not watching".
  // ─── THE DURABLE LEDGER ───────────────────────────────────────────────────
  //
  // Fire-and-forget by design. A ledger write must never delay or block a
  // warning appearing on the page: the user seeing the flag is the product, the
  // record is the receipt. A failed write logs to the console and nothing else
  // stops.
  function logToLedger(entry) {
    try {
      chrome.runtime.sendMessage({ type: 'helmion:log', entry }, (response) => {
        void chrome.runtime.lastError;
        if (response && response.ok !== true) {
          console.warn('[Helmion Guard] ledger write failed:', response.error);
        }
      });
    } catch (error) {
      console.warn('[Helmion Guard] could not reach the ledger:', error.message);
    }
  }

  // Best-effort. Empty is a legitimate answer and the row records it as such.
  function conversationContext() {
    try {
      return HelmionExtract.lastUserMessage(document) || '';
    } catch (error) {
      return '';
    }
  }

  // ------------------------------------------------------------ prompt lane

  const COMPOSER_SELECTOR = 'textarea, [contenteditable="true"], [role="textbox"]';

  function composerText(element) {
    if (!element) return '';
    if (typeof element.value === 'string') return element.value;
    return String(element.innerText == null ? element.textContent : element.innerText).trim();
  }

  function eventComposer(event) {
    const path = event && typeof event.composedPath === 'function'
      ? event.composedPath() : [event && event.target].filter(Boolean);
    const roots = new Set([document]);

    for (const node of path) {
      if (node && typeof node.closest === 'function') {
        const direct = node.closest(COMPOSER_SELECTOR);
        if (direct) return direct;
      }
      if (node && typeof node.getRootNode === 'function') roots.add(node.getRootNode());
    }

    // Gemini may move focus into an open shadow root. Walk through the focused
    // hosts before falling back to a page-wide selector.
    let activeRoot = document;
    let active = activeRoot.activeElement;
    while (active) {
      if (typeof active.closest === 'function') {
        const focusedComposer = active.closest(COMPOSER_SELECTOR);
        if (focusedComposer) return focusedComposer;
      }
      if (!active.shadowRoot) break;
      activeRoot = active.shadowRoot;
      roots.add(activeRoot);
      active = activeRoot.activeElement;
    }

    const candidates = [];
    for (const root of roots) {
      if (root && typeof root.querySelectorAll === 'function') {
        candidates.push(...Array.from(root.querySelectorAll(COMPOSER_SELECTOR)));
      }
    }
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const candidate = candidates[i];
      if (candidate.getAttribute('aria-hidden') === 'true') continue;
      if (candidate.getAttribute('disabled') !== null) continue;
      if (composerText(candidate)) return candidate;
    }
    return null;
  }

  function isSendEvent(event) {
    if (!event) return false;
    if (event.type === 'submit') return true;
    if (event.type === 'keydown' || event.type === 'keypress' || event.type === 'keyup') {
      return event.key === 'Enter' && !event.shiftKey && !event.ctrlKey
        && !event.altKey && !event.metaKey && !event.isComposing;
    }
    if (event.type === 'beforeinput') {
      return event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak';
    }
    if (!['pointerdown', 'mousedown', 'touchstart', 'click'].includes(event.type)) return false;
    const path = typeof event.composedPath === 'function'
      ? event.composedPath() : [event.target].filter(Boolean);
    let button = null;
    for (const node of path) {
      if (!node || typeof node.closest !== 'function') continue;
      button = node.closest('button, [role="button"]');
      if (button) break;
    }
    if (!button) return false;
    const label = [
      button.getAttribute('aria-label'),
      button.getAttribute('title'),
      button.getAttribute('data-test-id'),
      button.getAttribute('data-testid'),
      button.className,
      button.textContent,
    ]
      .filter(Boolean).join(' ').toLowerCase();
    return button.getAttribute('type') === 'submit' || /\b(?:send|submit)\b/.test(label);
  }

  function stopPrompt(event, composer, verdict) {
    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    else if (typeof event.stopPropagation === 'function') event.stopPropagation();

    state.promptRiskActive = true;
    const prompt = composerText(composer);
    const now = Date.now();
    const duplicate = state.lastPromptFingerprint === prompt && now - state.lastPromptBlockedAt < 1500;
    state.lastPromptFingerprint = prompt;
    state.lastPromptBlockedAt = now;
    if (duplicate) return;

    HelmionUI.showPromptAlert(
      verdict.message,
      'Guard has not sent it. Edit the request so it does not ask for irreversible deletion.',
      () => { if (typeof composer.focus === 'function') composer.focus(); },
    );
    sendBadge();
    logToLedger({
      kind: 'destructive-command',
      site: SOURCE,
      query: prompt,
      conversation: prompt,
      matched: verdict.hits.join(', '),
      text: prompt,
      lineNumber: 1,
      outcome: 'blocked-before-send',
    });
  }

  function inspectPromptEvent(event) {
    if (!isSendEvent(event)) return;
    const composer = eventComposer(event);
    if (!composer) return;
    const text = composerText(composer);
    const fp = fingerprint(text);

    // Guard's OWN Scribe auto-nudge (content/nudge.js). It is not exempt from
    // scanning: the same prompt-risk and secret checks run, and only a clean
    // scan lets it through. A dirty scan stops it and tells nudge.js, which
    // clears the composer and reports a failure (fail closed).
    const nudge = globalThis.HelmionNudge;
    if (nudge && typeof nudge.pendingFor === 'function' && nudge.pendingFor(text)) {
      const risk = HelmionPromptRisk.scan(text);
      const leak = HelmionSanitize.scan(text);
      if (risk.blocked || leak.found) {
        stopEvent(event);
        nudge.markBlocked();
        logToLedger({ kind: 'ai-flag', site: SOURCE, matched: 'scribe-nudge-blocked', text: leak.redacted || '', outcome: 'blocked-before-send' });
      }
      return;
    }

    // An explicit "send it as written" (or a verified Executive Guard approval)
    // for exactly this text. Every event of the one send gesture
    // (pointerdown, mousedown, click) passes; the window closes shortly after.
    if (state.allowOnce && state.allowOnce.fp === fp) {
      if (Date.now() - state.allowOnce.usedAt < 1500 || !state.allowOnce.usedAt) {
        if (!state.allowOnce.usedAt) {
          state.allowOnce.usedAt = Date.now();
          if (!state.allowOnce.quiet) logToLedger({
            kind: 'ai-flag',
            site: SOURCE,
            matched: `send-approved: ${state.allowOnce.by}`,
            text: HelmionSanitize.scan(text).redacted,
            outcome: 'sent-after-approval',
          });
          HelmionUI.hideAskAlert();
        }
        return;
      }
      state.allowOnce = null;
    }

    const verdict = HelmionPromptRisk.scan(text);
    if (verdict.blocked) {
      stopPrompt(event, composer, verdict);
      askExecutiveAboutDestructive(text, fp);
      return;
    }

    const privacy = HelmionSanitize.scan(text);
    if (privacy.found) { stopForPrivacy(event, composer, text, fp, privacy); return; }
    if (state.flagsScan && text.trim()) crossCheckWithFlags(event, composer, text, fp);
    refreshFlagsConfig();
  }

  function refreshFlagsConfig() {
    askWorker({ type: 'helmion:flags-config' })
      .then((response) => { state.flagsScan = Boolean(response && response.scanBeforeSend === true); })
      .catch(() => { /* keep the last answer */ });
  }

  // Guard's own scan found nothing. The person asked for a second opinion from
  // their Flags scanner, so hold this one send until it answers. The scanner
  // stores nothing. If it cannot answer, Guard's own result stands and the card
  // says so; the message is never sent without the person pressing Send again.
  function crossCheckWithFlags(event, composer, text, fp) {
    stopEvent(event);
    const now = Date.now();
    if (state.scanActiveFp === fp && now - state.scanShownAt < 1500) return;
    state.scanActiveFp = fp;
    state.scanShownAt = now;
    const cancel = { id: 'cancel', label: 'Cancel', onClick: () => { state.scanActiveFp = null; HelmionUI.hideAskAlert(); } };
    HelmionUI.showAskAlert({
      tone: 'warn',
      title: 'Checking with your Flags scanner',
      message: 'Guard found nothing. Your Flags scanner is double-checking before this is sent.',
      status: 'Checking…',
      actions: [cancel],
    });
    askWorker({ type: 'helmion:flags-scan', text })
      .then((response) => {
        if (state.scanActiveFp !== fp) return;
        const result = response && response.result;
        if (!result || !result.ok) {
          grantOnce(fp, 'local-check-only', { quiet: true });
          const why = {
            'too-long': 'the message is too long for the scanner',
            budget: "today's call budget is used up",
            'daily-limit': 'the Flags account is over its daily limit',
            'key-rejected': 'the API key was refused',
          }[result && result.skipped] || 'it could not be reached';
          HelmionUI.showAskAlert({
            tone: 'warn',
            title: 'Flags scanner did not check this',
            message: `Not checked because ${why}. Guard's own check found nothing. Press Send again to send it.`,
            actions: [cancel],
          });
          return;
        }
        const leaks = Array.isArray(result.leaks) ? result.leaks : [];
        if (!leaks.length) {
          state.scanActiveFp = null;
          grantOnce(fp, 'flags-scan-clean', { quiet: true });
          HelmionUI.showAskAlert({
            tone: 'ok',
            title: 'Flags scanner found nothing',
            message: 'Press Send again to send it.',
            actions: [cancel],
          });
          return;
        }
        const what = Array.from(new Set(leaks.map((l) => l.reason || l.rule))).slice(0, 3).join('; ');
        logToLedger({
          kind: 'ai-flag',
          site: SOURCE,
          matched: `flags-scan: ${leaks.map((l) => l.rule).join(',')}`,
          // The scanner's redacted copy: never the raw text.
          text: String(result.redacted || ''),
          outcome: 'paused-before-send',
        });
        HelmionUI.showAskAlert({
          tone: 'danger',
          title: 'Your Flags scanner found something Guard missed',
          message: `${what}. Nothing has been sent.`,
          actions: [
            {
              id: 'redact',
              label: 'Redact and keep editing',
              primary: true,
              onClick: () => {
                replaceComposerText(composer, String(result.redacted || ''));
                state.scanActiveFp = null;
                HelmionUI.hideAskAlert();
                if (typeof composer.focus === 'function') composer.focus();
              },
            },
            {
              id: 'send-anyway',
              label: 'Send as written',
              onClick: () => {
                grantOnce(fp, 'person-after-flags-scan');
                HelmionUI.showAskAlert({ tone: 'ok', title: 'Allowed once', message: 'Press Send again to send it as written.', actions: [cancel] });
              },
            },
            cancel,
          ],
        });
      }, () => {
        if (state.scanActiveFp !== fp) return;
        grantOnce(fp, 'local-check-only', { quiet: true });
        HelmionUI.showAskAlert({
          tone: 'warn',
          title: 'Flags scanner did not check this',
          message: "Guard's own check found nothing. Press Send again to send it.",
          actions: [cancel],
        });
      });
  }

  // ----------------------------------------------------------- privacy lane

  function stopEvent(event) {
    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    else if (typeof event.stopPropagation === 'function') event.stopPropagation();
  }

  async function contentHash(text) {
    const subtle = typeof crypto !== 'undefined' && crypto && crypto.subtle;
    if (!subtle || typeof TextEncoder !== 'function') throw new Error('WebCrypto is not available on this page');
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function askDecision(action) {
    return askWorker({ type: 'helmion:decide', action }).then((response) => response.decision);
  }

  function setNativeValue(element, value) {
    try {
      const proto = Object.getPrototypeOf(element);
      const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(element, value);
      else element.value = value;
    } catch {
      element.value = value;
    }
  }

  function fireInput(element) {
    try {
      if (typeof InputEvent === 'function') element.dispatchEvent(new InputEvent('input', { bubbles: true }));
      else if (typeof Event === 'function' && typeof element.dispatchEvent === 'function') element.dispatchEvent(new Event('input', { bubbles: true }));
    } catch { /* the page re-reads the composer on its next keystroke */ }
  }

  // Replaces the whole composer text. Textareas get the native value setter so
  // React-controlled inputs see the change; rich editors get a select-all and
  // insertText so their own model updates, with a plain text fallback.
  function replaceComposerText(composer, value) {
    if (typeof composer.value === 'string') {
      setNativeValue(composer, value);
      fireInput(composer);
      return;
    }
    let done = false;
    try {
      if (typeof composer.focus === 'function') composer.focus();
      const selection = typeof document.getSelection === 'function' ? document.getSelection() : null;
      if (selection && typeof selection.selectAllChildren === 'function' && typeof document.execCommand === 'function') {
        selection.selectAllChildren(composer);
        done = document.execCommand('insertText', false, value);
      }
    } catch { done = false; }
    if (!done) composer.textContent = value;
  }

  // Inserts text at the caret (paste replacement).
  function insertIntoComposer(composer, value) {
    if (typeof composer.value === 'string') {
      const current = composer.value;
      const start = typeof composer.selectionStart === 'number' ? composer.selectionStart : current.length;
      const end = typeof composer.selectionEnd === 'number' ? composer.selectionEnd : current.length;
      setNativeValue(composer, current.slice(0, start) + value + current.slice(end));
      fireInput(composer);
      return;
    }
    let done = false;
    try {
      if (typeof document.execCommand === 'function') done = document.execCommand('insertText', false, value);
    } catch { done = false; }
    if (!done) composer.appendChild(document.createTextNode(value));
  }

  function grantOnce(fp, by, options) {
    state.allowOnce = { fp, by, usedAt: 0, quiet: Boolean(options && options.quiet) };
  }

  function stopApprovalPolling() {
    if (state.approvalTimer) clearTimeout(state.approvalTimer);
    state.approvalTimer = null;
  }

  // Polls the worker (which polls Executive Guard and verifies the signature)
  // every 3 s for up to 15 minutes.
  function pollApproval(approvalId, fp, labels) {
    stopApprovalPolling();
    const deadline = Date.now() + 15 * 60 * 1000;
    const tick = () => {
      askWorker({ type: 'helmion:approval-status', approvalId }).then((response) => {
        const status = response.status || {};
        if (status.status === 'approved' && status.verdict === 'allow' && status.verified) {
          stopApprovalPolling();
          grantOnce(fp, `executive-guard:${status.decidedBy || 'approver'}`);
          HelmionUI.showAskAlert({
            tone: 'ok',
            title: 'Approved in Executive Guard',
            message: `${status.decidedBy ? `Approved by ${status.decidedBy}.` : 'Approved.'} Press Send again to send it.`,
            actions: [{ id: 'dismiss', label: 'OK', onClick: () => HelmionUI.hideAskAlert() }],
          });
          return;
        }
        if (status.status === 'denied' || status.status === 'expired' || (status.status === 'approved' && !status.verified)) {
          stopApprovalPolling();
          HelmionUI.showAskAlert({
            tone: 'danger',
            title: status.status === 'expired' ? 'Approval expired' : 'Denied in Executive Guard',
            message: status.reason || labels.denied,
            actions: labels.actions,
          });
          return;
        }
        if (Date.now() < deadline) state.approvalTimer = setTimeout(tick, 3000);
      }, () => {
        if (Date.now() < deadline) state.approvalTimer = setTimeout(tick, 3000);
      });
    };
    state.approvalTimer = setTimeout(tick, 3000);
  }

  function stopForPrivacy(event, composer, text, fp, privacy) {
    stopEvent(event);
    // One send gesture fires several events; answer the first, swallow the rest.
    const now = Date.now();
    if (state.privacyActiveFp === fp && now - state.privacyShownAt < 1500) return;
    state.privacyActiveFp = fp;
    state.privacyShownAt = now;

    const what = HelmionSanitize.describe(privacy);
    const redactAction = {
      id: 'redact',
      label: 'Redact and keep editing',
      primary: true,
      onClick: () => {
        replaceComposerText(composer, privacy.redacted);
        state.privacyActiveFp = null;
        stopApprovalPolling();
        HelmionUI.hideAskAlert();
        if (typeof composer.focus === 'function') composer.focus();
      },
    };
    const cancelAction = {
      id: 'cancel',
      label: 'Cancel',
      onClick: () => { state.privacyActiveFp = null; stopApprovalPolling(); HelmionUI.hideAskAlert(); },
    };

    HelmionUI.showAskAlert({
      tone: privacy.hasSecrets ? 'danger' : 'warn',
      title: 'Helmion Guard paused this message',
      message: `It contains ${what}. Nothing has been sent.`,
      status: 'Checking policy…',
      actions: [redactAction, cancelAction],
    });

    logToLedger({
      kind: 'ai-flag',
      site: SOURCE,
      matched: `privacy-prompt: ${privacy.signals.join(',')}`,
      // Never the raw text: the ledger must not become a second copy of the secret.
      text: privacy.redacted,
      outcome: 'paused-before-send',
    });

    contentHash(text)
      .then((hash) => askDecision({
        kind: 'prompt.send',
        site: SOURCE,
        contentHash: hash,
        riskSignals: privacy.signals,
        summary: privacy.redacted.slice(0, 500),
      }))
      .then((decision) => {
        if (state.privacyActiveFp !== fp) return; // the person already moved on
        const where = decision.source === 'executive-guard' ? 'Executive Guard' : 'Guard policy on this computer';
        if (decision.verdict === 'allow') {
          grantOnce(fp, decision.source);
          HelmionUI.showAskAlert({
            tone: 'ok',
            title: `${where} allowed this message`,
            message: 'Press Send again to send it as written.',
            actions: [redactAction, cancelAction],
          });
          return;
        }
        if (decision.verdict === 'deny') {
          HelmionUI.showAskAlert({
            tone: 'danger',
            title: 'Helmion Guard stopped this message',
            message: `It contains ${what}. ${decision.reason || ''}`.trim(),
            status: `Decided by ${where}${decision.serverUnavailable ? ' (Executive Guard could not be reached)' : ''}.`,
            actions: [redactAction, cancelAction],
          });
          return;
        }
        // ask
        if (decision.source === 'executive-guard' && decision.pending && decision.approvalId) {
          HelmionUI.showAskAlert({
            tone: 'warn',
            title: 'Waiting for approval',
            message: `It contains ${what}. An approver must allow it in Executive Guard.`,
            status: 'Waiting for an approver…',
            actions: [redactAction, cancelAction],
          });
          pollApproval(decision.approvalId, fp, { denied: 'The approver did not allow this message.', actions: [redactAction, cancelAction] });
          return;
        }
        // Compact corner pill: explicit Allow or Deny; timeout = deny; never auto-allows.
        HelmionUI.hideAskAlert();
        HelmionUI.showApprovalPill({
          tone: 'warn',
          title: 'Guard: send this as written?',
          message: `It contains ${what}. ${decision.reason || ''}`.trim(),
          status: decision.serverUnavailable ? 'Executive Guard could not be reached; you decide. No answer in 60 s = Deny.' : 'No answer in 60 s = Deny.',
          allowLabel: 'Allow once',
          denyLabel: 'Deny',
          timeoutMs: 60000,
          onAllow: () => {
            if (state.privacyActiveFp !== fp) return;
            grantOnce(fp, 'person-at-keyboard');
            HelmionUI.showAskAlert({
              tone: 'ok',
              title: 'Allowed once',
              message: 'Press Send again to send it as written.',
              actions: [redactAction, cancelAction],
            });
          },
          onDeny: (why) => {
            logToLedger({ kind: 'ai-flag', site: SOURCE, matched: `approval-pill-${why}`, text: '', outcome: 'blocked-before-send' });
          },
        });
      })
      .catch((error) => {
        // Fail closed: no decision means the message stays unsent.
        console.warn('[Helmion Guard] privacy decision failed:', error && error.message);
        if (state.privacyActiveFp !== fp) return;
        HelmionUI.showAskAlert({
          tone: 'danger',
          title: 'Helmion Guard paused this message',
          message: `It contains ${what}. The policy check did not answer, so it was not sent.`,
          actions: [redactAction, cancelAction],
        });
      });
  }

  // Destructive prompts stay blocked locally exactly as before. If an
  // Executive Guard server is paired, it is also asked, and a VERIFIED approval
  // from a human approver lets this one exact text through once.
  function askExecutiveAboutDestructive(text, fp) {
    contentHash(text)
      .then((hash) => askDecision({
        kind: 'prompt.send',
        site: SOURCE,
        contentHash: hash,
        riskSignals: ['destructive-intent'],
        summary: HelmionSanitize.scan(text).redacted.slice(0, 500),
      }))
      .then((decision) => {
        if (!decision || decision.source !== 'executive-guard' || !decision.verified) return;
        if (decision.verdict === 'ask' && decision.pending && decision.approvalId) {
          HelmionUI.showAskAlert({
            tone: 'danger',
            title: 'Sent to Executive Guard for approval',
            message: 'This request could permanently erase files, data or a device. It stays blocked unless an approver allows it.',
            status: 'Waiting for an approver…',
            actions: [{ id: 'cancel', label: 'Cancel', onClick: () => { stopApprovalPolling(); HelmionUI.hideAskAlert(); } }],
          });
          pollApproval(decision.approvalId, fp, {
            denied: 'The approver did not allow this request.',
            actions: [{ id: 'dismiss', label: 'OK', onClick: () => HelmionUI.hideAskAlert() }],
          });
        }
      })
      .catch(() => { /* local block already in place */ });
  }

  // Paste: a secret pasted into the composer is redacted before it lands.
  // Personal details are left for the send-time check, which asks.
  function inspectPaste(event) {
    const composer = eventComposer(event);
    if (!composer) return;
    const data = event && event.clipboardData;
    const pasted = data && typeof data.getData === 'function' ? String(data.getData('text/plain') || '') : '';
    if (!pasted) return;
    const privacy = HelmionSanitize.scan(pasted);
    if (!privacy.hasSecrets) return;
    stopEvent(event);
    insertIntoComposer(composer, privacy.redacted);
    HelmionUI.showAskAlert({
      tone: 'warn',
      title: 'Helmion Guard redacted your paste',
      message: `It removed ${HelmionSanitize.describe(privacy)} before it reached the AI.`,
      actions: [{ id: 'dismiss', label: 'OK', onClick: () => HelmionUI.hideAskAlert() }],
    });
    logToLedger({
      kind: 'ai-flag',
      site: SOURCE,
      matched: `privacy-paste: ${privacy.signals.join(',')}`,
      text: privacy.redacted,
      outcome: 'redacted-on-paste',
    });
  }

  function clearPromptWarningWhenSafe(event) {
    const composer = eventComposer(event);
    if (!composer || HelmionPromptRisk.scan(composerText(composer)).blocked) return;
    if (!state.promptRiskActive) return;
    state.promptRiskActive = false;
    HelmionUI.hidePromptAlert();
    sendBadge();
  }

  function inspectPromptDraft(event) {
    const composer = eventComposer(event);
    if (!composer) return;
    const verdict = HelmionPromptRisk.scan(composerText(composer));
    if (!verdict.blocked) {
      clearPromptWarningWhenSafe(event);
      return;
    }
    state.promptRiskActive = true;
    HelmionUI.showPromptAlert(
      verdict.message,
      'Edit the request so it does not ask for irreversible deletion.',
      () => { if (typeof composer.focus === 'function') composer.focus(); },
    );
    sendBadge();
  }

  function startPromptGuard() {
    const destructive = HelmionPromptRisk.scan('Permanently erase all computer files.');
    const protective = HelmionPromptRisk.scan('How can I prevent someone from erasing all computer files?');
    if (!destructive.blocked || protective.blocked) {
      throw new Error('the destructive-prompt detector failed its own test');
    }
    // The privacy lane's positive and negative control.
    const secret = HelmionSanitize.scan('key sk-helmionselftestprobe0001');
    const plain = HelmionSanitize.scan('Order 1234 5678 9012 3456 shipped to the example address.');
    if (!secret.hasSecrets || secret.redacted.indexOf('sk-helmion') !== -1 || plain.found) {
      throw new Error('the privacy detector failed its own test');
    }
    // Window capture runs before Gemini's document- or component-level event
    // handlers, even when Gemini registered those handlers before this script.
    // Document capture was too late on the live site.
    for (const type of [
      'submit', 'pointerdown', 'mousedown', 'touchstart', 'click',
      'keydown', 'keypress', 'keyup', 'beforeinput',
    ]) {
      window.addEventListener(type, inspectPromptEvent, true);
    }
    window.addEventListener('input', inspectPromptDraft, true);
    window.addEventListener('paste', inspectPaste, true);
    refreshFlagsConfig();
  }

  function noteAudit(result) {
    const audit = result && result.audit;
    if (!audit) {
      state.auditUnrecorded += 1;
      console.warn(
        '[Helmion Guard] a blocked code block came back with no audit field at all — '
        + 'background/scan.js is older than content/guard.js.',
      );
      return;
    }
    state.auditRecorded += Number(audit.recorded) || 0;
    if (audit.reason) {
      state.auditUnrecorded += 1;
      console.warn('[Helmion Guard] block ledger:', audit.reason);
    }
  }

  function applyResults(pending, results) {
    const byId = new Map(results.map((result) => [result.id, result]));
    let newlyDangerous = null;

    pruneDetached();

    for (const block of pending) {
      const result = byId.get(block.id);
      // Both, explicitly. A block can be dangerous, part-unchecked, both or
      // neither, and resetting it means resetting whichever it currently is.
      // clearWarning deliberately no longer clears the unchecked notice for it
      // — see the note on it in content/ui.js.
      HelmionUI.clearWarning(block.element);
      HelmionUI.clearUnchecked(block.element);
      state.dangerousIds.delete(block.id);

      // Lines the scanner could not examine. Not a match, and not a clean
      // result either — the honest answer is "part of this block was not
      // checked", and the page has to say so rather than look reassuring.
      const unchecked = (result && result.unchecked) || [];
      if (unchecked.length > 0) HelmionUI.noteUnchecked(block.element, unchecked);

      if (!result || !result.blocked) continue;

      HelmionUI.warnBlock(block.element, result, { mask: MASK_DANGEROUS_BLOCKS });
      state.dangerousIds.set(block.id, block.element);
      if (!newlyDangerous) newlyDangerous = result;
      noteAudit(result);

      // One durable row per offending LINE, not per block: two different
      // destructive commands in one block are two findings and deserve two
      // rows, or the second one disappears from the record.
      const query = conversationContext();
      for (const finding of result.findings || []) {
        logToLedger({
          kind: 'destructive-command',
          site: SOURCE,
          query,
          conversation: block.text,
          matched: (finding.hits || []).join(', '),
          text: finding.text,
          lineNumber: finding.lineNumber,
          outcome: MASK_DANGEROUS_BLOCKS ? 'blocked' : 'flagged',
        });
      }
    }

    if (newlyDangerous) {
      const first = (newlyDangerous.findings || [])[0];
      HelmionUI.showToast(
        state.dangerousIds.size === 1
          ? 'Helmion Guard blocked a destructive command in this reply.'
          : `Helmion Guard blocked ${state.dangerousIds.size} destructive code blocks in this conversation.`,
        first ? first.text : (newlyDangerous.hits || []).join(', '),
      );
    } else if (state.dangerousIds.size === 0) {
      HelmionUI.hideToast();
    }

    sendBadge();
  }

  // ------------------------------------------------------------ claims lane

  // Everything below reads PROSE and produces a footnote. It cannot mask
  // anything, it cannot add to state.dangerousIds, and it never calls fail() or
  // sendBadge(). Those are the guarantees that keep an advisory feature from
  // eroding a safety one, and they are held here structurally — by this section
  // simply not containing the calls — rather than by a flag somebody could flip.

  function claimsFail(message, detail) {
    state.claimsBroken = true;
    console.error('[Helmion Guard] claim checking is not running:', message, detail || '');
    sendStatus();
  }

  function claimsRecover() {
    if (!state.claimsBroken) return;
    state.claimsBroken = false;
    state.claimsHealthFailures = 0;
    HelmionUI.hideAdvisoryBanner();
    sendStatus();
  }

  // Same rule as blockId: the page does not get to name its own paragraphs.
  const proseIds = new WeakMap();

  function proseId(element) {
    let id = proseIds.get(element);
    if (!id) {
      id = `hp-${state.nextProseId}`;
      state.nextProseId += 1;
      proseIds.set(element, id);
      element.setAttribute('data-helmion-prose-id', id);
    }
    return id;
  }

  function pruneDetachedClaims() {
    for (const [id, element] of [...state.claimIds]) {
      if (!element || !element.isConnected) state.claimIds.delete(id);
    }
  }

  async function runClaimsPass(options) {
    let collected;
    try {
      collected = HelmionExtract.collectProse(document);
    } catch (error) {
      claimsFail('the extension could not read the prose on this page.', error.message);
      return;
    }

    // Same limited-mode tracking as the code lane. Claim health is visible in
    // the toolbar popup and never becomes an overlay on the page.
    if (collected.tier > 1 && collected.tier !== state.lastProseTier) {
      state.claimsDegraded = true;
      sendStatus();
    } else if (collected.tier === 1 && state.claimsDegraded) {
      state.claimsDegraded = false;
      HelmionUI.hideAdvisoryBanner();
      sendStatus();
    }
    state.lastProseTier = collected.tier;

    const force = Boolean(options && options.force);
    const pending = [];
    for (const passage of collected.passages) {
      const element = passage.element;
      const id = proseId(element);
      if (!force && !hasChanged(element, passage.text, PROSE_SEEN_ATTR)) continue;
      markSeen(element, passage.text, PROSE_SEEN_ATTR);
      pending.push({ id, element, text: passage.text });
    }

    if (pending.length === 0) {
      pruneDetachedClaims();
      return;
    }

    let response;
    try {
      response = await askWorker({
        type: 'helmion:claims',
        passages: pending.map((passage) => ({ id: passage.id, text: passage.text })),
      });
    } catch (error) {
      pending.forEach((passage) => forgetSeen(passage.element, PROSE_SEEN_ATTR));
      claimsFail('the claim check is not running.', error.message);
      return;
    }

    claimsRecover();
    applyClaimResults(pending, response.results || []);
  }

  function applyClaimResults(pending, results) {
    const byId = new Map(results.map((result) => [result.id, result]));
    pruneDetachedClaims();
    const before = state.claimIds.size;

    for (const passage of pending) {
      const result = byId.get(passage.id);
      HelmionUI.clearClaims(passage.element);
      state.claimIds.delete(passage.id);

      // A passage the scanner refused to look at is neither flagged nor clear.
      // It is rarer here than in the code lane — a paragraph a million
      // characters long is not a paragraph — so it is a console line rather
      // than page furniture, but it is never nothing.
      if (result && result.skipped) {
        console.warn('[Helmion Guard] a passage was not checked for claims:', result.skipped);
        continue;
      }

      if (!result || !result.flagged) continue;

      // Belt and braces across the message boundary. The lane has no masking
      // code at all, but if a future worker ever answered `blocked:true` this
      // says out loud that something upstream changed shape, rather than
      // quietly acting on it.
      if (result.blocked === true) {
        console.error(
          '[Helmion Guard] the claim lane answered blocked:true — it is advisory and must never block. '
          + 'Ignoring the flag and showing the note only.',
        );
      }

      HelmionUI.noteClaims(passage.element, result);
      state.claimIds.set(passage.id, passage.element);

      // Unsourced claims are logged too. This reverses a decision made in
      // background/claims.js on 2026-07-29 — that a machine's opinion about
      // English did not belong in a safety ledger. Troy overruled it on
      // 2026-07-30: "a lie, a gaslight, an omission, anything that that
      // extension is built to filter and catch. It needs to log it." His call,
      // his product. The `kind` field keeps the two apart so nobody later reads
      // an advisory note as a block.
      const claimQuery = conversationContext();
      for (const claim of result.claims || []) {
        logToLedger({
          kind: 'unsourced-claim',
          site: SOURCE,
          query: claimQuery,
          conversation: passage.text,
          matched: `${claim.marker} → ${claim.referentKind}: ${claim.referent}`,
          text: claim.sentence,
          outcome: 'flagged',
        });
      }
    }

    // The tally lives in the console and nowhere else. It is the only aggregate
    // this lane gets: the toolbar badge counts destructive code blocks, and
    // letting an advisory number share it would blunt the one indicator that has
    // to mean something.
    if (state.claimIds.size !== before) {
      console.info(
        `[Helmion Guard] paragraphs carrying an unsourced claim on this page: ${state.claimIds.size}`,
      );
    }
  }

  // -------------------------------------------------------------- flags lane

  const COMPOSER_REGION = 'textarea, [contenteditable="true"], [role="textbox"]';

  function inComposer(element) {
    return Boolean(element && typeof element.closest === 'function' && element.closest(COMPOSER_REGION));
  }

  function raiseFlag(flag) {
    const id = HelmionFlags.fingerprint(flag, SOURCE);
    if (state.flagsShown.has(id)) return;
    state.flagsShown.add(id);
    HelmionUI.showFlagAlert(flag);
    try {
      chrome.runtime.sendMessage({ type: 'helmion:flag', flag: { ...flag, id, site: SOURCE } }, () => {
        void chrome.runtime.lastError;
      });
    } catch (error) {
      console.warn('[Helmion Guard] could not record a flag:', error.message);
    }
  }

  function runFlagsPass() {
    let prose;
    let code;
    try {
      prose = HelmionExtract.collectProse(document).passages;
      code = HelmionExtract.collectCodeBlocks(document).blocks;
    } catch (error) {
      console.warn('[Helmion Guard] flags lane could not read the page:', error.message);
      return;
    }
    for (const passage of prose) {
      if (inComposer(passage.element)) continue; // the person's own draft is the privacy lane's job
      if (!hasChanged(passage.element, `p:${passage.text}`, FLAGS_SEEN_ATTR)) continue;
      markSeen(passage.element, `p:${passage.text}`, FLAGS_SEEN_ATTR);
      HelmionFlags.detectProse(passage.text).forEach(raiseFlag);
    }
    for (const block of code) {
      if (inComposer(block.element)) continue;
      if (!hasChanged(block.element, `c:${block.text}`, FLAGS_SEEN_ATTR)) continue;
      markSeen(block.element, `c:${block.text}`, FLAGS_SEEN_ATTR);
      HelmionFlags.detectCode(block.text).forEach(raiseFlag);
    }
  }

  // ------------------------------------------------------------------ health

  // Positive control. Do not ask "did the check find nothing?" — nothing is also
  // the right answer on a page with no code on it. Ask "does a string we KNOW is
  // destructive still come back flagged, and does a string we KNOW is harmless
  // still come back clean?" Only that distinguishes working from broken.
  async function selfTest() {
    const response = await askWorker({
      type: 'helmion:scan',
      blocks: [
        { id: 'selftest-dangerous', text: PROBE_DANGEROUS },
        { id: 'selftest-clean', text: PROBE_CLEAN },
      ],
    });

    const results = new Map((response.results || []).map((r) => [r.id, r]));
    const dangerous = results.get('selftest-dangerous');
    const clean = results.get('selftest-clean');

    if (!dangerous || dangerous.blocked !== true) {
      throw new Error(`a known destructive command ("${PROBE_DANGEROUS}") was not flagged`);
    }
    if (!clean || clean.blocked !== false) {
      throw new Error(`a known harmless command ("${PROBE_CLEAN}") was flagged`);
    }
    return true;
  }

  // The claim lane's own positive control, run through the real message path.
  // Three probes, because two signals have to be proven present AND proven
  // required — see the constants at the top of this file.
  async function claimsSelfTest() {
    const response = await askWorker({
      type: 'helmion:claims',
      passages: [
        { id: 'selftest-unsourced', text: PROBE_UNSOURCED },
        { id: 'selftest-marker-only', text: PROBE_MARKER_ONLY },
        { id: 'selftest-referent-only', text: PROBE_REFERENT_ONLY },
      ],
    });

    const results = new Map((response.results || []).map((r) => [r.id, r]));
    const unsourced = results.get('selftest-unsourced');
    const markerOnly = results.get('selftest-marker-only');
    const referentOnly = results.get('selftest-referent-only');

    if (!unsourced || unsourced.flagged !== true) {
      throw new Error(`a known unsourced claim ("${PROBE_UNSOURCED}") was not flagged`);
    }
    if (!markerOnly || markerOnly.flagged !== false) {
      throw new Error('a hedge with nothing checkable in it was flagged — the two-signal rule is gone');
    }
    if (!referentOnly || referentOnly.flagged !== false) {
      throw new Error('a sourced statement with no hedge was flagged — the two-signal rule is gone');
    }
    // The one thing this lane must never do, checked every single time.
    if (unsourced.blocked !== false) {
      throw new Error('the claim lane reported blocked — it is advisory and must never block');
    }
    return true;
  }

  async function claimsHealthCheck() {
    try {
      await claimsSelfTest();
    } catch (error) {
      state.claimsHealthFailures += 1;
      if (state.claimsHealthFailures >= FAILURES_BEFORE_BANNER) {
        claimsFail(`the claim check failed its own test: ${error.message}`);
      }
      return;
    }
    state.claimsHealthFailures = 0;
    claimsRecover();
  }

  async function healthCheck(watch) {
    let problem = null;

    try {
      await selfTest();
    } catch (error) {
      problem = `the detection chain failed its own test: ${error.message}`;
    }

    if (!problem) {
      const stats = watch.stats();
      const pageText = (document.body && document.body.innerText) || '';
      if (stats.mutationCount === 0 && pageText.length > MIN_PAGE_TEXT_FOR_HEALTH) {
        problem = 'this page is full of content but the extension has not seen it change once. '
          + 'It may not be able to watch this page.';
      }
    }

    if (problem) {
      state.healthFailures += 1;
      if (state.healthFailures >= FAILURES_BEFORE_BANNER) fail(problem);
      return;
    }

    state.healthFailures = 0;
    recover();
  }

  // -------------------------------------------------------------------- boot

  function start() {
    // Both callbacks receive { streaming } from the stop-button probe, and both
    // used to discard it — so the "primary" signal stream-watch.js documents at
    // length was computed on every tick and never once acted on. The extension
    // was running on quiescence alone.
    //
    // What the signal is FOR: while the model is typing, a code block is
    // half-written and gets scanned repeatedly as it grows. The moment the stop
    // button disappears the reply is final, and that is the one state worth a
    // guaranteed full re-check — including blocks whose content-fingerprint has
    // not changed, because a block that finished mid-pattern must not stay on
    // a stale verdict.
    const onSignal = (info) => {
      const streaming = Boolean(info && info.streaming);
      const finished = state.lastStreaming && !streaming;
      state.lastStreaming = streaming;
      runPass({ force: finished });
      // The claim lane rides the same signal and is deliberately NOT awaited
      // behind the code lane. A slow or broken reading aid must not delay the
      // check that stops somebody pasting a destructive command.
      runClaimsPass({ force: finished });
      // Flags read the reply once it has stopped streaming, so a half-typed
      // sentence is not judged. Advisory: nothing waits on it.
      if (!streaming) {
        try { runFlagsPass(); } catch (error) { console.warn('[Helmion Guard] flags lane error:', error.message); }
      }
    };

    const watch = HelmionStreamWatch.createStreamWatch({
      onPass: onSignal,
      // The quiescence fallback. If the stop-button signal is ever wrong, this
      // still forces one last pass once the page has gone quiet.
      onIdle: onSignal,
      onError: (error) => fail('the page watcher threw.', error.message),
    });

    // Prove the chain works before claiming to guard anything.
    selfTest().then(
      () => {
        console.info('[Helmion Guard] self-test passed — watching this page.');
        sendBadge();
        sendStatus();
      },
      (error) => fail('the detection chain failed its own test on load.', error.message),
    );

    // And the reading aid proves itself separately, so a failure in one is
    // never reported as a failure in the other.
    claimsSelfTest().then(
      () => {
        console.info('[Helmion Guard] claim self-test passed — reading this page for unsourced claims.');
        sendStatus();
      },
      (error) => claimsFail('the claim check failed its own test on load.', error.message),
    );

    try {
      watch.start();
    } catch (error) {
      fail('the extension could not start watching this page.', error.message);
      return;
    }

    setInterval(() => {
      healthCheck(watch);
      claimsHealthCheck();
    }, HEALTH_INTERVAL_MS);

    window.addEventListener('error', (event) => {
      if (!event || !event.filename || event.filename.indexOf('chrome-extension://') !== 0) return;
      fail('the extension hit an unexpected error.', event.message);
    });
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event && event.reason;
      const message = reason && reason.message ? reason.message : String(reason);
      console.error('[Helmion Guard] unhandled rejection:', message);
    });
  }

  // Register the prompt blocker immediately at document_start, before Gemini's
  // application installs its own submit handlers. Page scanning still waits
  // for <body>, because the stream observer needs a concrete node to watch.
  try {
    startPromptGuard();
    if (document.body) {
      start();
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        try { start(); }
        catch (error) { fail('the extension failed to start.', error.message); }
      }, { once: true });
    }
  } catch (error) {
    // Startup failing is the worst case, and it must still be visible.
    fail('the extension failed to start.', error.message);
  }
}());
