// Connector key form — the panel-native face (panel-native home
// bite 2, 2026-11-10). Pure model + the exact wire shapes of the
// connector library's key roads — no DOM, no fetch of its own — so
// it is unit tested like connector-panel.mjs; envoy-workspace.js
// renders it inside the channel connector panel and hands it the
// workspace's own post function.
//
// WHY THIS FACE LIVES HERE. A connector whose sign-in is a key or
// a header token (the library's authMode 'header' — a person's own
// custom entries declare it, and catalog entries of that class
// ride the same road) could not be connected from the panel at
// all: the panel's Connect called the connect start, the start
// answered "needs-credential", and the panel answered with a toast
// and a trip to the Agents tab, which holds no key form — the
// Manage surface that once held this form was removed 2026-11-10
// (Troy's order). This module is that form's model, rebuilt from
// the server contracts and the removed surface's own words. The
// server roads never went away:
//
//   POST /api/admin/connector-library/connect        { seatId, entryId }
//     → a header entry answers { status:'needs-credential', seatId,
//       entryId, providerId, accessTokenRef,
//       completeAction:'connect/header' } and connects nothing yet.
//   POST /api/admin/connector-library/connect/header { seatId, entryId, apiKey, accountLabel? }
//     → 201 { status:'connected', connection } — the ONE action
//       that ever receives a credential value: the key goes
//       straight to the credential service under the minted vault
//       reference and the library record holds the reference only.
//       A custom entry's key rides this same road, behind its
//       safety check: the write route runs the custom-entry gate
//       (connector-custom-gate.mjs) BEFORE any key is stored, and a
//       gate that has not passed answers 409 with the gate's own
//       plain words and code 'CUSTOM_GATE_NOT_PASSED' — nothing is
//       stored for a server the check has not examined.
//   POST /api/admin/connector-library/disconnect     { seatId, entryId }
//     → { status:'disconnected', connection, custodyRevoked } —
//       the existing disconnect: stored credentials are revoked
//       before the record's references are cleared.
//
// THE FIELDS. The header road's own definition declares them (the
// removed Manage surface's key form carried exactly these): one
// secret — the key itself, a password field, write-only — and one
// optional plain field, a name for the key, which the road stores
// as the connection's account label. There is no multi-field
// shape on this road: a body carrying anything else is refused.
//
// TRUTH RULES (flywheel R52 §3, restated for this face):
// - The form NEVER renders a secret back: the key field starts
//   empty every time the form opens — first connect and Replace
//   alike — and no model in this module carries a key value. A
//   stored key's presence is shown as the connection's state
//   ("Connected as …"), never as a value.
// - After a submit, the panel state is the write road's own
//   returned connection record (applyKeyConnect) — the form does
//   not declare success from its own field values. A write answer
//   with no connection record changes nothing.
// - A refused write surfaces the server's answer in plain words
//   in the form (the thrown error's body error text, the same
//   preference the GitHub file source uses), and nothing reads
//   connected.
// - An empty key is refused HERE, before any road is called, with
//   the road's own answer for that refusal (EMPTY_KEY_MESSAGE,
//   connector-library-write-route.mjs's connect/header refusal) —
//   the client mirror of the server's rule, word for word.
//
// HOW THE PANEL KNOWS AN ENTRY IS A KEY ENTRY. Two sources, in a
// stated precedence order (the known set below carries both):
// 1. THE LIBRARY READ (the seed). Since the server-truth pair, each
//    read row carries the entry's authMode from its definition —
//    a row carrying 'header' is key-kind from the moment the
//    library loads, so a header entry connected in an EARLIER
//    session shows Replace in a fresh session with no connect
//    attempt, and an unconnected one opens the key form on Connect
//    without the round-trip answer. Rows carrying 'oauth' or
//    'none', mirror rows, and mcp-local rows never seed. A row
//    WITHOUT the field (a read from before the pair landed) seeds
//    nothing: the panel falls back to today's behaviour exactly —
//    it learns from the connect answer alone and never guesses.
// 2. THE CONNECT START'S ANSWER (the live truth). The
//    needs-credential answer IS the key-kind signal, exactly as
//    the removed Manage surface learned it. The answer is fresher
//    than any read, so where the two disagree THE ANSWER WINS: a
//    needs-credential answer confirms (or newly teaches) key-kind,
//    and any other connect-start answer clears whatever the read
//    seeded — the entry the road just spoke for is not treated as
//    key-kind on a stale seed's say-so.
//
// SCOPE: entries that exist only — catalog header entries and
// already-created custom entries. Creating a custom entry (the
// add-a-custom form) is the next bite; it is not built here.

