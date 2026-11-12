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
// the connector for the CHANNEL until flipped off (the standing set,
// Amendment 1 §2.3), then the rest of the catalog with its state
// label. A back affordance returns to Level 1; closing the panel
// leaves the composer text untouched (the workspace owns that —
// this model never sees the draft).
//
// THE TOGGLE LAWS (§1.6, §3.4, and the Bite 3 gate — the standing
// set per Amendment 1 §2.3, bite A2):
// - Toggle state is held per (seat, channel). Nothing about one
//   seat's toggles is visible in, or affects, another seat's library
//   or another channel.
// - A toggle is STANDING: it records the channel's armed set for
//   that seat until it is flipped off — it is not consumed by a
//   send. The set persists on the channel's own config (the
//   channel-config road, action 'set-armed-connectors';
//   armedStateFromConfig / armedConnectorPairs below are the two
//   bridges between that stored shape and this store), and every
//   message the composer sends carries the set's still-connected
//   pairs as metadata.connectors. Since Mirror M3 G4 (commit
//   d6d215b) the turn path's connectorArming seam IS wired:
//   dispatch resolves the set into arming records, the runner
//   opens the connection and gates its tools by the connection's
//   posture, fail closed. A flip therefore does run something —
//   the armed connector's frozen tools join the seat's next turn.
// - Only a Connected, Helmian-brokered row can be armed. A
//   vendor-brokered row is a mirror (§1.5): its state is what the
//   seat's vendor side last reported, its management lives in the
//   vendor's own product, and posture/tool toggles do not apply to
//   mirror records (§2.2) — the row carries the mirror note and the
//   Manage link, never a toggle. Not-connected, needs-reconnect and
//   owner-disabled rows show their state label and nothing else:
//   Bite 3 builds no connect road, so the panel draws no Connect
//   button it cannot honour yet.
// - A CUSTOM row carries its gate (pipeline map G1): until the
//   entry's null-credential safety check has passed, the row words
//   that instead of a plain "Not connected" — "Not ready — safety
//   check has not passed", or "Check failed — not ready" when the
//   check ran and failed — and it can never carry a toggle, which
//   the read already enforces by capping its state; the model
//   rules it again here so no read shape can arm an ungated row.
//   THE ONE EXCEPTION is a gate that is MISSING on this seat
//   (sync S2a/S2c): the gate is keyed per (seat, entry), and a
//   custom entry created on another agent is projected into this
//   agent's library with no gate row here at all — its check has
//   never RUN for this agent, which is not a failure and not a
//   "not ready". That row words its plain truth — not connected,
//   connecting runs its safety check for this agent — and its
//   Connect stands, because the connect start itself registers
//   and probes this seat's gate before anything lands (the write
//   route's ensure road; S2a proved it on the second seat).
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

/** Arm or disarm one connector in the scope's standing set. */
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
 * The armed set for a scope, as the ask path carries it: one
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

/** Drop a scope's whole armed set. */
export function clearConversationToggles(state, conversationId) {
  if (!state || !Object.hasOwn(state, conversationId)) return state ?? {};
  const out = { ...state };
  delete out[conversationId];
  return out;
}

// ------------------------------------------------- the standing set
// The bridges between the channel config's stored shape and this
// store. The config (GET /api/admin/envoy/channel-config →
// config.armedConnectors, written by the 'set-armed-connectors'
// action) carries the set as a flat [{ seatId, entryId }] list —
// the same pairs connectorsForTurn returns — because the config is
// per channel already and needs no scope key. The store keys its
// branches by scope (`channel:<id>`), so hydration folds the flat
// list under the channel's scope and extraction reads it back out.
// Ids are slug-checked with the same pattern the message metadata
// validator uses; a malformed stored pair is dropped, never armed.

const ARMED_PAIR_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;

