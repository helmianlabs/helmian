// Bottom-corner account menu (the sidebar foot): the model half. Pure —
// no DOM, no fetch — so it is unit tested like slash-menu.mjs; app.js
// renders it and owns the wiring.
//
// WHAT EACH ITEM RIDES ON (read from the code, 2026-11-04):
// - Log out is a plain link to /admin/auth/logout?return=/app — the
//   shipped sign-out road: src/cloud/live-admin.mjs answers that path
//   with a redirect to the /sign-out handoff page, which ends the Clerk
//   browser session before landing back on /app/. This menu builds no
//   second sign-out path; LOGOUT_HREF below is that road, verbatim.
// - Settings shows the signed-in identity the app already holds: the
//   session actor (the workspace's real display name, read server-side
//   from helmion.tenants and carried as actor.tenantName, plus the
//   role) and the Clerk browser user (name + email) when the app's lazy
//   Clerk load resolves one. Nothing is invented: while that load is
//   still settling the panel says so, and when it settles without a
//   user the panel says in plain words that the signed-in details
//   could not be loaded (the model's `notice`) — placeholders are
//   never presented as the final answer.
// - Download apps reads /api/latest-release — the same live release
//   read the Get started page plans from (its handler returns
//   { available, name, url, version } only when a real Windows
//   installer exists). The Windows row is offered only on that answer.
//   Mac and Linux installers do not exist yet, and their rows say so
//   in plain words instead of faking a link.
// - Report an issue: the product has no in-app issue inbox. Its one
//   contact path is the site contact address (web/marketing/
//   site-config.js, links.contact). The form composes that email in
//   the person's own mail app — nothing is sent from Helmian, and the
//   panel says so before the button is pressed.
// - Keyboard shortcuts lists only bindings the app handles today;
//   each row names the surface where the binding lives.
import { workspaceName } from './app-model.mjs?v=30a56f991a6244c2';

// The shipped sign-out road (see header). The menu's Log out anchor in
// index.html carries this exact href; the unit test pins the two
// together so the menu can never drift onto a second sign-out path.
export const LOGOUT_HREF = '/admin/auth/logout?return=/app';

// The product's one contact address (site-config.js links.contact).
export const ISSUE_CONTACT = 'helmianlabs@gmail.com';

export const ACCOUNT_MENU_ITEMS = Object.freeze([
  Object.freeze({ id: 'settings', label: 'Settings' }),
  Object.freeze({ id: 'shortcuts', label: 'Keyboard shortcuts' }),
  Object.freeze({ id: 'downloads', label: 'Download apps' }),
  Object.freeze({ id: 'report', label: 'Report an issue' }),
  Object.freeze({ id: 'logout', label: 'Log out', href: LOGOUT_HREF }),
]);

/**
 * The identity the Settings pop-out shows. `actor` is the session actor
 * ({ tenantId, tenantName, role }) the shell already holds; `user` is
 * the Clerk browser user when it has loaded, else null. Rows carry only
 * what actually exists — an email row appears only with a real email.
 * When the caller has settled the identity lookup WITHOUT a user
 * (`identityUnavailable`), the model carries the plain-words notice
 * the panel shows instead of silently presenting the workspace and
 * role rows as the whole answer.
 */
export function accountIdentityModel(actor = {}, user = null, { identityUnavailable = false } = {}) {
  const email = String(user?.primaryEmailAddress?.emailAddress ?? '').trim();
  const named = String(user?.fullName ?? '').trim()
    || [user?.firstName, user?.lastName].map((s) => String(s ?? '').trim()).filter(Boolean).join(' ');
  const workspace = workspaceName(actor);
  const role = String(actor?.role ?? '').trim();
  const rows = [];
  if (named) rows.push(Object.freeze({ label: 'Name', value: named }));
  if (email) rows.push(Object.freeze({ label: 'Email', value: email }));
  rows.push(Object.freeze({ label: 'Workspace', value: workspace }));
  if (role) rows.push(Object.freeze({ label: 'Your role', value: role }));
  return Object.freeze({
    headline: named || email || 'Your account',
    initial: (named || email || 'A').charAt(0).toUpperCase(),
    email,
    hasEmail: Boolean(email),
    notice: identityUnavailable ? 'Signed-in details could not be loaded.' : null,
    rows: Object.freeze(rows),
  });
}

