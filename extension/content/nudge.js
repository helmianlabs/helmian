// Scribe AUTO-NUDGE, page side (0.6.0). Plain script; publishes globalThis.HelmionNudge.
//
// The background decides WHETHER a nudge is due (policy, limits, cursors). This
// script decides whether it is SAFE RIGHT NOW on this page, and if so types the
// one fixed Guard line into the composer and submits it. It never interrupts:
//   * the composer must be empty,
//   * no reply may be streaming,
//   * the page must have had no real (trusted) user input for N minutes.
// If any check fails it answers "busy" and the background retries later.
// If the site's DOM does not match an adapter it answers "dom-mismatch", types
// nothing (or removes what it typed), and the background pauses that site.
//
// Guard's own interceptor (guard.js) sees the submit like any other send. It
// recognises the pending nudge, STILL scans it (prompt risk + secrets) and only
// lets it through if the scan is clean.

(function attachHelmionNudge(root) {
  'use strict';

  var PREFIX = '[Helmian Guard, automatic] You have unread Scribe mail.';
  var MAX_LEN = 700;
  var CONFIRM_MS = 2000;

  // Site adapters. Selectors are meaning-first (ids, test ids, aria labels)
  // and checked against fixture pages in test/scribe-auto-nudge-dom.test.mjs.
  // NOT yet verified against the live sites' current DOM.
  var ADAPTERS = {
    'chatgpt.com': {
      composer: ['#prompt-textarea[contenteditable="true"]', 'div#prompt-textarea', 'textarea#prompt-textarea', 'form textarea'],
      send: ['button[data-testid="send-button"]', '#composer-submit-button', 'button[aria-label="Send prompt"]', 'button[aria-label*="Send" i]'],
    },
    'claude.ai': {
      composer: ['div.ProseMirror[contenteditable="true"]', '[data-testid="chat-input"][contenteditable="true"]', 'fieldset [contenteditable="true"]'],
      send: ['button[aria-label="Send message"]', 'button[aria-label*="Send" i]'],
    },
    'grok.com': {
      composer: ['form textarea', 'div.ProseMirror[contenteditable="true"]', 'form [contenteditable="true"]'],
      send: ['form button[type="submit"]', 'button[aria-label="Submit"]', 'button[aria-label*="Send" i]'],
    },
    // Perplexity (verified 2026-10-29 on www.perplexity.ai, signed out, Chromium 141):
    // a Lexical editor div#ask-input[contenteditable][role=textbox], no <form>;
    // a button[aria-label="Submit"] appears only once the composer has text.
    'perplexity.ai': {
      composer: ['#ask-input[contenteditable="true"]', 'div[data-lexical-editor="true"][contenteditable="true"]', 'textarea#ask-input'],
      send: ['button[aria-label="Submit"]', 'button[data-testid="submit-button"]'],
    },
    'gemini.google.com': {
      composer: ['rich-textarea .ql-editor[contenteditable="true"]', '.ql-editor[contenteditable="true"]', 'div[role="textbox"][contenteditable="true"]'],
      send: ['button.send-button', 'button[aria-label="Send message"]', 'button[aria-label*="Send" i]'],
    },
  };

  var state = { lastUserInputAt: Date.now(), pending: null, busy: false };

  function siteKey(host) {
    var h = String(host || '').toLowerCase();
    for (var k in ADAPTERS) if (h === k || h.slice(-(k.length + 1)) === '.' + k) return k;
    return null;
  }

  function visible(el) {
    if (!el) return false;
    if (el.getAttribute && (el.getAttribute('aria-hidden') === 'true' || el.getAttribute('disabled') !== null)) return false;
    if (el.hidden) return false;
    return true;
  }
  function first(doc, selectors) {
    for (var i = 0; i < selectors.length; i += 1) {
      var list = doc.querySelectorAll(selectors[i]);
      for (var j = 0; j < list.length; j += 1) if (visible(list[j])) return list[j];
    }
    return null;
  }
  function text(el) {
    if (!el) return '';
    if (typeof el.value === 'string') return el.value;
    return String(el.innerText == null ? el.textContent : el.innerText);
  }
  function norm(s) { return String(s || '').replace(/\u200b/g, '').replace(/\s+/g, ' ').trim(); }

  function noteUserInput(event) { if (event && event.isTrusted) state.lastUserInputAt = Date.now(); }

  function streaming(doc) {
    try { return Boolean(root.HelmionStreamWatch && root.HelmionStreamWatch.isStreaming(doc)); } catch (e) { return true; } // unknown = busy
  }

  function probe(doc, opts) {
    var site = siteKey((doc.location && doc.location.hostname) || (root.location && root.location.hostname));
    var adapter = site && ADAPTERS[site];
    if (!adapter) return { ok: false, reason: 'dom-mismatch', detail: 'no adapter for this site' };
    var composer = first(doc, adapter.composer);
    if (!composer) return { ok: false, reason: 'dom-mismatch', detail: 'composer not found' };
    if (norm(text(composer))) return { ok: false, reason: 'busy', detail: 'composer not empty' };
    if (streaming(doc)) return { ok: false, reason: 'busy', detail: 'reply streaming' };
    var idleMs = Math.max(1, Number(opts && opts.idleMinutes) || 3) * 60000;
    var now = Number(opts && opts.now) || Date.now();
    if (now - state.lastUserInputAt < idleMs) return { ok: false, reason: 'busy', detail: 'user active in the last ' + Math.round(idleMs / 60000) + ' min' };
    if (state.busy) return { ok: false, reason: 'busy', detail: 'a nudge is already running' };
    return { ok: true, site: site, adapter: adapter, composer: composer };
  }

  function setNativeValue(el, value) {
    var proto = Object.getPrototypeOf(el);
    var d = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && typeof d.set === 'function') d.set.call(el, value); else el.value = value;
  }
  function fire(el, type, init) {
    try {
      var E = type === 'input' || type === 'beforeinput' ? (typeof InputEvent === 'function' ? InputEvent : Event) : Event;
      el.dispatchEvent(new E(type, Object.assign({ bubbles: true, cancelable: type === 'beforeinput' }, init || {})));
    } catch (e) { /* best effort */ }
  }

  function insert(doc, composer, value) {
    if (typeof composer.focus === 'function') composer.focus();
    if (typeof composer.value === 'string') {
      setNativeValue(composer, value);
      fire(composer, 'input', { inputType: 'insertText', data: value });
      fire(composer, 'change');
      return;
    }
    // Rich editors (ProseMirror on ChatGPT/Claude/Grok, Quill on Gemini) update
    // their own model from a real insertText edit; that is the robust path.
    var done = false;
    try {
      var sel = typeof doc.getSelection === 'function' ? doc.getSelection() : null;
      if (sel && typeof sel.selectAllChildren === 'function') sel.selectAllChildren(composer);
      if (typeof doc.execCommand === 'function') done = doc.execCommand('insertText', false, value);
    } catch (e) { done = false; }
    if (!done) {
      fire(composer, 'beforeinput', { inputType: 'insertText', data: value });
      if (!norm(text(composer))) composer.textContent = value;
      fire(composer, 'input', { inputType: 'insertText', data: value });
    }
  }
  function clear(doc, composer) {
    try {
      if (typeof composer.value === 'string') { setNativeValue(composer, ''); fire(composer, 'input', { inputType: 'deleteContentBackward' }); return; }
      var sel = typeof doc.getSelection === 'function' ? doc.getSelection() : null;
      if (sel && typeof sel.selectAllChildren === 'function') sel.selectAllChildren(composer);
      var ok = typeof doc.execCommand === 'function' && doc.execCommand('delete', false);
      if (!ok || norm(text(composer))) { composer.textContent = ''; fire(composer, 'input', { inputType: 'deleteContentBackward' }); }
    } catch (e) { /* ignore */ }
  }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /**
   * Try one nudge. Resolves {ok, reason, detail}. Never throws.
   * reason: 'sent' | 'busy' | 'dom-mismatch' | 'blocked-by-guard' | 'refused'
   */
  async function tryNudge(doc, msg) {
    var value = String((msg && msg.text) || '');
    if (value.indexOf(PREFIX) !== 0 || value.length > MAX_LEN || /[\r\n]/.test(value)) return { ok: false, reason: 'refused', detail: 'not a Guard nudge' };
    var p = probe(doc, msg);
    if (!p.ok) return p;
    state.busy = true;
    try {
      state.pending = { text: value, at: Date.now(), blocked: false };
      insert(doc, p.composer, value);
      await wait(Number(msg && msg.settleMs) >= 0 ? Number(msg.settleMs) : 150);
      if (norm(text(p.composer)) !== norm(value)) { clear(doc, p.composer); return { ok: false, reason: 'dom-mismatch', detail: 'editor did not accept the text' }; }
      var button = first(doc, p.adapter.send);
      if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true') {
        button.click();
      } else {
        var kd = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
        try { p.composer.dispatchEvent(new KeyboardEvent('keydown', kd)); } catch (e) { /* ignore */ }
      }
      if (state.pending && state.pending.blocked) { clear(doc, p.composer); return { ok: false, reason: 'blocked-by-guard', detail: 'Guard scan stopped its own nudge' }; }
      var deadline = Date.now() + (Number(msg && msg.confirmMs) >= 0 ? Number(msg.confirmMs) : CONFIRM_MS);
      while (Date.now() < deadline) {
        if (!norm(text(p.composer)) || streaming(doc)) return { ok: true, reason: 'sent' };
        await wait(100);
      }
      if (!norm(text(p.composer)) || streaming(doc)) return { ok: true, reason: 'sent' };
      clear(doc, p.composer);
      return { ok: false, reason: 'dom-mismatch', detail: 'submit not confirmed' };
    } catch (e) {
      return { ok: false, reason: 'dom-mismatch', detail: 'error: ' + (e && e.message ? e.message : String(e)) };
    } finally {
      state.busy = false;
      setTimeout(function () { state.pending = null; }, 3000);
    }
  }

  /** For guard.js: is this exact composer text Guard's own pending nudge? */
  function pendingFor(value) {
    var p = state.pending;
    return Boolean(p && Date.now() - p.at < 5000 && norm(p.text) === norm(value));
  }
  function markBlocked() { if (state.pending) state.pending.blocked = true; }

  function install(win) {
    ['keydown', 'input', 'pointerdown', 'mousedown', 'wheel', 'paste', 'touchstart'].forEach(function (t) {
      win.addEventListener(t, noteUserInput, true);
    });
    var rt = root.chrome && root.chrome.runtime;
    if (!rt || !rt.onMessage) return;
    rt.onMessage.addListener(function (message, _sender, sendResponse) {
      if (!message || message.type !== 'helmion:nudge-try') return false;
      tryNudge(win.document, message).then(sendResponse, function () { sendResponse({ ok: false, reason: 'dom-mismatch' }); });
      return true;
    });
    var hello = function () {
      try { rt.sendMessage({ type: 'helmion:nudge-hello', site: siteKey(win.location.hostname) }, function () { void rt.lastError; }); } catch (e) { /* worker asleep */ }
    };
    hello();
    setInterval(hello, 4 * 60000); // re-register after a service-worker restart
  }

  root.HelmionNudge = { ADAPTERS: ADAPTERS, PREFIX: PREFIX, siteKey: siteKey, probe: probe, tryNudge: tryNudge, pendingFor: pendingFor, markBlocked: markBlocked, install: install, _state: state };
  if (typeof window !== 'undefined' && root === window && !root.__helmionNudgeNoAutoInstall) install(window);
})(typeof globalThis !== 'undefined' ? globalThis : this);
