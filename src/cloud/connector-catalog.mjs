// Connector catalog (connector-library SPEC §3, build bite 2): the
// day-one library DATA — Source 1 vendor-catalog mirrors and Source 2
// Helmian-native entries for every seat live in the room — plus the
// refresh road that mirrors this data into the library store
// (src/cloud/connector-library.mjs, bite 1).
//
// This module is DATA + one job. It holds no connection state and never
// will: the catalog is the one shared thing (§3.4) — the same
// definitions for everyone. State lives in the store's connection /
// mirror records and in the tool-connections store, and is joined at
// read time by connector-library-read.mjs.
//
// THE LAWS, carried from the spec:
//   - brokerMode is decided per entry by where the pipe actually lives
//     (§3.1): the vendor's cloud brokers it → 'vendor' (a mirror, never
//     a fake Connect target); a plain MCP server Helmian can reach and
//     run the standard handshake against → 'helmian'. When in doubt the
//     entry ships 'vendor'. Anthropic's and OpenAI's connectors are
//     brokered from their clouds (REPORT §3.3's network law, §2), so
//     every Claude / ChatGPT directory mirror here is 'vendor'. xAI's
//     built-ins and pre-configured catalog are brokered by xAI →
//     'vendor', except GitHub, whose MCP server is a public endpoint
//     Helmian can handshake directly → 'helmian'.
//   - Trust labels mirror the vendor's own (§3.1): Helmian does not
//     re-review or upgrade them. Where the vendor's published label for
//     a specific entry was not in the research, the conservative
//     'community' is used and the refresh-from-the-live-catalog road is
//     the correction path (see the bite report's UNVERIFIED list).
//   - Native entry ids are prefixed ('helmian-github', 'helmian-scribe')
//     so a native entry can never collide with a same-named catalog
//     entry inside one seat's library — they are different pipes (§3.2).
//   - iconRef uses the 'icon:<slug>' asset-reference scheme; the marks
//     themselves are surface asset work (Bites 3/5), not data.

// The seats live in the room today (the room's own seat ids).
export const LIVE_SEATS = Object.freeze([
  'claude', 'chatgpt', 'grok', 'gemini', 'mistral', 'groq', 'nvidia',
  'openrouter', 'cloudflare', 'qwen', 'muse', 'maestro', 'helm', 'owner',
]);

const icon = (slug) => `icon:${slug}`;
const mirror = (manageUrl, ref) => ({ ref, manageUrl });

// One Source 1 row. `pipe` is the §3.1 decision made explicit in the
// data: { mode: 'vendor', manageUrl, ref } or { mode: 'helmian',
// endpoint, authMode, scopesSummary? }.
function catalogEntry(seatId, def) {
  const base = {
    seatId,
    id: def.id,
    kind: 'catalog',
    name: def.name,
    oneLiner: def.oneLiner,
    iconRef: icon(def.icon ?? def.id),
    vendorName: def.vendorName,
    trustLabel: def.trustLabel,
    category: def.category ?? null,
    authMode: def.pipe.mode === 'helmian' ? def.pipe.authMode : 'oauth',
    addedBy: 'system',
  };
  if (def.pipe.mode === 'vendor') {
    return {
      ...base,
      brokerMode: 'vendor',
      vendorConnectorRef: mirror(def.pipe.manageUrl, def.pipe.ref),
    };
  }
  return {
    ...base,
    brokerMode: 'helmian',
    mcpEndpointUrl: def.pipe.endpoint,
    ...(def.pipe.scopesSummary ? { scopesSummary: def.pipe.scopesSummary } : {}),
  };
}

const vendorPipe = (manageUrl, ref) => ({ mode: 'vendor', manageUrl, ref });

