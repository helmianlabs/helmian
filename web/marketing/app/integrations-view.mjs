// Integrations page: small cards, plain words. Nothing internal is shown here:
// no setting names, ids, addresses of services, or keys. The model is pure (tested);
// renderIntegrations draws it.
import { integrationsModel, usageModel } from './app-model.mjs';
import { avatarFor } from './avatars.mjs';

export const PHONE_URL = 'https://helmian.cloud/app';
// The five AI providers of the owner's one connect road (2026-11-01):
// when not connected their cards carry the ConnectFields component
// (connect-fields.mjs) — an email field and a password field — instead
// of any link out or help act. Runway is not one of the five and keeps
// its existing card exactly.
const CONNECT_FIELD_PROVIDERS = new Set(['claude', 'openai', 'gemini', 'grok', 'mistral']);
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
});

// presence: rows from the runner presence feed (null when that read never
// arrived); connectors/providers/toolConnections: the cloud's connection
// lists. Every status below renders the shared truth rows from
// integrationsModel (app-model.mjs) — this page invents no state of its own.
export function integrationSections({ presence = null, connectors = {}, providers = {}, toolConnections = null, usage = null, overview = null, now = Date.now() } = {}) {
  const online = new Set((Array.isArray(presence) ? presence : []).filter((p) => p.connected === true).map((p) => { const n = String(p.provider ?? p.providerName ?? '').toLowerCase(); return n === 'xai' ? 'grok' : n; }));
  // Every presence row, whatever its boolean says: a row means a device
  // reported this provider or a sync stamped it. That earns "Synced" —
  // never "Connected"; that word belongs to the connections store, via
  // the truth rows below.
  const stamped = new Set((Array.isArray(presence) ? presence : []).map((p) => { const n = String(p.provider ?? p.providerName ?? '').toLowerCase(); return n === 'xai' ? 'grok' : n; }));
  // Rows carrying a last-answered stamp (written by the reply path when
  // an agent posts a reply back): this provider has answered through
  // its road before, so its card reads "Answered" — the registry rows
  // carry the same state via the truth model; this set covers the
  // providers with no registry row of their own (Mistral, Runway).
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
  ].map(([key, cloudKey, name, blurb]) => {
    const row = truth.get(cloudKey);
    const connected = row?.connected === true;
    // Providers with no registry row of their own (Mistral, Runway) get
    // the same truth from the raw feeds: a presence stamp earns "Synced",
    // and "Not connected" waits for the connections read, like everywhere.
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
      ? { img: `/assets/agents/${key === 'openai' ? 'chatgpt' : key}.png` }
      : { tile: avatarFor(null, name) };
    const connect = !connected && CONNECT_FIELD_PROVIDERS.has(key) ? { provider: key } : null;
    const apiKeyConnect = !connected && API_KEY_CONNECT_FIELDS[key] ? { provider: key, fields: API_KEY_CONNECT_FIELDS[key] } : null;
    return { key, name, blurb, icon, status: connected || answered.has(key) ? 'on' : 'off', statusText, connect, apiKeyConnect,
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
  const devices = [
    { key: 'profile-sync', name: 'Sync Profile and Guard', blurb: 'One-push sync of your rules, flywheel, markdown files and Guard hooks.', icon: { glyph: '⚡' }, status: 'on', statusText: 'Ready', action: { label: 'Sync now', act: 'sync-profile' } },
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