// The server roads, named once.
export const KEY_CONNECT_PATH = '/api/admin/connector-library/connect';
export const KEY_HEADER_PATH = '/api/admin/connector-library/connect/header';
export const KEY_DISCONNECT_PATH = '/api/admin/connector-library/disconnect';

// The road's own refusal for an empty key (connector-library-write-
// route.mjs, connect/header): the client-side mirror refuses with
// the same words, so the person reads one answer either way.
export const EMPTY_KEY_MESSAGE = 'the key itself is required on this one action — it is stored in the credential service and never written to the library record';

// The fields the header road's definition declares, in road order:
// the secret (password semantics, write-only, required) and the
// optional name for the key (the road stores it, trimmed, as the
// connection's account label — its own 512-character cap mirrored
// here as the field's max length, never as a silent edit of a key:
// the label field is plain text the person can see and fix).
export const KEY_FORM_FIELDS = Object.freeze([
  Object.freeze({ name: 'apiKey', label: 'API key or header token', kind: 'secret', type: 'password', autocomplete: 'off', placeholder: 'Paste the key', required: true }),
  Object.freeze({ name: 'accountLabel', label: 'A name for this key (optional)', kind: 'text', type: 'text', autocomplete: 'off', placeholder: 'A name for this key (optional)', required: false, maxLength: 512 }),
]);

/** The session key the workspace tracks a known key entry under. */
export function keyEntryKey(seatId, entryId) {
  return seatId && entryId ? `${seatId}/${entryId}` : null;
}

/** Is this connect-start answer the key-kind signal? */
export function isNeedsCredentialAnswer(out) {
  return out?.status === 'needs-credential';
}

// ------------------------------------------------------------ the known set
// The session's record of which entries take a key: a plain map
// keyed by keyEntryKey(seatId, entryId), each value naming its
// source — 'read' (seeded from the library read's authMode) or
// 'answer' (taught by a connect start's needs-credential answer
// this session). The workspace holds it as ws.keyForm.known; the
// renderer offers a connected entry's Replace row exactly when
// its key is present here, from either source. The set only ever
// learns: seeding adds read-sourced entries and never removes or
// overwrites one (a re-read cannot un-teach an answer, and a
// later read row is not a live answer); the connect answer is
// the one voice that can clear an entry (noteConnectAnswer).

/** The known-set record for one entry, or null when not known. */
export function knownKeyEntry(known, seatId, entryId) {
  const key = keyEntryKey(seatId, entryId);
  return key ? (known?.[key] ?? null) : null;
}

/**
 * Is this library read row a key-kind row the panel may seed
 * from? Exactly: the row carries authMode 'header' from its
 * definition, on a pipe Helmian holds (a mirror row — brokerMode
 * 'vendor' — never enters the set, whatever mode it carries),
 * and the entry is one the key road serves (an mcp-local entry
 * has no connect start and no header road, so it never seeds).
 * A row without the authMode field is not key-kind here: the
 * fallback is today's behaviour, learned from the connect
 * answer alone.
 */
export function isKeyKindReadRow(row) {
  return !!row
    && row.authMode === 'header'
    && row.brokerMode !== 'vendor'
    && row.kind !== 'mcp-local';
}

/**
 * Seed the known set from one seat library read (its rows, in the
 * read's own shape). Returns the set unchanged — the same object —
 * when no row teaches anything new, so a re-read is free. An
 * entry already known, from either source, stands as it is: the
 * seed never overwrites an answer with a read, and never removes.
 */