// ------------------------------------------------------- Claude (Anthropic)
// Anthropic's Connectors Directory, mirrored. Anthropic brokers every
// one of these from its own cloud (REPORT §3.3: connections are made
// from Anthropic's infrastructure, by the person's Claude account), so
// every entry is a 'vendor' mirror: Helmian shows state as reported and
// deep-links management — it never draws its own Connect button (§1.5).
const CLAUDE_MANAGE = 'https://claude.ai/settings/connectors';
const claudeCatalog = (def) => catalogEntry('claude', {
  ...def,
  pipe: vendorPipe(CLAUDE_MANAGE, `anthropic:${def.id}`),
});
const CLAUDE_CATALOG = Object.freeze([
  claudeCatalog({ id: 'gmail', name: 'Gmail', oneLiner: 'Draft replies, summarize threads, & search your inbox', vendorName: 'Google', trustLabel: 'verified', category: 'productivity' }),
  claudeCatalog({ id: 'google-calendar', name: 'Google Calendar', oneLiner: 'See your schedule, check availability, and manage events', vendorName: 'Google', trustLabel: 'verified', category: 'productivity' }),
  claudeCatalog({ id: 'google-drive', name: 'Google Drive', oneLiner: 'Search, open, and summarise your documents and files', vendorName: 'Google', trustLabel: 'verified', category: 'documents' }),
  claudeCatalog({ id: 'github', name: 'GitHub', oneLiner: 'Review pull requests, issues, and repository activity', vendorName: 'GitHub', trustLabel: 'verified', category: 'development' }),
  claudeCatalog({ id: 'slack', name: 'Slack', oneLiner: 'Search messages, summarise channels, and draft replies', vendorName: 'Slack', trustLabel: 'verified', category: 'communication' }),
  claudeCatalog({ id: 'notion', name: 'Notion', oneLiner: 'Search pages, summarise notes, and draft new pages', vendorName: 'Notion', trustLabel: 'verified', category: 'documents' }),
  claudeCatalog({ id: 'linear', name: 'Linear', oneLiner: 'Look up issues, check project status, and file new work', vendorName: 'Linear', trustLabel: 'verified', category: 'productivity' }),
  claudeCatalog({ id: 'stripe', name: 'Stripe', oneLiner: 'Look up payments, customers, and invoices', vendorName: 'Stripe', trustLabel: 'verified', category: 'data' }),
  claudeCatalog({ id: 'atlassian', name: 'Atlassian', oneLiner: 'Search Jira issues and Confluence pages', vendorName: 'Atlassian', trustLabel: 'verified', category: 'productivity' }),
  claudeCatalog({ id: 'canva', name: 'Canva', oneLiner: 'Find designs and work from your Canva library', vendorName: 'Canva', trustLabel: 'community', category: 'design' }),
]);

// --------------------------------------------------------- ChatGPT (OpenAI)
// OpenAI's app directory, mirrored. Connections are brokered by OpenAI
// from the person's ChatGPT account (Settings > Plugins), so every
// entry is a 'vendor' mirror here too.
const CHATGPT_MANAGE = 'https://chatgpt.com/plugins';
const chatgptCatalog = (def) => catalogEntry('chatgpt', {
  ...def,
  pipe: vendorPipe(CHATGPT_MANAGE, `openai:${def.id}`),
});
const CHATGPT_CATALOG = Object.freeze([
  chatgptCatalog({ id: 'gmail', name: 'Gmail', oneLiner: 'Draft replies, summarize threads, & search your inbox', vendorName: 'Google', trustLabel: 'verified', category: 'productivity' }),
  chatgptCatalog({ id: 'google-calendar', name: 'Google Calendar', oneLiner: 'See your schedule, check availability, and manage events', vendorName: 'Google', trustLabel: 'verified', category: 'productivity' }),
  chatgptCatalog({ id: 'google-drive', name: 'Google Drive', oneLiner: 'Search, open, and summarise your documents and files', vendorName: 'Google', trustLabel: 'verified', category: 'documents' }),
  chatgptCatalog({ id: 'slack', name: 'Slack', oneLiner: 'Search messages, summarise channels, and draft replies', vendorName: 'Slack', trustLabel: 'verified', category: 'communication' }),
  chatgptCatalog({ id: 'notion', name: 'Notion', oneLiner: 'Search pages, summarise notes, and draft new pages', vendorName: 'Notion', trustLabel: 'verified', category: 'documents' }),
  chatgptCatalog({ id: 'github', name: 'GitHub', oneLiner: 'Review pull requests, issues, and repository activity', vendorName: 'GitHub', trustLabel: 'verified', category: 'development' }),
  chatgptCatalog({ id: 'canva', name: 'Canva', oneLiner: 'Find designs and work from your Canva library', vendorName: 'Canva', trustLabel: 'community', category: 'design' }),
  chatgptCatalog({ id: 'dropbox', name: 'Dropbox', oneLiner: 'Search and open files stored in Dropbox', vendorName: 'Dropbox', trustLabel: 'community', category: 'documents' }),
]);

