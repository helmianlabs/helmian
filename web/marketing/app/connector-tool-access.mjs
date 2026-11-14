// Tool access — the panel-native face (panel-native home bite 1,
// 2026-11-10). Pure model + the exact wire shapes of the connector
// library's tool-access roads — no DOM, no fetch of its own — so it
// is unit tested like connector-panel.mjs; envoy-workspace.js
// renders it inside the channel connector panel and hands it the
// workspace's own api/post functions.
//
// WHY THIS FACE LIVES HERE. The per-connection posture picker and
// the per-tool switches once lived on the Integrations Connectors
// tab's Manage surface. That surface was removed 2026-11-10 (Troy's
// order); its cleanup report named the grounded home for these two
// capabilities: a panel-native face in the channel. This module is
// that face's model. The server roads never went away:
//
//   GET  /api/admin/connector-library/tool-access?seat=<seatId>&entry=<entryId>
//     → { valid, seatId, entryId, connected, posture, tools,
//         snapshotTakenAt, snapshotHash }
//     The caller's OWN connection for one entry: its posture, and
//     the tools of its FROZEN snapshot with their on/off state.
//     A disconnected (or absent) connection answers connected:false
//     with an empty tool list — never an invented one.
//   POST /api/admin/connector-library/posture
//     { seatId, entryId, posture } → { status:'posture-set', connection }
//   POST /api/admin/connector-library/tool-enable
//     { seatId, entryId, toolEnableMap } → { status:'tool-map-set', connection }
//     Per-tool on/off against the connection's frozen snapshot; the
//     store refuses any tool the snapshot does not name, and partial
//     maps merge over the stored one.
//   POST /api/admin/connector-library/tool-refresh
//     { seatId, entryId, preview:true } → { status:'tool-refresh-preview', diff, hasSnapshot }
//     { seatId, entryId, confirm:true } → { status:'tools-refreshed', diff, snapshot, connection }
//     The review act (m3-github DESIGN §4.1(3)): the preview lists
//     the server's tools fresh and answers the diff against the
//     frozen snapshot BY NAME — added / removed / changed — and
//     writes nothing, so the face can show the review before
//     anything is saved. The confirm lists again and re-freezes:
//     new and changed tools land OFF until the person turns them
//     on here, unchanged tools keep their setting, removed tools
//     drop out. The diff is computed on the call, never stored.
//
// TRUTH RULES (flywheel R52 §3, restated for this face):
// - The face reads its state from the tool-access read when it
//   opens — nothing is cached or invented client-side.
// - A write answers with the server's stored state: both write
//   roads return the full connection record, and the face re-derives
//   its state from THAT record (applyToolAccessWrite) — the panel
//   switch is the server's state, never an optimistic flip.
// - Posture belongs to a CONNECTION. An entry with no connection
//   has no posture and no tool switches: the face says "Connect
//   first" in plain words and offers no dead control.
// - Vendor-brokered (mirror) entries carry no posture and no tool
//   switches either — their connection lives in the seat's own
//   product (connector-panel.mjs's mirror law) — so they never
//   appear in this face's entry list at all.
//
// SCOPE: posture + per-tool switches + the tool-refresh review.
// The key/token form and the add-a-custom form are sibling bites;
// if they ever share this face's container, that container is the
// panel section this face renders in (envoy-workspace.js's
// tool-access section in the "+" panel) — named here, not built
// here.

// The server roads, named once.
export const TOOL_ACCESS_READ_PATH = '/api/admin/connector-library/tool-access';
export const TOOL_ACCESS_POSTURE_PATH = '/api/admin/connector-library/posture';
export const TOOL_ACCESS_TOOL_ENABLE_PATH = '/api/admin/connector-library/tool-enable';
export const TOOL_ACCESS_TOOL_REFRESH_PATH = '/api/admin/connector-library/tool-refresh';

