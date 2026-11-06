// ConnectFields — the one connect road (owner's law, 2026-11-01):
// every AI provider connects the same way, with an email field and a
// password field right in the connect step. Those two fields ARE the
// connection; submitting them stores the pair through the credential
// connect route (Bite 3) and the card's status afterwards comes only
// from the connections / presence store — never from this click. This
// component therefore contains no presence write of any kind: a click
// in a browser cannot verify a connection, and this one does not try.
//
// Pending state is built to make the old "Enabling…" failure impossible
// (integrations app.js, pre-honest-connect): the submit races a real
// timeout, and a finally block restores the button and the inputs on
// every exit — success, refusal, timeout, or throw.
//
// Change mode (owner's order, 2026-11-06): a connected card must let
// the person change the saved pair — before this, a connected card
// showed no form at all, so a wrong or stale pair could never be
// corrected from the page. In change mode the same fields render for
// an already-connected provider and the same submit stores over the
// old pair through the same route (the vault treats it as a
// replacement, with its existing Guard gate).
export const CREDENTIAL_CONNECT_PATH = '/api/admin/envoy/credential/connect';
export const CONNECT_FIELDS_TIMEOUT_MS = 15000;

export function connectFieldsModel({ provider, connected = false, change = false } = {}) {
  const p = String(provider ?? '').toLowerCase();
  if (!p || (connected === true && change !== true)) return null;
  const isChange = change === true;
  return {
    provider: p,
    change: isChange,
    path: CREDENTIAL_CONNECT_PATH,
    fields: [
      { name: 'username', label: 'Email', type: 'email', autocomplete: 'username', placeholder: 'you@example.com' },
      { name: 'password', label: 'Password', type: 'password', autocomplete: 'current-password', placeholder: 'Password' },
    ],
    button: { label: isChange ? 'Save' : 'Connect', pendingLabel: isChange ? 'Saving…' : 'Connecting…' },
  };
}

// The body is exactly the two fields and the provider — the route
// refuses anything else (a tenant id above all), so nothing else is sent.
export function connectPayload(provider, username, password) {
  return {
    provider: String(provider ?? '').toLowerCase(),
    username: String(username ?? '').trim(),
    password: typeof password === 'string' ? password : '',
  };
}

export function connectFailureText(result) {
  if (result?.timedOut) return 'Connecting timed out — nothing was saved. Try again.';
  switch (result?.status) {
    case 503: return 'Connect is not live yet — nothing was saved.';
    case 403: return 'That connect was refused — nothing was saved.';
    case 502: return 'The sign-in store could not be reached — nothing was saved.';
    default: return 'Could not connect — nothing was saved. Check the email and password and try again.';
  }
}

// One submit attempt. Never throws: every outcome is a plain result the
// component can surface truthfully, including the staged route's real
// answer (503 until the burst lands and the service is configured).
export async function submitConnectFields({ provider, username, password, post, timeoutMs = CONNECT_FIELDS_TIMEOUT_MS, setTimeoutFn = globalThis.setTimeout, clearTimeoutFn = globalThis.clearTimeout } = {}) {
  if (typeof post !== 'function') return { ok: false, status: 0, code: 'CONNECT_POST_MISSING', timedOut: false };
  let timer = null;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeoutFn(() => {
        const error = new Error('connect timed out');
        error.code = 'CONNECT_TIMEOUT';
        error.timedOut = true;
        reject(error);
      }, timeoutMs);
    });
    const body = await Promise.race([post(CREDENTIAL_CONNECT_PATH, connectPayload(provider, username, password)), timeout]);
    return { ok: true, body };
  } catch (error) {
    return {
      ok: false,
      status: Number(error?.status ?? 0) || 0,
      code: String(error?.body?.code ?? error?.code ?? error?.message ?? 'CONNECT_FAILED'),
      timedOut: error?.timedOut === true,
    };
  } finally {
    if (timer !== null) clearTimeoutFn(timer);
  }
}

// DOM factory. `post` is the host's JSON POST helper (app.js); `onStored`
// lets the host re-read the store after a successful store — the status
// the person then sees is the store's, rendered by the host, not a claim
// made here. Returns null when there is nothing to render (connected
// and not in change mode, no provider, or no document).
export function createConnectFields({ provider, connected = false, change = false, post, onStored = null, timeoutMs, doc = globalThis.document } = {}) {
  const model = connectFieldsModel({ provider, connected, change });
  if (!model || !doc || typeof doc.createElement !== 'function') return null;
  const mk = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const form = mk('form', 'connect-fields');
  if (form.dataset) form.dataset.provider = model.provider;
  const inputs = {};
  for (const f of model.fields) {
    const label = mk('label', 'connect-fields-label', f.label);
    const input = mk('input', 'connect-fields-input');
    input.type = f.type;
    input.name = f.name;
    input.autocomplete = f.autocomplete;
    input.placeholder = f.placeholder;
    input.required = true;
    label.append(input);
    form.append(label);
    inputs[f.name] = input;
  }
  const button = mk('button', 'btn sm primary', model.button.label);
  button.type = 'submit';
  const note = mk('p', 'connect-fields-note muted sm');
  note.hidden = true;
  if (typeof note.setAttribute === 'function') note.setAttribute('role', 'status');
  form.append(button, note);
  form.connectFields = { usernameInput: inputs.username, passwordInput: inputs.password, button, note };
  let pending = false;
  form.onsubmit = async (event) => {
    event?.preventDefault?.();
    if (pending) return;
    pending = true;
    button.disabled = true;
    button.textContent = model.button.pendingLabel;
    inputs.username.disabled = true;
    inputs.password.disabled = true;
    note.hidden = true;
    note.textContent = '';
    try {
      const result = await submitConnectFields({ provider: model.provider, username: inputs.username.value, password: inputs.password.value, post, timeoutMs });
      if (result.ok) {
        inputs.password.value = '';
        note.textContent = model.change
          ? 'Saved. The new sign-in replaced the old one.'
          : 'Saved. This card now reads its status from the saved connection.';
        note.hidden = false;
        if (onStored) { try { await onStored(result); } catch { /* the store already happened; a failed re-read is not a failed connect */ } }
      } else {
        note.textContent = connectFailureText(result);
        note.hidden = false;
      }
    } finally {
      pending = false;
      button.disabled = false;
      button.textContent = model.button.label;
      inputs.username.disabled = false;
      inputs.password.disabled = false;
    }
  };
  return form;
}
