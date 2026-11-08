// Connector library "+" panel — Surface A (connector-library SPEC
// §1.1/§1.2/§1.6, build bite 3). Pure model — no DOM — so it is unit
// tested like composer-picker.mjs; envoy-workspace.js renders it
// inside the room composer's existing "+" panel.
//
// THE SHAPE (§1.1): the panel opens on Level 1 — pick the seat: one
// row per seat that has a library, carrying the seat's face (rendered
// by the workspace from the seat id), its name, and its connected
// count. Tapping a seat opens Level 2 — that seat's library, read from
// GET /api/admin/connector-library (the Bite 2 read behind the Bite 3
// route): connected connectors first, each with a toggle that arms
// the connector FOR THIS MESSAGE ONLY, then the rest of the catalog
// with its state label. A back affordance returns to Level 1; closing
// the panel leaves the composer text untouched (the workspace owns
// that — this model never sees the draft).
//
// THE TOGGLE LAWS (§1.6, §3.4, and the Bite 3 gate):
// - Toggle state is held per (seat, conversation). Nothing about one
//   seat's toggles is visible in, or affects, another seat's library
//   or another conversation.
// - A toggle arms its connector for the NEXT message in that
//   conversation and is consumed by that send: connectorsForTurn()
//   reads the armed set for the ask path, and the workspace clears
//   the conversation's set once the message lands, so the next
//   message starts from the same defaults (nothing armed) — arming a
//   connector for one message never quietly re-arms it for the next.
// - Only a Connected, Helmian-brokered row can be armed. A
//   vendor-brokered row is a mirror (§1.5): its state is what the
//   seat's vendor side last reported, its management lives in the
//   vendor's own product, and posture/tool toggles do not apply to
//   mirror records (§2.2) — the row carries the mirror note and the
//   Manage link, never a toggle. Not-connected, needs-reconnect and
//   owner-disabled rows show their state label and nothing else:
//   Bite 3 builds no connect road, so the panel draws no Connect
//   button it cannot honour yet.
// - On the wire the armed set rides as message metadata
//   (metadata.connectors, built by composer-picker.mjs's
//   buildMessageRequest): each entry names its seat, and a seat's
//   turn consumes only its own entries. An untouched panel changes
//   nothing on the wire.

// The seats that hold libraries (the catalog's LIVE_SEATS,
// src/cloud/connector-catalog.mjs) and how the room names and runs
// them. `provider` is the room's workspace agent key for the seat —
// the face/presence key envoy-workspace.js already uses — or null for
// the seats that hold a library but are not composer agents (Muse,
// Helm, Owner). ChatGPT is the one mismatch: library seat 'chatgpt',
// room provider 'openai' (the same mismatch the crew faces carry).
export const LIBRARY_SEATS = Object.freeze([
  Object.freeze({ seatId: 'claude', name: 'Claude', provider: 'claude' }),
  Object.freeze({ seatId: 'chatgpt', name: 'ChatGPT', provider: 'openai' }),
  Object.freeze({ seatId: 'grok', name: 'Grok', provider: 'grok' }),
  Object.freeze({ seatId: 'gemini', name: 'Gemini', provider: 'gemini' }),
  Object.freeze({ seatId: 'mistral', name: 'Mistral', provider: 'mistral' }),
  Object.freeze({ seatId: 'groq', name: 'Groq', provider: 'groq' }),
  Object.freeze({ seatId: 'nvidia', name: 'NVIDIA', provider: 'nvidia' }),
  Object.freeze({ seatId: 'openrouter', name: 'OpenRouter', provider: 'openrouter' }),
  Object.freeze({ seatId: 'cloudflare', name: 'Cloudflare', provider: 'cloudflare' }),
  Object.freeze({ seatId: 'qwen', name: 'Qwen', provider: 'qwen' }),
  Object.freeze({ seatId: 'muse', name: 'Muse', provider: null }),
  Object.freeze({ seatId: 'maestro', name: 'Maestro', provider: 'maestro' }),
  Object.freeze({ seatId: 'helm', name: 'Helm', provider: null }),
  Object.freeze({ seatId: 'owner', name: 'Owner', provider: null }),
]);
const SEAT_BY_ID = new Map(LIBRARY_SEATS.map((s) => [s.seatId, s]));
const SEAT_BY_PROVIDER = new Map(LIBRARY_SEATS.filter((s) => s.provider).map((s) => [s.provider, s]));

export function librarySeat(seatId) {
  return SEAT_BY_ID.get(String(seatId ?? '')) ?? null;
}
export function seatName(seatId) {
  return librarySeat(seatId)?.name ?? String(seatId ?? '');
}
export function providerForSeat(seatId) {
  return librarySeat(seatId)?.provider ?? null;
}
export function seatForProvider(provider) {
  return SEAT_BY_PROVIDER.get(String(provider ?? ''))?.seatId ?? null;
}

// §1.2's browse rule: category grouping and a search box appear once a
// seat's list passes ~20 entries. Below that, a flat list sorted
// connected-first (the read's own order) is correct.
export const LIBRARY_SEARCH_THRESHOLD = 20;

// ------------------------------------------------------------ toggle store
// State shape: { [conversationId]: { [seatId]: [entryId, ...] } } —
// plain JSON, immutable updates (every write returns a new state, the
// composer-picker convention). An absent branch means nothing armed.

export function emptyConnectorToggles() {
  return Object.freeze({});
}

