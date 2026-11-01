// Integrations page: small cards, plain words. Nothing internal is shown here:
// no setting names, ids, addresses of services, or keys. The model is pure (tested);
// renderIntegrations draws it.
import { integrationsModel, usageModel } from './app-model.mjs';

export const PHONE_URL = 'https://helmian.cloud/app';
const OAUTH = { openai: '/api/provider-oauth/openai/start', gemini: '/api/provider-oauth/gemini/start', grok: '/api/provider-oauth/grok/start' };

// presence: rows from the runner presence feed (null when that read never
// arrived); connectors/providers/toolConnections: the cloud's connection
// lists. Every status below renders the shared truth rows from
// integrationsModel (app-model.mjs) — this page invents no state of its own.
export function integrationSections({ presence = null, connectors = {}, providers = {}, toolConnections = null, usage = null, overview = null, now = Date.now() } = {}) {
  const online = new Set((Array.isArray(presence) ? presence : []).filter((p) => p.connected !== false).map((p) => { const n = String(p.provider ?? p.providerName ?? '').toLowerCase(); return n === 'xai' ? 'grok' : n; }));
  // Every presence row, whatever its boolean says: a row means a device
  // reported this provider or a sync stamped it. That earns "Synced" —
  // never "Connected"; that word belongs to the connections store, via
  // the truth rows below.
  const stamped = new Set((Array.isArray(presence) ? presence : []).map((p) => { const n = String(p.provider ?? p.providerName ?? '').toLowerCase(); return n === 'xai' ? 'grok' : n; }));
  const truth = new Map(integrationsModel(connectors, providers, { toolConnections, presence, now }).map((i) => [i.key, i]));
  const ai = [
    ['claude', 'anthropic', 'Claude', 'Use your Claude subscription.'],
    ['openai', 'openai', 'ChatGPT', 'Sign in with your ChatGPT account.'],
    ['gemini', 'google', 'Gemini', 'Sign in with your Google account.'],
    ['grok', 'xai', 'Grok', 'Sign in with your X account.'],
    ['mistral', 'mistral', 'Mistral Le Chat', 'Use your Mistral account or key on your PC.'],
    ['runway', 'runway', 'Runway', 'Use your Runway account for video and image generation.'],
  ].map(([key, cloudKey, name, blurb]) => {
    const row = truth.get(cloudKey);
    const connected = row?.connected === true;
    // Providers with no registry row of their own (Mistral, Runway) get
    // the same truth from the raw feeds: a presence stamp earns "Synced",
    // and "Not connected" waits for the connections read, like everywhere.
    const fallbackText = stamped.has(key)
      ? (Array.isArray(providers?.connections) ? 'Synced · Not connected' : 'Synced')
      : (Array.isArray(presence) && Array.isArray(providers?.connections) ? 'Not connected' : 'Not checked');
    const statusText = row?.statusText ?? fallbackText;
    const icon = ['claude', 'openai', 'gemini', 'grok'].includes(key)
      ? { img: `/assets/agents/${key === 'openai' ? 'chatgpt' : key}.png` }
      : { glyph: key === 'mistral' ? '🦊' : '🎬' };
    return { key, name, blurb, icon, status: connected ? 'on' : 'off', statusText,
      action: connected ? { label: 'Manage', href: '#agents' } : OAUTH[key] ? { label: 'Connect', href: OAUTH[key] } : { label: 'Connect', act: key === 'claude' ? 'claude-help' : 'keys-help', provider: key } };
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
  const keys = [...online].length;
  const u = usage ? usageModel(usage) : null;
  const db = typeof overview?.settings?.database === 'boolean' ? overview.settings.database : null;
  const account = [
    { key: 'usage', name: 'Usage and billing', blurb: u ? u.text : 'Usage is not available right now.', icon: { glyph: '💳' }, status: u?.level === 'over' ? 'off' : 'info', statusText: u ? (u.limit ? `Limit ${u.limit}` : 'No limit set') : 'Checking', action: { label: 'See usage', href: '#home' } },
    { key: 'keys', name: 'Your own AI keys', blurb: 'Kept on your PC, never in the cloud.', icon: { glyph: '🔑' }, status: keys ? 'on' : 'off', statusText: keys ? `${keys} in use` : 'None yet', action: { label: 'How it works', act: 'keys-help' } },
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
  'claude-help': ['Connect Claude', ['Claude signs in on your PC, using your Claude subscription.', 'Install Helmian on your PC, then sign in to Claude there. Your sign-in stays on that PC.']],
  'pc-help': ['Set up your PC', ['1. Download Helmian for Windows from the Get started page.', '2. Sign in with this same account.', '3. Leave it running. This card turns Online by itself.']],
  'keys-help': ['Your own AI keys', ['If you prefer your own keys over signing in, add them in Helmian on your PC.', 'Keys never leave your PC. The cloud only sees whether one is in use.']],
});
