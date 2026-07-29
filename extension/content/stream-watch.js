// Knows when the assistant is still typing and when it has stopped.
//
// TWO SIGNALS, ON PURPOSE.
//
// Primary — the stop button. While any of the three sites is generating, the
// send button turns into a stop button. It is a real focusable control with an
// accessible label, because these sites are built to work with a screen reader,
// and that label is far more stable than any CSS class. "Streaming" is therefore
// "a control labelled Stop exists on the page"; "finished" is "it no longer
// does". No site's internal class names are involved.
//
// Fallback — quiescence. Watch the page with a MutationObserver and treat the
// reply as finished when nothing has changed for QUIESCENCE_MS. This works on
// any site, through any redesign, forever. It is slightly late and a model that
// pauses mid-thought can fool it, which is why it is the fallback rather than
// the primary. Either signal alone is enough to work; together they are prompt
// and they are hard to break.
//
// The observer is debounced (DEBOUNCE_MS). Streaming fires a mutation per token
// batch, so an undebounced observer would run hundreds of times per reply.
//
// Plain script: content scripts cannot be ES modules. Publishes
// globalThis.HelmionStreamWatch.

(function attachHelmionStreamWatch(root) {
  'use strict';

  var DEBOUNCE_MS = 300;
  var QUIESCENCE_MS = 700;

  // Meaning first, never a CSS class. Covers "Stop", "Stop generating",
  // "Stop response", "Stop streaming" across the three sites.
  var STOP_SELECTORS = [
    '[aria-label*="Stop" i]',
    'button[data-testid*="stop" i]',
    '[aria-label*="Detener" i]',
  ];

  function isStreaming(doc) {
    var scope = doc || (typeof document !== 'undefined' ? document : null);
    if (!scope || typeof scope.querySelector !== 'function') return false;
    for (var i = 0; i < STOP_SELECTORS.length; i += 1) {
      var control = scope.querySelector(STOP_SELECTORS[i]);
      if (!control) continue;
      // A hidden control is not a live stop button.
      if (control.getAttribute && control.getAttribute('aria-hidden') === 'true') continue;
      return true;
    }
    return false;
  }

  // Our own warning banners mutate the page too. Without this filter the
  // observer would re-trigger itself every time it drew a warning.
  function isOwnNode(node) {
    var element = node && node.nodeType === 1 ? node : (node && node.parentElement);
    if (!element || typeof element.closest !== 'function') return false;
    return element.closest('[data-helmion-ui]') !== null;
  }

  function isOwnMutation(record) {
    if (record.type === 'childList') {
      var nodes = Array.prototype.slice.call(record.addedNodes)
        .concat(Array.prototype.slice.call(record.removedNodes));
      if (nodes.length === 0) return false;
      return nodes.every(isOwnNode);
    }
    return isOwnNode(record.target);
  }

  // options:
  //   onPass({ streaming })  runs DEBOUNCE_MS after the page settles briefly
  //   onIdle({ streaming })  runs QUIESCENCE_MS after the page goes quiet
  //   onError(error)         anything thrown inside the observer
  function createStreamWatch(options) {
    var settings = options || {};
    var onPass = settings.onPass || function () {};
    var onIdle = settings.onIdle || function () {};
    var onError = settings.onError || function () {};
    var debounceMs = settings.debounceMs || DEBOUNCE_MS;
    var quiescenceMs = settings.quiescenceMs || QUIESCENCE_MS;
    var target = settings.target || (typeof document !== 'undefined' ? document.body : null);
    var doc = settings.document || (typeof document !== 'undefined' ? document : null);

    var passTimer = null;
    var idleTimer = null;
    var observer = null;
    var mutationCount = 0;
    var passCount = 0;
    var started = false;

    function firePass() {
      passTimer = null;
      passCount += 1;
      try {
        onPass({ streaming: isStreaming(doc) });
      } catch (error) {
        onError(error);
      }
    }

    function fireIdle() {
      idleTimer = null;
      try {
        onIdle({ streaming: isStreaming(doc) });
      } catch (error) {
        onError(error);
      }
    }

    function schedule() {
      if (passTimer !== null) clearTimeout(passTimer);
      if (idleTimer !== null) clearTimeout(idleTimer);
      passTimer = setTimeout(firePass, debounceMs);
      idleTimer = setTimeout(fireIdle, quiescenceMs);
    }

    function handle(records) {
      try {
        var theirs = false;
        for (var i = 0; i < records.length; i += 1) {
          if (!isOwnMutation(records[i])) { theirs = true; break; }
        }
        if (!theirs) return;
        mutationCount += 1;
        schedule();
      } catch (error) {
        onError(error);
      }
    }

    return {
      start: function start() {
        if (started) return;
        if (!target) throw new Error('HelmionStreamWatch needs a DOM node to observe');
        observer = new MutationObserver(handle);
        observer.observe(target, { childList: true, subtree: true, characterData: true });
        started = true;
        // The page may already hold a finished conversation. Check it once now
        // rather than waiting for the next thing to change.
        firePass();
        fireIdle();
      },
      stop: function stop() {
        if (observer) observer.disconnect();
        if (passTimer !== null) clearTimeout(passTimer);
        if (idleTimer !== null) clearTimeout(idleTimer);
        observer = null;
        passTimer = null;
        idleTimer = null;
        started = false;
      },
      // Read by the health check: an observer that has never fired on a page
      // full of text is an observer that is not watching anything.
      stats: function stats() {
        return { mutationCount: mutationCount, passCount: passCount, started: started };
      },
    };
  }

  root.HelmionStreamWatch = {
    DEBOUNCE_MS: DEBOUNCE_MS,
    QUIESCENCE_MS: QUIESCENCE_MS,
    STOP_SELECTORS: STOP_SELECTORS,
    isStreaming: isStreaming,
    isOwnMutation: isOwnMutation,
    createStreamWatch: createStreamWatch,
  };
}(typeof globalThis !== 'undefined' ? globalThis : this));
