// Skill editor model: the pure half of the Helmian skill authoring
// surface (slash-skills DESIGN §2.3/§4.3, bite S3). No DOM —
// envoy-workspace.js renders the editor into the channel's modal and
// owns the fetch calls; everything decidable is decided here so it
// unit-tests like composer-picker.mjs and slash-menu.mjs.
//
// A Helmian skill is authored ONCE per workspace (the cloud store,
// src/cloud/skill-library.mjs, behind the S2 routes in
// src/cloud/skill-library-route.mjs): a name, a one-line description,
// and a body of plain instruction text, scoped to every agent
// ('blanket') or to named seats ('seats'). The caps and the slug
// pattern below MIRROR the store's — the server re-checks everything;
// these exist so the editor can refuse early, in plain words, the
// same discipline as composer-picker.mjs's file bounds. Keep in step
// with SKILL_ID_PATTERN / SKILL_*_MAX_CHARS in
// src/cloud/skill-library.mjs.
//
// TYPING AND PASTE ARE ONE SURFACE (DESIGN §2.3): the same three
// fields serve both. The one difference is a prefill: when the pasted
// text opens with Claude-Code-style frontmatter, its name /
// description (and a slug-shaped name as the id) prefill the fields
// the person left empty, so what the form shows is what will be
// saved. THE BODY IS NEVER REWRITTEN HERE — the raw paste rides in
// the save payload byte for byte, and the S2 route's own lift
// (liftSkillPaste, running the same parseFrontmatter rules) strips
// the block server-side. One lift, on the server; the port below
// only reads the same fields for the prefill, and must not grow a
// second stripping behaviour.

export const SKILL_ID_MAX_CHARS = 64;
export const SKILL_NAME_MAX_CHARS = 120;
export const SKILL_DESCRIPTION_MAX_CHARS = 200;
export const SKILL_BODY_MAX_CHARS = 24_000;
// Mirror of SKILL_ID_PATTERN in src/cloud/skill-library.mjs: a single
// lowercase slug segment — no colon, so a Helmian skill can never be
// mistaken for a plugin:skill command name (DESIGN §5.2).
export const SKILL_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
// Mirror of SEAT_ID_PATTERN's shape in the same store: the seat ids a
// 'seats' scope may name (library seats and custom-agent handles).
const SKILL_SEAT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;

// One display line, the store's cleanLine rule: control characters
// stripped, whitespace collapsed. The editor validates the cleaned
// value, because the cleaned value is what the store will keep.
export function cleanSkillLine(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The slug a typed name becomes: lowercased, runs of characters the
 * pattern forbids collapse to a single dash, leading characters that
 * are not a letter or digit are dropped (the pattern must open with
 * one), and the result is capped at the store's 64. Returns null when
 * nothing usable remains — the editor then asks for a name it can
 * derive from instead of inventing one.
 */
export function deriveSkillId(name) {
  const slug = cleanSkillLine(name).toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-{2,}/g, '-')
    .slice(0, SKILL_ID_MAX_CHARS)
    .replace(/[-_]+$/, '');
  return slug && SKILL_SLUG_PATTERN.test(slug) ? slug : null;
}

/**
 * A port of parseFrontmatter's rules (src/agent/commands.mjs) for
 * the two fields the prefill reads — KEEP IN STEP with that parser
 * and with liftSkillPaste in src/cloud/skill-library-route.mjs,
 * which run the same rules authoritatively on the server. The port
 * is deliberately narrow: BOM/CRLF tolerated, the block must open
 * with a `---` first line and close with a `---` line (an unclosed
 * block is NO frontmatter — the whole text is body), and inside the
 * block only simple `key: value` lines are read (the full parser's
 * continuation and quoting rules stay server-side; a value this port
 * cannot read plainly is simply not prefilled, never mangled).
 * Returns { present, name, description } with nulls for absent.
 */
export function parseSkillFrontmatter(text) {
  const none = { present: false, name: null, description: null };
  const source = String(text ?? '');
  const normalized = source.replace(/^\ufeff/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n') && normalized.trimStart().startsWith('---') === false) return none;
  const lines = normalized.split('\n');
  if (lines[0].trim() !== '---') return none;
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) return none;
  const meta = {};
  for (let i = 1; i < end; i += 1) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let value = m[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
    if (value) meta[m[1].toLowerCase()] = value;
  }
  return {
    present: true,
    name: typeof meta.name === 'string' ? meta.name : null,
    description: typeof meta.description === 'string' ? meta.description : null,
  };
}

/**
 * What a paste offers the draft's empty fields: the frontmatter's
 * name and description, cleaned to one line, and — when the
 * frontmatter name is already a valid skill slug — the id (the
 * route's lift applies the identical rule server-side). Fields the
 * frontmatter does not carry come back absent, never blanked.
 */
