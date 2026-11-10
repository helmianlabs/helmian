// Connector custom form — the panel-native face (panel-native home
// bite 3, 2026-11-10). Pure model + the exact wire shape of the
// connector library's custom-entry creation road — no DOM, no
// fetch of its own — so it is unit tested like connector-panel.mjs;
// envoy-workspace.js renders it inside the channel connector panel
// and hands it the workspace's own post function.
//
// WHY THIS FACE LIVES HERE. A person could not create a custom
// connector entry anywhere: the Integrations Connectors page that
// held the creation form was removed 2026-11-10 (Troy's order), and
// the panel's own Level 2 model still carries its "Add custom
// connector" row as present-but-not-actionable theatre. The server
// road never went away:
//
//   POST /api/admin/connector-library/entries
//     { seatId, name, authMode, mcpEndpointUrl, oneLiner? }
//     → 201 { status:'created', entry, gate } — owner/admin only.
//       The entry is created standing in the seat's library,
//       NOT connected: no connection is recorded, and a key for it
//       is entered afterwards through the panel's key form
//       (connector-key-form.mjs — its connect start, then the
//       header store, with the gate re-checked server-side).
//       Creating also runs the entry's safety check (the gate,
//       connector-custom-gate.mjs): a tools/list against the
//       server with NO credential. The gate is NOT a creation
//       refusal — the entry is created either way, and the answer
//       carries the check's own state ('verified', 'failed',
//       'not-run', 'error'). An entry whose check has not passed
//       stands in the library read as not ready (the read joins
//       the gate into the row's state, and the panel words it
//       "Not ready — safety check has not passed" / "Check failed
//       — not ready"), and every connect road refuses it until
//       the check passes. This form presents that truthfully: it
//       never says a check passed that the answer did not say
//       passed, and never pre-approves what the gate has not run.
//     Refusals (nothing is created): a body naming a tenant or a
//       person is refused; a non-owner/admin caller gets the
//       road's workspace-level words; an unknown seat, a missing
//       name, an auth mode outside the road's three, and a server
//       address the library store refuses (not a URL, not HTTPS,
//       credentials carried in the URL, or none at all) each get
//       the road's own words, and a duplicate slug gets the
//       store's "never edited in place" conflict.
//
// THE FIELDS. Exactly the fields the removed Manage surface's own
// creation form carried, which are exactly the fields the road
// reads: the name, the server's MCP address, one optional line
// about what it does (the road stores it, trimmed, capped at 512
// characters, and names the entry by the name alone when it is
// blank), and how the server signs a person in — one of the
// road's three auth modes, worded as the old form worded them.
// The road also accepts a category; the old form never sent one
// and this form does not invent one — the entry's category stays
// what the road defaults it to. The seat is the panel's own seat,
// never a field.
//
// TRUTH RULES (flywheel R52 §3, restated for this face):
// - The panel never declares a creation the server did not
//   return: the created entry the face hands back is the write
//   road's own returned entry record (applyCustomCreate), folded
//   with the answer's gate state in the gate's plain terms. A
//   write answer with no entry record creates nothing here.
// - A refused write surfaces the server's answer in plain words
//   in the form (the thrown error's body error text first), and
//   no entry appears.
// - The form's own refusals mirror the road's, word for word and
//   pinned against the server files by tests: a missing name, an
//   auth mode outside the three, a missing address, a malformed
//   address, a non-HTTPS address, and an address carrying
//   credentials are each refused here before any road is called,
//   with the words the road itself would answer.
//
// SCOPE: creation ONLY. Removing a custom entry rides its own
// road (POST /api/admin/connector-library/entries/remove — the
// write route exposes it, owner/admin, custom entries only), but
// no panel surface calls it, so a created entry cannot be removed
// from the panel: that is a finding in this bite's REPORT, named
// with its road evidence, not a removal control built here. The
// Skills/Plugins tabs are the next bite; they are not built here.

// The server road, named once.
export const CUSTOM_CREATE_PATH = '/api/admin/connector-library/entries';

// The road's own refusals, mirrored client-side word for word
// (connector-library-write-route.mjs's entries action, and the
// library store's endpoint validation in connector-library.mjs):
// the client mirror refuses with the same words, so the person
// reads one answer either way.
export const MISSING_NAME_MESSAGE = 'a custom connector needs a name';
export const BAD_AUTH_MODE_MESSAGE = 'authMode must be one of none, header, oauth';
export const MISSING_URL_MESSAGE = 'a helmian-brokered entry needs its mcpEndpointUrl — Helmian runs the pipe';
export const BAD_URL_MESSAGE = 'mcpEndpointUrl must be a public HTTPS MCP endpoint URL';
export const HTTPS_URL_MESSAGE = 'mcpEndpointUrl must be HTTPS — connections are made from Helmian\u2019s servers (§2.4 rule 1)';
export const URL_CREDENTIALS_MESSAGE = 'mcpEndpointUrl must not carry credentials in the URL';

