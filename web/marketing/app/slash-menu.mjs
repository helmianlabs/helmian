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
//
// THE SKILLS GROUP (slash-skills DESIGN §4.1, bite S3): the menu also
// carries the workspace's HELMIAN skills — the cloud store's list
// (GET /api/admin/skills, rows without bodies). They are a second
// group under the commands, never mixed into them: a command pick
// inserts "/name " as always, while a skill pick opens the scope step
// (slashSkillScopeModel) and ATTACHES the skill to the message
// (metadata.skills — it does not become body text, and no fake 'skill'
// command is ever registered: "/skill" stays filter text that happens
// to address this group, per the rule in filterSlashSkills).

export const SLASH_MENU_MAX_ROWS = 12;
// The row cap is PER GROUP (DESIGN §4.1): a long command list can
// never starve the skills group off the menu, or the other way round.
export const SLASH_SKILLS_MAX_ROWS = 12;

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
 * The right-hand badge for a skill row: what the skill's own scope
 * already says — 'all agents' for a blanket skill, the seat names for
 * a seats-scoped one — or 'Turned off' for an owner-disabled skill,
 * which stands in place of its scope (it cannot ride a turn until it
 * is turned back on; DESIGN §4.1 + the S1 store's states). `seatLabel`
 * resolves a seat id to the name the room shows; ids it does not know
 * stand as themselves.
 */
export function slashSkillBadge(skill, seatLabel = (id) => String(id ?? '')) {
  if (!skill) return '';
  if (skill.state === 'disabled-by-owner') return 'Turned off';
  if (skill.scope === 'seats') {
    const names = (Array.isArray(skill.seatIds) ? skill.seatIds : []).map((id) => seatLabel(id));
    return names.length ? names.join(' · ') : 'all agents';
  }
  return 'all agents';
}

function skillRowOf(skill, seatLabel) {
  return Object.freeze({
    kind: 'skill',
    id: String(skill.id),
    name: String(skill.name ?? skill.id),
    description: typeof skill.description === 'string' ? skill.description : '',
    scope: skill.scope === 'seats' ? 'seats' : 'blanket',
    seatIds: Object.freeze(Array.isArray(skill.seatIds) ? skill.seatIds.map((s) => String(s)) : []),
    state: String(skill.state ?? 'available'),
    badge: slashSkillBadge(skill, seatLabel),
  });
}

/**
 * The skills matching the token (DESIGN §4.1's literal-token rule):
 * while the token is a prefix of the word "skill" itself — "/s",
 * "/ski", "/skill" — the token is addressing the GROUP, so the whole
 * list stands (that is what makes typing /skill pop the skills
 * picker, listing the workspace's skills). Any other token filters
 * the list by id prefix, the commands' rule. Rows are the store's
 * list rows (no bodies — the list route carries none), sorted by id,
 * capped per group.
 */
export function filterSlashSkills(skills = [], token = '', seatLabel) {
  const needle = String(token ?? '').toLowerCase();
  // A prefix of "skill" (or the empty token) addresses the whole
  // group; anything longer filters by id prefix. (The two-word
  // '/skill <id>' form never reaches the menu: a space ends the
  // token and closes it — that form is read at send time, by S1.)
  const addressingGroup = needle === '' || 'skill'.startsWith(needle);
  const out = [];
  for (const s of skills ?? []) {
    if (!s || typeof s.id !== 'string' || !s.id) continue;
    if (!addressingGroup && !s.id.toLowerCase().startsWith(needle)) continue;
    out.push(skillRowOf(s, seatLabel));
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return Object.freeze(out.slice(0, SLASH_SKILLS_MAX_ROWS));
}

/**
 * The menu for the current input, or null when it should not show.
 * `loaded` separates "we asked and the workspace has no commands"
 * (an honest empty menu) from "we don't know yet" (no menu at all).
 * The skills group follows the same discipline on its own flag:
 * until `skillsLoaded`, the group is simply absent and the model is
 * exactly the commands-only model it has always been. When loaded,
 * `showNewSkill` is always true — the group's final row (＋ New
 * skill…) is how the first skill ever gets made (DESIGN §4.3).
 */
export function slashMenuModel({ commands = [], loaded = false, value = '', skills = [], skillsLoaded = false, seatLabel } = {}) {
  const t = slashTokenOf(value);
  if (!t || !loaded) return null;
  const rows = filterSlashCommands(commands, t.token);
  const skillRows = skillsLoaded ? filterSlashSkills(skills, t.token, seatLabel) : Object.freeze([]);
  const skillList = Array.isArray(skills) ? skills : [];
  return Object.freeze({
    token: t.token,
    rows,
    empty: rows.length ? null : (commands.length ? 'no-match' : 'no-commands'),
    skillRows,
    skillsEmpty: !skillsLoaded || skillRows.length ? null : (skillList.length ? 'no-match' : 'no-skills'),
    showNewSkill: skillsLoaded === true,
  });
}

/**
 * The flat, keyboard-navigable pick list for the menu's first level:
 * command picks, then skill picks, then the New skill row. The
 * workspace's highlight index walks THIS list; a command entry picks
 * by inserting text, a skill entry opens the scope step, and the
 * new-skill entry opens the editor.
 */
export function slashPickList(model) {
  if (!model) return Object.freeze([]);
  const out = [
    ...(model.rows ?? []).map((c) => Object.freeze({ type: 'command', name: c.name })),
    ...(model.skillRows ?? []).map((s) => Object.freeze({ type: 'skill', id: s.id })),
  ];
  if (model.showNewSkill) out.push(Object.freeze({ type: 'new-skill' }));
  return Object.freeze(out);
}

/**
 * The scope step for one picked skill (DESIGN §4.2): the rows the
 * second level of the menu offers. `seats` is the channel's own seat
 * list ([{ seatId, name }] — library seats by their seat id, custom
 * agents by handle; Maestro is never among them, being the human).
 * A blanket-scoped record offers Every agent plus every channel
 * seat; a seats-scoped record offers ONLY its recorded seats (the
 * record's scope is the ceiling — a message can narrow a skill, it
 * can never widen one, DESIGN §2.1). An owner-disabled skill offers
 * no attach rows at all: the step exists so its Edit row stays
 * reachable, with the turned-off note standing where the rows would.
 */
export function slashSkillScopeModel(skill, seats = []) {
  if (!skill) return null;
  const channelSeats = (Array.isArray(seats) ? seats : []).filter((s) => s && typeof s.seatId === 'string' && s.seatId);
  const disabled = skill.state === 'disabled-by-owner';
  let rows = [];
  if (!disabled) {
    if (skill.scope === 'seats') {
      const recorded = new Set(Array.isArray(skill.seatIds) ? skill.seatIds.map((s) => String(s)) : []);
      rows = channelSeats.filter((s) => recorded.has(s.seatId)).map((s) => Object.freeze({ seatId: s.seatId, name: s.name ?? s.seatId }));
    } else {
      rows = [Object.freeze({ seatId: 'all', name: 'Every agent' }), ...channelSeats.map((s) => Object.freeze({ seatId: s.seatId, name: s.name ?? s.seatId }))];
    }
  }
  return Object.freeze({
    skillId: String(skill.id ?? ''),
    name: String(skill.name ?? skill.id ?? ''),
    scope: skill.scope === 'seats' ? 'seats' : 'blanket',
    disabled,
    rows: Object.freeze(rows),
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