// --------------------------------------------------------------- Grok (xAI)
// xAI's connector library (REPORT §1): built-ins maintained and
// brokered by xAI, plus the pre-configured OAuth catalog — brokered by
// xAI too, with ONE exception: GitHub's catalog entry runs on GitHub's
// own public MCP server, a plain endpoint Helmian can reach and run the
// standard handshake against, so by the §3.1 rule it ships 'helmian'
// and Helmian's own Connect flow (Bite 4) applies to it.
//
// xAI's docs bundle some built-ins ("Gmail & Google Calendar",
// "Outlook Mail & Calendar"); they are split into per-service rows
// here so each library row names one service (the Outlook pair stays
// one row — one Microsoft account pipe).
const GROK_MANAGE = 'https://grok.com/connectors';
const grokVendor = (def) => catalogEntry('grok', {
  ...def,
  pipe: vendorPipe(GROK_MANAGE, `xai:${def.id}`),
});
const GROK_CATALOG = Object.freeze([
  // Built-ins (brokered by xAI).
  grokVendor({ id: 'gmail', name: 'Gmail', oneLiner: 'Search your inbox, summarise threads, and draft replies', vendorName: 'Google', trustLabel: 'verified', category: 'productivity' }),
  grokVendor({ id: 'google-calendar', name: 'Google Calendar', oneLiner: 'See your schedule and check availability', vendorName: 'Google', trustLabel: 'verified', category: 'productivity' }),
  grokVendor({ id: 'google-drive', name: 'Google Drive', oneLiner: 'Search and open your Drive files', vendorName: 'Google', trustLabel: 'verified', category: 'documents' }),
  grokVendor({ id: 'onedrive', name: 'OneDrive', oneLiner: 'Open and search files stored in OneDrive', vendorName: 'Microsoft', trustLabel: 'verified', category: 'documents' }),
  grokVendor({ id: 'outlook', name: 'Outlook', oneLiner: 'Read Outlook mail and check your Outlook calendar', vendorName: 'Microsoft', trustLabel: 'verified', category: 'productivity' }),
  grokVendor({ id: 'microsoft-teams', name: 'Microsoft Teams', oneLiner: 'Catch up on Teams chats and channels', vendorName: 'Microsoft', trustLabel: 'verified', category: 'communication' }),
  grokVendor({ id: 'sharepoint', name: 'SharePoint', oneLiner: 'Search documents across SharePoint', vendorName: 'Microsoft', trustLabel: 'verified', category: 'documents' }),
  grokVendor({ id: 'salesforce', name: 'Salesforce', oneLiner: 'Look up accounts, leads, and opportunities', vendorName: 'Salesforce', trustLabel: 'verified', category: 'sales' }),
  // Catalog (pre-configured OAuth, brokered by xAI) — except GitHub.
  catalogEntry('grok', {
    id: 'github', name: 'GitHub',
    oneLiner: 'Review pull requests, issues, and repository activity',
    iconRef: icon('github'), vendorName: 'GitHub', trustLabel: 'verified', category: 'development',
    pipe: {
      mode: 'helmian',
      endpoint: 'https://api.githubcopilot.com/mcp/',
      authMode: 'oauth',
      scopesSummary: 'Read and work with repositories, issues, and pull requests',
    },
  }),
  grokVendor({ id: 'box', name: 'Box', oneLiner: 'Search and open files stored in Box', vendorName: 'Box', trustLabel: 'community', category: 'documents' }),
  grokVendor({ id: 'canva', name: 'Canva', oneLiner: 'Find designs and work from your Canva library', vendorName: 'Canva', trustLabel: 'community', category: 'design' }),
  grokVendor({ id: 'gamma', name: 'Gamma', oneLiner: 'Pull decks and documents from Gamma', vendorName: 'Gamma', trustLabel: 'community', category: 'documents' }),
  grokVendor({ id: 'linear', name: 'Linear', oneLiner: 'Look up issues, check project status, and file new work', vendorName: 'Linear', trustLabel: 'verified', category: 'productivity' }),
  grokVendor({ id: 'meltwater', name: 'Meltwater', oneLiner: 'Track media coverage and brand mentions', vendorName: 'Meltwater', trustLabel: 'community', category: 'data' }),
  grokVendor({ id: 'notion', name: 'Notion', oneLiner: 'Search pages, summarise notes, and draft new pages', vendorName: 'Notion', trustLabel: 'verified', category: 'documents' }),
  grokVendor({ id: 'sp-global', name: 'S&P Global', oneLiner: 'Look up company and market data', vendorName: 'S&P Global', trustLabel: 'community', category: 'data' }),
  grokVendor({ id: 'vercel', name: 'Vercel', oneLiner: 'Check deployments and project status', vendorName: 'Vercel', trustLabel: 'verified', category: 'development' }),
]);