// How the server signs a person in — the road's three auth modes
// (the write route accepts exactly these), in road order, worded
// as the removed Manage form's picker worded them.
export const CUSTOM_AUTH_MODES = Object.freeze([
  Object.freeze({ value: 'none', label: 'No sign-in' }),
  Object.freeze({ value: 'header', label: 'API key / header token' }),
  Object.freeze({ value: 'oauth', label: 'OAuth sign-in' }),
]);
const AUTH_MODE_VALUES = new Set(CUSTOM_AUTH_MODES.map((m) => m.value));

export function authModeOption(value) {
  return CUSTOM_AUTH_MODES.find((m) => m.value === value) ?? null;
}

// The fields the creation road's contract declares, in road
// order: the name and the server address (both required text),
// the optional one line (the road's own 512-character cap
// mirrored as the field's max length), and the sign-in picker
// (required, one of the three auth modes — its options ride
// CUSTOM_AUTH_MODES, and the form opens on 'none', the old
// form's first option).
export const CUSTOM_FORM_FIELDS = Object.freeze([
  Object.freeze({ name: 'name', label: 'Name', kind: 'text', type: 'text', autocomplete: 'off', placeholder: 'Name', required: true }),
  Object.freeze({ name: 'mcpEndpointUrl', label: 'MCP address', kind: 'url', type: 'url', autocomplete: 'off', placeholder: 'MCP address (https://…)', required: true }),
  Object.freeze({ name: 'oneLiner', label: 'One line about what it does (optional)', kind: 'text', type: 'text', autocomplete: 'off', placeholder: 'One line about what it does (optional)', required: false, maxLength: 512 }),
  Object.freeze({ name: 'authMode', label: 'How it signs you in', kind: 'select', type: 'select', autocomplete: 'off', required: true, options: CUSTOM_AUTH_MODES }),
]);

// ------------------------------------------------------------ the face model
// The form's state for one seat. The seat is the panel's seat —
// the creation road creates into the seat the person is looking
// at, and a form with no seat creates nothing.

export function customFormModel({ seatId = null } = {}) {
  if (!seatId) return null;
  return Object.freeze({
    seatId,
    intro: 'Your own MCP server, added to this seat\u2019s library. It is labelled \u201ccustom\u201d everywhere it shows.',
    fields: CUSTOM_FORM_FIELDS,
    authModes: CUSTOM_AUTH_MODES,
    defaultAuthMode: 'none',
    button: Object.freeze({ label: 'Add it', pendingLabel: 'Adding…' }),
  });
}

/**
 * The created entry, folded from the write road's own answer:
 * the returned entry record, in its true state — created in the
 * library, NOT connected (no connection exists until the entry's
 * own connect road lands one) — plus the creation answer's gate
 * state worded in plain terms (gateLine). An answer that is not
 * the road's created answer, or that carries no entry record,
 * folds to null: the panel declares no creation the server did
 * not return.
 */
export function applyCustomCreate(out) {
  const entry = out?.entry ?? null;
  if (out?.status !== 'created' || !entry || typeof entry.id !== 'string' || !entry.id
    || typeof entry.name !== 'string' || !entry.name) return null;
  return Object.freeze({
    entryId: entry.id,
    seatId: typeof entry.seatId === 'string' && entry.seatId ? entry.seatId : null,
    name: entry.name,
    kind: typeof entry.kind === 'string' ? entry.kind : null,
    authMode: typeof entry.authMode === 'string' ? entry.authMode : null,
    state: 'not-connected',
    gate: gateModel(out?.gate ?? null),
  });
}

/**
 * The creation answer's gate, in the gate's own plain terms. The
 * create road's gate is a state, not a verdict this form invents:
 * 'verified' is the only state that reads as passed. A failed
 * check says so and names the check's own recorded error when the
 * answer carries one; a check that did not run says that instead
 * — never that it passed.
 */
export function gateModel(gate) {
  const state = typeof gate?.state === 'string' && gate.state ? gate.state : 'not-run';
  const passed = state === 'verified';
  return Object.freeze({
    state,
    passed,
    toolsCount: Number.isInteger(gate?.toolsCount) ? gate.toolsCount : null,
    error: typeof gate?.error === 'string' && gate.error ? gate.error : null,
    line: gateLine(gate),
  });
}

