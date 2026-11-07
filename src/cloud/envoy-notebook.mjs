// Envoy notebook: the shared notebook in the channel seats' prompt
// (EVERY-SEAT-COVERAGE-MAP-2026-11-06, build-order bite 2).
//
// A channel seat's whole world was the prompt composed for its turn —
// a role line, the last 12 channel messages, and the message being
// answered (envoy-agents.mjs agentPrompt). Facts the channel scrolled
// past, or that were never said in the channel at all, did not exist
// for the seat: asked which seat's landing page won the November 6
// staging build, the seat that HAD won answered that it did not know
// (the cross-check test, 2026-11-06). The shared notebook is where
// those facts live — the helmion tables behind the MCP door's
// helmion_get_context read (src/mcp/server.mjs → the Neon adapter's
// getContext): active blockers, context entries, and the lessons
// resolved blockers carry (helmion.blockers.lesson).
//
// This module is the read half of that door for the channel road.
// agentWork (envoy-mesh.mjs) reads the block ONCE per poll that
// actually hands out work, through this module, and rides it on the
// work item as `notebook`; agentPrompt renders it between the role
// line and the recent conversation; the PC bridge passes it through.
// The Hetzner session executor composes its own prompt copy from the
// work item (box-only code, absent from this repo — Guard trace G2);
// the block rides the work item for it the same way, and picking it
// up there is a box-side follow-up, not part of this bite.
//
// Scoping. The notebook tables predate tenants and are keyed by
// project_slug (sql/001), with NULL meaning the shared rows every
// project read has always included (getContext's exact semantics:
// project_slug = $1 OR project_slug IS NULL). This read keeps those
// semantics with the tenant's own id as the slug: a seat sees its own
// tenant's rows plus the shared rows, and another tenant's rows can
// never appear — the WHERE clause is the whole isolation story, and
// the seam test proves it with two tenants' entries side by side.
// Where a context key exists both as a tenant row and a shared row,
// the tenant row wins.
//
// Bounds follow the session-start-context precedent (the PC seats'
// hook, templates/agent-os/hooks/session-start-context.mjs): at most
// 40 lines per section and 6,000 characters for the whole block, with
// blockers rendered first so truncation starves the last section,
// never the first. One rendered line is capped at 300 characters.
//
// Fail-soft, in both directions. An empty notebook renders NOTHING —
// no header, no empty section — so a tenant without entries gets the
// prompt it has always gotten, byte for byte. A failed read returns
// null the same way and logs loudly server-side: the seat answers
// without the notebook for that poll, and dispatch never fails
// because the notebook could not be read. This module never throws.

export const NOTEBOOK_MAX_LINES_PER_SECTION = 40;
export const NOTEBOOK_MAX_TOTAL_CHARS = 6000;
export const NOTEBOOK_MAX_LINE_CHARS = 300;

const NOTEBOOK_HEADER = "Shared notebook (Helmian's shared memory — facts recorded in the helmion notebook outside this channel):";

// One notebook line: single-line, control-free, capped. A line that
// collapses to nothing is dropped by the caller.
function notebookLine(text) {
  return String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NOTEBOOK_MAX_LINE_CHARS);
}

// context_entries.value is jsonb: a fact may be stored as a plain
// string or as structured JSON. Strings render as themselves; any
// other JSON renders compact, the way the store's own reads hand it
// to the MCP caller.
export function renderNotebookValue(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try { return JSON.stringify(value) ?? ''; } catch { return String(value); }
}

/**
 * Shape notebook rows into the bounded prompt block, or null when
 * there is nothing to say. Pure: the caller supplies rows in the
 * order they should render (blockers severity-first, entries and
 * lessons newest-first — the read below orders them). Sections
 * render blockers first, then context entries, then lessons, and a
 * line is added only while the whole block stays within
 * NOTEBOOK_MAX_TOTAL_CHARS, so an over-long notebook loses its tail,
 * never its blockers.
 */