// The posture values the server accepts (connector-library.mjs's
// CONNECTOR_POSTURES), in the server's own order, each with the
// plain words the face shows for it. The words state what the
// posture DOES at the approval gate (src/agent/attachments.mjs's
// postureRequiresApproval): ask → every call asks; read → reads run
// free, writes ask; low-risk → reads and declared non-destructive
// writes run free, other writes ask; all → nothing asks.
export const TOOL_ACCESS_POSTURES = Object.freeze([
  Object.freeze({ value: 'ask', label: 'Ask first', detail: 'Ask before every tool call.' }),
  Object.freeze({ value: 'read', label: 'Reading runs freely', detail: 'Tools that only read run without asking. Tools that change things ask first.' }),
  Object.freeze({ value: 'low-risk', label: 'Low-risk tools run freely', detail: 'Tools that only read, and tools marked as not changing anything important, run without asking. Other tools ask first.' }),
  Object.freeze({ value: 'all', label: 'Everything runs freely', detail: 'Every tool runs without asking.' }),
]);
const POSTURE_VALUES = new Set(TOOL_ACCESS_POSTURES.map((p) => p.value));

export function postureOption(value) {
  return TOOL_ACCESS_POSTURES.find((p) => p.value === value) ?? null;
}

// ------------------------------------------------------------ entry list
// Which of a seat's library rows this face can speak for. Input is
// connector-panel.mjs's Level 2 row models (the panel's single
// source of row state): every Helmian-brokered row stands in the
// list; connected rows can open their face; the rest carry the
// plain reason they cannot — a connection is what posture and tool
// switches belong to, so an unconnected row's word is "Connect
// first" (or "Reconnect first" when a saved connection needs its
// sign-in redone). Mirror rows are absent, per the header law.

export function toolAccessEntries(level2) {
  const rows = [...(level2?.connected ?? []), ...(level2?.catalog ?? [])];
  const out = [];
  for (const row of rows) {
    if (!row || row.brokerMode !== 'helmian') continue;
    const connected = row.state === 'connected';
    out.push(Object.freeze({
      entryId: row.entryId,
      seatId: row.seatId,
      name: row.name,
      state: row.state,
      connected,
      blockedNote: connected ? null : row.state === 'needs-reconnect' ? 'Reconnect first' : 'Connect first',
    }));
  }
  return Object.freeze(out);
}

/** The entry the face opens on: the picked one when it is connected, else the first connected entry, else null. */
export function pickToolAccessEntry(entries, wantedEntryId = null) {
  const list = Array.isArray(entries) ? entries : [];
  const wanted = wantedEntryId ? list.find((e) => e.entryId === wantedEntryId && e.connected) : null;
  return wanted ?? list.find((e) => e.connected) ?? null;
}

// ------------------------------------------------------------ the face model
// The tool-access READ answer, normalised into the face's state.
// Anything the read did not say stays empty/null — the model never
// fills a gap. A tool's kind word comes from the read's own
// effectiveAnnotation ('read' | 'write'; undeclared tools already
// read as 'write' server-side), falling back to the raw annotation.

function toolModel(tool) {
  if (!tool || typeof tool.name !== 'string' || !tool.name) return null;
  const effective = tool.effectiveAnnotation === 'read' || tool.effectiveAnnotation === 'write'
    ? tool.effectiveAnnotation
    : tool.annotation === 'read' ? 'read' : 'write';
  return Object.freeze({
    name: tool.name,
    description: typeof tool.description === 'string' ? tool.description : '',
    kind: effective,
    kindLabel: effective === 'read' ? 'Reads only' : 'Can change things',
    enabled: tool.enabled !== false,
  });
}

export function toolAccessModel(raw, { seatId = null, entryId = null } = {}) {
  const tools = (Array.isArray(raw?.tools) ? raw.tools : []).map(toolModel).filter(Boolean);
  const posture = typeof raw?.posture === 'string' ? raw.posture : null;
  const connected = raw?.connected === true;
  return Object.freeze({
    seatId: raw?.seatId ?? seatId,
    entryId: raw?.entryId ?? entryId,
    connected,
    // No connection → no controls at all, only the plain word.
    connectFirst: !connected,
    posture,
    postureKnown: posture !== null && POSTURE_VALUES.has(posture),
    options: Object.freeze(TOOL_ACCESS_POSTURES.map((p) => Object.freeze({ ...p, selected: connected && p.value === posture }))),
    tools: Object.freeze(tools),
    hasSnapshot: typeof raw?.snapshotHash === 'string' && raw.snapshotHash !== '',
    snapshotTakenAt: raw?.snapshotTakenAt ?? null,
    snapshotHash: raw?.snapshotHash ?? null,
    // The tool-refresh review's diff, once the person has checked:
    // null until a preview answers (a fresh read starts unreviewed).
    refreshDiff: null,
  });
}

