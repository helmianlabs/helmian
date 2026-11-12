// Connector library "+" menu — the per-seat menu DEFINITIONS
// (plus-research REPORT §3/§4, build bite 3R-a). Pure data + tiny
// accessors — no DOM, no fetch — so it is unit tested like
// connector-panel.mjs; bite 3R-b renders it inside the room
// composer's "+" menu.
//
// WHAT THIS MODULE IS, AND IS NOT. Bite 3 shipped the panel face and
// the row-state model (connector-panel.mjs: level1Model /
// level2Model stay the single source of row STATE — connected,
// needs-reconnect, the account a row is connected as). This module
// decides only SHAPE, ORDER and WORDS: for each seat, the Level 2
// items of that seat's "+" menu, in the seat vendor's own words and
// order from REPORT §3, following the shared skeleton of REPORT §4
// (attach leads; the seat's own capability rows next; connectors in
// one grouped section; a Manage footer leaves the menu). The render
// composes (menu definition × library read × toggle state); a
// definition never carries state, and never invents a row the read
// cannot fill.
//
// ITEM TYPES — exactly eight, nothing else (six from bite 3R-a; the
// mirror design §5.1 names the shell's three missing row kinds —
// action rows, the badge roll-up, the Add row — and bite M2 lands
// the first two of them here):
//   attach            the files row (the room's upload is real for
//                     every seat: composer-picker.mjs's upload group).
//   capability        a room capability row. A row exists ONLY where
//                     the room can actually run the capability for
//                     that seat (REPORT §6) — see the exclusions
//                     named in the bite report.
//   action            a row that DOES something in the room when
//                     picked (mirror-design §4): 'github-file' opens
//                     the GitHub file source (the picker's picked
//                     file rides the attach road); 'tool-access'
//                     expands the seat's Tool access face in the
//                     panel itself — the per-connection posture
//                     picker and per-tool switches
//                     (connector-tool-access.mjs; the Manage surface
//                     it once landed on was removed 2026-11-10, and
//                     its panel-native home landed the same day).
//                     An action exists ONLY where its carrier is
//                     real for that seat.
//   projects          the "Add to project" row: the composer's
//                     active-project picker, bound to the workspace
//                     project registry (mirror-design §3.1).
//   live-toggle-group the channel's standing toggle list
//                     (Amendment 1 §2.3): connector rows the person
//                     switches on for the channel until switched off
//                     (connector-panel.mjs's toggle store, persisted
//                     on the channel config). Binds catalog entries
//                     by id, and binds ONLY brokerMode:'helmian'
//                     entries — a live toggle on a pipe Helmian does
//                     not hold is a fake (SPEC §1.5/§5.3, REPORT §6).
//                     The face renders only the group's Connected
//                     rows as switches; the rest of the group is not
//                     offered.
//   mirror-group      vendor-brokered rows: state + "Managed in
//                     <product>", nothing else. THE NEVER-FAKE LAW IS
//                     STRUCTURAL HERE: a mirror group has no toggle
//                     field, no armed/on field, no posture field, no
//                     connect field — not flagged off, ABSENT. Its
//                     rows are brokerMode:'vendor' catalog entries;
//                     `rowShape` is 'mirror' (the per-conversation
//                     mirror rows of Claude / ChatGPT / Mistral) or
//                     'state' (the ACCOUNT-LEVEL state rows of Grok
//                     and Gemini, whose vendors connect account-wide
//                     and invoke by @ — REPORT §3.3/§3.4, §5.1: there
//                     is no per-chat toggle to imitate, so the row
//                     shape says so).
//   submenu           a "›" row holding further items (Skills ›,
//                     Connectors ›, Plugins ›, More ›, Tools ›,
//                     Connected Apps ›).
//   manage-link       the footer row — always Helmian's own
//                     Integrations view ('integrations'). A vendor's
//                     own manager is never a menu row: Troy's ruling
//                     (2026-11-08) — a seat's connections are managed
//                     inside Helmian, never on a vendor page the
//                     customer has to go manage.
//
// GROUP BINDINGS. A connector group binds its rows in exactly one of
// two ways: `entryIds` — ids into the shipped catalog
// (src/cloud/connector-catalog.mjs, resolved per seat; a test proves
// every id resolves, that live groups bind only helmian-brokered
// entries, mirror groups only vendor-brokered ones, and that every
// catalog entry of the seat is bound exactly once across its menu) —
// or `feed`, naming a non-catalog HELMIAN-side source the renderer
// fills: 'helmian-skills' (the workspace skill library, GET
// /api/admin/skills — the skills that actually run on Helmian's
// turns for the seat) and 'bridge-plugins' (the PC bridge's real
// plugin list, GET /api/admin/plugins). Bite M2 closed the old
// vendor feeds (seat-skills-api, seat-skills-vendor, vendor-plugins,
// vendor-agents) under the mirror design §8 law: a feed-bound group
// that can only ever render "Nothing here yet" is a broken promise —
// each was either rebound to a lawful Helmian source (skills,
// plugins) or deleted (the vendor skills mirror, Mistral's agents;
// M7 re-points Mistral's at Helmian's custom agents). A feed-bound
// group names no connector, so it can never invent one.
import { LIBRARY_SEATS } from './connector-panel.mjs?v=2373ccb8c45e367b';

