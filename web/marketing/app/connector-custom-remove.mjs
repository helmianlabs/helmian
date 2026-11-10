// Connector custom remove — the panel-native face (panel-native
// home bite 4, 2026-11-10). Pure model + the exact wire shape of
// the connector library's custom-entry removal road — no DOM, no
// fetch of its own — so it is unit tested like connector-panel.mjs;
// envoy-workspace.js renders it inside the channel connector panel
// and hands it the workspace's own post function.
//
// WHY THIS FACE LIVES HERE. A person could create a custom
// connector entry in the panel (bite 3) but could not remove one
// anywhere: the Integrations Connectors page that once held a
// removal surface was removed 2026-11-10 (Troy's order), and no
// panel surface called the removal road, so a created entry was a
// dead end — the duplicate-name conflict's own remedy ("remove it
// and add it again") was not reachable from the panel either. The
// server road never went away:
//
//   POST /api/admin/connector-library/entries/remove
//     { seatId, entryId }
//     → 200 { status:'removed', entry } — owner/admin only
//       (ownerAct: a member who is neither gets 403 with "this is
//       a workspace-level change — it takes the workspace owner
//       or an admin").
//     Refusals (nothing is removed): an unknown entry gets 404
//       ("connector entry not found in this seat's library"); an
//       entry that is not a custom entry gets 400 ("only custom
//       entries are removed from here — catalog and Helmian
//       entries are turned off with entry-state instead"); a body
//       naming a tenant, a person, or a credential value is
//       refused by name before any of that.
//     What removal does (the library store's removeEntry, and its
//       own words): it removes "an entry and everything under
//       it" — the entry row is deleted, and its connections,
//       mirrors, and their snapshots cascade with it (sql/074's
//       on-delete-cascade references). Removal does NOT refuse
//       while a connection lives, and it is NOT the disconnect
//       road: disconnect revokes a stored credential before its
//       record's references are cleared, and leaves the entry
//       standing; this road deletes the entry itself, connection
//       and all, and runs no credential revoke of its own. The
//       confirmation copy below says exactly that and no more —
//       it never claims a stored sign-in was revoked.
//
// WHO SEES THE CONTROL. Only a custom entry's row, because the
// road removes custom entries only: catalog entries, Helmian
// entries, and local-install entries never carry the control (the
// panel does not offer what it knows the road will refuse), and
// neither does a mirror row — a mirror is a vendor-brokered row
// whose state lives in the vendor's own product, and a custom
// entry is Helmian-brokered by construction, so a row carrying a
// mirror is never a custom entry's row here.
//
// TRUTH RULES (flywheel R52 §3, restated for this face):
// - After a successful remove, the panel's list state is
//   re-derived from the library re-read (envoy-workspace.js
//   re-reads the seat's library, exactly as the create and key
//   faces do): the entry is gone because the read no longer
//   returns it. This module returns no list and deletes nothing
//   locally — the removed record it hands back is the write
//   road's own returned entry record, folded by
//   applyCustomRemove, and nothing else.
// - A refused remove surfaces the server's answer in plain words
//   on the entry's row (the thrown error's body error text
//   first), and the entry stays — no re-read paints it away and
//   nothing is removed here.
// - A remove answer that is not the road's removed answer, or
//   that carries no entry record, removes nothing here.
//
// SCOPE: removal ONLY. No entry editing (the store refuses it
// outright — "never edited in place"), no rename, no icon work.

// The server road, named once.
export const CUSTOM_REMOVE_PATH = '/api/admin/connector-library/entries/remove';

// The road's own refusals, named for the tests that pin this
// module against the server files word for word. The panel never
// sends a shape these would refuse for a reason it can know
// itself (the control is only offered on custom entries), but a
// caller the road refuses — a member who is not owner/admin, an
// entry that stopped being custom — reads these exact words back
// through refusalText below.
export const OWNER_REFUSAL_MESSAGE = 'this is a workspace-level change — it takes the workspace owner or an admin';
export const NOT_CUSTOM_MESSAGE = 'only custom entries are removed from here — catalog and Helmian entries are turned off with entry-state instead';
export const NOT_FOUND_MESSAGE = 'connector entry not found in this seat\u2019s library';

