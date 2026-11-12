// ApiKeyFields — the API-key connect road for the provider-catalog
// seats (src/cloud/provider-registry.mjs). A catalog seat connects
// with what its registry row names: one API key for most, and for the
// one multi-field row (Cloudflare) an account ID plus an API token,
// which the connect route composes at store time into the single
// bundle record the seat's runner reads. Submitting stores through
// the same credential connect route as the email-and-password road
// (connect-fields.mjs), and the card's status afterwards comes only
// from the connections / presence store — never from this click. This
// component therefore contains no presence write of any kind.
//
// Pending state follows the ConnectFields discipline exactly: the
// submit races a real timeout, and a finally block restores the
// button and the inputs on every exit — success, refusal, timeout,
// or throw.
//
// Change mode (owner's order, 2026-11-06) mirrors ConnectFields: a
// connected card must let the person change the saved key — before
// this, a connected card showed no form at all. In change mode the
// same fields render for an already-connected provider and the same
// submit stores over the old record through the same route.
import { CREDENTIAL_CONNECT_PATH, CONNECT_FIELDS_TIMEOUT_MS, connectFailureText } from './connect-fields.mjs?v=c15fa8551413f59b';

export { CREDENTIAL_CONNECT_PATH, CONNECT_FIELDS_TIMEOUT_MS };

// The human shape of each registry auth field. The field NAMES are
// the registry row's contract (provider-registry.mjs auth.fields);
// labels and placeholders are this component's alone.
const FIELD_SHAPES = Object.freeze({
  api_key: { name: 'api_key', label: 'API key', type: 'password', autocomplete: 'off', placeholder: 'Paste your API key' },
  account_id: { name: 'account_id', label: 'Account ID', type: 'text', autocomplete: 'off', placeholder: 'Your account ID' },
  api_token: { name: 'api_token', label: 'API token', type: 'password', autocomplete: 'off', placeholder: 'Your API token' },
});

export function apiKeyFieldsModel({ provider, fields = ['api_key'], connected = false, change = false } = {}) {
  const p = String(provider ?? '').toLowerCase();
  if (!p || (connected === true && change !== true)) return null;
  const shapes = (Array.isArray(fields) ? fields : []).map((f) => FIELD_SHAPES[String(f ?? '').toLowerCase()]).filter(Boolean);
  if (!shapes.length || shapes.length !== (Array.isArray(fields) ? fields.length : 0)) return null;
  const isChange = change === true;
  return {
    provider: p,
    change: isChange,
    path: CREDENTIAL_CONNECT_PATH,
    fields: shapes,
    button: { label: isChange ? 'Save' : 'Save key', pendingLabel: 'Saving…' },
  };
}

// The body is exactly the credential and the provider — the route
// refuses anything else (a tenant id above all), so nothing else is
// sent. A one-field row sends its key as `apiKey`; a multi-field row
// sends its named fields under `fields` for the route to compose.
export function apiKeyPayload(provider, values = {}, fields = ['api_key']) {
  const p = String(provider ?? '').toLowerCase();
  const names = (Array.isArray(fields) ? fields : []).map((f) => String(f ?? '').toLowerCase());
  if (names.length <= 1) {
    const only = names[0] ?? 'api_key';
    return { provider: p, apiKey: typeof values?.[only] === 'string' ? values[only] : '' };
  }
  const out = {};
  for (const f of names) out[f] = typeof values?.[f] === 'string' ? values[f].trim() : '';
  return { provider: p, fields: out };
}

// One submit attempt. Never throws: every outcome is a plain result
// the component can surface truthfully, including the route's real
// answer (503 until the service is configured).
export async function submitApiKeyFields({ provider, values, fields, post, timeoutMs = CONNECT_FIELDS_TIMEOUT_MS, setTimeoutFn = globalThis.setTimeout, clearTimeoutFn = globalThis.clearTimeout } = {}) {
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
    const body = await Promise.race([post(CREDENTIAL_CONNECT_PATH, apiKeyPayload(provider, values, fields)), timeout]);
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

// DOM factory. `post` is the host's JSON POST helper (app.js);
// `onStored` lets the host re-read the store after a successful
// store — the status the person then sees is the store's, rendered
// by the host, not a claim made here. Returns null when there is
// nothing to render (connected and not in change mode, no provider,
// unknown fields, or no document).
export function createApiKeyFields({ provider, fields = ['api_key'], connected = false, change = false, post, onStored = null, timeoutMs, doc = globalThis.document } = {}) {
  const model = apiKeyFieldsModel({ provider, fields, connected, change });
  if (!model || !doc || typeof doc.createElement !== 'function') return null;
  const mk = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const form = mk('form', 'connect-fields api-key-fields');
  if (form.dataset) form.dataset.provider = model.provider;
  const inputs = {};
  for (const f of model.fields) {
    // R3 (fields across): same presentation as ConnectFields — the
    // label text rides a visually-hidden span, the placeholder names
    // the field on screen. The model's fields and words are unchanged.
    const label = mk('label', 'connect-fields-label');
    label.append(mk('span', 'connect-fields-label-text', f.label));
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
  form.apiKeyFields = { inputs, button, note };
  let pending = false;
  form.onsubmit = async (event) => {
    event?.preventDefault?.();
    if (pending) return;
    pending = true;
    button.disabled = true;
    button.textContent = model.button.pendingLabel;
    for (const input of Object.values(inputs)) input.disabled = true;
    note.hidden = true;
    note.textContent = '';
    try {
      const values = {};
      for (const [name, input] of Object.entries(inputs)) values[name] = input.value;
      const result = await submitApiKeyFields({ provider: model.provider, values, fields: model.fields.map((f) => f.name), post, timeoutMs });
      if (result.ok) {
        for (const input of Object.values(inputs)) input.value = '';
        note.textContent = model.change
          ? 'Saved. The new values replaced the old ones.'
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
      for (const input of Object.values(inputs)) input.disabled = false;
    }
  };
  return form;
}