export const MENU_ITEM_TYPES = Object.freeze([
  'attach', 'capability', 'action', 'projects', 'live-toggle-group', 'mirror-group', 'submenu', 'manage-link',
]);

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
};

const attach = (label) => ({ type: 'attach', label });
const capability = (label, capabilityKey) => ({ type: 'capability', label, capability: capabilityKey });
const action = (label, actionKey) => ({ type: 'action', label, action: actionKey });
const projects = (label) => ({ type: 'projects', label });
const liveGroup = ({ label = null, entryIds = null, feed = null, note = null, requiresToolCapableModel = false }) => ({
  type: 'live-toggle-group', label, ...(entryIds ? { entryIds } : { feed }), ...(note ? { note } : {}),
  ...(requiresToolCapableModel ? { requiresToolCapableModel: true } : {}),
});
const mirrorGroup = ({ label = null, managedIn, rowShape = 'mirror', entryIds = null, feed = null }) => ({
  type: 'mirror-group', label, managedIn, rowShape, ...(entryIds ? { entryIds } : { feed }),
});
const submenu = (label, items) => ({ type: 'submenu', label, items });
const manageLink = ({ label, target }) => ({ type: 'manage-link', label, target });

// The Helmian-native entries every seat's library holds
// (connector-catalog.mjs Source 2) — the Helmian-brokered core of
// every seat's live toggle group.
const NATIVES = ['helmian-github'];
// The seat-agnostic Source 3 shelf (connector-catalog.mjs, from
// src/cloud/mcp-registry-curation.mjs — the official MCP Registry
// imports): offered on EVERY seat and Helmian-brokered like the
// natives, so it rides the same live toggle groups. Today: the
// weather pick (a US National Weather Service data server).
const REGISTRY_SHELF = ['registry-weather'];
// The Source 4 vendor-published servers (connector-catalog.mjs): a
// vendor's own MCP server Helmian brokers directly — Vercel's, plus
// Bite R2's team-work family (Slack, Asana, HubSpot), plus the
// Google family (Gmail, Google Calendar, Google Drive), plus the
// DCR long tail (Meltwater, S&P Global, Idiolect, Gamma), plus the
// fixed tail (Canva, Dropbox) — riding
// the live groups of the seats their catalog entries stock
// (claude, chatgpt, grok).
const BROKERED_SERVERS = ['helmian-vercel', 'helmian-slack', 'helmian-asana', 'helmian-hubspot', 'helmian-gmail', 'helmian-google-calendar', 'helmian-google-drive', 'helmian-meltwater', 'helmian-sp-global', 'helmian-idiolect', 'helmian-gamma', 'helmian-canva', 'helmian-dropbox', 'helmian-onedrive', 'helmian-outlook', 'helmian-microsoft-teams', 'helmian-sharepoint', 'helmian-box', 'helmian-salesforce'];
const manageInHelmian = () => manageLink({ label: 'Manage connectors', target: 'integrations' });
// The plain Helmian list (REPORT §3.6–§3.10 + §3.11): seats with no
// vendor furniture get attach, the live toggles, and the manager —
// in Helmian's own words, with no invented vendor furniture.
const helmianList = ({ entryIds = [...NATIVES, ...REGISTRY_SHELF], note = null, requiresToolCapableModel = false } = {}) => [
  attach('Add files'),
  liveGroup({ label: 'Connectors', entryIds, ...(note ? { note } : {}), requiresToolCapableModel }),
  manageInHelmian(),
];

