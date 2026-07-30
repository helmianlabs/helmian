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
// The two share a page and a worker and nothing else: separate state, separate
// self-tests, separate banners, separate failure counters. Either can be broken
// while the other keeps working, and the page has to be able to say which.
//
// It fails loud. Every path that can break — the worker not answering, the page
// never changing, the code-block anchor no longer matching, an exception
// anywhere — puts a banner across the top of the page saying the guard is not
// watching. A safety tool that goes quiet is indistinguishable from one that
// found nothing wrong, so this one is never allowed to go quiet.
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
    dangerousIds: new Set(),
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
    claimIds: new Set(),
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
  }

  function recover() {
    if (!state.broken) return;
    state.broken = false;
    state.healthFailures = 0;
    HelmionUI.hideBanner();
    // hideBanner clears whatever banner is on the page, and a degraded anchor
    // may still be true underneath the failure that just cleared. Put that one
    // back rather than letting a recovery quietly erase a live warning.
    if (state.degraded) {
      HelmionUI.showBanner(
        'the usual code-block anchor no longer matches this site.',
        'Running on a fallback. Checking still works, but this needs looking at.',
      );
    }
    sendBadge();
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
      dangerous: state.dangerousIds.size,
      // A degraded anchor is a real "look at me" state, not a healthy one. It
      // rides the same flag the worker already turns into the warning mark,
      // because from the toolbar's point of view "running on a fallback" and
      // "not running" both mean do not trust this silence.
      broken: state.broken || state.degraded,
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

  // ------------------------------------------------------------------- scan

  function blockId(element) {
    let id = element.getAttribute('data-helmion-id');
    if (!id) {
      id = `hg-${state.nextId}`;
      state.nextId += 1;
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

  // The attribute is a parameter because the two lanes read DIFFERENT text off
  // the same page and must not share a fingerprint: a paragraph's prose and a
  // code block's contents change independently, and one lane marking an element
  // seen would stop the other from ever looking at it.
  const SEEN_ATTR = 'data-helmion-seen';
  const PROSE_SEEN_ATTR = 'data-helmion-prose-seen';

  function hasChanged(element, text, attribute) {
    return element.getAttribute(attribute || SEEN_ATTR) !== fingerprint(text);
  }

  function markSeen(element, text, attribute) {
    element.setAttribute(attribute || SEEN_ATTR, fingerprint(text));
  }

  function forgetSeen(element, attribute) {
    element.removeAttribute(attribute || SEEN_ATTR);
  }

  // A flagged block can leave the page without us ever seeing it again — the
  // site swaps conversations, or re-renders a message. Its id used to stay in
  // dangerousIds forever, so the red count only ever climbed and the toast
  // could never clear (that path needs size === 0). Drop ids whose element is
  // no longer in the document.
  function pruneDetached() {
    const before = state.dangerousIds.size;
    for (const id of [...state.dangerousIds]) {
      if (!document.querySelector(`[data-helmion-id="${id}"]`)) state.dangerousIds.delete(id);
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

    // Tier 1 is the <pre> element. If a lower tier answered, the primary anchor
    // has stopped matching and the guard is running on a fallback. Say so.
    //
    // This is tracked in state.degraded so it can also be UNSAID. It used to
    // call showBanner without recording anything, and recover() returns early
    // unless state says something is wrong — so the banner outlived the problem
    // and stayed on the page forever once drawn, and the toolbar icon never
    // showed the warning mark the README promises.
    if (collected.tier > 1 && collected.tier !== state.lastTier) {
      state.degraded = true;
      HelmionUI.showBanner(
        'the usual code-block anchor no longer matches this site.',
        `Running on a fallback (${collected.tierName}). Checking still works, but this needs looking at.`,
      );
      sendBadge();
    } else if (collected.tier === 1 && state.degraded) {
      state.degraded = false;
      HelmionUI.hideBanner();
      sendBadge();
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
      state.dangerousIds.add(block.id);
      if (!newlyDangerous) newlyDangerous = result;
      noteAudit(result);
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
    try {
      HelmionUI.showAdvisoryBanner(message, detail);
    } catch (uiError) {
      console.error('[Helmion Guard] could not draw the advisory banner:', uiError);
    }
    console.error('[Helmion Guard] claim checking is not running:', message, detail || '');
  }

  function claimsRecover() {
    if (!state.claimsBroken) return;
    state.claimsBroken = false;
    state.claimsHealthFailures = 0;
    HelmionUI.hideAdvisoryBanner();
    if (state.claimsDegraded) {
      HelmionUI.showAdvisoryBanner(
        'the usual paragraph anchor no longer matches this site.',
        'Reading prose from a fallback. Claim checking still works, but this needs looking at.',
      );
    }
  }

  function proseId(element) {
    let id = element.getAttribute('data-helmion-prose-id');
    if (!id) {
      id = `hp-${state.nextProseId}`;
      state.nextProseId += 1;
      element.setAttribute('data-helmion-prose-id', id);
    }
    return id;
  }

  function pruneDetachedClaims() {
    for (const id of [...state.claimIds]) {
      if (!document.querySelector(`[data-helmion-prose-id="${id}"]`)) state.claimIds.delete(id);
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

    // Same degraded-anchor logic as the code lane, in its own state and its own
    // banner. Tier 1 is semantic markup; anything lower means this site stopped
    // rendering paragraphs as paragraphs.
    if (collected.tier > 1 && collected.tier !== state.lastProseTier) {
      state.claimsDegraded = true;
      HelmionUI.showAdvisoryBanner(
        'the usual paragraph anchor no longer matches this site.',
        `Reading prose from a fallback (${collected.tierName}). Claim checking still works, but this needs looking at.`,
      );
    } else if (collected.tier === 1 && state.claimsDegraded) {
      state.claimsDegraded = false;
      HelmionUI.hideAdvisoryBanner();
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
      state.claimIds.add(passage.id);
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
      },
      (error) => fail('the detection chain failed its own test on load.', error.message),
    );

    // And the reading aid proves itself separately, so a failure in one is
    // never reported as a failure in the other.
    claimsSelfTest().then(
      () => console.info('[Helmion Guard] claim self-test passed — reading this page for unsourced claims.'),
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

  try {
    start();
  } catch (error) {
    // start() itself failing is the worst case, and it must still be visible.
    try {
      HelmionUI.showBanner('the extension failed to start.', error.message);
    } catch (uiError) {
      console.error('[Helmion Guard] failed to start and could not say so:', error, uiError);
    }
  }
}());