// ------------------------------------------------------------ Gemini (Google)
// Gemini's connected Google Workspace apps are brokered by Google from
// the person's Google account — 'vendor' mirrors. (The research covers
// the three leaders' catalogs in depth; Gemini's published connector
// catalog is its Workspace app set. The management deep link is the
// Gemini surface itself — see the report's UNVERIFIED list.)
const GEMINI_MANAGE = 'https://gemini.google.com';
const geminiCatalog = (def) => catalogEntry('gemini', {
  ...def,
  pipe: vendorPipe(GEMINI_MANAGE, `google:gemini-${def.id}`),
});
const GEMINI_CATALOG = Object.freeze([
  geminiCatalog({ id: 'gmail', name: 'Gmail', oneLiner: 'Search your inbox, summarise threads, and draft replies', vendorName: 'Google', trustLabel: 'verified', category: 'productivity' }),
  geminiCatalog({ id: 'google-drive', name: 'Google Drive', oneLiner: 'Search and open your Drive files', vendorName: 'Google', trustLabel: 'verified', category: 'documents' }),
  geminiCatalog({ id: 'google-calendar', name: 'Google Calendar', oneLiner: 'See your schedule and check availability', vendorName: 'Google', trustLabel: 'verified', category: 'productivity' }),
]);

// --------------------------------------------------------------- Cloudflare
// Cloudflare publishes its own remote MCP server catalog (its docs /
// agents platform). Those servers are plain public MCP endpoints
// Helmian can reach and handshake directly, so by the §3.1 rule they
// ship 'helmian' — Helmian's Connect flow applies, no mirror pretence.
const CLOUDFLARE_CATALOG = Object.freeze([
  catalogEntry('cloudflare', {
    id: 'cloudflare-docs', name: 'Cloudflare Docs',
    oneLiner: 'Search and read Cloudflare’s developer documentation',
    iconRef: icon('cloudflare'), vendorName: 'Cloudflare', trustLabel: 'verified', category: 'development',
    pipe: { mode: 'helmian', endpoint: 'https://docs.mcp.cloudflare.com/mcp', authMode: 'none' },
  }),
]);

// Seats whose vendor publishes no connector library in the research
// (mistral, groq, nvidia, openrouter, qwen, muse, maestro, helm, owner)
// get Source 2 only — an empty Source 1 is the honest seed; inventing a
// mirror for a catalog nobody documented would be a fake library.
const SOURCE1_BY_SEAT = Object.freeze({
  claude: CLAUDE_CATALOG,
  chatgpt: CHATGPT_CATALOG,
  grok: GROK_CATALOG,
  gemini: GEMINI_CATALOG,
  cloudflare: CLOUDFLARE_CATALOG,
});

// ------------------------------------------------- Source 2 — Helmian-native
// Present in EVERY seat's library (§3.2), "Connector by Helmian",
// trust 'verified'. Two entries on day one:
//
//   helmian-github — the room's existing GitHub reach, SURFACED.
//     Its state is not a library connection record: it is joined at
//     read time from the two places that truth already lives (see
//     NATIVE_STATE_SOURCES below and connector-library-read.mjs), so
//     no second, parallel connection is minted:
//       · the workspace's per-channel repo links — a channel whose
//         config carries github.repo is linked, full stop. The rail's
//         GITHUB section, the channel header badge, and the commit/PR
//         stream all live by that link; it is the connection the room
//         actually uses (repoLinks: true below);
//       · the tool-connections store (sql/061) — a verified probe
//         receipt there also reads connected, under that store's own
//         freshness rule.
//     Either source suffices; neither invents a state.
//
//   helmian-scribe — Scribe, Helmian's own shared memory and
//     inter-agent mail: how the seats already reach each other. Its
//     endpoint is Helmian's own hosted MCP door. State joins when a
//     seat-side report exists; the read never invents one.
export const NATIVE_STATE_SOURCES = Object.freeze({
  'helmian-github': Object.freeze({ stateSource: 'tool-connections', serviceId: 'github', repoLinks: true }),
  'helmian-scribe': Object.freeze({ stateSource: 'helmian-service' }),
});

function helmianNativeEntries(seatId) {
  return [
    {
      seatId,
      id: 'helmian-github',
      kind: 'helmian-native',
      name: 'GitHub',
      oneLiner: 'Work with the repositories this workspace already reaches',
      iconRef: icon('github'),
      vendorName: 'Helmian',
      trustLabel: 'verified',
      category: 'development',
      brokerMode: 'helmian',
      mcpEndpointUrl: 'https://api.githubcopilot.com/mcp/',
      authMode: 'oauth',
      scopesSummary: 'The access the workspace connection already holds',
      addedBy: 'system',
    },
    {
      seatId,
      id: 'helmian-scribe',
      kind: 'helmian-native',
      name: 'Scribe',
      oneLiner: 'Reach the other seats and the shared memory',
      iconRef: icon('scribe'),
      vendorName: 'Helmian',
      trustLabel: 'verified',
      category: 'memory',
      brokerMode: 'helmian',
      mcpEndpointUrl: 'https://connect.helmian.cloud/mcp',
      authMode: 'none',
      addedBy: 'system',
    },
  ];
}