function cleanArmedPairs(pairs) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(pairs) ? pairs : []) {
    const seatId = String(item?.seatId ?? '');
    const entryId = String(item?.entryId ?? '');
    if (!ARMED_PAIR_ID_PATTERN.test(seatId) || !ARMED_PAIR_ID_PATTERN.test(entryId)) continue;
    const id = `${seatId}:${entryId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ seatId, entryId });
  }
  return out;
}

/**
 * The toggle-store state for one channel, hydrated from its public
 * config (the shape publicConfig returns: armedConnectors as a flat
 * pair list). An absent or malformed list hydrates to the empty
 * store — nothing armed is the honest default.
 */
export function armedStateFromConfig(config, scopeId) {
  const pairs = cleanArmedPairs(config?.armedConnectors);
  if (!pairs.length || !scopeId) return Object.freeze({});
  const branch = {};
  for (const { seatId, entryId } of pairs) {
    if (!branch[seatId]) branch[seatId] = [];
    branch[seatId].push(entryId);
  }
  return Object.freeze({ [scopeId]: Object.freeze(branch) });
}

/**
 * The flat pair list the channel-config write carries: the scope's
 * armed set, sorted (connectorsForTurn's deterministic order).
 */
export function armedConnectorPairs(state, scopeId) {
  return connectorsForTurn(state, scopeId);
}

/**
 * The composer draft an MCP prompt row seeds when the prompt takes
 * required arguments and so cannot be rendered sight-unseen
 * (mirror-design §4, bite M2): the prompt's own description (or
 * title/name) as the ask, then one fill-in line per required
 * argument. Mirrors promptDraftText in src/cloud/connector-library
 * .mjs — the two must word the draft the same way. Choosing the row
 * only ever fills the composer; sending stays the person's act.
 */
export function starterDraftText(prompt) {
  const head = (typeof prompt?.description === 'string' && prompt.description.trim())
    ? prompt.description.trim()
    : String(prompt?.title ?? prompt?.name ?? '').trim();
  const lines = [head || 'Use this starter:'];
  for (const arg of Array.isArray(prompt?.arguments) ? prompt.arguments : []) {
    if (arg?.required) lines.push(`${arg.name}: `);
  }
  return lines.join('\n');
}

// ------------------------------------------------------------ view models

const TRUST_TEXT = Object.freeze({ verified: 'Verified', community: 'Community', custom: 'Custom' });

/** §1.2 field 5, worded for the row. Connected names the account. */
export function stateLabelFor(row) {
  if (!row) return '';
  // The custom-entry gate words itself before the generic states:
  // an ungated row is not merely "not connected", it is not ready —
  // and a failed check says so (G1).
  const gate = row.gate ?? row.stateDetail?.gate ?? null;
  if (row.kind === 'custom' && gate && gate.passed !== true) {
    if (gate.state === 'failed') return 'Check failed — not ready';
    // Missing on THIS seat (sync S2c): no gate row exists here —
    // the check has not run for this agent yet, so the row reads
    // as what it is, a not-connected connector whose Connect runs
    // that check — never as a check that failed to pass.
    if (gate.state === 'missing') return 'Not connected — connecting runs its safety check for this agent';
    return 'Not ready — safety check has not passed';
  }
  // A connection-family row (the Microsoft four) says the
  // connection is shared: this row's connected state IS the one
  // family connection, recorded under whichever member name the
  // person connected — the read names it in the detail
  // (sharedConnection), and the label carries the truth so four
  // rows never each imply their own connection.
  const shared = row.sharedConnection ?? row.stateDetail?.sharedConnection ?? null;
  const sharedWords = shared ? ` — the shared ${shared.family === 'microsoft' ? 'Microsoft' : shared.family} connection` : '';
  if (row.state === 'connected') return row.accountIdentity ? `Connected as ${row.accountIdentity}${sharedWords}` : `Connected${sharedWords}`;
  if (row.state === 'needs-reconnect') return `Needs reconnect${sharedWords}`;
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
  // The custom-entry gate (G1), joined by the read into stateDetail:
  // state ('missing' | 'registered' | 'probing' | 'verified' |
  // 'failed' | 'revoked') + passed. Absent for every other kind.
  const gate = row.kind === 'custom' && row.stateDetail?.gate
    ? Object.freeze({
      state: row.stateDetail.gate.state ?? null,
      passed: row.stateDetail.gate.passed === true,
      lastError: row.stateDetail.gate.lastError ?? null,
    })
    : null;
  // A connection-family projection (the Microsoft four): the read
  // marks a row whose connection is the family's one connection,
  // recorded under a sibling member's name. Carried on the model
  // so the row can say the connection is shared (stateLabelFor
  // above reads the same detail).
  const sharedConnection = row.stateDetail?.sharedConnection
    ? Object.freeze({
      family: row.stateDetail.sharedConnection.family ?? null,
      recordedUnderEntryId: row.stateDetail.sharedConnection.recordedUnderEntryId ?? null,
    })
    : null;
  // The one toggle law: only a Connected row on a pipe Helmian holds
  // can be armed for the channel. Mirror rows never carry a toggle —
  // and neither does a custom row whose gate has not passed.
  const toggleable = row.state === 'connected' && row.brokerMode === 'helmian' && (!gate || gate.passed);
  // The connect law (owner order, 2026-11-10): the connect road
  // exists — the same library write route the Connectors tab's Manage
  // panel calls — so a not-connected row on a pipe Helmian holds
  // carries a Connect action in this panel. Mirror rows never carry
  // one (the write route refuses vendor entries; the connection lives
  // in the seat's own product), a local-only entry has no
  // connect-start, an owner-disabled row waits for the owner's Manage
  // switch, and a custom row whose gate has run on this seat and
  // not passed is not connectable yet. The one gate state that IS
  // connectable unpassed is 'missing' (sync S2c): no gate row
  // exists for this seat — the entry is the person's own, projected
  // from the agent they created it on — and the connect start is
  // itself the road that registers and probes this seat's gate, so
  // Connect is how the check gets run here, not a prize for having
  // passed it elsewhere. A row whose saved connection needs its
  // sign-in redone reads Reconnect.
  const connectable = row.brokerMode === 'helmian'
    && (row.state === 'not-connected' || row.state === 'needs-reconnect')
    && row.kind !== 'mcp-local'
    && (!gate || gate.passed || gate.state === 'missing');
  const reconnect = connectable && row.state === 'needs-reconnect';
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
    stateLabel: stateLabelFor({ ...row, gate }),
    accountIdentity: row.accountIdentity ?? null,
    brokerMode: row.brokerMode,
    kind: row.kind,
    gate,
    sharedConnection,
    // A tenant-pair row (Box, Salesforce): the read marks it from
    // the definition (connector-library-read.mjs), and the
    // renderer offers the Client pair action — the pair is the
    // TENANT's, entered once for the whole workspace, never per
    // row or per person. oauthProvider names the pair's provider
    // for the pair form. False/null on every other row.
    tenantPair: row.tenantPair === true,
    oauthProvider: typeof row.oauthProvider === 'string' && row.oauthProvider ? row.oauthProvider : null,
    toggleable,
    connectable,
    reconnect,
    on: toggleable ? isConnectorOn(state, conversationId, row.seatId, row.entryId) : false,
    mirror,
    // Catalog starter actions (mirror-design §4, bite M2): the read
    // joins them from the catalog; the menu renders them as draft-
    // seeding rows under this connector. Absent → empty, never
    // invented.
    starterActions: Object.freeze((Array.isArray(row.starterActions) ? row.starterActions : [])
      .filter((a) => a && typeof a.label === 'string' && typeof a.prompt === 'string')
      .map((a) => Object.freeze({ label: a.label, prompt: a.prompt }))),
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
