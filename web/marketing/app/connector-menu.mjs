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
// ITEM TYPES — exactly six, nothing else:
//   attach            the files row (the room's upload is real for
//                     every seat: composer-picker.mjs's upload group).
//   capability        a room capability row. A row exists ONLY where
//                     the room can actually run the capability for
//                     that seat (REPORT §6) — see the exclusions
//                     named in the bite report.
//   live-toggle-group connector rows the person arms per message
//                     (connector-panel.mjs's toggle store). Binds
//                     catalog entries by id, and binds ONLY
//                     brokerMode:'helmian' entries — a live toggle on
//                     a pipe Helmian does not hold is a fake (SPEC
//                     §1.5/§5.3, REPORT §6).
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
//   manage-link       the footer row out to the manager surface —
//                     Helmian's Integrations view ('integrations')
//                     or the vendor's own manager ('vendor').
//
// GROUP BINDINGS. A connector group binds its rows in exactly one of
// two ways: `entryIds` — ids into the shipped catalog
// (src/cloud/connector-catalog.mjs, resolved per seat; a test proves
// every id resolves, that live groups bind only helmian-brokered
// entries, mirror groups only vendor-brokered ones, and that every
// catalog entry of the seat is bound exactly once across its menu) —
// or `feed`, naming a non-catalog source a later bite reads (Claude's
// API-account skills and claude.ai skills, Claude's plugins, Mistral's
// agents: vendor surfaces whose state arrives by the bite-7 intake,
// never from the connector catalog). A feed-bound group names no
// connector, so it can never invent one.
import { LIBRARY_SEATS } from './connector-panel.mjs';

export const MENU_ITEM_TYPES = Object.freeze([
  'attach', 'capability', 'live-toggle-group', 'mirror-group', 'submenu', 'manage-link',
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
const liveGroup = ({ label = null, entryIds = null, feed = null, note = null, requiresToolCapableModel = false }) => ({
  type: 'live-toggle-group', label, ...(entryIds ? { entryIds } : { feed }), ...(note ? { note } : {}),
  ...(requiresToolCapableModel ? { requiresToolCapableModel: true } : {}),
});
const mirrorGroup = ({ label = null, managedIn, rowShape = 'mirror', entryIds = null, feed = null }) => ({
  type: 'mirror-group', label, managedIn, rowShape, ...(entryIds ? { entryIds } : { feed }),
});
const submenu = (label, items) => ({ type: 'submenu', label, items });
const manageLink = ({ label, target, url = null }) => ({ type: 'manage-link', label, target, ...(url ? { url } : {}) });

// The two Helmian-native entries every seat's library holds
// (connector-catalog.mjs Source 2) — the Helmian-brokered core of
// every seat's live toggle group.
const NATIVES = ['helmian-github', 'helmian-scribe'];
const manageInHelmian = () => manageLink({ label: 'Manage connectors', target: 'integrations' });
// The plain Helmian list (REPORT §3.6–§3.10 + §3.11): seats with no
// vendor furniture get attach, the live toggles, and the manager —
// in Helmian's own words, with no invented vendor furniture.
const helmianList = ({ entryIds = NATIVES, note = null, requiresToolCapableModel = false } = {}) => [
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
    submenu('Skills', [
      // API-account skills: live per-message attach (the Skills road
      // is real for this seat only — REPORT §5.3). Fed by the Skills
      // Management API read (bite 4R), not by the connector catalog.
      liveGroup({ feed: 'seat-skills-api' }),
      // The person's claude.ai skills are a different store: mirror.
      mirrorGroup({ managedIn: 'Claude', feed: 'seat-skills-vendor' }),
    ]),
    submenu('Connectors', [
      liveGroup({ entryIds: [...NATIVES] }),
      mirrorGroup({
        managedIn: 'Claude',
        entryIds: ['gmail', 'google-calendar', 'google-drive', 'github', 'slack', 'notion', 'linear', 'stripe', 'atlassian', 'canva'],
      }),
    ]),
    submenu('Plugins', [
      // Plugins are a claude.ai / Claude Code surface with no API
      // road: mirror rows, and no control of any kind (REPORT §3.1).
      mirrorGroup({ managedIn: 'Claude', feed: 'vendor-plugins' }),
    ]),
    // The one capability row with a real road for this seat: the
    // per-message webSearch toggle is honored natively for Claude
    // (src/agent/attachments.mjs — Anthropic's own search tool).
    capability('Web search', 'web-search'),
    manageInHelmian(),
  ],

  // -------------------------------------------------------- ChatGPT
  // REPORT §3.2: Add photos & files · More › (the connector list) ·
  // Manage in ChatGPT. (Create image, Deep research and Web search
  // are excluded — the room runs none of them for this seat; see the
  // exclusion list.)
  chatgpt: [
    attach('Add photos & files'),
    submenu('More', [
      liveGroup({ entryIds: [...NATIVES] }),
      mirrorGroup({
        managedIn: 'ChatGPT',
        entryIds: ['gmail', 'google-calendar', 'google-drive', 'slack', 'notion', 'github', 'canva', 'dropbox'],
      }),
    ]),
    manageLink({ label: 'Manage in ChatGPT', target: 'vendor', url: 'https://chatgpt.com/plugins' }),
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
      liveGroup({ entryIds: ['github', ...NATIVES] }),
      mirrorGroup({
        managedIn: 'Grok', rowShape: 'state',
        entryIds: ['gmail', 'google-calendar', 'google-drive', 'onedrive', 'outlook', 'microsoft-teams', 'sharepoint', 'salesforce', 'box', 'canva', 'gamma', 'linear', 'meltwater', 'notion', 'sp-global', 'vercel'],
      }),
    ]),
    manageLink({ label: 'Manage in Grok', target: 'vendor', url: 'https://grok.com/connectors' }),
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
    liveGroup({ label: 'Connectors', entryIds: [...NATIVES] }),
    manageLink({ label: 'Manage in Gemini', target: 'vendor', url: 'https://gemini.google.com' }),
  ],

  // --------------------------------------------------------- Mistral
  // REPORT §3.5: "+" → Tools › → the connectors list (Helmian-brokered
  // as live toggles; Vibe-brokered as mirror rows — none are in the
  // shipped catalog yet, so the mirror group binds an empty set and
  // renders nothing until the catalog grows one) · Agents (mirror —
  // a Studio/Vibe surface, fed by the bite-7 intake) · Manage in
  // Mistral. (The manager URL is not in the shipped data — the link
  // carries its target and words; 3R-b/7R supplies the address.)
  mistral: [
    attach('Add files'),
    submenu('Tools', [
      liveGroup({ entryIds: [...NATIVES] }),
      mirrorGroup({ managedIn: 'Mistral', entryIds: [] }),
    ]),
    mirrorGroup({ label: 'Agents', managedIn: 'Mistral', feed: 'vendor-agents' }),
    manageLink({ label: 'Manage in Mistral', target: 'vendor' }),
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
  cloudflare: helmianList({ entryIds: ['cloudflare-docs', ...NATIVES] }),

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