/**
 * The face's state after a write: the write roads answer with the
 * full connection record ({ posture, toolEnableMap, state, … }), and
 * the stored state in that record is what the face shows next — a
 * posture the server stored, and each tool's on/off from the
 * server's stored map (a tool absent from the map is on, the read's
 * own rule). A write answer with no connection record changes
 * nothing the face can prove, so the model stands unchanged.
 */
export function applyToolAccessWrite(model, connection) {
  if (!model || !connection || typeof connection !== 'object') return model;
  const posture = typeof connection.posture === 'string' ? connection.posture : model.posture;
  const map = connection.toolEnableMap && typeof connection.toolEnableMap === 'object' && !Array.isArray(connection.toolEnableMap)
    ? connection.toolEnableMap
    : null;
  return Object.freeze({
    ...model,
    connected: connection.state === 'disconnected' ? false : model.connected,
    connectFirst: connection.state === 'disconnected' ? true : model.connectFirst,
    posture,
    postureKnown: posture !== null && POSTURE_VALUES.has(posture),
    options: Object.freeze(TOOL_ACCESS_POSTURES.map((p) => Object.freeze({ ...p, selected: model.connected && p.value === posture }))),
    tools: Object.freeze(model.tools.map((tool) => Object.freeze(map ? { ...tool, enabled: map[tool.name] !== false } : tool))),
  });
}

// -------------------------------------------------- the refresh review
// The preview's diff, normalised for the face: the three name
// lists the server answered (added / removed / changed against
// the frozen snapshot), nothing else. A name the server did not
// send is never invented; an answer with no diff in it is no
// review at all (the callers keep the model's standing diff).

export function toolRefreshDiffModel(raw) {
  const names = (list) => Object.freeze((Array.isArray(list) ? list : []).filter((n) => typeof n === 'string' && n !== ''));
  const added = names(raw?.added);
  const removed = names(raw?.removed);
  const changed = names(raw?.changed);
  return Object.freeze({
    added,
    removed,
    changed,
    hasDrift: added.length + removed.length + changed.length > 0,
  });
}

/**
 * The face after a refresh PREVIEW: only the diff changes. The
 * preview wrote nothing server-side, so the tools, the posture,
 * and the snapshot facts all stand exactly as the read left
 * them — the review is a statement about what a confirm WOULD
 * freeze, never a state the face pretends was saved.
 */
export function applyToolRefreshPreview(model, raw) {
  if (!model || !raw || typeof raw !== 'object' || !raw.diff || typeof raw.diff !== 'object') return model;
  return Object.freeze({ ...model, refreshDiff: toolRefreshDiffModel(raw.diff) });
}

/**
 * The face after a refresh CONFIRM: the answer carries the new
 * frozen snapshot and the connection it landed on, and the face
 * re-derives from THOSE — the tool rows are the new snapshot's
 * tools with the connection's stored on/off map over them (new
 * and changed tools OFF, the freeze's own merge), the snapshot
 * facts are the new snapshot's, and the review is spent. An
 * answer with no snapshot in it proves no freeze landed, so
 * only the connection folds (applyToolAccessWrite's rule) and
 * the review stands.
 */
export function applyToolRefreshConfirm(model, raw) {
  if (!model || !raw || typeof raw !== 'object') return model;
  const folded = applyToolAccessWrite(model, raw.connection ?? null);
  const snapTools = Array.isArray(raw.snapshot?.tools) ? raw.snapshot.tools : null;
  if (!snapTools) return folded;
  const map = raw.connection?.toolEnableMap && typeof raw.connection.toolEnableMap === 'object' && !Array.isArray(raw.connection.toolEnableMap)
    ? raw.connection.toolEnableMap
    : {};
  return Object.freeze({
    ...folded,
    tools: Object.freeze(snapTools
      .map((tool) => toolModel({ ...(tool ?? {}), enabled: map[tool?.name] !== false }))
      .filter(Boolean)),
    hasSnapshot: typeof raw.snapshot?.snapshotHash === 'string' && raw.snapshot.snapshotHash !== '',
    snapshotTakenAt: raw.snapshot?.takenAt ?? null,
    snapshotHash: raw.snapshot?.snapshotHash ?? null,
    refreshDiff: null,
  });
}