export const MENU_DEFINITIONS = deepFreeze({
  // ---------------------------------------------------------- Claude
  // REPORT §3.1, Claude's order: Add files or photos · Skills › ·
  // Connectors › · Plugins › · Web search · Manage connectors.
  // (Research is excluded — no research mode exists anywhere in the
  // room's turn path; see the bite report's exclusion list.)
  claude: [
    attach('Add files or photos'),
    // Take a screenshot (mirror-design §3.1, bite M2): the browser's
    // own screen capture, framed into the existing image-attach
    // road — a real road in the web room, so the row ships.
    capability('Take a screenshot', 'screenshot'),
    // Add to project: the composer's active-project picker over the
    // workspace project registry; the picked project rides the
    // message metadata (§3.1).
    projects('Add to project'),
    // Add from GitHub (§4's file-source action): the picker's repo
    // is the channel's linked repo; the picked file rides the
    // attach road.
    action('Add from GitHub', 'github-file'),
    submenu('Skills', [
      // The skills that run on Helmian's turns for this seat: the
      // workspace skill library (blanket + seat-scoped), armed per
      // message exactly like the "/" menu arms them. Claude.ai's own
      // skill store is Anthropic-account state with no read road —
      // its mirror group was deleted in M2 (design §8 law) rather
      // than left rendering "Nothing here yet" forever.
      liveGroup({ feed: 'helmian-skills' }),
    ]),
    submenu('Connectors', [
      // Source 3 service picks for this seat ride beside their
      // vendor mirrors below (different ids, different pipes):
      // Helmian's own brokered road to the same service.
      liveGroup({ entryIds: [...NATIVES, ...REGISTRY_SHELF, 'registry-atlassian', 'registry-notion', 'registry-linear', 'registry-stripe', ...BROKERED_SERVERS] }),
      mirrorGroup({
        managedIn: 'Claude',
        entryIds: ['gmail', 'google-calendar', 'google-drive', 'github', 'slack', 'notion', 'linear', 'stripe', 'atlassian', 'canva', 'idiolect', 'figma'],
      }),
      // Tool access (§3.1): the per-connection posture + the
      // frozen snapshot's per-tool switches (bites M1/M2). They
      // lived on the seat's Manage surface until it was removed
      // 2026-11-10; the row now expands their panel-native face
      // right here in the panel (connector-tool-access.mjs,
      // rendered by envoy-workspace.js's toolAccessNode).
      action('Tool access', 'tool-access'),
    ]),
    submenu('Plugins', [
      // Bound to the room's REAL plugin list — the PC bridge's
      // installed plugins (GET /api/admin/plugins), whose tools
      // genuinely join this seat's turns. Claude.ai's own plugin
      // garden stays (c): no API road, not Helmian's to show.
      liveGroup({ feed: 'bridge-plugins' }),
    ]),
    // The one capability row with a real road for this seat: the
    // per-message webSearch toggle is honored natively for Claude
    // (src/agent/attachments.mjs — Anthropic's own search tool).
    capability('Web search', 'web-search'),
    manageInHelmian(),
  ],

  // -------------------------------------------------------- ChatGPT
  // REPORT §3.2: Add photos & files · More › (the connector list) ·
  // the manage footer — Helmian's, per the header note (REPORT §3's
  // vendor manage row is not carried). (Create image, Deep research and Web search
  // are excluded — the room runs none of them for this seat; see the
  // exclusion list.)
  chatgpt: [
    attach('Add photos & files'),
    submenu('More', [
      liveGroup({ entryIds: [...NATIVES, ...REGISTRY_SHELF, 'registry-notion', ...BROKERED_SERVERS] }),
      mirrorGroup({
        managedIn: 'ChatGPT',
        entryIds: ['gmail', 'google-calendar', 'google-drive', 'slack', 'notion', 'github', 'canva', 'dropbox', 'figma'],
      }),
    ]),
    manageInHelmian(),
  ],

  // ------------------------------------------------------------ Grok
  // REPORT §3.3: Files · Connectors › — Helmian-brokered entries as
  // live toggles; grok.com-brokered entries as account-level STATE
  // rows (Grok connects account-wide and invokes by @; there is no
  // per-chat toggle to imitate). The thinking-mode menu stays out of
  // "+", exactly as xAI keeps it out.
  grok: [
    attach('Files'),
    submenu('Connectors', [
      liveGroup({ entryIds: ['github', ...NATIVES, ...REGISTRY_SHELF, 'registry-notion', 'registry-linear', ...BROKERED_SERVERS] }),
      mirrorGroup({
        managedIn: 'Grok', rowShape: 'state',
        entryIds: ['gmail', 'google-calendar', 'google-drive', 'onedrive', 'outlook', 'microsoft-teams', 'sharepoint', 'salesforce', 'box', 'canva', 'gamma', 'linear', 'meltwater', 'notion', 'sp-global', 'vercel'],
      }),
    ]),
    manageInHelmian(),
  ],

  // ---------------------------------------------------------- Gemini
  // REPORT §3.4: Add photos & files · Connected Apps › as state rows
  // (account-level, "Managed in Gemini", invoked by @) · the
  // Helmian-brokered connectors as live toggles in their OWN group,
  // so the two kinds never blur. (Create image, Canvas, Deep
  // research and Guided learning are excluded — no road in the room;
  // see the exclusion list.)
  gemini: [
    attach('Add photos & files'),
    submenu('Connected Apps', [
      mirrorGroup({
        managedIn: 'Gemini', rowShape: 'state',
        entryIds: ['gmail', 'google-drive', 'google-calendar'],
      }),
    ]),
    liveGroup({ label: 'Connectors', entryIds: [...NATIVES, ...REGISTRY_SHELF] }),
    manageInHelmian(),
  ],

  // --------------------------------------------------------- Mistral
  // REPORT §3.5: "+" → Tools › → the connectors list (Helmian-brokered
  // as live toggles; Vibe-brokered as mirror rows — none are in the
  // shipped catalog yet, so the mirror group binds an empty set and
  // renders nothing until the catalog grows one) · Agents (mirror —
  // a Studio/Vibe surface, fed by the bite-7 intake) · the manage
  // footer — Helmian's, per the header note (REPORT §3's vendor
  // manage row is not carried, so no vendor address is needed).
  mistral: [
    attach('Add files'),
    submenu('Tools', [
      liveGroup({ entryIds: [...NATIVES, ...REGISTRY_SHELF] }),
      mirrorGroup({ managedIn: 'Mistral', entryIds: [] }),
    ]),
    // The Agents mirror group (feed 'vendor-agents') was deleted in
    // bite M2 under the mirror design §8 law: it could only ever
    // render "Nothing here yet". M7 re-points the row at Helmian's
    // own custom-agent list, the lawful Helmian-side source.
    manageInHelmian(),
  ],

  // ------------------------------------------------------------ Groq
  // REPORT §3.6: no consumer product — a plain Helmian list. The
  // live toggles ride Groq's remote-MCP road, which is BETA, and the
  // group carries that word (REPORT §3.6/§6). Groq's own Google
  // Workspace MCP Connectors are excluded: they are catalog rows
  // only until a state read exists, and the shipped catalog holds
  // none — see the exclusion list.
  groq: helmianList({ note: 'Beta — Groq remote MCP' }),

  // ---------------------------------------------------------- NVIDIA
  // REPORT §3.9: API-only seat; NVIDIA's own docs prescribe the
  // Pattern-B shape Helmian already runs. Plain list, live toggles.
  nvidia: helmianList(),

  // ------------------------------------------------------ OpenRouter
  // REPORT §3.8: live toggles, gated per routed model — an armed set
  // is only real for models that support tool calling, so the group
  // carries that gate as data for the face to dim by. (OpenRouter's
  // own MCP server is excluded: REPORT §3.8 names it catalog
  // content, but the shipped catalog holds no such entry — see the
  // exclusion list.)
  openrouter: helmianList({ requiresToolCapableModel: true }),

  // ------------------------------------------------------ Cloudflare
  // REPORT §3.10: plain list; Cloudflare's hosted MCP servers are
  // ordinary Helmian-brokered catalog entries (cloudflare-docs).
  cloudflare: helmianList({ entryIds: ['cloudflare-docs', ...NATIVES, ...REGISTRY_SHELF] }),

  // ------------------------------------------------------------ Qwen
  // REPORT §3.7: PIPE seat; plain list, live toggles only. Model
  // Studio plugins and MCP Square are excluded — console/community
  // surfaces that never appear as rows (see the exclusion list).
  qwen: helmianList(),

  // ------------------------------------------- Helmian's own seats
  // REPORT §2/§3.11: Muse, Maestro, Helm and Owner have no vendor
  // product to mirror — Helmian-native entries only, every row real
  // by definition. Same plain list shape.
  muse: helmianList(),
  maestro: helmianList(),
  helm: helmianList(),
  owner: helmianList(),
});

