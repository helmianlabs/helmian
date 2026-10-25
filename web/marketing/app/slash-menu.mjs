// Composer "/" menu: the visible list of slash commands. Pure model —
// no DOM — so it is unit tested like composer-picker.mjs;
// envoy-workspace.js renders it and owns the keyboard wiring.
//
// WHERE THE LIST COMES FROM: GET /api/admin/commands (src/cloud/
// slash-commands.mjs) — the served workspace's own command discovery,
// the same registry the bridge expands a leading /name against. The
// menu only ever shows rows from that list; it invents nothing. A
// command typed by hand that is not in the list still rides through as
// text exactly as it does today — the menu is a guide, not a gate.
//
// THE OPENING RULE: the menu exists only while the composer holds one
// unfinished token — the whole input is "/" plus a partial name, with
// no whitespace anywhere. The moment a space lands (a finished command
// or an ordinary sentence) the token is over and the menu closes.

export const SLASH_MENU_MAX_ROWS = 12;

/**
 * The slash token being typed, or null when the input is not one.
 * "/" alone is a token with an empty name (the menu shows everything).
 */
export function slashTokenOf(value) {
  const text = String(value ?? '');
  if (!text.startsWith('/') || /\s/.test(text)) return null;
  return Object.freeze({ token: text.slice(1) });
}

function baseName(name) {
  const text = String(name ?? '');
  const cut = text.lastIndexOf(':');
  return cut === -1 ? text : text.slice(cut + 1);
}

/** Rows matching the token: full-name prefixes first, then base-name prefixes, each alphabetical. */
export function filterSlashCommands(commands = [], token = '') {
  const needle = String(token ?? '').toLowerCase();
  const full = [];
  const base = [];
  for (const c of commands ?? []) {
    if (!c || typeof c.name !== 'string') continue;
    const name = c.name.toLowerCase();
    if (name.startsWith(needle)) full.push(c);
    else if (baseName(name).startsWith(needle)) base.push(c);
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  return Object.freeze([...full.sort(byName), ...base.sort(byName)].slice(0, SLASH_MENU_MAX_ROWS));
}

/**
 * The menu for the current input, or null when it should not show.
 * `loaded` separates "we asked and the workspace has no commands"
 * (an honest empty menu) from "we don't know yet" (no menu at all).
 */
export function slashMenuModel({ commands = [], loaded = false, value = '' } = {}) {
  const t = slashTokenOf(value);
  if (!t || !loaded) return null;
  const rows = filterSlashCommands(commands, t.token);
  return Object.freeze({
    token: t.token,
    rows,
    empty: rows.length ? null : (commands.length ? 'no-match' : 'no-commands'),
  });
}

/** The input after picking a row: the command leads, ready for its arguments. Never a send. */
export function slashInsertValue(name) {
  return `/${String(name ?? '')} `;
}

/**
 * Highlight movement for the open menu. Pure so the keyboard behaviour
 * is testable: arrows wrap, and an empty row set has no highlight.
 */
export function moveSlashHighlight(index, delta, count) {
  if (!count) return -1;
  const cur = Number.isInteger(index) && index >= 0 && index < count ? index : 0;
  return (((cur + delta) % count) + count) % count;
}