function branchOf(state, conversationId, seatId) {
  const list = state?.[conversationId]?.[seatId];
  return Array.isArray(list) ? list : [];
}

export function isConnectorOn(state, conversationId, seatId, entryId) {
  return branchOf(state, conversationId, seatId).includes(entryId);
}

/** Arm or disarm one connector for the conversation's next message. */
export function toggleConnector(state, conversationId, seatId, entryId) {
  const conv = { ...(state?.[conversationId] ?? {}) };
  const list = branchOf(state, conversationId, seatId);
  const next = list.includes(entryId) ? list.filter((id) => id !== entryId) : [...list, entryId];
  if (next.length) conv[seatId] = next; else delete conv[seatId];
  const out = { ...(state ?? {}) };
  if (Object.keys(conv).length) out[conversationId] = conv; else delete out[conversationId];
  return out;
}

/**
 * The armed set for a conversation, as the ask path carries it: one
 * { seatId, entryId } per armed connector, sorted so the wire shape
 * is deterministic. Every entry names its seat — a seat's turn
 * consumes only its own (§3.4).
 */
export function connectorsForTurn(state, conversationId) {
  const conv = state?.[conversationId] ?? {};
  const out = [];
  for (const seatId of Object.keys(conv).sort()) {
    for (const entryId of [...conv[seatId]].sort()) out.push(Object.freeze({ seatId, entryId }));
  }
  return Object.freeze(out);
}

/** Drop a conversation's whole armed set (its message has landed). */
export function clearConversationToggles(state, conversationId) {
  if (!state || !Object.hasOwn(state, conversationId)) return state ?? {};
  const out = { ...state };
  delete out[conversationId];
  return out;
}

// ------------------------------------------------------------ view models

const TRUST_TEXT = Object.freeze({ verified: 'Verified', community: 'Community', custom: 'Custom' });

/** §1.2 field 5, worded for the row. Connected names the account. */
export function stateLabelFor(row) {
  if (!row) return '';
  if (row.state === 'connected') return row.accountIdentity ? `Connected as ${row.accountIdentity}` : 'Connected';
  if (row.state === 'needs-reconnect') return 'Needs reconnect';
  if (row.state === 'disabled-by-owner') return 'Turned off by your workspace owner';
  return 'Not connected';
}

function iconSlugOf(row) {
  const ref = String(row?.iconRef ?? '');
  return ref.startsWith('icon:') ? ref.slice('icon:'.length) : null;
}

function rowModel(row, state, conversationId) {
  const mirror = row.brokerMode === 'vendor'
    ? Object.freeze({ manageUrl: row.stateDetail?.manageUrl ?? null, managedIn: seatName(row.seatId) })
    : null;
  // The one toggle law: only a Connected row on a pipe Helmian holds
  // can be armed for a message. Mirror rows never carry a toggle.
  const toggleable = row.state === 'connected' && row.brokerMode === 'helmian';
  return Object.freeze({
    entryId: row.entryId,
    seatId: row.seatId,
    name: row.name,
    oneLiner: row.oneLiner,
    vendorLabel: row.vendorLabel,
    trustLabel: row.trustLabel,
    trustText: TRUST_TEXT[row.trustLabel] ?? row.trustLabel,
    iconSlug: iconSlugOf(row),
    state: row.state,
    stateLabel: stateLabelFor(row),
    accountIdentity: row.accountIdentity ?? null,
    brokerMode: row.brokerMode,
    kind: row.kind,
    toggleable,
    on: toggleable ? isConnectorOn(state, conversationId, row.seatId, row.entryId) : false,
    mirror,
  });
}

/**
 * Level 1 (§1.1): one row per seat the seats read returned — face
 * (rendered by the workspace from the seat id), name, connected
 * count. Server order is preserved (the catalog's seat order).
 */
export function level1Model(seats) {
  const rows = (Array.isArray(seats) ? seats : []).map((s) => Object.freeze({
    seatId: s.seatId,
    name: seatName(s.seatId),
    provider: providerForSeat(s.seatId),
    connectedCount: Number.isSafeInteger(s.connectedCount) ? s.connectedCount : 0,
    entryCount: Number.isSafeInteger(s.entryCount) ? s.entryCount : 0,
  }));
  return Object.freeze({ rows: Object.freeze(rows) });
}

/**
 * Level 2 (§1.1): one seat's library — the connected rows first (the
 * read already sorts them first; the split preserves its order), then
 * the catalog, then the Add-custom row's model. The custom row is
 * present but not actionable in this bite: Surface C is Bite 6, and a
 * row that pretends to add would be theatre — it renders disabled
 * with its honest note.
 */
export function level2Model(library, state, conversationId) {
  const rows = Array.isArray(library?.rows) ? library.rows : [];
  const models = rows.map((row) => rowModel(row, state, conversationId));
  return Object.freeze({
    seatId: library?.seatId ?? null,
    seatName: seatName(library?.seatId),
    connectedCount: Number.isSafeInteger(library?.connectedCount) ? library.connectedCount : models.filter((r) => r.state === 'connected').length,
    connected: Object.freeze(models.filter((r) => r.state === 'connected')),
    catalog: Object.freeze(models.filter((r) => r.state !== 'connected')),
    searchable: rows.length > LIBRARY_SEARCH_THRESHOLD,
    customRow: Object.freeze({ label: 'Add custom connector', enabled: false, note: 'Custom connectors can\'t be added yet.' }),
  });
}