// ------------------------------------------------------------ wire shapes
// The exact bodies/URLs the server contracts demand. Builders refuse
// (null) rather than send a shape the server would refuse: an
// unknown posture, a tool the face's own snapshot does not name, a
// missing seat or entry.

export function toolAccessReadUrl({ seatId, entryId } = {}) {
  if (!seatId || !entryId) return null;
  return `${TOOL_ACCESS_READ_PATH}?seat=${encodeURIComponent(seatId)}&entry=${encodeURIComponent(entryId)}`;
}

export function postureWriteBody({ seatId, entryId, posture } = {}) {
  if (!seatId || !entryId || !POSTURE_VALUES.has(posture)) return null;
  return Object.freeze({ seatId, entryId, posture });
}

export function toolEnableWriteBody({ seatId, entryId, toolName, enabled, knownTools = null } = {}) {
  if (!seatId || !entryId || typeof toolName !== 'string' || !toolName) return null;
  if (Array.isArray(knownTools) && !knownTools.some((t) => (typeof t === 'string' ? t : t?.name) === toolName)) return null;
  return Object.freeze({ seatId, entryId, toolEnableMap: Object.freeze({ [toolName]: enabled === true }) });
}

export function toolRefreshWriteBody({ seatId, entryId, confirm = false } = {}) {
  if (!seatId || !entryId) return null;
  return Object.freeze(confirm === true
    ? { seatId, entryId, confirm: true }
    : { seatId, entryId, preview: true });
}

// ------------------------------------------------------------ the round trip
// The face's roads, driven through transport functions the
// caller supplies ({ api, post } — the workspace's own, in the
// panel; shaped stubs, in tests). Each returns the face model the
// caller should render: the read's model on open, and the write's
// own returned connection folded back over the read model after a
// write — so what renders is always a state the server stated.

export async function loadToolAccess({ api, seatId, entryId } = {}) {
  const url = toolAccessReadUrl({ seatId, entryId });
  if (!url || typeof api !== 'function') return null;
  const raw = await api(url);
  return toolAccessModel(raw, { seatId, entryId });
}

export async function writeToolAccessPosture({ post, model, posture } = {}) {
  const body = model ? postureWriteBody({ seatId: model.seatId, entryId: model.entryId, posture }) : null;
  if (!body || typeof post !== 'function') return null;
  const out = await post(TOOL_ACCESS_POSTURE_PATH, body);
  return applyToolAccessWrite(model, out?.connection ?? null);
}

export async function writeToolAccessTool({ post, model, toolName, enabled } = {}) {
  const body = model ? toolEnableWriteBody({ seatId: model.seatId, entryId: model.entryId, toolName, enabled, knownTools: model.tools }) : null;
  if (!body || typeof post !== 'function') return null;
  const out = await post(TOOL_ACCESS_TOOL_ENABLE_PATH, body);
  return applyToolAccessWrite(model, out?.connection ?? null);
}

export async function previewToolAccessRefresh({ post, model } = {}) {
  const body = model ? toolRefreshWriteBody({ seatId: model.seatId, entryId: model.entryId }) : null;
  if (!body || typeof post !== 'function') return null;
  const out = await post(TOOL_ACCESS_TOOL_REFRESH_PATH, body);
  return applyToolRefreshPreview(model, out);
}

export async function confirmToolAccessRefresh({ post, model } = {}) {
  const body = model ? toolRefreshWriteBody({ seatId: model.seatId, entryId: model.entryId, confirm: true }) : null;
  if (!body || typeof post !== 'function') return null;
  const out = await post(TOOL_ACCESS_TOOL_REFRESH_PATH, body);
  return applyToolRefreshConfirm(model, out);
}
