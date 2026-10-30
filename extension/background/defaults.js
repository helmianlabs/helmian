// Shipped defaults for zero-friction Scribe setup (0.6.2).
//
// SCRIBE_DEFAULT_URL is the ONE place the hosted Scribe server address lives.
// It is a build-time constant: tools/package-guard.mjs rewrites the line below
// when given --scribe-url URL (or the HELMIAN_SCRIBE_URL environment variable).
// Users never type it; it stays editable under Advanced.

export const SCRIBE_DEFAULT_URL = 'https://5-78-222-178.sslip.io'; // @build:scribe-url

// THE AI TABLE. One row per AI the welcome page offers. To add an AI, add a row.
//   key      stable id for the tick box
//   label    what the user sees
//   mailbox  the Scribe mailbox Guard watches (lowercase, Scribe's own naming)
//   hosts    chat host names (exact host or any subdomain of it)
//   chatUrl  where "Open to read" sends you; null when not verified
//   nudge    true only when content/nudge.js has a tested adapter for the site
//            AND the manifest's content_scripts cover it
//   note     optional short plain note shown next to the tick box
export const AI_CHOICES = Object.freeze([
  { key: 'chatgpt', label: 'ChatGPT', mailbox: 'chatgpt', hosts: ['chatgpt.com'], chatUrl: 'https://chatgpt.com/', nudge: true },
  { key: 'claude', label: 'Claude', mailbox: 'claude.ai', hosts: ['claude.ai'], chatUrl: 'https://claude.ai/', nudge: true },
  { key: 'grok', label: 'Grok', mailbox: 'grok', hosts: ['grok.com'], chatUrl: 'https://grok.com/', nudge: true },
  { key: 'gemini', label: 'Gemini', mailbox: 'gemini', hosts: ['gemini.google.com'], chatUrl: 'https://gemini.google.com/', nudge: true },
  // Mailbox only for now: no tested nudge adapter, and nudging would widen the
  // content-script host list (a new install-time permission prompt).
  { key: 'mistral', label: 'Mistral (Le Chat)', mailbox: 'mistral', hosts: ['chat.mistral.ai'], chatUrl: 'https://chat.mistral.ai/', nudge: true },
  { key: 'perplexity', label: 'Perplexity', mailbox: 'perplexity', hosts: ['perplexity.ai'], chatUrl: 'https://www.perplexity.ai/', nudge: true,
    note: 'Custom connectors may need a higher Perplexity plan.' },
  // Muse: Troy's own assistant ("Shared Memory — muse" in Scribe). Its chat
  // address is not verified, so it is a mailbox only.
  { key: 'muse', label: 'Muse', mailbox: 'muse', hosts: [], chatUrl: null, nudge: false },
].map((row) => Object.freeze({ ...row, hosts: Object.freeze([...row.hosts]) })));

/** Nudge sites derived from the table: { host: mailbox } for nudge-capable rows. */
export function nudgeSiteTable() {
  return Object.fromEntries(AI_CHOICES.filter((c) => c.nudge).map((c) => [c.hosts[0], c.mailbox]));
}
/** "Open to read" links derived from the table: { mailbox: chatUrl }. */
export function mailboxSiteTable() {
  return Object.fromEntries(AI_CHOICES.filter((c) => c.chatUrl).map((c) => [c.mailbox, c.chatUrl]));
}

export const DEFAULT_NUDGE_IDLE_MIN = 3;
export const DEFAULT_NUDGE_DAILY_CAP = 20;

function picked(keys) {
  const want = new Set((Array.isArray(keys) ? keys : []).map((k) => String(k).toLowerCase()));
  return AI_CHOICES.filter((c) => want.has(c.key));
}
/** Mailboxes to watch for the ticked AIs, in a fixed order. Never typed. */
export function mailboxesForAis(keys) { return picked(keys).map((c) => c.mailbox); }
/** Per-site auto-nudge switches: on for the ticked AIs, off for the rest. */
export function nudgeSitesForAis(keys) {
  const on = new Set(picked(keys).filter((c) => c.nudge).map((c) => c.hosts[0]));
  return Object.fromEntries(AI_CHOICES.filter((c) => c.nudge).map((c) => [c.hosts[0], on.has(c.hosts[0])]));
}

/** The redirect address the Scribe OAuth server sends the browser back to. */
export function redirectUrlFor(runtimeId, identity) {
  try { if (identity && typeof identity.getRedirectURL === 'function') return identity.getRedirectURL(); } catch { /* fall through */ }
  return runtimeId ? `https://${runtimeId}.chromiumapp.org/` : '';
}

// 0.6.7: the ONLY pages Guard may nudge. Exact host (no subdomain or substring
// matching) plus the real consumer-chat paths. Anything else is refused, so a
// lookalike app (e.g. the Grok Bot agent app) never gets typed into.
// Keep in sync with CHAT_PAGES in content/nudge.js (a test checks they match).
export const CHAT_PAGES = Object.freeze({
  'chatgpt.com': { hosts: ['chatgpt.com'], paths: ['^/$', '^/c/[A-Za-z0-9-]+/?$', '^/g/[A-Za-z0-9-]+(/c/[A-Za-z0-9-]+)?/?$'] },
  'claude.ai': { hosts: ['claude.ai'], paths: ['^/$', '^/new/?$', '^/chat/[A-Za-z0-9-]+/?$'] },
  'grok.com': { hosts: ['grok.com'], paths: ['^/$', '^/c/[A-Za-z0-9-]+/?$', '^/chat/[A-Za-z0-9-]+/?$'] },
  'gemini.google.com': { hosts: ['gemini.google.com'], paths: ['^(/u/[0-9]+)?/app(/[A-Za-z0-9]+)?/?$', '^(/u/[0-9]+)?/gem/[A-Za-z0-9-]+(/[A-Za-z0-9]+)?/?$'] },
  'perplexity.ai': { hosts: ['www.perplexity.ai', 'perplexity.ai'], paths: ['^/$', '^/search/[A-Za-z0-9._-]+/?$'] },
  'chat.mistral.ai': { hosts: ['chat.mistral.ai'], paths: ['^/chat(/[A-Za-z0-9-]+)?/?$'] },
});
/** Nudge site key for a full page URL, or null. https only, exact host, allow-listed path. */
export function chatSiteForUrl(url) {
  let u; try { u = new URL(String(url || '')); } catch { return null; }
  if (u.protocol !== 'https:' || u.port || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  for (const [site, rule] of Object.entries(CHAT_PAGES)) {
    if (!rule.hosts.includes(host)) continue;
    return rule.paths.some((p) => new RegExp(p).test(u.pathname)) ? site : null;
  }
  return null;
}