export function gateLine(gate) {
  const state = typeof gate?.state === 'string' && gate.state ? gate.state : 'not-run';
  if (state === 'verified') return 'Its safety check passed.';
  if (state === 'failed') {
    const error = typeof gate?.error === 'string' && gate.error ? gate.error : null;
    return error
      ? `Its safety check failed, so it cannot be connected yet. The check said: ${error}`
      : 'Its safety check failed, so it cannot be connected yet.';
  }
  if (state === 'error') return 'Its safety check could not be run, so it cannot be connected yet.';
  return 'Its safety check has not run yet, so it cannot be connected yet.';
}

// ------------------------------------------------------------ wire shape
// The exact body the creation road demands. The builder refuses
// (null) rather than send a shape the server would refuse — see
// customCreateValidationError for which refusal, in the road's
// own check order (name, then auth mode, then the address the
// store validates). The name and the address ride trimmed, the
// way the road trims them; the optional line rides only when the
// person typed one — an absent line lets the road name the entry
// by its name itself, as it always has.

export function customCreateValidationError({ seatId, name, mcpEndpointUrl, authMode } = {}) {
  if (!seatId) return 'This connector cannot be added here.';
  if (typeof name !== 'string' || !name.trim()) return MISSING_NAME_MESSAGE;
  if (!AUTH_MODE_VALUES.has(authMode)) return BAD_AUTH_MODE_MESSAGE;
  if (typeof mcpEndpointUrl !== 'string' || !mcpEndpointUrl.trim()) return MISSING_URL_MESSAGE;
  let parsed;
  try { parsed = new URL(mcpEndpointUrl.trim()); } catch { return BAD_URL_MESSAGE; }
  if (parsed.protocol !== 'https:') return HTTPS_URL_MESSAGE;
  if (parsed.username || parsed.password) return URL_CREDENTIALS_MESSAGE;
  return '';
}

export function createCustomBody({ seatId, name, mcpEndpointUrl, oneLiner, authMode } = {}) {
  if (customCreateValidationError({ seatId, name, mcpEndpointUrl, authMode })) return null;
  const line = typeof oneLiner === 'string' ? oneLiner.trim().slice(0, 512) : '';
  return Object.freeze({
    seatId,
    name: name.trim(),
    mcpEndpointUrl: mcpEndpointUrl.trim(),
    ...(line ? { oneLiner: line } : {}),
    authMode,
  });
}

// The server's answer in plain words, from a thrown road error:
// the error body's own error text first (the road's refusal
// words), then the error's message, then a plain fallback. A
// resolved-but-refused answer carries its words on `error` the
// same way.
function refusalText(error, fallback) {
  const text = error?.body?.error ?? error?.error ?? error?.message ?? null;
  return typeof text === 'string' && text ? text : fallback;
}

// ------------------------------------------------------------ the round trip
// The form's one write, driven through a transport the caller
// supplies ({ post } — the workspace's own, in the panel; shaped
// stubs, in tests). On success it returns the created entry
// folded from the road's own returned record; on refusal the
// road's plain words and no entry, so nothing the server did not
// create ever appears in the panel's list.

export async function submitCustomForm({ post, model, values = {} } = {}) {
  if (!model || typeof post !== 'function') return { ok: false, sent: false, error: 'This connector cannot be added here.', created: null };
  const body = createCustomBody({
    seatId: model.seatId,
    name: values?.name, mcpEndpointUrl: values?.mcpEndpointUrl,
    oneLiner: values?.oneLiner, authMode: values?.authMode,
  });
  if (!body) {
    // A client-side refusal, worded exactly as the road words it
    // (see the message constants): the shape is never sent.
    return {
      ok: false, sent: false,
      error: customCreateValidationError({ seatId: model.seatId, name: values?.name, mcpEndpointUrl: values?.mcpEndpointUrl, authMode: values?.authMode }) || 'This connector cannot be added here.',
      created: null,
    };
  }
  let out;
  try {
    out = await post(CUSTOM_CREATE_PATH, body);
  } catch (error) {
    return { ok: false, sent: true, error: refusalText(error, 'That connector could not be added. Try again.'), created: null };
  }
  const created = applyCustomCreate(out);
  if (!created) {
    return { ok: false, sent: true, error: refusalText(out, 'That connector could not be added. Try again.'), created: null };
  }
  return { ok: true, sent: true, error: '', created, out };
}
