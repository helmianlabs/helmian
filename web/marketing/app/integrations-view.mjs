// Integrations page: small cards, plain words. Nothing internal is shown here:
// no setting names, ids, addresses of services, or keys. The model is pure (tested);
// renderIntegrations draws it.
import { integrationsModel, profileSyncResultModel, usageModel } from './app-model.mjs?v=94caa8deac8b08b8';
import { avatarFor } from './avatars.mjs?v=94caa8deac8b08b8';
// The art URLs minted here ride the shell stamp (optimization
// bite 2, 2026-11-12): the import graph loads this module under
// `?v=<shell stamp>` (scripts/shell-stamp.mjs), so the stamp is
// read back off this module's own URL and lent to the art — a
// face, clip or emoji is then served under the same immutable
// cache rule as the code, and can never drift from it. Loaded
// without a stamp (the test suite, tooling), the builders
// return the bare URLs they return today.
const ASSET_STAMP = new URL(import.meta.url).searchParams.get('v');
const assetUrl = (url) => (ASSET_STAMP ? `${url}?v=${ASSET_STAMP}` : url);

export const PHONE_URL = 'https://helmian.cloud/app';
// The AI providers of the owner's one connect road (2026-11-01):
// when not connected their cards carry the ConnectFields component
// (connect-fields.mjs) — an email field and a password field — instead
// of any link out or help act. Runway joins the set (P2 fix,
// 2026-11-09): the credential-connect route has always accepted
// runway, so its card was a dead end for no product reason — it now
// carries the same fields as the other sign-in seats.
const CONNECT_FIELD_PROVIDERS = new Set(['claude', 'openai', 'gemini', 'grok', 'mistral', 'runway']);
// The provider-catalog seats (src/cloud/provider-registry.mjs) connect
// a different way: with a key the person pastes on the card
// (api-key-fields.mjs), stored under the seat's own name. The field
// lists are the registry rows' auth fields — one key for most, and
// Cloudflare's two pieces, which the connect route composes into the
// one saved record its seat reads.
const API_KEY_CONNECT_FIELDS = Object.freeze({
  groq: ['api_key'],
  nvidia: ['api_key'],
  cloudflare: ['account_id', 'api_token'],
  openrouter: ['api_key'],
  muse: ['api_key'],
});
// The names a seat's saved connection rows can carry, per card key —
// the same lists the truth model matches on (app-model.mjs
// PROVIDER_SOURCE_NAMES, connections side). Used only to find the
// seat's own rows in the raw connections read for the account line
// below; Runway's row arrived with the P2 fix (2026-11-09), so it
// matches under its own name like the other sign-in seats.
const ACCOUNT_ROW_NAMES = Object.freeze({
  claude: ['anthropic', 'claude'],
  openai: ['openai'],
  gemini: ['google', 'gemini'],
  grok: ['xai', 'grok'],
  mistral: ['mistral'],
  runway: ['runway'],
  groq: ['groq'],
  nvidia: ['nvidia'],
  cloudflare: ['cloudflare'],
  openrouter: ['openrouter'],
  muse: ['muse'],
});