// ------------------------------------------------------------------ catalog

/** Source 1 + Source 2 definitions for one seat's library. */
export function catalogEntriesForSeat(seatId) {
  if (!LIVE_SEATS.includes(seatId)) {
    throw Object.assign(new Error(`unknown seat "${seatId}" — the catalog seeds the seats live in the room`), { status: 400 });
  }
  return [...(SOURCE1_BY_SEAT[seatId] ?? []), ...helmianNativeEntries(seatId)];
}

/** The whole day-one catalog: every live seat's definitions. */
export const CONNECTOR_CATALOG = Object.freeze(
  LIVE_SEATS.flatMap((seatId) => catalogEntriesForSeat(seatId)),
);

export function catalogEntryById(seatId, entryId) {
  return catalogEntriesForSeat(seatId).find((entry) => entry.id === entryId) ?? null;
}

// ------------------------------------------------------------ refresh road
// The mirror is data, refreshed on a schedule (and by hand) from the
// vendor's published catalog (SPEC §3.1). In code the published catalog
// IS this module's data; the refresh road is what carries it into the
// store. It writes ENTRIES ONLY, through bite 1's createEntry — whose
// upsert updates descriptive fields and refuses a brokerMode change
// with a 409: a refresh can therefore never flip an entry's pipe, and
// it never touches a connection, mirror, or snapshot record. Conflicts
// are reported, never silently resolved: a catalog definition that
// disagrees with a stored entry's brokerMode is a data bug a human
// must look at, and the stored entry keeps its original mode.

export function createCatalogRefresh({ libraryStore, subject } = {}) {
  if (!libraryStore || typeof libraryStore.createEntry !== 'function') {
    throw Object.assign(new Error('createCatalogRefresh needs the connector library store'), { status: 500 });
  }
  if (!subject || typeof subject !== 'string') {
    throw Object.assign(new Error('catalog refresh needs the acting subject'), { status: 400 });
  }

  async function refreshSeat(tenantId, seatId) {
    const applied = [];
    const conflicts = [];
    for (const definition of catalogEntriesForSeat(seatId)) {
      if (definition.kind === 'custom') {
        // Catalog data never provisions custom entries (§3.3: customs
        // are added by a person, per seat). Defensive — none exist.
        conflicts.push({ seatId, entryId: definition.id, message: 'catalog data may not carry custom entries' });
        continue;
      }
      try {
        await libraryStore.createEntry(tenantId, subject, definition);
        applied.push(definition.id);
      } catch (error) {
        if (error?.status === 409) {
          conflicts.push({ seatId, entryId: definition.id, message: error.message });
          continue;
        }
        throw error;
      }
    }
    return { seatId, applied, conflicts };
  }

  async function refreshAll(tenantId) {
    const seats = [];
    for (const seatId of LIVE_SEATS) seats.push(await refreshSeat(tenantId, seatId));
    return { tenantId, seats };
  }

  return { refreshSeat, refreshAll };
}

/**
 * The scheduled/manual job shape: run one refresh pass for the given
 * tenants and return the per-tenant summaries. Scheduling (the same
 * cadence that re-runs discovery, §1.7) and manual invocation both call
 * exactly this — the module starts no timers and keeps no state of its
 * own. `libraryStore` is injectable for tests; production builds it
 * from the caller's pool.
 */
export async function runCatalogRefreshOnce({ pool, tenantIds, subject, libraryStore, createStore } = {}) {
  if (!Array.isArray(tenantIds) || tenantIds.length === 0) {
    throw Object.assign(new Error('runCatalogRefreshOnce needs at least one tenantId'), { status: 400 });
  }
  let store = libraryStore ?? null;
  if (!store) {
    if (!pool || typeof createStore !== 'function') {
      throw Object.assign(new Error('runCatalogRefreshOnce needs a libraryStore, or a pool plus createStore'), { status: 500 });
    }
    store = createStore(pool);
  }
  const refresh = createCatalogRefresh({ libraryStore: store, subject });
  const results = [];
  for (const tenantId of tenantIds) results.push(await refresh.refreshAll(tenantId));
  return results;
}
