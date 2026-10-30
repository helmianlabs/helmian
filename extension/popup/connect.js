// "Connect Scribe": the one sign-in path shared by the popup, the options tab
// and the welcome page (0.6.2). Plain script, no bundler.
//
// Rules learned the hard way:
// * chrome.permissions.request must be called SYNCHRONOUSLY inside the click.
//   After any await, Chrome drops the user gesture and refuses the request.
//   So the request is the very first thing connect() does.
// * Every failure is shown loudly, in plain words, with what to do next.
//   Never a silent no-op.
(function () {
  const api = globalThis.chrome;

  function send(type, payload, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, error: 'Guard\'s background service did not answer. Reload the extension (chrome://extensions, then the reload arrow) and try again.' }); } }, timeoutMs || 15000);
      try {
        api.runtime.sendMessage({ type, ...payload }, (response) => {
          const err = api.runtime.lastError;
          if (done) return; done = true; clearTimeout(timer);
          if (err) resolve({ ok: false, error: `Guard's background service could not be reached (${err.message}). Reload the extension and try again.` });
          else resolve(response || { ok: false, error: 'Guard\'s background service gave no answer. Reload the extension and try again.' });
        });
      } catch (error) {
        done = true; clearTimeout(timer);
        resolve({ ok: false, error: `Could not talk to Guard's background service (${error.message}).` });
      }
    });
  }

  function originFor(value) {
    try { const u = new URL(value); return `${u.protocol}//${u.hostname}/*`; } catch { return null; }
  }

  /** Starts the permission prompt NOW (synchronously). Resolves {granted, error}. */
  function requestSignInPermissions(url) {
    const origin = originFor(url);
    if (!origin) return Promise.resolve({ granted: false, error: `The Scribe server address "${url}" is not a valid web address. Fix it under Advanced.` });
    const firefox = Boolean(globalThis.browser && globalThis.browser.runtime && globalThis.browser.runtime.getBrowserInfo);
    const want = firefox ? { origins: [origin] } : { permissions: ['identity'], origins: [origin] };
    if (!api || !api.permissions || typeof api.permissions.request !== 'function') {
      return Promise.resolve({ granted: false, error: 'This page cannot ask the browser for permissions. Open Guard from its toolbar button or its welcome page and try again.' });
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (granted, why) => {
        if (settled) return; settled = true;
        resolve(granted ? { granted: true } : { granted: false, error: why || 'You did not allow Guard to reach Scribe, so sign-in stopped. Click Connect Scribe again and choose Allow.' });
      };
      try {
        const r = api.permissions.request(want, (g) => {
          const err = api.runtime.lastError;
          finish(Boolean(g), err ? `The browser refused the permission request (${err.message}). Click Connect Scribe again.` : undefined);
        });
        if (r && typeof r.then === 'function') r.then((g) => finish(Boolean(g)), (e) => finish(false, `The browser refused the permission request (${e && e.message}). Click Connect Scribe again.`));
      } catch (error) {
        finish(false, `The browser refused the permission request (${error.message}). Click Connect Scribe again.`);
      }
    });
  }

  /**
   * Call from a click handler WITHOUT awaiting anything before it.
   * report(kind, text): kind is 'busy' | 'ok' | 'error'.
   */
  function connect(url, report, before) {
    const perm = requestSignInPermissions(url); // synchronous start: keeps the user gesture
    return (async () => {
      const p = await perm;
      if (!p.granted) { report('error', p.error); return { ok: false, error: p.error }; }
      if (typeof before === 'function') {
        const b = await before();
        if (b && b.ok === false) { report('error', b.error); return b; }
      }
      const saved = await send('helmion:scribe-settings', { settings: { baseUrl: url } });
      if (!saved.ok) { const e = `Could not save the Scribe address: ${saved.error}`; report('error', e); return { ok: false, error: e }; }
      report('busy', 'Opening the Scribe sign-in window. Enter your Scribe passphrase there.');
      const r = await send('helmion:scribe-signin', { action: 'signin' }, 5 * 60 * 1000);
      if (!r.ok) { const e = `Scribe is NOT connected. ${r.error}`; report('error', e); return { ok: false, error: e }; }
      report('ok', 'Scribe is connected (read-only). Guard will knock when your AIs have mail.');
      return { ok: true };
    })();
  }

  globalThis.HelmionConnect = { send, connect, requestSignInPermissions, originFor };
})();