export function seedKnownKeyEntries(known, rows) {
  const base = known ?? {};
  let next = base;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isKeyKindReadRow(row)) continue;
    const key = keyEntryKey(row.seatId, row.entryId);
    if (!key || next[key]) continue;
    if (next === base) next = { ...base };
    next[key] = { seatId: row.seatId, entryId: row.entryId, source: 'read' };
  }
  return next;
}

/**
 * Fold one connect start's answer into the known set — the
 * precedence rule, stated once: the road's live answer outranks
 * the read seed. A needs-credential answer marks the entry
 * key-kind with source 'answer' (upgrading a read seed, or
 * teaching a fresh entry exactly as the panel always learned).
 * Any other answered status is the road saying this entry does
 * not take a key on this road right now, so the entry is cleared
 * — seed and earlier answer alike. No answer at all (a thrown
 * road error, an empty body) teaches nothing and clears nothing:
 * the set stands.
 */
export function noteConnectAnswer(known, { seatId = null, entryId = null } = {}, out = null) {
  const base = known ?? {};
  const key = keyEntryKey(seatId, entryId);
  if (!key) return base;
  if (isNeedsCredentialAnswer(out)) {
    if (base[key]?.source === 'answer') return base;
    return { ...base, [key]: { seatId, entryId, source: 'answer' } };
  }
  if (typeof out?.status === 'string' && out.status) {
    if (!base[key]) return base;
    const next = { ...base };
    delete next[key];
    return next;
  }
  return base;
}

/**
 * Should this entry's Connect open the key form straight from
 * the read seed, with no connect-start round trip? Only a
 * read-sourced entry: an answer-sourced one keeps today's road
 * (its Connect asks the connect start again, and the fresh
 * answer re-rules via noteConnectAnswer).
 */
export function opensKeyFormFromSeed(known, seatId, entryId) {
  return knownKeyEntry(known, seatId, entryId)?.source === 'read';
}

// ------------------------------------------------------------ the face model
// The form's state for one entry. `connected` and `accountIdentity`
// are server-stated state only — the library read's row state, or
// a write road's returned connection — never a form value. The
// model carries no key, ever: there is no field a secret could be
// read back from.

export function keyFormModel({ seatId = null, entryId = null, name = null, kind = null, connected = false, accountIdentity = null } = {}) {
  if (!seatId || !entryId || !name) return null;
  const isConnected = connected === true;
  return Object.freeze({
    seatId,
    entryId,
    name,
    kind: kind ?? null,
    connected: isConnected,
    accountIdentity: isConnected && typeof accountIdentity === 'string' && accountIdentity ? accountIdentity : null,
    // The stored state shown in plain words — the connection's
    // state and the account it is connected as, never a value.
    stateLine: isConnected
      ? (accountIdentity ? `Connected as ${accountIdentity}` : 'Connected')
      : 'Not connected',
    intro: `${name} takes an API key or header token. Paste it here — it goes straight into Helmian's credential storage, and this list keeps only a reference to it.`,
    fields: KEY_FORM_FIELDS,
    // Replace is the same road with a fresh key: the submit button
    // says which of the two this store is, in plain words.
    button: Object.freeze({
      label: isConnected ? 'Store the new key and connect' : 'Store the key and connect',
      pendingLabel: 'Storing…',
    }),
    replace: isConnected,
  });
}

/**
 * The face's state after a key write: the road answers with the
 * full connection record, and the stored state in that record is
 * what the face shows next. A write answer with no connection
 * record — or one whose record does not read connected — changes
 * nothing the face can prove, so the model stands unchanged.
 */
export function applyKeyConnect(model, out) {
  const connection = out?.connection ?? null;
  if (!model || out?.status !== 'connected' || !connection || connection.state !== 'connected') return model;
  return keyFormModel({
    seatId: model.seatId,
    entryId: model.entryId,
    name: model.name,
    kind: model.kind,
    connected: true,
    accountIdentity: typeof connection.accountIdentity === 'string' ? connection.accountIdentity : null,
  }) ?? model;
}

