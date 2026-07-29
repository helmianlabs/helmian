// The content script that ties everything together.
//
// It runs on claude.ai, chatgpt.com and gemini.google.com. On every settled
// change to the page it pulls the code blocks out of the conversation, sends
// them to the background worker, and draws a red warning on any block whose
// lines match Helmion's destructive-command patterns. Prose is never sent.
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

  // ------------------------------------------------------------------- state

  const state = {
    broken: false,
    degraded: false,
    dangerousIds: new Set(),
    healthFailures: 0,
    lastTier: null,
    lastStreaming: false,
    nextId: 1,
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

  function hasChanged(element, text) {
    return element.getAttribute('data-helmion-seen') !== fingerprint(text);
  }

  function markSeen(element, text) {
    element.setAttribute('data-helmion-seen', fingerprint(text));
  }

  function forgetSeen(element) {
    element.removeAttribute('data-helmion-seen');
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
        blocks: pending.map((block) => ({ id: block.id, text: block.text })),
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

  function applyResults(pending, results) {
    const byId = new Map(results.map((result) => [result.id, result]));
    let newlyDangerous = null;

    pruneDetached();

    for (const block of pending) {
      const result = byId.get(block.id);
      HelmionUI.clearWarning(block.element);
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

    try {
      watch.start();
    } catch (error) {
      fail('the extension could not start watching this page.', error.message);
      return;
    }

    setInterval(() => { healthCheck(watch); }, HEALTH_INTERVAL_MS);

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