export function skillPastePrefill(text) {
  const fm = parseSkillFrontmatter(text);
  if (!fm.present) return {};
  const out = {};
  const name = fm.name ? cleanSkillLine(fm.name) : '';
  const description = fm.description ? cleanSkillLine(fm.description) : '';
  if (name) out.name = name;
  if (description) out.description = description;
  if (fm.name && SKILL_SLUG_PATTERN.test(fm.name.trim()) && fm.name.trim().length <= SKILL_ID_MAX_CHARS) out.id = fm.name.trim();
  return out;
}

/** A blank draft: the New skill editor's starting shape. */
export function emptySkillDraft() {
  return Object.freeze({ id: '', name: '', description: '', body: '', scope: 'blanket', seatIds: Object.freeze([]) });
}

/** The editor's draft for an existing record (the GET :id read). */
export function skillDraftFromRecord(record) {
  if (!record || typeof record !== 'object') return emptySkillDraft();
  return Object.freeze({
    id: String(record.id ?? ''),
    name: String(record.name ?? ''),
    description: String(record.description ?? ''),
    body: String(record.body ?? ''),
    scope: record.scope === 'seats' ? 'seats' : 'blanket',
    seatIds: Object.freeze(Array.isArray(record.seatIds) ? record.seatIds.map((s) => String(s)) : []),
  });
}

/**
 * A paste lands in the draft: the body becomes the pasted text
 * VERBATIM (the route's lift strips any frontmatter server-side —
 * see the header), and the frontmatter's name / description / id
 * prefill ONLY the fields the person has not already filled. What
 * they typed always wins over what they pasted.
 */
export function applySkillPaste(draft, text) {
  const prefill = skillPastePrefill(text);
  return Object.freeze({
    ...draft,
    body: String(text ?? ''),
    name: draft.name ? draft.name : (prefill.name ?? draft.name),
    description: draft.description ? draft.description : (prefill.description ?? draft.description),
    id: draft.id ? draft.id : (prefill.id ?? draft.id),
  });
}

/** The id a draft will be saved under: its own, or derived from the name. */
export function skillDraftId(draft) {
  const own = String(draft?.id ?? '').trim();
  return own || deriveSkillId(draft?.name ?? '');
}

/**
 * The store's rules, mirrored (see the header): returns
 * { ok, errors } with one plain-words reason per bad field. The id
 * is judged as the draft will save it (derived when not given), so
 * the form never promises a slug the save would not carry.
 */
export function validateSkillDraft(draft) {
  const errors = {};
  const id = skillDraftId(draft);
  if (!id) errors.id = 'Give the skill a name the menu can use — letters, numbers and dashes.';
  else if (id.length > SKILL_ID_MAX_CHARS || !SKILL_SLUG_PATTERN.test(id)) errors.id = 'That name makes an unusable skill id — a lowercase slug of at most 64 characters, no colon.';
  const name = cleanSkillLine(draft?.name ?? '');
  if (!name) errors.name = 'Give the skill a name.';
  if (name.length > SKILL_NAME_MAX_CHARS) errors.name = 'That name is too long — the limit is 120 characters.';
  const description = cleanSkillLine(draft?.description ?? '');
  if (description.length > SKILL_DESCRIPTION_MAX_CHARS) errors.description = 'That description is too long — the limit is 200 characters.';
  const body = String(draft?.body ?? '');
  if (!body.trim()) errors.body = 'Write or paste the skill\'s instructions first.';
  else if (body.length > SKILL_BODY_MAX_CHARS) errors.body = 'That skill is too long — the limit is 24,000 characters.';
  if (draft?.scope !== 'blanket' && draft?.scope !== 'seats') errors.scope = 'Pick who the skill is for.';
  else if (draft.scope === 'seats') {
    const seats = Array.isArray(draft.seatIds) ? draft.seatIds : [];
    if (!seats.length) errors.seatIds = 'Pick at least one agent, or choose Every agent.';
    else if (seats.some((s) => !SKILL_SEAT_ID_PATTERN.test(String(s ?? '')))) errors.seatIds = 'One of the picked agents is not a seat this workspace knows.';
  }
  return { ok: !Object.keys(errors).length, errors: Object.freeze(errors) };
}

/**
 * The request body for the S2 routes. Create carries the id (the
 * draft's own or the derived slug); an edit omits it — the id
 * travels in the PUT URL and never changes under an edit. The
 * description rides only when non-empty (an absent description lets
 * the route's paste lift fill it from frontmatter, and the store
 * keeps null otherwise); seatIds ride only for a 'seats' scope (the
 * store normalizes a blanket skill's list to empty). The body rides
 * byte for byte as drafted — typed, or the raw paste (see the
 * header).
 */
export function skillSavePayload(draft, { editing = false } = {}) {
  const description = cleanSkillLine(draft?.description ?? '');
  return Object.freeze({
    ...(editing ? {} : { id: skillDraftId(draft) }),
    name: cleanSkillLine(draft?.name ?? ''),
    ...(description ? { description } : {}),
    body: String(draft?.body ?? ''),
    scope: draft?.scope === 'seats' ? 'seats' : 'blanket',
    ...(draft?.scope === 'seats' ? { seatIds: Object.freeze([...(draft.seatIds ?? [])]) } : {}),
  });
}