/**
 * The face's state after the existing disconnect: its answer's
 * connection record reads disconnected, and the face then shows
 * the plain not-connected form again — the key field empty, the
 * connect button back. Any other answer changes nothing.
 */
export function applyKeyDisconnect(model, out) {
  const connection = out?.connection ?? null;
  if (!model || out?.status !== 'disconnected' || !connection || connection.state !== 'disconnected') return model;
  return keyFormModel({
    seatId: model.seatId,
    entryId: model.entryId,
    name: model.name,
    kind: model.kind,
    connected: false,
    accountIdentity: null,
  }) ?? model;
}

// ------------------------------------------------------------ wire shapes
// The exact bodies the server contracts demand. Builders refuse
// (null) rather than send a shape the server would refuse: a
// missing seat or entry, an empty key. The optional label rides
// only when the person typed one — an absent label lets the road
// name the connection 'API key' itself, as it always has.

export function connectStartBody({ seatId, entryId } = {}) {
  if (!seatId || !entryId) return null;
  return Object.freeze({ seatId, entryId });
}

export function headerConnectBody({ seatId, entryId, apiKey, accountLabel } = {}) {
  if (!seatId || !entryId) return null;
  if (typeof apiKey !== 'string' || apiKey.length === 0) return null;
  const label = typeof accountLabel === 'string' ? accountLabel.trim().slice(0, 512) : '';
  return Object.freeze({ seatId, entryId, apiKey, ...(label ? { accountLabel: label } : {}) });
}

export function disconnectBody({ seatId, entryId } = {}) {
  if (!seatId || !entryId) return null;
  return Object.freeze({ seatId, entryId });
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
// The form's two writes, driven through a transport the caller
// supplies ({ post } — the workspace's own, in the panel; shaped
// stubs, in tests). Each returns a plain result: on success the
// model re-derived from the road's own returned connection; on
// refusal the road's plain words and the model unchanged, so
// nothing the server did not store ever reads connected.

export async function submitKeyForm({ post, model, values = {} } = {}) {
  if (!model || typeof post !== 'function') return { ok: false, sent: false, error: 'This connector cannot be connected here.', model: model ?? null };
  const body = headerConnectBody({ seatId: model.seatId, entryId: model.entryId, apiKey: values?.apiKey, accountLabel: values?.accountLabel });
  if (!body) {
    // The one client-side refusal, worded exactly as the road
    // words it (see EMPTY_KEY_MESSAGE): an empty key is never sent.
    return { ok: false, sent: false, error: EMPTY_KEY_MESSAGE, model };
  }
  let out;
  try {
    out = await post(KEY_HEADER_PATH, body);
  } catch (error) {
    return { ok: false, sent: true, error: refusalText(error, 'That key could not be stored. Try again.'), model };
  }
  const next = applyKeyConnect(model, out);
  if (next === model) {
    return { ok: false, sent: true, error: refusalText(out, 'That key could not be stored. Try again.'), model };
  }
  return { ok: true, sent: true, error: '', model: next, out };
}

export async function disconnectKeyEntry({ post, model } = {}) {
  if (!model || typeof post !== 'function') return { ok: false, sent: false, error: 'This connector cannot be disconnected here.', model: model ?? null };
  const body = disconnectBody({ seatId: model.seatId, entryId: model.entryId });
  if (!body) return { ok: false, sent: false, error: 'This connector cannot be disconnected here.', model };
  let out;
  try {
    out = await post(KEY_DISCONNECT_PATH, body);
  } catch (error) {
    return { ok: false, sent: true, error: refusalText(error, 'That disconnect could not be done. Try again.'), model };
  }
  const next = applyKeyDisconnect(model, out);
  if (next === model) {
    return { ok: false, sent: true, error: refusalText(out, 'That disconnect could not be done. Try again.'), model };
  }
  return { ok: true, sent: true, error: '', model: next, out };
}
