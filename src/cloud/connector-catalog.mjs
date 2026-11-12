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
//   - Native entry ids are prefixed ('helmian-github')
//     so a native entry can never collide with a same-named catalog
//     entry inside one seat's library — they are different pipes (§3.2).
//   - iconRef uses the 'icon:<slug>' asset-reference scheme; the marks
//     themselves are surface asset work (Bites 3/5), not data.

import { REGISTRY_PICKS_AS_OF, registryPicksForSeat } from './mcp-registry-curation.mjs';

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
  const actions = Array.isArray(def.actions) && def.actions.length
    ? { actions: Object.freeze(def.actions.map((a) => Object.freeze({ label: String(a.label), prompt: String(a.prompt) }))) }
    : {};
  if (def.pipe.mode === 'vendor') {
    return {
      ...base,
      brokerMode: 'vendor',
      vendorConnectorRef: mirror(def.pipe.manageUrl, def.pipe.ref),
      ...actions,
    };
  }
  return {
    ...base,
    brokerMode: 'helmian',
    mcpEndpointUrl: def.pipe.endpoint,
    ...(def.pipe.scopesSummary ? { scopesSummary: def.pipe.scopesSummary } : {}),
    ...actions,
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
  // Figma is a MIRROR ONLY (Bite R2): Figma's own gate admits only
  // clients listed in the Figma MCP Catalog — new clients are
  // paused and there is no self-serve registration (Figma's own
  // forum answer from the Figma team, PLAN B6) — so no brokered
  // Figma entry exists until Figma opens that door. The row is
  // stocked so the library shows the service honestly as the
  // vendor's own pipe, the way every Source 1 mirror works. The
  // trust label is the conservative 'community': the vendor's
  // published label for this entry was not in the research.
  claudeCatalog({ id: 'figma', name: 'Figma', oneLiner: 'Find and open your Figma designs and files', vendorName: 'Figma', trustLabel: 'community', category: 'design' }),
  // Idiolect is in Troy's own Claude connectors set (his 2026-11-09
  // screenshots, mirror-design §2.1) and is the one directory entry
  // whose published menu actions the record holds verbatim: the three
  // quick actions §4 names ("Write an email in my style", "Write a
  // LinkedIn post in my style", "Set up my Writing Profile"). They
  // ride as CATALOG STARTER ACTIONS — Helmian's catalogued copy of the
  // vendor's published starters, labelled as Helmian's copy wherever
  // they render; choosing one seeds the composer as a draft and never
  // sends. The trust label is the conservative 'community': the
  // vendor's published label for this entry was not in the research.
  claudeCatalog({
    id: 'idiolect', name: 'Idiolect', oneLiner: 'Write in your own style — emails, posts, and a writing profile', vendorName: 'Idiolect', trustLabel: 'community', category: 'productivity',
    actions: [
      { label: 'Write an email in my style', prompt: 'Write an email in my style' },
      { label: 'Write a LinkedIn post in my style', prompt: 'Write a LinkedIn post in my style' },
      { label: 'Set up my Writing Profile', prompt: 'Set up my Writing Profile' },
    ],
  }),
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
  // Figma mirror only — see the note on the Claude catalog's row.
  chatgptCatalog({ id: 'figma', name: 'Figma', oneLiner: 'Find and open your Figma designs and files', vendorName: 'Figma', trustLabel: 'community', category: 'design' }),
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
export const NATIVE_STATE_SOURCES = Object.freeze({
  'helmian-github': Object.freeze({ stateSource: 'tool-connections', serviceId: 'github', repoLinks: true }),
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
  ];
}

// ------------------------------------- Source 3 — MCP Registry imports
// Curated picks from the OFFICIAL MCP Registry, ruled in
// mcp-registry-curation.mjs (the picks, their placement law, and the
// live-record check live there; the endpoint/version facts were
// pulled from the live registry on REGISTRY_PICKS_AS_OF). The
// registry is the AGGREGATOR road of research §5: Helmian polls and
// curates, then serves its own persisted copy — this data — never
// the raw feed, and never at read time.
//
// Every import is a Helmian-brokered listing: the registry record
// names a public MCP endpoint Helmian can reach and handshake
// directly, so by the §3.1 rule it ships 'helmian' and Helmian's
// own Connect flow applies — connecting still goes through the
// normal connect roads (and the safety gate where a road is
// custom-shaped); stocking the shelf marks nothing connected.
// Trust: 'community', always (the curation law — registry metadata
// being CC0 says nothing about the server it points at, and no
// label is upgraded here). Ids are prefixed ('registry-…') so an
// import can never collide with a same-named mirror or native
// inside one seat's library — they are different pipes, the §3.2
// rule the natives already follow. The pick's registry name and
// the version the curation check last saw ride on the definition
// as provenance (catalog data only, like the starter actions —
// the store keeps its own fixed entry shape).
function registryEntriesForSeat(seatId) {
  return registryPicksForSeat(seatId).map((pick) => ({
    ...catalogEntry(seatId, {
      id: pick.entryId,
      name: pick.name,
      oneLiner: pick.oneLiner,
      icon: pick.icon,
      vendorName: pick.vendorName,
      trustLabel: 'community',
      category: pick.category,
      pipe: {
        mode: 'helmian',
        endpoint: pick.endpoint,
        authMode: pick.authMode,
        ...(pick.scopesSummary ? { scopesSummary: pick.scopesSummary } : {}),
      },
    }),
    registryName: pick.registryName,
    registryVersion: pick.registryVersion,
    registryAsOf: REGISTRY_PICKS_AS_OF,
    // A pick that declares the scopes it asks for carries them as
    // catalog data (same discipline as the registry fields above —
    // the store keeps its own fixed entry shape). The connect road
    // reads them from this definition, never from the stored row
    // (see effectiveAuthMode's law in the write route).
    ...(pick.oauthScopes ? { oauthScopes: pick.oauthScopes } : {}),
  }));
}

// --------------------------- Source 4 — vendor-published servers
// A vendor's OWN published MCP server, offered as a Helmian-brokered
// connector in its own right — not a mirror (Source 1), not a
// registry import (Source 3). One entry today:
//
//   helmian-vercel — Vercel's official MCP server. Vercel's own docs
//     ("Use Vercel", vercel.com/docs/agent-resources/vercel-mcp,
//     last updated 2026-09-15) publish the endpoint
//     https://mcp.vercel.com as a remote MCP server (Streamable
//     HTTP) whose sign-in is OAuth under the MCP Authorization spec.
//     The endpoint also accepts a Vercel access token in the
//     Authorization header, and the entry originally shipped that
//     token road (authMode 'header': connecting asked the person to
//     paste a token from their account settings). Troy's product
//     call (2026-11-10) retired it: Connect must open the provider's
//     own sign-in door, never a paste-a-token form. Vercel's server
//     publishes a complete OAuth road — its authorization-server
//     metadata (issuer https://vercel.com, read live 2026-11-10)
//     names an authorize endpoint, a token endpoint (public client,
//     PKCE S256), and a registration endpoint, so Helmian registers
//     itself at connect time on the DCR road, the same machinery
//     the registry DCR entries already run. The entry therefore
//     ships authMode 'oauth', and declares the one scope Vercel's
//     own protected-resource document publishes for this server
//     ('openid' — the sign-in itself; what the connection can
//     reach is bounded by the person's own Vercel account).
//     The header road is REPLACED, not kept beside it: an entry
//     carries exactly one authMode (the catalog/store shape), and
//     the write route's connect/header action refuses any entry
//     whose catalog mode is not 'header' — the generic header road
//     itself stays for entries that declare it (custom entries).
//     A connection landed earlier through a pasted token is not
//     read by the OAuth road; reconnecting through Vercel's sign-in
//     replaces it. The change is this entry's authMode and declared
//     scopes only — never its identity.
//     LIVE-PROOF FINDING (2026-11-10, vercel-oauth bite REPORT):
//     Vercel's registration endpoint currently refuses Helmian's
//     callback — POST /api/login/oauth/register with the
//     helmian.cloud callback answers 400 invalid_redirect_uri,
//     "The provided redirect URIs are not approved for use by this
//     authorization server." Diagnostics the same day: the same
//     registration with a loopback redirect is approved (201), and
//     any other hosted or custom-scheme redirect is refused the
//     same way — Vercel approves DCR registrations for local
//     clients, and hosted clients connect, in Vercel's own docs
//     words, by Client ID Metadata Documents (CIMD) or after
//     Vercel's client review.
//     CIMD IDENTIFICATION (2026-11-10, vercel-cimd bite): the
//     entry now declares that identification — cimdClientId above
//     is the HTTPS URL of Helmian's client metadata document,
//     served as a static file on helmian.cloud by the marketing
//     site's Vercel hosting (the road that already serves the
//     site's public documents), naming Helmian, the same
//     production callback, authorization-code + refresh grants,
//     response type 'code', and the public-client auth method
//     'none' (builder + three-way pin: connector-oauth-dcr.mjs
//     and test/connector-vercel.test.mjs). Vercel's authorization
//     server metadata advertises client_id_metadata_document_
//     supported: true (live read, 2026-11-10), so the connect
//     start runs the CIMD kind: no registration call — the
//     authorize URL carries the document URL as client_id, and
//     the callback's exchange presents it the same way. The
//     entry's declared road stays 'oauth' throughout: that is
//     the truthful road, now with its hosted-client door built.
//   - The id is prefixed ('helmian-') by the §3.2 law: on Grok the
//     Source 1 Vercel mirror (id 'vercel') stays as data, untouched,
//     and a brokered entry never takes a mirror's id inside one
//     seat's library. The row a person sees for the name is this
//     brokered one; the connectors tab represents a name by its
//     brokered row.
//   - Placement follows Source 3's geography — the seats named for
//     it: claude, chatgpt, grok.
//   - trustLabel 'verified': Vercel's own published server, the
//     same label Grok's mirror already carries for Vercel.
//   - The definition carries `vendorPublished: true` as provenance
//     (catalog data only, like Source 3's registry fields — the
//     store keeps its own fixed entry shape). It is the marker the
//     §3.1 brokerMode pin in the bite-2 gate rules by: a vendor-
//     published reachable pipe is 'helmian', not a mirror.
const BROKERED_SERVERS = Object.freeze([
  Object.freeze({
    seats: Object.freeze(['claude', 'chatgpt', 'grok']),
    def: Object.freeze({
      id: 'helmian-vercel',
      name: 'Vercel',
      oneLiner: 'Manage projects and deployments, read build logs, and search the Vercel docs',
      icon: 'vercel',
      vendorName: 'Vercel',
      trustLabel: 'verified',
      category: 'development',
      oauthScopes: Object.freeze(['openid']),
      // The CIMD identification (see the Source 4 note): Helmian's
      // client_id at Vercel is the HTTPS URL of its published
      // client metadata document — the static file at this path on
      // helmian.cloud (web/marketing/oauth/client-metadata.json),
      // whose content connector-oauth-dcr.mjs's builder produces
      // and the tests pin together.
      cimdClientId: 'https://helmian.cloud/oauth/client-metadata.json',
      pipe: {
        mode: 'helmian',
        endpoint: 'https://mcp.vercel.com',
        authMode: 'oauth',
        scopesSummary: 'Connect opens Vercel\u2019s own sign-in page: you sign in with your Vercel account and approve the connection there \u2014 nothing to paste, no token to create. What the connection can reach is the access your own Vercel account already has.',
      },
    }),
  }),
  // ------------------------------------------ Bite R2 (2026-11-10)
  // The team-work family: Slack, Asana, HubSpot. Each vendor
  // publishes its own remote MCP server, and each sign-in road is
  // OAuth with a PRE-REGISTERED client — none of the three lets a
  // client register itself (live discovery reads, 2026-11-10: all
  // three metadata sets name NO registration endpoint). Helmian's
  // side of each road is the fixed registry (connector-oauth-
  // pending.mjs): an app registered in the provider's own console,
  // its client ID and secret held as project env, authorization
  // code + PKCE S256. Until that env pair is placed, a connect
  // start answers the honest consent boundary — Helmian holds no
  // registration yet — and connects nothing.
  //   - Slack: the person's own Slack account is what connects
  //     (the server runs on user tokens). Only an internal app or
  //     a Slack Marketplace app may use the server, the app must
  //     have MCP turned on, and a workspace admin may have to
  //     approve it (PLAN B7). The brokered row stands beside the
  //     Claude/ChatGPT Slack mirrors, which stay as data — the
  //     brokered row represents the name, the mirror law's usual
  //     shape (the Vercel pair above).
  //   - Asana: the registration is an "MCP app" in Asana's
  //     developer console. Asana defines no permission split for
  //     MCP apps (its own guide: use `default` or omit the scope —
  //     including a scope parameter ERRORS), so the connect asks
  //     for none; the grant is the person's own Asana access. MCP
  //     tokens work only against the MCP server, last an hour, and
  //     refresh; each connection sees ONE Asana workspace.
  //   - HubSpot: the registration is an "MCP connector" created in
  //     HubSpot itself (Development → MCP Connectors). HubSpot
  //     defines no scopes on the connector — its consent page
  //     derives them from the server's tools and the person's own
  //     permissions — so the connect asks for none either. PKCE is
  //     mandatory on this road (HubSpot's own integration guide).
  Object.freeze({
    seats: Object.freeze(['claude', 'chatgpt', 'grok']),
    def: Object.freeze({
      id: 'helmian-slack',
      name: 'Slack',
      oneLiner: 'Search messages, summarise channels, and draft replies',
      icon: 'slack',
      vendorName: 'Slack',
      trustLabel: 'verified',
      category: 'communication',
      pipe: {
        mode: 'helmian',
        endpoint: 'https://mcp.slack.com/mcp',
        authMode: 'oauth',
        scopesSummary: 'Signing in connects your own Slack account: this agent searches and reads what you can see in Slack, under your name. It never posts as you. A workspace admin may need to approve Helmian\u2019s Slack app first.',
      },
    }),
  }),
  Object.freeze({
    seats: Object.freeze(['claude', 'chatgpt', 'grok']),
    def: Object.freeze({
      id: 'helmian-asana',
      name: 'Asana',
      oneLiner: 'Look up projects and tasks, check status, and file new work',
      icon: 'asana',
      vendorName: 'Asana',
      trustLabel: 'verified',
      category: 'productivity',
      pipe: {
        mode: 'helmian',
        endpoint: 'https://mcp.asana.com/v2/mcp',
        authMode: 'oauth',
        scopesSummary: 'Signing in grants the access your own Asana account already has — Asana does not split an MCP connection into separate permissions. Each connection sees one Asana workspace.',
      },
    }),
  }),
  Object.freeze({
    seats: Object.freeze(['claude', 'chatgpt', 'grok']),
    def: Object.freeze({
      id: 'helmian-hubspot',
      name: 'HubSpot',
      oneLiner: 'Search contacts, companies, and deals, and keep CRM records up to date',
      icon: 'hubspot',
      vendorName: 'HubSpot',
      trustLabel: 'verified',
      category: 'sales',
      pipe: {
        mode: 'helmian',
        endpoint: 'https://mcp.hubspot.com',
        authMode: 'oauth',
        scopesSummary: 'HubSpot sets the permissions on its own consent page, from the tools its server offers and the access your HubSpot account already holds. Helmian does not pick them.',
      },
    }),
  }),
  // ------------------------------------------ Google family (2026-11-10)
  // Gmail, Google Calendar, Google Drive. Google publishes one
  // remote MCP server per Workspace product (whole-list research,
  // google-microsoft.md §1), and the sign-in road is fixed
  // registration ONLY: Google's authorization-server metadata
  // (live read, 2026-11-10) names NO registration endpoint and no
  // CIMD support, so the DCR/CIMD roads cannot serve these entries
  // by construction. ONE Google Cloud OAuth client covers all
  // three products — the consent is per-product scopes on the one
  // client — so all three entries run under the ONE fixed provider
  // 'google' (connector-oauth-pending.mjs), its pair held as
  // project env (GOOGLE_OAUTH_CLIENT_ID /
  // GOOGLE_OAUTH_CLIENT_SECRET). Until that pair is placed, a
  // connect start answers the honest consent boundary naming
  // Google, and connects nothing.
  //   - Placement follows Source 4's geography — the seats the
  //     existing brokered family (Vercel, Slack, Asana, HubSpot)
  //     is stocked on: claude, chatgpt, grok. The Google mirrors
  //     also live on gemini (Google brokers Gemini's Workspace
  //     apps itself), but no brokered entry is stocked there; the
  //     brokered placement follows the Source 4 family, not the
  //     mirrors' spread. The mirrors stay as data beside these
  //     rows on claude/chatgpt/grok (and alone on gemini) — the
  //     brokered row represents the name where both exist.
  //   - Each entry declares its OWN product scopes (oauthScopes
  //     below): the scopes Google's own Workspace MCP setup page
  //     names for that product. The connect road reads them from
  //     this definition via declaredOAuthScopes — never from the
  //     stored row — and the Google factory adds
  //     access_type=offline + prompt=consent, without which
  //     Google issues no refresh token and the person re-signs-in
  //     about every hour.
  //   - Gmail's copy is draft-and-read, truthfully: Google's
  //     published Gmail tool list has NO send tool, so the words
  //     promise drafts and reads and never sending. Calendar's
  //     declared scopes are read-only (Google's setup page) and
  //     whether the server exposes write tools is UNVERIFIED in
  //     the research, so its words promise no event creation.
  Object.freeze({
    seats: Object.freeze(['claude', 'chatgpt', 'grok']),
    def: Object.freeze({
      id: 'helmian-gmail',
      name: 'Gmail',
      oneLiner: 'Search your inbox, read threads, and draft replies',
      icon: 'gmail',
      vendorName: 'Google',
      trustLabel: 'verified',
      category: 'productivity',
      oauthScopes: Object.freeze([
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.compose',
      ]),
      pipe: {
        mode: 'helmian',
        endpoint: 'https://gmailmcp.googleapis.com/mcp/v1',
        authMode: 'oauth',
        scopesSummary: 'Signing in connects your own Google account: this agent can search and read your mail and prepare drafts in Gmail. It cannot send mail from here \u2014 Google\u2019s Gmail server offers drafts and reads only, so you send from Gmail yourself.',
      },
    }),
  }),
  Object.freeze({
    seats: Object.freeze(['claude', 'chatgpt', 'grok']),
    def: Object.freeze({
      id: 'helmian-google-calendar',
      name: 'Google Calendar',
      oneLiner: 'See your calendars, check availability, and read your events',
      icon: 'google-calendar',
      vendorName: 'Google',
      trustLabel: 'verified',
      category: 'productivity',
      oauthScopes: Object.freeze([
        'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
        'https://www.googleapis.com/auth/calendar.events.freebusy',
        'https://www.googleapis.com/auth/calendar.events.readonly',
      ]),
      pipe: {
        mode: 'helmian',
        endpoint: 'https://calendarmcp.googleapis.com/mcp/v1',
        authMode: 'oauth',
        scopesSummary: 'Signing in connects your own Google account: this agent can see your calendar list, check free and busy times, and read your events.',
      },
    }),
  }),
  Object.freeze({
    seats: Object.freeze(['claude', 'chatgpt', 'grok']),
    def: Object.freeze({
      id: 'helmian-google-drive',
      name: 'Google Drive',
      oneLiner: 'Search, open, and read your documents and files',
      icon: 'google-drive',
      vendorName: 'Google',
      trustLabel: 'verified',
      category: 'documents',
      oauthScopes: Object.freeze([
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/drive.file',
      ]),
      pipe: {
        mode: 'helmian',
        endpoint: 'https://drivemcp.googleapis.com/mcp/v1',
        authMode: 'oauth',
        scopesSummary: 'Signing in connects your own Google account: this agent can search and read the files in your Drive, and work with the files it opens or creates there.',
      },
    }),
  }),
  // --------------------------------- DCR long tail (2026-11-10)
  // Meltwater, S&P Global, Idiolect, Gamma. Each vendor publishes
  // its own remote MCP server whose authorization server offers
  // DYNAMIC CLIENT REGISTRATION (live discovery reads, 2026-11-10:
  // every authorization-server document below names a registration
  // endpoint and PKCE S256), so Helmian registers itself at
  // connect time on the DCR road — no pre-registered app, no env
  // pair, no fixed provider. None of the four is named in
  // FIXED_PROVIDER_BY_ENTRY_ID and none declares a CIMD client id,
  // so kind resolution rules each one 'dcr' under its own service
  // key. Placement follows Source 4's geography — claude,
  // chatgpt, grok. The mirrors stay as data beside these rows:
  // Gamma, Meltwater and S&P Global on Grok, Idiolect on Claude;
  // the brokered row represents the name where both exist. Trust
  // labels follow the mirrors' own labels for each name —
  // 'community' for all four; no label is upgraded here.
  //   - Declared scopes are each authorization server's own
  //     published scopes_supported, read live 2026-11-10, and
  //     nothing else. The DCR road narrows a declared ask to what
  //     the server's resource document offers at registration
  //     (Meltwater's resource document offers tools:read and
  //     tools:call, so that pair is Meltwater's registration ask).
  //   - Idiolect declares NO scopes: neither its protected-
  //     resource document nor its ScaleKit issuer's authorization-
  //     server metadata publishes any scopes_supported (live read,
  //     2026-11-10), and no provider-hosted setup documentation
  //     naming scopes was located — so the entry declares none
  //     and its words promise no more than the mirror's own
  //     one-liner (writing-style tools). Its issuer publishes BOTH
  //     a registration endpoint and CIMD support; the live-proof
  //     start (this bite's REPORT) registered on the DCR road, so
  //     the entry declares no cimdClientId — DCR is the road that
  //     works, and a declared CIMD identity would outrank it.
  //   - S&P Global's real gate is the person's own account: the
  //     Kensho LLM-Ready API answers under the signing-in person's
  //     provisioned, entitled S&P Global/Kensho account. That is
  //     consent-side truth, carried in the entry's scopesSummary —
  //     not a registration blocker: registration itself is open.
  //   - Gamma stands behind TWO provider-side gates, both met
  //     live in this bite's proof (REPORT's live-proof table):
  //     its protected-resource document names the origin
  //     (https://mcp.gamma.app) as its resource rather than the
  //     /mcp endpoint its own docs publish, so Helmian's
  //     discovery — which refuses a metadata document naming a
  //     different resource — stops the start before registration
  //     is ever attempted; and Gamma's registration endpoint
  //     itself refuses the production callback until Gamma's
  //     team allowlists it through the Request MCP Access form
  //     (REGISTRATION-PACK §11; the direct probe in the REPORT
  //     carries Gamma's exact words). The entry ships on the DCR
  //     road regardless: the start surfaces the refusal honestly
  //     and connects nothing, and no fake boundary state stands
  //     in for either gate.
  Object.freeze({
    seats: Object.freeze(['claude', 'chatgpt', 'grok']),
    def: Object.freeze({
      id: 'helmian-meltwater',
      name: 'Meltwater',
      oneLiner: 'Track media coverage and brand mentions',
      icon: 'meltwater',
      vendorName: 'Meltwater',
      trustLabel: 'community',
      category: 'data',
      oauthScopes: Object.freeze(['openid', 'profile', 'email', 'tools:read', 'tools:call']),
      pipe: {
        mode: 'helmian',
        endpoint: 'https://api.meltwater.com/v2/mcp',
        authMode: 'oauth',
        scopesSummary: 'Connect opens Meltwater\u2019s own sign-in page: you sign in with your Meltwater account and approve the connection there \u2014 nothing to paste. This agent can then use Meltwater\u2019s tools to read media coverage and brand mentions, under the access your own Meltwater account already has.',
      },
    }),
  }),
  Object.freeze({
    seats: Object.freeze(['claude', 'chatgpt', 'grok']),
    def: Object.freeze({
      id: 'helmian-sp-global',
      name: 'S&P Global',
      oneLiner: 'Look up company and market data',
      icon: 'sp-global',
      vendorName: 'S&P Global',
      trustLabel: 'community',
      category: 'data',
      oauthScopes: Object.freeze(['kensho:app:kfinance', 'offline_access']),
      pipe: {
        mode: 'helmian',
        endpoint: 'https://kfinance.kensho.com/integrations/mcp',
        authMode: 'oauth',
        scopesSummary: 'Connect opens S&P Global\u2019s own sign-in page for the Kensho LLM-Ready API: you sign in with your own S&P Global account and approve the connection there \u2014 nothing to paste. The connection works with your own S&P Global/Kensho account access and entitlements: it can look up only the company and market data your account is provisioned and entitled to see.',
      },
    }),
  }),
  Object.freeze({
    seats: Object.freeze(['claude', 'chatgpt', 'grok']),
    def: Object.freeze({
      id: 'helmian-idiolect',
      name: 'Idiolect',
      oneLiner: 'Write in your own style \u2014 emails, posts, and a writing profile',
      icon: 'idiolect',
      vendorName: 'Idiolect',
      trustLabel: 'community',
      category: 'productivity',
      pipe: {
        mode: 'helmian',
        endpoint: 'https://idiolect.app/api/mcp',
        authMode: 'oauth',
        scopesSummary: 'Connect opens Idiolect\u2019s own sign-in page: you sign in with your Idiolect account and approve the connection there \u2014 nothing to paste. This agent can then use Idiolect\u2019s writing-style tools \u2014 writing emails and posts in your style and working with your writing profile \u2014 under your own account.',
      },
    }),
  }),
  Object.freeze({
    seats: Object.freeze(['claude', 'chatgpt', 'grok']),
    def: Object.freeze({
      id: 'helmian-gamma',
      name: 'Gamma',
      oneLiner: 'Generate, read, and edit presentations and documents in Gamma',
      icon: 'gamma',
      vendorName: 'Gamma',
      trustLabel: 'community',
      category: 'documents',
      oauthScopes: Object.freeze(['generate', 'gamma:read']),
      pipe: {
        mode: 'helmian',
        endpoint: 'https://mcp.gamma.app/mcp',
        authMode: 'oauth',
        scopesSummary: 'Connect opens Gamma\u2019s own sign-in page: you sign in with your Gamma account and approve the connection there \u2014 nothing to paste. This agent can then generate, read, and edit presentations and documents in Gamma. Generations and edits use your own Gamma plan\u2019s credits \u2014 Helmian does not provide them.',
      },
    }),
  }),
  // --------------------------------- Fixed tail (2026-11-10)
  // Canva, Dropbox. Each vendor publishes its own remote MCP
  // server, and neither road lets Helmian register itself for
  // MCP use: Canva's developer-endpoint road runs on a fixed
  // Developer Portal app (its documents: "create an app in the
  // Developer Portal and turn on Canva MCP. You get a client ID
  // and client secret straight away"; CIMD is offered only
  // through a waitlist application), and Dropbox's own Help
  // Center limits MCP dynamic registration to a trusted set of
  // named clients Helmian is not in — every other client brings
  // a Dropbox App Console app's credentials. Both entries
  // therefore run under the fixed registry
  // (connector-oauth-pending.mjs): one provider each ('canva',
  // 'dropbox'), its pair held as project env (CANVA_OAUTH_*,
  // DROPBOX_OAUTH_* — Dropbox's pair is its App key / App
  // secret). Until a pair is placed, a connect start answers
  // the honest consent boundary naming that provider, and
  // connects nothing.
  //   - Placement follows Source 4's geography — claude,
  //     chatgpt, grok. The mirrors stay as data beside these
  //     rows (Canva on all three seats; Dropbox on chatgpt —
  //     its only mirror); the brokered row represents the name
  //     where both exist. Trust labels follow the mirrors' own
  //     labels for each name — 'community' for both; no label
  //     is upgraded here.
  //   - Each entry declares its OWN ask (oauthScopes below),
  //     read by the connect road from this definition via
  //     declaredOAuthScopes — never from the stored row.
  //     Canva's set is exactly the scopes_supported list in
  //     the developer server's own protected-resource document
  //     (https://api.canva.com/.well-known/oauth-protected-
  //     resource/connect/v1/mcp, live read 2026-11-10).
  //     Dropbox's set is exactly the scopes_supported list in
  //     its MCP server's own protected-resource document
  //     (https://mcp.dropbox.com/.well-known/oauth-protected-
  //     resource/mcp, live read 2026-11-10) — the MCP set,
  //     which is the Dropbox Help Center's App Console
  //     permissions list for this server plus
  //     files.metadata.write, the metadata-write scope its
  //     create/organise tools run on.
  //   - Canva's factory adds nothing to the authorize URL
  //     beyond PKCE: its token exchange is Basic-auth + PKCE
  //     and its authorization server issues a refresh token
  //     with the code (Canva's Connect authentication page),
  //     so refresh-on-resolve covers Canva from day one.
  //     Dropbox's factory shapes token_access_type=offline —
  //     without it Dropbox issues NO refresh token on this
  //     road. Dropbox's MCP server is in beta (Dropbox's own
  //     Help Center page), which the entry's words say.
  Object.freeze({
    seats: Object.freeze(['claude', 'chatgpt', 'grok']),
    def: Object.freeze({
      id: 'helmian-canva',
      name: 'Canva',
      oneLiner: 'Find, read, and create designs in your Canva library',
      icon: 'canva',
      vendorName: 'Canva',
      trustLabel: 'community',
      category: 'design',
      oauthScopes: Object.freeze([
        'profile:read',
        'design:meta:read', 'design:content:read', 'design:content:write',
        'folder:read', 'folder:write',
        'brandtemplate:meta:read', 'brandtemplate:content:read', 'brandtemplate:content:write',
        'comment:read', 'comment:write',
        'asset:read', 'asset:write',
        'brandkit:read',
        'help:answers:read', 'help:answers:write',
      ]),
      pipe: {
        mode: 'helmian',
        endpoint: 'https://api.canva.com/connect/v1/mcp',
        authMode: 'oauth',
        scopesSummary: 'Connect opens Canva\u2019s own sign-in page: you sign in with your Canva account and approve the connection there \u2014 nothing to paste. This agent can then search and read your designs, create and edit designs, work with your folders and assets, read your brand templates and brand kits, and read and add comments \u2014 under the access your own Canva account already has.',
      },
    }),
  }),
  Object.freeze({
    seats: Object.freeze(['claude', 'chatgpt', 'grok']),
    def: Object.freeze({
      id: 'helmian-dropbox',
      name: 'Dropbox',
      oneLiner: 'Search, open, and organise files stored in Dropbox',
      icon: 'dropbox',
      vendorName: 'Dropbox',
      trustLabel: 'community',
      category: 'documents',
      oauthScopes: Object.freeze([
        'account_info.read',
        'file_requests.read', 'file_requests.write',
        'files.content.read', 'files.content.write',
        'files.metadata.read', 'files.metadata.write',
        'sharing.read', 'sharing.write',
      ]),
      pipe: {
        mode: 'helmian',
        endpoint: 'https://mcp.dropbox.com/mcp',
        authMode: 'oauth',
        scopesSummary: 'Connect opens Dropbox\u2019s own sign-in page: you sign in with your Dropbox account and approve the connection there \u2014 nothing to paste. This agent can then search, browse, and read your files and their details, create and update files and folders \u2014 Dropbox\u2019s published scope set for its MCP server includes writing file content, which its create and organise tools need \u2014 manage sharing and shared links, and work with file requests, under the access your own Dropbox account already has. Dropbox\u2019s MCP server is in beta.',
      },
    }),
  }),
  // MICROSOFT — ONE CONNECTION UNDER FOUR NAMES (Troy's ruling,
  // 2026-11-10; REGISTRATION-PACK §6). OneDrive, Outlook,
  // Microsoft Teams and SharePoint keep their separate names in
  // the catalog and the panel, and underneath they are ONE
  // Microsoft connection: Microsoft's unified Work IQ server
  // (https://workiq.svc.cloud.microsoft/mcp) serves all four —
  // Outlook mail and calendar, OneDrive and SharePoint files,
  // Teams chats and channels — behind ONE sign-in. Connecting
  // any one of the four connects the Microsoft connection; the
  // other three rows then read connected too, because they are
  // the same connection. The four definitions declare that with
  // connectionFamily 'microsoft', and the store resolves the
  // family's connections as one set entry (connector-library.mjs
  // carries the same table by hand, pinned by test).
  //   - The road is a FIXED registration: Entra offers no dynamic
  //     registration and no client-id metadata document, so the
  //     connect road runs under the fixed registry's 'microsoft'
  //     provider (connector-oauth-pending.mjs), its pair held as
  //     project env (MICROSOFT_OAUTH_CLIENT_ID /
  //     MICROSOFT_OAUTH_CLIENT_SECRET). Placing that registration
  //     is the registration pack's §6 sitting step — an Entra app
  //     registration for work or school accounts with Helmian's
  //     callback as its web redirect. Until the pair is placed,
  //     a connect start answers the honest consent boundary
  //     naming Microsoft, and connects nothing.
  //   - The ask each entry declares is the Work IQ server's own:
  //     its protected-resource document
  //     (https://workiq.svc.cloud.microsoft/.well-known/oauth-
  //     protected-resource/mcp, live read 2026-11-10) publishes
  //     exactly one scope, named there in its resource form
  //     (fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask —
  //     the same scope the pack names in its api:// spelling),
  //     plus the standard sign-in scopes that carry the refresh
  //     token (offline_access) and the account identity (openid,
  //     profile). All four entries declare the same ask because
  //     the connection is one.
  //   - The connection is work-or-school only: Microsoft's own
  //     rules put Work IQ behind an organization's tenant, its
  //     admin's approval, and Copilot licensing measured in
  //     Copilot Credits — a personal Microsoft account cannot
  //     connect, and every entry's words say so. When the
  //     organization's admin has not approved Helmian yet, the
  //     callback answers with the admin-approval road in plain
  //     words (the write route's consent page), never a bare
  //     failure.
  //   - Placement follows the fixed-tail geography — claude,
  //     chatgpt, grok. The mirrors stay as data beside these rows
  //     (all four names mirror on grok); the brokered row
  //     represents the name where both exist. Trust labels
  //     follow the mirrors' own label — 'verified' for all four;
  //     no label is upgraded here.
  //   - Teams honesty: Work IQ's published surface reads Teams
  //     chats and channels; whether it can post is not verified,
  //     so the Teams entry's words promise reading only.
  Object.freeze({
    seats: Object.freeze(['claude', 'chatgpt', 'grok']),
    def: Object.freeze({
      id: 'helmian-onedrive',
      name: 'OneDrive',
      oneLiner: 'Search, open, and work with files in OneDrive',
      icon: 'onedrive',
      vendorName: 'Microsoft',
      trustLabel: 'verified',
      category: 'documents',
      connectionFamily: 'microsoft',
      oauthScopes: Object.freeze([
        'fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask',
        'offline_access', 'openid', 'profile',
      ]),
      pipe: {
        mode: 'helmian',
        endpoint: 'https://workiq.svc.cloud.microsoft/mcp',
        authMode: 'oauth',
        scopesSummary: 'Connect opens Microsoft\u2019s own sign-in page: you sign in with your work or school Microsoft account and approve the connection there \u2014 nothing to paste, and a personal Microsoft account cannot connect. OneDrive, Outlook, Microsoft Teams and SharePoint share this one Microsoft connection in Helmian: connecting any one of them connects all four. This agent can then search, open, and work with your OneDrive files under the access your own account already has. Your organization\u2019s Microsoft admin may need to approve Helmian before the first connection can finish.',
      },
    }),
  }),
  Object.freeze({
    seats: Object.freeze(['claude', 'chatgpt', 'grok']),
    def: Object.freeze({
      id: 'helmian-outlook',
      name: 'Outlook',
      oneLiner: 'Read and search your Outlook mail and calendar',
      icon: 'outlook',
      vendorName: 'Microsoft',
      trustLabel: 'verified',
      category: 'communication',
      connectionFamily: 'microsoft',
      oauthScopes: Object.freeze([
        'fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask',
        'offline_access', 'openid', 'profile',
      ]),
      pipe: {
        mode: 'helmian',
        endpoint: 'https://workiq.svc.cloud.microsoft/mcp',
        authMode: 'oauth',
        scopesSummary: 'Connect opens Microsoft\u2019s own sign-in page: you sign in with your work or school Microsoft account and approve the connection there \u2014 nothing to paste, and a personal Microsoft account cannot connect. Outlook, OneDrive, Microsoft Teams and SharePoint share this one Microsoft connection in Helmian: connecting any one of them connects all four. This agent can then read and search your Outlook mail and work with your calendar under the access your own account already has. Your organization\u2019s Microsoft admin may need to approve Helmian before the first connection can finish.',
      },
    }),
  }),
  Object.freeze({
    seats: Object.freeze(['claude', 'chatgpt', 'grok']),
    def: Object.freeze({
      id: 'helmian-microsoft-teams',
      name: 'Microsoft Teams',
      oneLiner: 'Read your Teams chats and channels',
      icon: 'microsoft-teams',
      vendorName: 'Microsoft',
      trustLabel: 'verified',
      category: 'communication',
      connectionFamily: 'microsoft',
      oauthScopes: Object.freeze([
        'fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask',
        'offline_access', 'openid', 'profile',
      ]),
      pipe: {
        mode: 'helmian',
        endpoint: 'https://workiq.svc.cloud.microsoft/mcp',
        authMode: 'oauth',
        scopesSummary: 'Connect opens Microsoft\u2019s own sign-in page: you sign in with your work or school Microsoft account and approve the connection there \u2014 nothing to paste, and a personal Microsoft account cannot connect. Microsoft Teams, OneDrive, Outlook and SharePoint share this one Microsoft connection in Helmian: connecting any one of them connects all four. This agent can then read your Teams chats and channels under the access your own account already has. Your organization\u2019s Microsoft admin may need to approve Helmian before the first connection can finish.',
      },
    }),
  }),
  Object.freeze({
    seats: Object.freeze(['claude', 'chatgpt', 'grok']),
    def: Object.freeze({
      id: 'helmian-sharepoint',
      name: 'SharePoint',
      oneLiner: 'Search, open, and work with files in SharePoint',
      icon: 'sharepoint',
      vendorName: 'Microsoft',
      trustLabel: 'verified',
      category: 'documents',
      connectionFamily: 'microsoft',
      oauthScopes: Object.freeze([
        'fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask',
        'offline_access', 'openid', 'profile',
      ]),
      pipe: {
        mode: 'helmian',
        endpoint: 'https://workiq.svc.cloud.microsoft/mcp',
        authMode: 'oauth',
        scopesSummary: 'Connect opens Microsoft\u2019s own sign-in page: you sign in with your work or school Microsoft account and approve the connection there \u2014 nothing to paste, and a personal Microsoft account cannot connect. SharePoint, OneDrive, Outlook and Microsoft Teams share this one Microsoft connection in Helmian: connecting any one of them connects all four. This agent can then search, open, and work with your SharePoint files and sites under the access your own account already has. Your organization\u2019s Microsoft admin may need to approve Helmian before the first connection can finish.',
      },
    }),
  }),
  // BOX — THE FIRST TENANT-PAIR PROVIDER (Troy's ruling,
  // 2026-11-10; REGISTRATION-PACK §9). Box offers Helmian no
  // registration of its own: its MCP server supports no dynamic
  // registration (Box's own Support page says so), and its road
  // runs on integration credentials minted PER CUSTOMER in the
  // Box Admin Console. So this entry's OAuth road is the fixed
  // kind under the provider 'box' — but the client is built from
  // the TENANT's stored pair (connector-tenant-pair.mjs), never
  // from project env: the customer's Box admin creates the
  // credentials with Helmian's callback as the redirect, the
  // workspace owner or admin stores the pair in Helmian (the
  // panel's Client pair form), and every connect in that tenant
  // runs under it. Until a pair is stored, a connect start
  // answers needs-tenant-pair in plain words and connects
  // nothing.
  //   - The entry declares NO oauthScopes: the access is what
  //     the Box admin SELECTED when creating the integration
  //     credentials (the console's Access Scopes govern the
  //     grant), and Box's server publishes no scopes_supported
  //     for its MCP server (its protected-resource document,
  //     live read 2026-11-10). The factory therefore sends no
  //     scope parameter — what the authorize request actually
  //     grants on this road is UNVERIFIED until a live walk.
  //   - Placement follows the fixed geography — claude, chatgpt,
  //     grok. The mirror stays as data beside this row (Box
  //     mirrors on grok); the brokered row represents the name.
  //     Trust label follows the mirror's own — 'community'; no
  //     label is upgraded here.
  //   - Box meters this road (one API call per tool invocation,
  //     plus AI Units for its AI tools, per Box's own MCP page) —
  //     a pricing fact for the tenant, not a build input, and
  //     the entry's words do not promise otherwise.
  Object.freeze({
    seats: Object.freeze(['claude', 'chatgpt', 'grok']),
    def: Object.freeze({
      id: 'helmian-box',
      name: 'Box',
      oneLiner: 'Search, open, and work with files stored in Box',
      icon: 'box',
      vendorName: 'Box',
      trustLabel: 'community',
      category: 'documents',
      pipe: {
        mode: 'helmian',
        endpoint: 'https://mcp.box.com',
        authMode: 'oauth',
        scopesSummary: 'Connecting Box takes one setup step in your own Box first: your Box admin creates integration credentials for Helmian in the Box Admin Console and selects the access there, and your workspace owner or admin stores that client pair in Helmian with the Client pair action on this row. Connect then opens Box\u2019s own sign-in page: you sign in with your Box account and approve the connection there. This agent can then search, open, and work with your Box files under the access your admin selected and your own account already has.',
      },
    }),
  }),
  // SALESFORCE — THE SECOND TENANT-PAIR PROVIDER (Troy's ruling,
  // 2026-11-10; REGISTRATION-PACK §10). Same shape as Box: no
  // Helmian registration exists on this road — the customer's
  // Salesforce admin turns on MCP Servers in their org's Setup,
  // creates an External Client App there with Helmian's callback,
  // and the pair that app mints is stored PER TENANT
  // (connector-tenant-pair.mjs) and builds every client on this
  // entry's road. Two Salesforce-only facts shape the build:
  //   - The endpoint is PER ORG. Salesforce's MCP endpoint is a
  //     fixed host template plus the org's own server path
  //     (Salesforce's example: platform/sobject-reads). The
  //     endpoint declared below is that TEMPLATE, braces and
  //     all — it is not a callable address. The pair completes
  //     it: the admin enters the org's server path in the Client
  //     pair form, the write route composes the complete
  //     endpoint at the store, and the roads that run against
  //     the org (dispatch arming, the prompts road) take the
  //     endpoint from the pair. Any consumer that reads only
  //     this declaration still sees the template — named here so
  //     nobody mistakes it for a live address.
  //   - The scopes ARE published: the server's own metadata
  //     advertises exactly mcp_api and refresh_token, and the
  //     entry declares exactly those (the admin also selects
  //     them on the External Client App). No openid rides this
  //     road, so the factory carries no identity read — the
  //     callback records the provider's name as the account
  //     label, like Box.
  //   Placement follows the fixed geography — claude, chatgpt,
  //   grok. The mirror stays as data beside this row (Salesforce
  //   mirrors on grok); trust label follows the mirror's own —
  //   'verified'. Salesforce MCP requires Enterprise Edition or
  //   above — the customer's edition is their admin's fact, and
  //   the entry's words do not promise otherwise.
  Object.freeze({
    seats: Object.freeze(['claude', 'chatgpt', 'grok']),
    def: Object.freeze({
      id: 'helmian-salesforce',
      name: 'Salesforce',
      oneLiner: 'Look up accounts, leads, and opportunities',
      icon: 'salesforce',
      vendorName: 'Salesforce',
      trustLabel: 'verified',
      category: 'sales',
      oauthScopes: Object.freeze(['mcp_api', 'refresh_token']),
      pipe: {
        mode: 'helmian',
        endpoint: 'https://api.salesforce.com/platform/mcp/v1/{server}',
        authMode: 'oauth',
        scopesSummary: 'Connecting Salesforce takes one setup step in your own Salesforce first: your Salesforce admin turns on MCP Servers in Setup and creates an External Client App there with Helmian\u2019s callback, and your workspace owner or admin stores that client pair in Helmian with the Client pair action on this row, together with the MCP server path Setup shows for your org. Connect then opens Salesforce\u2019s own sign-in page: you sign in with your Salesforce account and approve the connection there. This agent can then look up accounts, leads, and opportunities in your org.',
      },
    }),
  }),
]);

function brokeredServerEntriesForSeat(seatId) {
  return BROKERED_SERVERS
    .filter((server) => server.seats.includes(seatId))
    .map((server) => ({
      ...catalogEntry(seatId, server.def),
      vendorPublished: true,
      // A brokered definition that declares the scopes it asks for
      // carries them as catalog data, the Source 3 discipline above
      // (the connect road reads them from this definition, never
      // from the stored row — see declaredOAuthScopes' law in the
      // write route).
      ...(server.def.oauthScopes ? { oauthScopes: server.def.oauthScopes } : {}),
      // Same discipline for a declared CIMD client id: catalog
      // data on the built entry, read by the connect road from
      // this definition, never from the stored row.
      ...(server.def.cimdClientId ? { cimdClientId: server.def.cimdClientId } : {}),
      // And for a declared connection family: several entries
      // that are ONE connection underneath (the Microsoft four
      // below). Catalog data on the built entry; the store's
      // family table (connector-library.mjs) is kept in step with
      // these declarations by hand and pinned against them by
      // test, the VAULT_REFERENCE discipline.
      ...(server.def.connectionFamily ? { connectionFamily: server.def.connectionFamily } : {}),
    }));
}

// ------------------------------------------------------------------ catalog

/** Source 1 + Source 3 + Source 4 + Source 2 definitions for one seat's library. */
export function catalogEntriesForSeat(seatId) {
  if (!LIVE_SEATS.includes(seatId)) {
    throw Object.assign(new Error(`unknown seat "${seatId}" — the catalog seeds the seats live in the room`), { status: 400 });
  }
  return [...(SOURCE1_BY_SEAT[seatId] ?? []), ...registryEntriesForSeat(seatId), ...brokeredServerEntriesForSeat(seatId), ...helmianNativeEntries(seatId)];
}

/** The whole day-one catalog: every live seat's definitions. */
export const CONNECTOR_CATALOG = Object.freeze(
  LIVE_SEATS.flatMap((seatId) => catalogEntriesForSeat(seatId)),
);

export function catalogEntryById(seatId, entryId) {
  return catalogEntriesForSeat(seatId).find((entry) => entry.id === entryId) ?? null;
}

/**
 * The catalog starter actions for one entry (mirror-design §4): the
 * vendor-published quick actions Helmian's catalog carries a copy of,
 * as frozen { label, prompt } rows, or null when the catalog holds
 * none for the entry. This is catalog DATA, not library state — it is
 * joined onto the read at read time (connector-library-read.mjs) and
 * never stored on the entry record, the same discipline as the
 * catalog's other descriptive fields before a refresh carries them.
 */
export function catalogStarterActions(seatId, entryId) {
  let entry = null;
  try { entry = catalogEntryById(seatId, entryId); } catch { entry = null; }
  return entry && Array.isArray(entry.actions) && entry.actions.length ? entry.actions : null;
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

// The delta test for one definition against its stored row: does
// the refresh have anything to write? The comparison covers exactly
// the fields createEntry's update writes (name through
// workspaceProvisioned) plus brokerMode — brokerMode is not written
// by an update, it is the guard: a stored row whose brokerMode
// disagrees must still be ATTEMPTED, so createEntry's 409 surfaces
// the conflict instead of the delta test quietly skipping a data
// bug. Kind is deliberately NOT compared (except custom, below):
// an update never rewrites kind either, so a kind drift on a
// non-custom row is not something a refresh can fix — attempting
// it every pass would only re-pay a no-op write. A stored CUSTOM
// row is never "matching": createEntry rules customs by refusal,
// and that refusal (409 → conflict) is the human-visible outcome.
function definitionMatchesStored(definition, stored) {
  if (!stored) return false;
  if (stored.kind === 'custom' || definition.kind === 'custom') return false;
  const sameRef = (a, b) => {
    const x = a ?? null;
    const y = b ?? null;
    if (x === null || y === null) return x === y;
    return x.ref === y.ref && x.manageUrl === y.manageUrl;
  };
  return stored.name === definition.name
    && stored.oneLiner === definition.oneLiner
    && (stored.iconRef ?? null) === (definition.iconRef ?? null)
    && stored.vendorName === definition.vendorName
    && stored.trustLabel === definition.trustLabel
    && (stored.category ?? null) === (definition.category ?? null)
    && stored.brokerMode === definition.brokerMode
    && (stored.mcpEndpointUrl ?? null) === (definition.mcpEndpointUrl ?? null)
    && sameRef(stored.vendorConnectorRef, definition.vendorConnectorRef)
    && stored.authMode === definition.authMode
    && (stored.clientIdentity ?? null) === (definition.clientIdentity ?? null)
    && (stored.scopesSummary ?? null) === (definition.scopesSummary ?? null)
    && (stored.workspaceProvisioned === true) === (definition.workspaceProvisioned === true);
}

export function createCatalogRefresh({ libraryStore, subject } = {}) {
  if (!libraryStore || typeof libraryStore.createEntry !== 'function') {
    throw Object.assign(new Error('createCatalogRefresh needs the connector library store'), { status: 500 });
  }
  if (!subject || typeof subject !== 'string') {
    throw Object.assign(new Error('catalog refresh needs the acting subject'), { status: 400 });
  }

  async function refreshSeat(tenantId, seatId) {
    const applied = [];
    const unchanged = [];
    const conflicts = [];
    // The refresh is a DELTA, not a sweep (2026-11-09 perf bite):
    // it lists the seat's stored entries once and writes only the
    // definitions that are missing or whose writable fields differ.
    // The old shape called createEntry for every definition — each
    // call its own transaction — so a catalog addition cost a full
    // 75-entry rewrite on the read that noticed it (~20s live), 54
    // of the 75 writes re-writing identical rows. Stores without a
    // list read (minimal fakes) keep the old write-everything path.
    const storedById = typeof libraryStore.listEntries === 'function'
      ? new Map((await libraryStore.listEntries(tenantId, seatId)).map((entry) => [entry.id, entry]))
      : null;
    for (const definition of catalogEntriesForSeat(seatId)) {
      if (definition.kind === 'custom') {
        // Catalog data never provisions custom entries (§3.3: customs
        // are added by a person, per seat). Defensive — none exist.
        conflicts.push({ seatId, entryId: definition.id, message: 'catalog data may not carry custom entries' });
        continue;
      }
      if (storedById && definitionMatchesStored(definition, storedById.get(definition.id))) {
        unchanged.push(definition.id);
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
    return { seatId, applied, unchanged, conflicts };
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