/** The seat ids that hold menu definitions, in the fleet's order. */
export const MENU_SEAT_IDS = Object.freeze(LIBRARY_SEATS.map((s) => s.seatId));

/** One seat's Level 2 menu definition (frozen), or null. */
export function menuForSeat(seatId) {
  return Object.hasOwn(MENU_DEFINITIONS, String(seatId ?? '')) ? MENU_DEFINITIONS[String(seatId ?? '')] : null;
}

/**
 * Depth-first walk over a menu definition, yielding
 * `{ item, depth, parent }` for every item including submenu
 * children. Renderers and tests share this so both see the same
 * shape.
 */
export function* walkMenuItems(items, { depth = 0, parent = null } = {}) {
  for (const item of Array.isArray(items) ? items : []) {
    yield { item, depth, parent };
    if (item?.type === 'submenu') yield* walkMenuItems(item.items, { depth: depth + 1, parent: item });
  }
}

/** Every catalog entry id a definition binds, in walk order. */
export function collectCatalogEntryIds(items) {
  const out = [];
  for (const { item } of walkMenuItems(items)) {
    if (Array.isArray(item.entryIds)) out.push(...item.entryIds);
  }
  return out;
}

// The panel dedupe (menu dedupe, 2026-11-09): ONE connector name,
// ONE row in a composed panel list — the connector library's
// standing one-name-one-row law, restated for the "+" panel's
// composed rows. A seat's menu binds
// both Helmian's brokered entry for a service (the live toggle
// group) and the seat vendor's own entry for the same service (the
// mirror group); when both stand in one list the person sees the
// connector twice — Claude's panel carried GitHub as Helmian's
// connected switch AND as Claude's not-connected mirror. The
// survivor is chosen in the tab's tiers: a Helmian-brokered row
// beats a vendor mirror; inside a tier a connected row beats a
// not-connected one; ties keep the list's own order. The survivor
// keeps its own place and its own state — a dropped row's state
// never lends itself to the row that stands. Only connector rows
// (toggle / mirror / row kinds carrying a library row) take part;
// labels, notes, actions, skills, plugins and projects pass
// through untouched. A mirror whose brokered namesake never made
// the list (not connected, so the live group offered no switch)
// stands as the name's only row, exactly as it does today.
const PANEL_CONNECTOR_KINDS = new Set(['toggle', 'mirror', 'row', 'connect']);
const panelConnectorNameKey = (entry) => String(entry?.row?.name ?? entry?.row?.entryId ?? '').trim().toLowerCase();

export function dedupePanelConnectorRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const groups = new Map();
  list.forEach((entry, i) => {
    if (!entry || !PANEL_CONNECTOR_KINDS.has(entry.kind) || !entry.row) return;
    const key = panelConnectorNameKey(entry);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });
  const dropped = new Set();
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    let survivor = idxs[0];
    for (const i of idxs.slice(1)) {
      const cand = list[i].row;
      const best = list[survivor].row;
      const candBrokered = cand.brokerMode !== 'vendor';
      const bestBrokered = best.brokerMode !== 'vendor';
      if (candBrokered !== bestBrokered) { if (candBrokered) survivor = i; continue; }
      if (cand.state === 'connected' && best.state !== 'connected') survivor = i;
    }
    for (const i of idxs) if (i !== survivor) dropped.add(i);
  }
  return dropped.size ? list.filter((_, i) => !dropped.has(i)) : list;
}