// presence: rows from the runner presence feed (null when that read never
// arrived); connectors/providers/toolConnections: the cloud's connection
// lists. Every status below renders the shared truth rows from
// integrationsModel (app-model.mjs) — this page invents no state of its own.
export function integrationSections({ presence = null, connectors = {}, providers = {}, toolConnections = null, usage = null, overview = null, profileSyncJob = null, now = Date.now() } = {}) {
  const online = new Set((Array.isArray(presence) ? presence : []).filter((p) => p.connected === true).map((p) => { const n = String(p.provider ?? p.providerName ?? '').toLowerCase(); return n === 'xai' ? 'grok' : n; }));
  // Every presence row, whatever its boolean says: a row means a device
  // reported this provider or a sync stamped it. That earns "Synced" —
  // never "Connected"; that word belongs to the connections store, via
  // the truth rows below.
  const stamped = new Set((Array.isArray(presence) ? presence : []).map((p) => { const n = String(p.provider ?? p.providerName ?? '').toLowerCase(); return n === 'xai' ? 'grok' : n; }));
  // Rows carrying a last-answered stamp (written by the reply path when
  // an agent posts a reply back): this provider has answered through
  // its road before, so its card reads "Answered" — the registry rows
  // carry the same state via the truth model; this set covers a
  // provider whose truth row has not answered (Mistral's row was
  // added 2026-11-06, Runway's with the P2 fix, 2026-11-09).
  const answered = new Set((Array.isArray(presence) ? presence : []).filter((p) => p?.lastAnsweredAt ?? p?.last_answered_at).map((p) => { const n = String(p.provider ?? p.providerName ?? '').toLowerCase(); return n === 'xai' ? 'grok' : n; }));
  const truth = new Map(integrationsModel(connectors, providers, { toolConnections, presence, now }).map((i) => [i.key, i]));
  const ai = [
    ['claude', 'anthropic', 'Claude', 'Sign in with your Claude account.'],
    ['openai', 'openai', 'ChatGPT', 'Sign in with your ChatGPT account.'],
    ['gemini', 'google', 'Gemini', 'Sign in with your Google account.'],
    ['grok', 'xai', 'Grok', 'Sign in with your Grok account.'],
    ['mistral', 'mistral', 'Mistral Le Chat', 'Sign in with your Mistral account.'],
    ['runway', 'runway', 'Runway', 'Use your Runway account for video and image generation.'],
    ['groq', 'groq', 'Groq', 'Connect with a key from your Groq account — free to create, no card needed.'],
    ['nvidia', 'nvidia', 'NVIDIA', 'Connect with a key from your NVIDIA Build account — free to create.'],
    ['cloudflare', 'cloudflare', 'Cloudflare', 'Connect with the two saved pieces from your Cloudflare account — free every day.'],
    ['openrouter', 'openrouter', 'OpenRouter', 'Connect with a key from your OpenRouter account — its free models cost nothing.'],
    ['muse', 'muse', 'Muse', 'Connect with a key from your Meta Model account — it bills by use, no free tier.'],
  ].map(([key, cloudKey, name, blurb]) => {
    const row = truth.get(cloudKey);
    const connected = row?.connected === true;
    // Every seat in this list now has a truth row; the raw-feed
    // fallback below stays for the day a row does not answer: a
    // presence stamp earns "Synced", and "Not connected" waits for
    // the connections read, like everywhere.
    const fallbackText = answered.has(key)
      ? 'Answered'
      : stamped.has(key)
        ? (Array.isArray(providers?.connections) ? 'Synced · Not connected' : 'Synced')
        : (Array.isArray(presence) && Array.isArray(providers?.connections) ? 'Not connected' : 'Not checked');
    const statusText = row?.statusText ?? fallbackText;
    // Icons (polish pass, §9): the four providers with settled letter
    // tiles under /assets/agents/ render those. Mistral and Runway have
    // no asset file there, so they render the app's own plain letter
    // tile (avatars.mjs: the name's initial on its name-stable colour)
    // in the same construction — no AI card in this row renders an
    // emoji glyph any more.
    const icon = ['claude', 'openai', 'gemini', 'grok'].includes(key)
      ? { img: assetUrl(`/assets/agents/${key === 'openai' ? 'chatgpt' : key}.png`) }
      : { tile: avatarFor(null, name) };
    const connect = !connected && CONNECT_FIELD_PROVIDERS.has(key) ? { provider: key } : null;
    const apiKeyConnect = !connected && API_KEY_CONNECT_FIELDS[key] ? { provider: key, fields: API_KEY_CONNECT_FIELDS[key] } : null;
    // The change road (owner's order, 2026-11-06): a connected card
    // also carries a plain button that opens the same fields in
    // change mode, so the person can put in new values over the old
    // ones — before this, a connected card offered no way to correct
    // its saved values from the page at all. The labels are the
    // owner's own words for the button: sign-in seats get "New
    // username and password", key seats get "New API key", and
    // Cloudflare names both of its pieces.
    const changeConnect = connected && CONNECT_FIELD_PROVIDERS.has(key) ? { provider: key, label: 'New username and password' } : null;
    const changeApiKey = connected && API_KEY_CONNECT_FIELDS[key]
      ? { provider: key, fields: API_KEY_CONNECT_FIELDS[key], label: key === 'cloudflare' ? 'New account number and API key' : 'New API key' }
      : null;
    // The account line (redesign §2): a connected seat's resting card
    // names the working account by its exact email, plus the stack
    // count when the seat holds more than one account. The reads this
    // page makes today return connection rows of providerId, authMode
    // and lifecycle only — the saved username lives in the credential
    // service and no read surfaces it — so this stays null until a
    // read returns the account (the stack read is R4's gate). It
    // prints only what a read actually returned, never a guess: the
    // seat's own rows in the raw connections read, and only a value
    // shaped like the email the sign-in road stores.
    const savedRows = connected && Array.isArray(providers?.connections)
      ? providers.connections.filter((c) => (ACCOUNT_ROW_NAMES[key] ?? []).includes(String(c?.providerId ?? c?.provider ?? c?.providerKey ?? '').toLowerCase()))
      : [];
    const accountEmail = savedRows
      .map((c) => c?.username ?? c?.email ?? c?.accountEmail ?? null)
      .find((v) => typeof v === 'string' && v.includes('@')) ?? null;
    return { key, name, blurb, icon, status: connected || answered.has(key) ? 'on' : 'off', statusText, connect, apiKeyConnect, changeConnect, changeApiKey,
      accountEmail, accountCount: savedRows.length,
      action: connected ? { label: 'Manage', href: '#agents' } : null };
  });
  const discord = truth.get('discord');
  const github = truth.get('github');
  const slack = truth.get('slack');
  const chat = [
    { key: 'discord', name: 'Discord', blurb: 'Mirror a team channel with Discord.', icon: { mark: 'discord' }, status: discord?.connected ? 'on' : 'off', statusText: discord?.statusText ?? 'Not checked', action: { label: discord?.connected ? 'Manage' : 'Link a channel', href: '#desktop' } },
    // GitHub is a tool connection or channel repo link.
    github?.source === 'tool-connections'
      ? { key: 'github', name: 'GitHub', blurb: 'See repo activity next to your chats.', icon: { mark: 'github' }, status: github.connected ? 'on' : 'off', statusText: github.statusText, action: { label: 'Link a channel', href: '#desktop' } }
      : { key: 'github', name: 'GitHub', blurb: 'Stream commits, pull requests and issues into any Envoy channel.', icon: { mark: 'github' }, status: 'info', statusText: 'Ready to link', action: { label: 'Link a channel', href: '#desktop' } },
    { key: 'slack', name: 'Slack', blurb: 'Mirror a team channel with Slack.', icon: { mark: 'slack' }, status: slack?.connected ? 'on' : 'off', statusText: slack?.statusText ?? 'Not checked', action: { label: slack?.connected ? 'Manage' : 'Link a channel', href: '#desktop' } },
  ];
  const pcOnline = online.size > 0;
  // The sync card renders the tenant's newest profile-sync job — the
  // same job row the Settings section renders, through the same model —
  // so a queued or running sync reads the same here as there. No job
  // yet (or the read did not answer) keeps the resting 'Ready'.
  const syncModel = profileSyncResultModel(profileSyncJob);
  const devices = [
    { key: 'profile-sync', name: 'Sync Profile and Guard', blurb: 'One-push sync of your rules, flywheel, markdown files and Guard hooks.', icon: { glyph: '⚡' }, status: syncModel.state === 'failed' ? 'off' : 'on', statusText: syncModel.state === 'idle' ? 'Ready' : syncModel.statusText, action: { label: 'Sync now', act: 'sync-profile' } },
    { key: 'pc', name: 'Your PC', blurb: pcOnline ? 'Online. Agents can answer from your PC.' : 'Offline. Install Helmian on your PC so agents can work there.', icon: { glyph: '🖥️' }, status: pcOnline ? 'on' : 'off', statusText: pcOnline ? 'Online' : 'Offline', action: pcOnline ? { label: 'Manage', href: '#devices' } : { label: 'Set up', act: 'pc-help' } },
    { key: 'phone', name: 'Your phone', blurb: 'Scan with your phone camera, sign in, done.', icon: { glyph: '📱' }, status: 'qr', statusText: 'Scan to open', action: null, qr: PHONE_URL },
  ];
  const u = usage ? usageModel(usage) : null;
  const db = typeof overview?.settings?.database === 'boolean' ? overview.settings.database : null;
  const account = [
    { key: 'usage', name: 'Usage and billing', blurb: u ? u.text : 'Usage is not available right now.', icon: { glyph: '💳' }, status: u?.level === 'over' ? 'off' : 'info', statusText: u ? (u.limit ? `Limit ${u.limit}` : 'No limit set') : 'Checking', action: { label: 'See usage', href: '#home' } },
    { key: 'data', name: 'Workspace storage', blurb: 'Your chats and projects, stored safely by Helmian.', icon: { glyph: '🗄️' }, status: db === false ? 'off' : db === true ? 'on' : 'info', statusText: db === false ? 'Offline' : db === true ? 'Connected' : 'Managed by Helmian', action: null },
  ];
  return [
    { id: 'ai', title: 'Sign in to your AI', cards: ai },
    { id: 'devices', title: 'Your devices', cards: devices },
    { id: 'chat', title: 'Chat and code', cards: chat },
    { id: 'account', title: 'Account', cards: account },
  ];
}

export const HELP = Object.freeze({
  'pc-help': ['Set up your PC', ['1. Download Helmian for Windows from the Get started page.', '2. Sign in with this same account.', '3. Leave it running. This card turns Online by itself.']],
});