// The shortcuts the app actually handles today, each traced to its
// handler (2026-11-04):
// - Enter / Shift+Enter in a message box: envoy-workspace.js composer
//   keydown handlers and app.js's console prompt handler.
// - "/" opens the command menu only as the first token of a message
//   (slash-menu.mjs's opening rule); with the menu open, ArrowUp /
//   ArrowDown move and Enter or Tab picks (envoy-workspace.js's
//   slashKeydown); Escape dismisses it without picking.
// - Escape closes the open picker, dialog or sheet (app.js and
//   envoy-workspace.js document keydown handlers).
// - Pane dividers are focusable separators: ArrowLeft / ArrowRight
//   resize, Home collapses, End resets the width (envoy-workspace.js
//   splitter keydown).
export const SHORTCUTS = Object.freeze([
  Object.freeze({ keys: 'Enter', action: 'Send the message', where: 'Message box' }),
  Object.freeze({ keys: 'Shift + Enter', action: 'New line in the message', where: 'Message box' }),
  Object.freeze({ keys: '/', action: 'Start a message with / to open the command menu', where: 'Message box' }),
  Object.freeze({ keys: '↑  ↓', action: 'Move through the command menu', where: 'Command menu open' }),
  Object.freeze({ keys: 'Enter or Tab', action: 'Use the highlighted command', where: 'Command menu open' }),
  Object.freeze({ keys: 'Esc', action: 'Close the open menu, picker or dialog', where: 'Anywhere' }),
  Object.freeze({ keys: '←  →', action: 'Resize the pane', where: 'On a pane divider' }),
  Object.freeze({ keys: 'Home', action: 'Collapse the pane', where: 'On a pane divider' }),
  Object.freeze({ keys: 'End', action: 'Reset the pane width', where: 'On a pane divider' }),
]);

/**
 * Download rows for the three desktop platforms. `release` is the
 * /api/latest-release answer ({ available, name, url, version }) or
 * null when that read has not landed / failed: an unlanded read and a
 * "no release" answer both leave the Windows row not-ready — the panel
 * never offers an installer the release read did not vouch for. Mac
 * and Linux have no installer at any time today, so their rows are
 * honestly not-ready with the reason in plain words.
 */
export function downloadsModel(release = null) {
  const winReady = release?.available === true
    && typeof release.url === 'string' && release.url.startsWith('https://');
  const windows = winReady
    ? { platform: 'Windows', ready: true, name: String(release.name ?? 'Helmian Setup'), url: release.url, version: release.version ?? null, note: null }
    : { platform: 'Windows', ready: false, name: null, url: null, version: null, note: 'The Windows installer is not available right now.' };
  return Object.freeze([
    Object.freeze(windows),
    Object.freeze({ platform: 'Mac', ready: false, name: null, url: null, version: null, note: 'The Mac app is not available yet.' }),
    Object.freeze({ platform: 'Linux', ready: false, name: null, url: null, version: null, note: 'The Linux app is not available yet.' }),
  ]);
}

/**
 * The Report-an-issue hand-off: a mailto to the product's contact
 * address with the person's words as subject and body. Pure string
 * building so the exact hand-off is unit-tested; app.js assigns it to
 * location.href only when the person presses the send button.
 */
export function reportIssueHref({ subject = '', details = '', page = '' } = {}) {
  const title = String(subject ?? '').trim() || 'Helmian issue report';
  const lines = [String(details ?? '').trim(), String(page ?? '').trim() ? `Page: ${String(page).trim()}` : ''].filter(Boolean);
  const body = lines.join('\n');
  return `mailto:${ISSUE_CONTACT}?subject=${encodeURIComponent(title)}${body ? `&body=${encodeURIComponent(body)}` : ''}`;
}