/**
 * Is this library row a custom entry's row — the only row the
 * removal road will ever remove? The row model the panel renders
 * (connector-panel.mjs's rowModel) carries the entry's kind, its
 * broker mode, and its mirror note: a custom entry is
 * kind 'custom', Helmian-brokered, and never a mirror. Anything
 * else — catalog, Helmian-native, a local install, a vendor
 * mirror — is not offered a control the road would refuse.
 */
export function isCustomEntryRow(row) {
  return Boolean(row)
    && row.kind === 'custom'
    && row.brokerMode === 'helmian'
    && !row.mirror;
}

// ------------------------------------------------------------ the face model
// The removal control's state for one entry. The seat and the
// entry are the panel's own — the removal road removes from the
// seat the person is looking at. The confirmation line is the
// road's own truth in plain words: this deletes the entry
// itself (not a disconnect, which leaves the entry standing),
// and a connection under the entry is removed with it, because
// the store removes the entry and everything under it. It does
// not claim the disconnect road's credential revoke — this road
// runs none.

export function customRemoveModel({ seatId = null, entryId = null, name = null, kind = null, brokerMode = null, mirror = null } = {}) {
  if (!seatId || !entryId || !name) return null;
  if (!isCustomEntryRow({ kind, brokerMode, mirror })) return null;
  return Object.freeze({
    seatId,
    entryId,
    name,
    kind: 'custom',
    button: Object.freeze({ label: 'Remove', pendingLabel: 'Removing…' }),
    keepLabel: 'Keep it',
    confirmLabel: 'Remove for good',
    confirmLine: `Remove ${name} for good? This deletes the custom connector itself from this seat's library — it is not a disconnect, and the entry does not stay standing. If anyone is connected to it, their connection is deleted with it. To use it again, it would have to be added again.`,
  });
}

// ------------------------------------------------------------ wire shape
// The exact body the removal road demands: the seat and the
// entry, nothing else — no tenant, no person, no credential
// value rides it (the road refuses all three by name). The
// builder refuses (null) rather than send a shape with no seat
// or no entry.

export function removeCustomBody({ seatId, entryId } = {}) {
  if (!seatId || !entryId) return null;
  return Object.freeze({ seatId, entryId });
}

/**
 * The removed entry, folded from the write road's own answer:
 * the returned entry record only — its id, its seat, its name.
 * An answer that is not the road's removed answer, or that
 * carries no entry record, folds to null: the panel declares no
 * removal the server did not return. Note what this does NOT
 * carry: no list. The entry's absence from the panel is the
 * library re-read's doing, never a local deletion here.
 */
export function applyCustomRemove(out) {
  const entry = out?.entry ?? null;
  if (out?.status !== 'removed' || !entry || typeof entry.id !== 'string' || !entry.id
    || typeof entry.name !== 'string' || !entry.name) return null;
  return Object.freeze({
    entryId: entry.id,
    seatId: typeof entry.seatId === 'string' && entry.seatId ? entry.seatId : null,
    name: entry.name,
    kind: typeof entry.kind === 'string' ? entry.kind : null,
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
// The face's one write, driven through a transport the caller
// supplies ({ post } — the workspace's own, in the panel; shaped
// stubs, in tests). On success it returns the removed entry
// folded from the road's own returned record — and no list, so
// the caller re-reads the library for the entry's absence. On
// refusal the road's plain words and no removal, so the entry
// stays exactly where it stood.

export async function submitCustomRemove({ post, model } = {}) {
  if (!model || typeof post !== 'function') return { ok: false, sent: false, error: 'This connector cannot be removed here.', removed: null };
  const body = removeCustomBody({ seatId: model.seatId, entryId: model.entryId });
  if (!body) return { ok: false, sent: false, error: 'This connector cannot be removed here.', removed: null };
  let out;
  try {
    out = await post(CUSTOM_REMOVE_PATH, body);
  } catch (error) {
    return { ok: false, sent: true, error: refusalText(error, 'That connector could not be removed. Try again.'), removed: null };
  }
  const removed = applyCustomRemove(out);
  if (!removed) {
    return { ok: false, sent: true, error: refusalText(out, 'That connector could not be removed. Try again.'), removed: null };
  }
  return { ok: true, sent: true, error: '', removed, out };
}