export function formatNotebookBlock({ blockers = [], entries = [], lessons = [] } = {}) {
  const sections = [];
  const blockerLines = [];
  for (const blocker of blockers ?? []) {
    const description = notebookLine(blocker?.description ?? '');
    if (!description) continue;
    const line = notebookLine(`${blocker?.severity ? `[${blocker.severity}] ` : ''}${description}`);
    if (line) blockerLines.push(`- ${line}`);
    if (blockerLines.length >= NOTEBOOK_MAX_LINES_PER_SECTION) break;
  }
  if (blockerLines.length) sections.push(['Blockers:', blockerLines]);
  const entryLines = [];
  for (const entry of entries ?? []) {
    const key = notebookLine(entry?.key ?? '');
    const value = notebookLine(renderNotebookValue(entry?.value));
    if (key && value) entryLines.push(`- ${key}: ${value}`);
    else if (key) entryLines.push(`- ${key}`);
    if (entryLines.length >= NOTEBOOK_MAX_LINES_PER_SECTION) break;
  }
  if (entryLines.length) sections.push(['Notebook entries:', entryLines]);
  const lessonLines = [];
  for (const lesson of lessons ?? []) {
    const line = notebookLine(typeof lesson === 'string' ? lesson : lesson?.lesson ?? '');
    if (line) lessonLines.push(`- ${line}`);
    if (lessonLines.length >= NOTEBOOK_MAX_LINES_PER_SECTION) break;
  }
  if (lessonLines.length) sections.push(['Lessons:', lessonLines]);
  if (!sections.length) return null;
  let block = NOTEBOOK_HEADER;
  for (const [title, lines] of sections) {
    for (let i = 0; i < lines.length; i += 1) {
      // A section's title is committed only together with its first
      // line, so a starved tail never leaves a bare section heading.
      const extra = (i === 0 ? 1 + title.length : 0) + 1 + lines[i].length;
      if (block.length + extra > NOTEBOOK_MAX_TOTAL_CHARS) return block;
      if (i === 0) block += `\n${title}`;
      block += `\n${lines[i]}`;
    }
  }
  return block;
}

/**
 * Read the tenant's notebook block from the live store at dispatch
 * time. `pool` is the mesh's own pool — deliberately NOT the dispatch
 * transaction's client, so a notebook failure can never poison the
 * transaction that hands out work. Returns the formatted block, or
 * null for an empty notebook or any read failure (logged loudly).
 * Never throws.
 */
export async function readNotebookBlock(pool, tenantId, { log = (...args) => console.error(...args) } = {}) {
  const slug = String(tenantId ?? '');
  if (!slug || !pool || typeof pool.query !== 'function') return null;
  try {
    const [blockers, entries, lessons] = await Promise.all([
      pool.query(
        `select severity, description from helmion.blockers
          where status in ('OPEN','ACTIVE','BLOCKED')
            and (project_slug = $1 or project_slug is null)
          order by case severity when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end, created_at`,
        [slug],
      ),
      pool.query(
        `select project_slug, key, value from helmion.context_entries
          where project_slug = $1 or project_slug is null
          order by (project_slug is null), updated_at desc, key`,
        [slug],
      ),
      pool.query(
        `select lesson from helmion.blockers
          where status = 'RESOLVED' and lesson is not null and nullif(trim(lesson), '') is not null
            and (project_slug = $1 or project_slug is null)
          order by resolved_at desc nulls last, id desc
          limit ${NOTEBOOK_MAX_LINES_PER_SECTION}`,
        [slug],
      ),
    ]);
    // A key filed both under the tenant and in the shared rows is the
    // tenant's fact: the query already sorts tenant rows first, so
    // the first sighting of a key wins and later ones are dropped.
    const seenKeys = new Set();
    const dedupedEntries = [];
    for (const row of entries.rows) {
      const key = String(row?.key ?? '');
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      dedupedEntries.push(row);
    }
    return formatNotebookBlock({ blockers: blockers.rows, entries: dedupedEntries, lessons: lessons.rows });
  } catch (error) {
    log(
      `[envoy-notebook] notebook read FAILED for tenant ${slug}: ${error?.message ?? error} `
      + '— seats answer without the notebook block this poll; dispatch is unchanged.',
    );
    return null;
  }
}
