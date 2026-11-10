// The Manage surface (mirror M1, 2026-11-09; mirror-design/DESIGN.md
// §5.4): ONE Helmian surface where a seat's connections are managed —
// the surface every seat panel's "Manage connectors" row lands on,
// opened at that seat's tab. It replaces the dead end Troy hit on the
// live site, where Manage opened the generic Integrations cards that
// manage provider accounts, not the per-seat connector library.
//
// Shape: per-seat tabs across the top; inside a seat, three tabs —
//   Connectors — the seat's library, live from the store's read, with
//     the write controls the entry kind supports wired to the M1
//     write routes: Connect / Disconnect / posture picker / owner
//     turn-off, the Tool access expander (bite M2: the connection's
//     frozen tool snapshot with per-tool switches, wired to the
//     tool-access read + tool-enable write), and the add-custom
//     form. Mirror (vendor-brokered)
//     rows never stand as their own cards in the primary list: a
//     mirror whose name a Helmian-brokered entry on the same seat
//     already carries is hidden behind that entry (the brokered row
//     is the one row for the name — the rule binds brokered entries
//     too: two primary-shaped entries with one name collapse to one
//     row), and the mirrors left over group
//     under one "On <seat>'s own side" section whose head says the
//     mirror note ONCE — they are managed in the vendor's own
//     garden; connecting them there connects nothing here.
//     Resting rows are compact (name, one line, state, one Manage
//     button); a row's working controls live in its expanded state.
//   Skills — the seat's skills, from the EXISTING skills read.
//   Plugins — the workspace's plugins, from the EXISTING plugins
//     read: the installed rows (a Helmian-shelf install carries
//     its Uninstall; a bridge plugin is the bridge's to remove),
//     and under them the Plugin catalog the read's shelf field
//     feeds — every bundle Helmian carries, with Install (or
//     Installed + Uninstall) wired to the EXISTING plugin routes
//     (plugin-catalog bite, 2026-11-09: before the read carried
//     the shelf, the tab could name nothing to install).
//
// Pure model first (rowControls), then the DOM renderer — the model
// is unit-tested like connector-panel.mjs's.

import { LIBRARY_SEATS } from './connector-panel.mjs?v=c967c3b4e6c767e5';

export const MANAGE_SEAT_STORAGE_KEY = 'helmian.manageSeat';
// The Manage road's landing intent (addition, 2026-11-09): taking
// Manage from a seat's menu names the tab it must land on — the
// one-shot sessionStorage marker envoy-workspace leaves beside the
// seat marker, consumed by app.js's loadIntegrations, which selects
// (and thereby persists) the tab. Without it the landing re-applied
// the remembered tab and the Manage surface sat hidden behind
// Agents. And the seat itself is remembered the way the tab choice
// is (localStorage), so the preselected seat survives re-mounts and
// navigation, not only the first landing.
export const MANAGE_TAB_STORAGE_KEY = 'helmian.manageTab';
export const MANAGE_SEAT_MEMORY_KEY = 'helmian.manageSeatMemory';
export const CONNECTOR_POSTURES = Object.freeze(['ask', 'read', 'low-risk', 'all']);
export const POSTURE_LINES = Object.freeze({
  ask: 'Ask me before every use',
  read: 'Reading is fine; ask before changes',
  'low-risk': 'Low-risk work is fine; ask before anything bigger',
  all: 'Use it without asking',
});
// The mirror note, said once per seat — at the head of the mirror
// group, never per card (Troy, 2026-11-09: the same paragraph under
// every card was the sprawl he rejected).
export const MIRROR_NOTE = 'These live in the seat\u2019s own product — Helmian shows what that account reports, and connecting them there does not connect them here.';
export function mirrorGroupTitle(seatDisplayName) {
  return `On ${seatDisplayName}’s own side`;
}
export const TOOL_ANNOTATION_LABELS = Object.freeze({
  read: 'Reads',
  write: 'Changes things',
  undeclared: 'Undeclared — treated as changes',
});
export const NO_SNAPSHOT_LINE = 'No tool list has been frozen for this connection yet — tools appear here after the first discovery.';

export function seatName(seatId) {
  return LIBRARY_SEATS.find((s) => s.seatId === seatId)?.name ?? String(seatId ?? '');
}

// What controls a library row carries on this surface. Owner acts
// (turn-off, remove custom) are offered only to owner/admin roles —
// the write route enforces the same gate server-side.
export function rowControls(row, { role = '' } = {}) {
  const owner = ['owner', 'admin'].includes(String(role).toLowerCase());
  if (!row || typeof row !== 'object') return { mode: 'none' };
  if (row.brokerMode === 'vendor') return { mode: 'mirror' };
  if (row.state === 'disabled-by-owner') return { mode: 'disabled', canEnable: owner };
  if (row.state === 'connected') {
    return {
      mode: 'connected',
      posture: row.stateDetail?.posture ?? 'ask',
      accountIdentity: row.accountIdentity ?? null,
      canDisconnect: true,
      canDisable: owner,
      canRemove: owner && row.kind === 'custom',
      // The Tool access face (bite M2): the per-connection posture +
      // the frozen snapshot's per-tool list. Mirror rows never reach
      // this branch (they return above), so this is Helmian-held
      // state only — the vendor's tools are never shown here.
      canToolAccess: true,
    };
  }
  return {
    mode: 'connect',
    reconnect: row.state === 'needs-reconnect',
    canDisable: owner,
    canRemove: owner && row.kind === 'custom',
  };
}

const STATE_TEXT = Object.freeze({
  connected: 'Connected',
  'not-connected': 'Not connected',
  'needs-reconnect': 'Needs reconnect',
  'disabled-by-owner': 'Turned off by the workspace owner',
});

// The Connectors tab's row plan (Troy, 2026-11-09 ~17:36; dedupe
// finished the same evening, ~18:00): ONE row per connector name
// per seat, across ALL entries. The key is the name alone (trimmed,
// case-insensitive): an entry id encodes which catalog source or
// road an entry came by, not a different connector — keying on it
// would keep the exact duplicate Troy rejected. The survivor for a
// name is chosen in tiers:
//   - A name with any Helmian-brokered entry is represented in the
//     primary list by ONE brokered entry (the rule the simplify
//     pass shipped: a mirror with a brokered namesake never
//     renders). Every other same-name entry — mirror or brokered —
//     is suppressed entirely; it does not drop into the mirror
//     group either. Grok's library carries two primary-shaped
//     GitHub entries (one connected, one not); the mirror-only
//     rule let both stand, and the seat showed two GitHub rows.
//   - A name with only mirrors is represented by ONE mirror in the
//     group, whose head carries the mirror note once (mirrorNote
//     is a single string for the seat, however many mirror rows
//     stand under it).
// Inside a tier, a connected entry beats a not-connected one, then
// the read's own order stands. The surviving row renders with its
// OWN state: a not-connected brokered survivor over a connected
// mirror still reads "Not connected" — the suppressed entry's
// state never lends itself to the row that stands. Row order
// follows each name's first appearance in the read.
function connectorNameKey(row) {
  return String(row?.name ?? row?.entryId ?? '').trim().toLowerCase();
}

// The one row of a same-name group that stands: connected beats
// not-connected; ties keep the read's order (first stands).
function nameSurvivor(group) {
  let best = null;
  for (const row of group) {
    if (!best) { best = row; continue; }
    if (row.state === 'connected' && best.state !== 'connected') best = row;
  }
  return best;
}

export function planConnectorRows(rows, seatDisplayName = '') {
  const list = Array.isArray(rows) ? rows : [];
  const groups = new Map();
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    // A row with no name and no entry id keys on itself, so two
    // nameless rows can never collapse into one another.
    const key = connectorNameKey(row) || row;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const primary = [];
  const mirrors = [];
  for (const group of groups.values()) {
    const brokered = group.filter((r) => r.brokerMode !== 'vendor');
    if (brokered.length) primary.push(nameSurvivor(brokered));
    else mirrors.push(nameSurvivor(group));
  }
  return Object.freeze({
    primary: Object.freeze(primary),
    mirrors: Object.freeze(mirrors),
    mirrorTitle: mirrors.length ? mirrorGroupTitle(seatDisplayName) : null,
    mirrorNote: mirrors.length ? MIRROR_NOTE : null,
  });
}

// Expansion state is keyed per (seat, entry): entry ids repeat
// across seats (every seat's library holds a 'github'), so an
// entryId alone leaks one seat's open row onto the next seat —
// the live walk (2026-11-09 ~18:00) found the GitHub row arriving
// expanded on a seat where it had never been opened. The renderer
// also clears the open set on a seat change, so a seat's rows
// start collapsed however the seat was arrived at.
export function openKeyFor(seatId, entryId) {
  return `${seatId ?? ''}:${entryId ?? ''}`;
}

// The Tool access read's shape, normalized for the face (bite M2).
// The route answers { connected, posture, tools: [{ name,
// description, annotation, effectiveAnnotation, enabled }],
// snapshotTakenAt, snapshotHash } for a connection the caller holds.
// `hasSnapshot` is the honest line the face needs most: no
// connection has a frozen snapshot until a discovery freezes one,
// and the face must say so in words instead of showing an empty
// tool list that looks like "no tools exist".
export function toolAccessRows(body) {
  const tools = (Array.isArray(body?.tools) ? body.tools : [])
    .filter((t) => t && typeof t.name === 'string' && t.name)
    .map((t) => Object.freeze({
      name: t.name,
      description: typeof t.description === 'string' ? t.description : '',
      annotation: TOOL_ANNOTATION_LABELS[t.annotation] ? t.annotation : 'undeclared',
      annotationLabel: TOOL_ANNOTATION_LABELS[t.annotation] ?? TOOL_ANNOTATION_LABELS.undeclared,
      enabled: t.enabled !== false,
    }));
  const posture = CONNECTOR_POSTURES.includes(body?.posture) ? body.posture : null;
  return Object.freeze({
    connected: body?.connected === true,
    posture,
    postureLine: posture ? POSTURE_LINES[posture] : null,
    hasSnapshot: Boolean(body?.snapshotHash) || tools.length > 0,
    snapshotTakenAt: typeof body?.snapshotTakenAt === 'string' ? body.snapshotTakenAt : null,
    tools: Object.freeze(tools),
  });
}

export const NO_PLUGINS_LINE = 'No plugins are installed.';

// The plugins read's failure line (fix B): one wording, shared with
// the plus menu's Plugins group.
export function pluginsUnavailableLine(count) {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return n ? `${n} plugin${n === 1 ? '' : 's'} could not be loaded.` : null;
}

export const PLUGIN_CATALOG_TITLE = 'Plugin catalog';
export const NO_SHELF_LINE = 'The plugin catalog is empty.';

// What a catalog row brings, in the bundle's own names — its
// declared entries and skills, as declarations. No state words:
// a shelf row claims nothing about connections (the installed
// row's brings line, computed server-side, carries those).
function catalogBringsLine(entries, skills) {
  const parts = [];
  for (const e of entries) parts.push(`the ${e.name} tools`);
  if (skills.length) {
    const names = skills.map((s) => s.name).join(', ');
    parts.push(`the ${names} skill${skills.length === 1 ? '' : 's'}`);
  }
  return parts.length ? `Brings ${parts.join(', plus ')}.` : null;
}

// The plugins read's shape, normalized for the face (fix B). The
// route answers { plugins, unavailable, shelf } — `unavailable`
// carries every plugin that failed to load. The face must say so:
// the empty line stands only when the read is truly empty (no
// plugins AND none unavailable); a list with failures behind it
// names the count instead of reading as "none installed".
// `shelf` is the catalog: every bundle Helmian carries, normalized
// here and joined against the plugins rows — a shelf row is
// installed exactly when a plugins row with source
// 'helmian-plugin' carries the same name (case-insensitive: the
// install record's name is the manifest's, lowercased server-side).
// A bridge row of the same name is NOT an install of the bundle —
// the bridge's list is the bridge's own truth.
export function pluginsListModel(body) {
  const plugins = Array.isArray(body?.plugins) ? body.plugins : (Array.isArray(body?.items) ? body.items : []);
  const unavailableCount = Array.isArray(body?.unavailable) ? body.unavailable.length : 0;
  const installedNames = new Set(
    plugins
      .filter((p) => p && typeof p === 'object' && p.source === 'helmian-plugin' && typeof p.name === 'string')
      .map((p) => p.name.trim().toLowerCase()),
  );
  const rawShelf = Array.isArray(body?.shelf) ? body.shelf : [];
  const catalog = rawShelf
    .filter((s) => s && typeof s === 'object' && typeof s.name === 'string' && s.name.trim())
    .map((s) => {
      const entries = (Array.isArray(s.entries) ? s.entries : [])
        .filter((e) => e && typeof e === 'object')
        .map((e) => Object.freeze({
          entryId: String(e.entryId ?? ''),
          name: String(e.name ?? e.entryId ?? ''),
        }));
      const skills = (Array.isArray(s.skills) ? s.skills : [])
        .filter((sk) => sk && typeof sk === 'object')
        .map((sk) => Object.freeze({
          id: String(sk.id ?? ''),
          name: String(sk.name ?? sk.id ?? ''),
          description: typeof sk.description === 'string' ? sk.description : '',
        }));
      return Object.freeze({
        name: s.name,
        version: typeof s.version === 'string' ? s.version : null,
        description: typeof s.description === 'string' ? s.description : '',
        entries: Object.freeze(entries),
        skills: Object.freeze(skills),
        brings: catalogBringsLine(entries, skills),
        installed: installedNames.has(s.name.trim().toLowerCase()),
      });
    });
  return Object.freeze({
    plugins: Object.freeze(plugins),
    catalog: Object.freeze(catalog),
    unavailableCount,
    unavailableLine: pluginsUnavailableLine(unavailableCount),
    emptyLine: !plugins.length && !unavailableCount ? NO_PLUGINS_LINE : null,
  });
}

// ---------------------------------------------------------------------
// The renderer. `api` is app.js's api() (throws on non-2xx with the
// server's error message where present), `el` its element helper.
export function renderConnectorManage(box, { api, el, role = '', initialSeat = null, loadRetryDelays = [350, 900] } = {}) {
  const state = { seat: initialSeat, tab: 'connectors', seats: [], rows: [], note: '', busy: false, loaded: false, renderedSeat: null, toolAccess: new Map(), open: new Set(), seatsLoaded: false, seatsStale: false };
  // Refresh order guard (P2 fix, 2026-11-09): refresh() passes are
  // numbered as they START, and a pass paints only while it is
  // still the newest. Without this, a pass whose reads were issued
  // before a write landed (the mount pass, a tab click) could
  // finish AFTER the post-write pass and repaint its stale read
  // over the fresh one — the fresh-signup walk saw exactly that on
  // the Plugins tab: "…is installed." over "No plugins are
  // installed.", cured only by a reload. The stale pass's reads
  // still run; only its paint (and its failure paint) is dropped.
  let refreshSeq = 0;
  // First-load retries spent (2026-11-10): a failed FIRST load is
  // retried a bounded number of times before the failure paints —
  // see the catch in refresh(). Reset whenever a load lands.
  let loadAttempts = 0;
  box.replaceChildren();
  const root = el('div', 'cm-root');
  const note = el('p', 'cm-note muted sm');
  note.hidden = true;
  root.append(note);
  box.append(root);
  // A loading state paints synchronously, before the first read: on
  // the 2026-11-09 live exercise the surface's first landings showed
  // a false empty state (no seat tabs, nothing apparently connected)
  // until a detour away and back let the reads land. The genuine
  // empty states below may render only once `loaded` says the reads
  // are in — before that, this line is the whole surface.
  const loadingLine = () => el('p', 'cm-loading muted sm', 'Loading connectors…');
  root.append(loadingLine());

  const say = (text, isError = false) => {
    note.textContent = text ?? '';
    note.hidden = !text;
    note.classList.toggle('cm-error', Boolean(isError));
  };
  const call = async (path, body) => {
    const out = await api(path, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return out;
  };

  async function loadSeats() {
    // The seat list is fetched once per surface, not once per
    // refresh (2026-11-09 perf bite): refresh() runs on every seat
    // switch, tab switch, and write, and the seats read is the
    // surface's most expensive call — re-asking it on every switch
    // made each switch pay the whole tenant's counts again (~20s
    // live). Seat membership cannot change under a read, a connect,
    // or a posture change; it changes only when an entry is REMOVED
    // (a seat can empty), whose handler marks the list stale. A
    // fresh mount (every Integrations landing builds one) always
    // fetches afresh.
    if (state.seatsLoaded && !state.seatsStale) return;
    const body = await api('/api/admin/connector-library/seats');
    state.seats = Array.isArray(body?.seats) ? body.seats : [];
    state.seatsLoaded = true;
    state.seatsStale = false;
    if (!state.seat || !state.seats.some((s) => s.seatId === state.seat)) {
      state.seat = state.seats[0]?.seatId ?? null;
    }
    // The settled seat is written down (localStorage, the way the
    // Integrations tab choice is) so it survives re-mounts.
    try { if (state.seat) localStorage.setItem(MANAGE_SEAT_MEMORY_KEY, state.seat); } catch {}
  }

  async function loadRows() {
    const seat = state.seat;
    if (!seat) { state.rows = []; return; }
    const body = await api(`/api/admin/connector-library?seat=${encodeURIComponent(seat)}`);
    // A read that lands after the seat moved on is stale by
    // construction — a newer read owns the rows now. The parallel
    // mount below can have two rows reads in flight on the stale-
    // marker edge; this guard is what keeps the loser's late answer
    // from painting over the settled seat's list.
    if (state.seat !== seat) return;
    state.rows = Array.isArray(body?.rows) ? body.rows : [];
  }

  // The rows read, started early and carried as a flight (speed
  // fix 1, 2026-11-09): refresh() fires it BESIDE the seats read —
  // the two are independent and each costs ~1 s on its own, so
  // awaiting them one after the other doubled the wait on every
  // mount. The flight never rejects: it settles to { ok } or
  // { error } and refresh() decides what the failure means.
  function startRowsFlight() {
    const seat = state.seat;
    const settled = loadRows().then(() => ({ ok: true }), (error) => ({ ok: false, error }));
    return { seat, settled };
  }

  function header() {
    const wrap = el('div', 'cm-head');
    const seatTabs = el('div', 'cm-seat-tabs');
    for (const seat of state.seats) {
      const b = el('button', `cm-seat-tab${seat.seatId === state.seat ? ' on' : ''}`, seatName(seat.seatId));
      b.type = 'button';
      b.addEventListener('click', async () => { state.seat = seat.seatId; state.tab = 'connectors'; say(''); await refresh(); });
      seatTabs.append(b);
    }
    wrap.append(seatTabs);
    const tabs = el('div', 'cm-tabs');
    for (const [id, label] of [['connectors', 'Connectors'], ['skills', 'Skills'], ['plugins', 'Plugins']]) {
      const b = el('button', `cm-tab${state.tab === id ? ' on' : ''}`, label);
      b.type = 'button';
      b.addEventListener('click', async () => { state.tab = id; say(''); await refresh(); });
      tabs.append(b);
    }
    wrap.append(tabs);
    return wrap;
  }

  // A primary row (simplify pass, 2026-11-09): the resting row is
  // compact like the Agents tab cards — name, one descriptor line,
  // state words, ONE button (Manage, which toggles the row's
  // expanded state shut again, the R2 pattern). Everything that
  // works — the account line, the posture picker, Disconnect, Turn
  // off for everyone, Remove, the Tool access expander — lives in
  // the expanded state, not sprawled across the resting card.
  function connectorRow(row) {
    const ctl = rowControls(row, { role });
    if (ctl.mode === 'mirror') return mirrorRow(row);
    const openKey = openKeyFor(state.seat, row.entryId);
    const open = state.open.has(openKey);
    const card = el('article', 'cm-row cm-connector');
    const head = el('div', 'cm-row-head');
    const main = el('div', 'cm-row-main');
    main.append(el('div', 'cm-row-name', row.name ?? row.entryId));
    if (row.oneLiner) main.append(el('div', 'cm-row-line muted sm', row.oneLiner));
    head.append(main);
    head.append(el('span', `cm-state ${row.state}`, STATE_TEXT[row.state] ?? row.state));
    const toggle = el('button', 'btn sm ghost', 'Manage');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.addEventListener('click', () => {
      if (open) state.open.delete(openKey); else state.open.add(openKey);
      refresh();
    });
    head.append(toggle);
    card.append(head);
    if (!open) return card;
    const body = el('div', 'cm-row-open');
    const meta = [row.vendorLabel, row.trustLabel ? `${row.trustLabel} connector` : null].filter(Boolean).join(' · ');
    if (meta) body.append(el('div', 'cm-row-meta muted sm', meta));
    const side = el('div', 'cm-row-side');
    if (ctl.mode === 'disabled') {
      side.append(el('span', 'muted sm', 'Nobody in this workspace can connect it while it is off.'));
      if (ctl.canEnable) side.append(actionButton('Turn back on', async () => {
        await call('/api/admin/connector-library/entry-state', { seatId: state.seat, entryId: row.entryId, state: 'available' });
        say(`${row.name} is available again.`); await refresh();
      }));
    }
    if (ctl.mode === 'connected') {
      if (ctl.accountIdentity) side.append(el('span', 'muted sm', ctl.accountIdentity));
      const picker = el('label', 'cm-posture');
      picker.append(el('span', 'muted sm', 'When a message arms it:'));
      const select = el('select', 'cm-posture-select');
      for (const p of CONNECTOR_POSTURES) {
        const opt = el('option', null, POSTURE_LINES[p]);
        opt.value = p;
        if (p === ctl.posture) opt.selected = true;
        select.append(opt);
      }
      select.addEventListener('change', async () => {
        await call('/api/admin/connector-library/posture', { seatId: state.seat, entryId: row.entryId, posture: select.value });
        say(`${row.name}: ${POSTURE_LINES[select.value]}.`);
        await refresh();
      });
      picker.append(select);
      side.append(picker);
      side.append(actionButton('Disconnect', async () => {
        const out = await call('/api/admin/connector-library/disconnect', { seatId: state.seat, entryId: row.entryId });
        say(out?.custodyRevoked ? `${row.name} is disconnected and its stored sign-in was revoked.` : `${row.name} is disconnected.`);
        await refresh();
      }));
    }
    if (ctl.mode === 'connect') {
      side.append(actionButton(ctl.reconnect ? 'Reconnect' : 'Connect', async (btn) => {
        const out = await call('/api/admin/connector-library/connect', { seatId: state.seat, entryId: row.entryId });
        if (out?.status === 'connected') { say(`${row.name} is connected.`); await refresh(); return; }
        if (out?.status === 'authorize' && out.authorizeUrl) {
          // The connect-start answered with the service's own
          // sign-in door (every OAuth road): hand the person the
          // door. The start also composed an approval briefing —
          // the service's name for what approving grants — which is
          // the words to say; the plain sentence stands when a road
          // returns no briefing. (The branch this replaces waited
          // for a 'consent' status no road ever returns, so the
          // authorize answer fell through to the bare status line —
          // "Atlassian: authorize." — and the door was never shown.)
          say(out.briefing?.summary || `${row.name} opens its sign-in page — approve it there and the connection lands back here.`);
          window.location.assign(out.authorizeUrl);
          return;
        }
        if (out?.status === 'consent-boundary') {
          say(out.note || 'This sign-in cannot be completed inside Helmian yet.', true);
          return;
        }
        if (out?.status === 'needs-credential') {
          showKeyForm(body, row, out);
          btn.disabled = true;
          return;
        }
        say(`${row.name}: ${out?.status ?? 'connect started'}.`);
      }));
    }
    if (ctl.canDisable) {
      side.append(actionButton('Turn off for everyone', async () => {
        await call('/api/admin/connector-library/entry-state', { seatId: state.seat, entryId: row.entryId, state: 'disabled-by-owner' });
        say(`${row.name} is turned off for the whole workspace.`);
        await refresh();
      }, 'ghost'));
    }
    if (ctl.canRemove) {
      side.append(actionButton('Remove', async () => {
        await call('/api/admin/connector-library/entries/remove', { seatId: state.seat, entryId: row.entryId });
        say(`${row.name} was removed from this seat\u2019s library.`);
        // Removing an entry is the one act that can change seat
        // membership (this seat may have just emptied) — the cached
        // seat list is stale now and the refresh must re-ask.
        state.seatsStale = true;
        await refresh();
      }, 'ghost'));
    }
    body.append(side);
    card.append(body);
    if (ctl.canToolAccess) card.append(toolAccessSection(row));
    return card;
  }

  // A mirror row inside the group: compact and view-only — name,
  // one line, state words. No controls, and NO note: the group's
  // head says the note once for the whole seat.
  function mirrorRow(row) {
    const card = el('article', 'cm-row cm-mirror-row');
    const main = el('div', 'cm-row-main');
    main.append(el('div', 'cm-row-name', row.name ?? row.entryId));
    if (row.oneLiner) main.append(el('div', 'cm-row-line muted sm', row.oneLiner));
    card.append(main);
    card.append(el('span', `cm-state ${row.state}`, STATE_TEXT[row.state] ?? row.state));
    return card;
  }

  // The mirror group: one section per seat, the note once at its
  // head, the leftover mirror rows compact under it.
  function mirrorGroup(plan) {
    const wrap = el('section', 'cm-mirror-group');
    wrap.append(el('h4', 'cm-mirror-title', plan.mirrorTitle));
    wrap.append(el('p', 'cm-mirror-note muted sm', plan.mirrorNote));
    for (const row of plan.mirrors) wrap.append(mirrorRow(row));
    return wrap;
  }

  // The Tool access expander (bite M2): the connection's posture in
  // words, then the frozen snapshot's tool list — each tool with
  // what it does (Reads / Changes things / Undeclared), and a switch
  // that writes the per-tool enable map through the tool-enable
  // route. The read is lazy (first expand), cached per seat+entry
  // for the surface's life, and honest about the common case: no
  // snapshot has been frozen yet, so there is no tool list to show.
  // Turn-time enforcement of posture + this map is M3's leg; this
  // face only reads and writes the stored state.
  function toolAccessSection(row) {
    const key = `${state.seat}:${row.entryId}`;
    let rec = state.toolAccess.get(key);
    if (!rec) { rec = { open: false, loading: false, body: null, error: '' }; state.toolAccess.set(key, rec); }
    const wrap = el('section', 'cm-tools');
    const toggle = el('button', 'btn sm ghost', rec.open ? 'Hide tool access' : 'Tool access');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(rec.open));
    toggle.addEventListener('click', async () => {
      rec.open = !rec.open;
      if (rec.open && !rec.body && !rec.loading) {
        rec.loading = true; rec.error = '';
        try {
          rec.body = await api(`/api/admin/connector-library/tool-access?seat=${encodeURIComponent(state.seat)}&entry=${encodeURIComponent(row.entryId)}`);
        } catch (error) { rec.error = error?.message || 'Tool access did not load.'; }
        rec.loading = false;
      }
      await refresh();
    });
    wrap.append(toggle);
    if (!rec.open) return wrap;
    if (rec.loading) { wrap.append(el('p', 'muted sm', 'Loading tools…')); return wrap; }
    if (rec.error) { wrap.append(el('p', 'muted sm', rec.error)); return wrap; }
    if (!rec.body) return wrap;
    const view = toolAccessRows(rec.body);
    if (view.postureLine) wrap.append(el('p', 'sm cm-tool-posture', `When a message arms it: ${view.postureLine}`));
    if (!view.hasSnapshot) { wrap.append(el('p', 'muted sm', NO_SNAPSHOT_LINE)); return wrap; }
    if (view.snapshotTakenAt) wrap.append(el('p', 'muted sm', `Tool list frozen at ${view.snapshotTakenAt}`));
    for (const tool of view.tools) {
      const line = el('div', 'cm-tool');
      const text = el('div', 'cm-tool-main');
      text.append(el('div', 'cm-tool-name', tool.name));
      if (tool.description) text.append(el('div', 'muted sm', tool.description));
      text.append(el('div', 'muted sm cm-tool-anno', tool.annotationLabel));
      line.append(text);
      const sw = el('label', 'cm-tool-switch');
      const input = el('input');
      input.type = 'checkbox';
      input.checked = tool.enabled;
      input.setAttribute('aria-label', `Allow ${tool.name}`);
      input.addEventListener('change', async () => {
        input.disabled = true;
        try {
          await call('/api/admin/connector-library/tool-enable', { seatId: state.seat, entryId: row.entryId, toolEnableMap: { [tool.name]: input.checked } });
          const raw = (Array.isArray(rec.body?.tools) ? rec.body.tools : []).find((t) => t?.name === tool.name);
          if (raw) raw.enabled = input.checked;
          say(`${row.name}: the ${tool.name} tool is ${input.checked ? 'on' : 'off'}.`);
        } catch (error) {
          input.checked = !input.checked;
          say(error?.message || 'That tool switch did not go through.', true);
        }
        input.disabled = false;
      });
      sw.append(input, el('span', 'sm', tool.enabled ? 'On' : 'Off'));
      line.append(sw);
      wrap.append(line);
    }
    return wrap;
  }

  function actionButton(label, fn, kind = '') {
    const b = el('button', `btn sm ${kind}`.trim(), label);
    b.type = 'button';
    b.addEventListener('click', async () => {
      if (state.busy) return;
      state.busy = true; b.disabled = true;
      try { await fn(b); } catch (error) { say(error?.message || 'that did not go through', true); }
      state.busy = false; b.disabled = false;
    });
    return b;
  }

  function showKeyForm(box, row, connectOut) {
    const form = el('div', 'cm-key-form');
    form.append(el('p', 'sm', `${row.name} takes an API key or header token. Paste it here — it goes straight into Helmian\u2019s credential storage, and this list keeps only a reference to it.`));
    const input = el('input', 'cm-key-input');
    input.type = 'password';
    input.placeholder = 'Paste the key';
    input.autocomplete = 'off';
    const label = el('input', 'cm-key-label');
    label.type = 'text';
    label.placeholder = 'A name for this key (optional)';
    const go = actionButton('Store the key and connect', async () => {
      if (!input.value) { say('Paste the key first.', true); return; }
      await call('/api/admin/connector-library/connect/header', {
        seatId: state.seat, entryId: row.entryId, apiKey: input.value, accountLabel: label.value || undefined,
      });
      input.value = '';
      say(`${row.name} is connected.`);
      await refresh();
    });
    form.append(input, label, go);
    box.append(form);
  }

  function addCustomForm() {
    const wrap = el('section', 'cm-add');
    wrap.append(el('h4', 'cm-add-head', 'Add a custom connector'));
    wrap.append(el('p', 'muted sm', 'Your own MCP server, added to this seat\u2019s library. It is labelled “custom” everywhere it shows.'));
    const name = el('input', 'cm-add-input'); name.placeholder = 'Name'; name.type = 'text';
    const url = el('input', 'cm-add-input'); url.placeholder = 'MCP address (https://…)'; url.type = 'url';
    const oneLiner = el('input', 'cm-add-input'); oneLiner.placeholder = 'One line about what it does (optional)'; oneLiner.type = 'text';
    const auth = el('select', 'cm-add-input');
    for (const [value, text] of [['none', 'No sign-in'], ['header', 'API key / header token'], ['oauth', 'OAuth sign-in']]) {
      const opt = el('option', null, text); opt.value = value; auth.append(opt);
    }
    const go = actionButton('Add it', async () => {
      if (!name.value.trim() || !url.value.trim()) { say('A custom connector needs a name and its MCP address.', true); return; }
      await call('/api/admin/connector-library/entries', {
        seatId: state.seat, name: name.value.trim(), mcpEndpointUrl: url.value.trim(),
        oneLiner: oneLiner.value.trim() || undefined, authMode: auth.value,
      });
      say(`${name.value.trim()} was added to ${seatName(state.seat)}\u2019s library.`);
      await refresh();
    });
    wrap.append(name, url, oneLiner, auth, go);
    return wrap;
  }

  async function connectorsTab() {
    const frag = el('div', 'cm-list');
    if (!state.seats.length) frag.append(el('p', 'muted sm', 'No seat in this workspace holds a connector library yet.'));
    const plan = planConnectorRows(state.rows, seatName(state.seat));
    for (const row of plan.primary) frag.append(connectorRow(row));
    if (!state.rows.length && state.seats.length) frag.append(el('p', 'muted sm', 'This seat\u2019s library is empty.'));
    if (plan.mirrors.length) frag.append(mirrorGroup(plan));
    if (['owner', 'admin'].includes(String(role).toLowerCase()) && state.seat) frag.append(addCustomForm());
    return frag;
  }

  async function skillsTab() {
    const frag = el('div', 'cm-list');
    try {
      const body = await api('/api/admin/skills');
      const skills = (Array.isArray(body?.skills) ? body.skills : []).filter((s) => !s.seatId || s.seatId === state.seat);
      if (!skills.length) frag.append(el('p', 'muted sm', 'No skills are on this seat\u2019s shelf. Skills are written and edited from the “/” menu in a channel.'));
      for (const s of skills) {
        const card = el('article', 'cm-row');
        const main = el('div', 'cm-row-main');
        main.append(el('div', 'cm-row-name', s.name ?? s.id));
        if (s.description) main.append(el('div', 'cm-row-line muted sm', s.description));
        card.append(main);
        frag.append(card);
      }
    } catch (error) { frag.append(el('p', 'muted sm', error?.message || 'Skills did not load.')); }
    return frag;
  }

  // The Plugin catalog section (plugin-catalog bite, 2026-11-09):
  // every bundle on the shelf, from the read's shelf field — the
  // install road that lives on THIS tab, not behind the composer
  // panel's race. Buttons ride the surface's call() helper to the
  // EXISTING plugin routes with the route's own body shape, and a
  // landed write refreshes the read so the row moves lists.
  function pluginCatalogSection(model) {
    const wrap = el('section', 'cm-catalog');
    wrap.append(el('h4', 'cm-add-head', PLUGIN_CATALOG_TITLE));
    if (!model.catalog.length) {
      wrap.append(el('p', 'muted sm', NO_SHELF_LINE));
      return wrap;
    }
    for (const row of model.catalog) {
      const card = el('article', 'cm-row');
      const main = el('div', 'cm-row-main');
      main.append(el('div', 'cm-row-name', row.name));
      if (row.description) main.append(el('div', 'cm-row-line muted sm', row.description));
      if (row.brings) main.append(el('div', 'cm-row-line muted sm', row.brings));
      card.append(main);
      const side = el('div', 'cm-row-side');
      if (row.installed) {
        side.append(el('span', 'muted sm', 'Installed'));
        side.append(actionButton('Uninstall', async () => {
          await call('/api/admin/plugins/uninstall', { name: row.name });
          say(`${row.name} was uninstalled.`);
          await refresh();
        }));
      } else {
        side.append(actionButton('Install', async () => {
          await call('/api/admin/plugins/install', { name: row.name });
          say(`${row.name} is installed.`);
          await refresh();
        }));
      }
      card.append(side);
      wrap.append(card);
    }
    return wrap;
  }

  async function pluginsTab() {
    const frag = el('div', 'cm-list');
    try {
      const body = await api('/api/admin/plugins');
      const model = pluginsListModel(body);
      if (model.emptyLine) frag.append(el('p', 'muted sm', model.emptyLine));
      for (const p of model.plugins) {
        const card = el('article', 'cm-row');
        const main = el('div', 'cm-row-main');
        main.append(el('div', 'cm-row-name', p.name ?? p.id ?? 'Plugin'));
        if (p.description) main.append(el('div', 'cm-row-line muted sm', p.description));
        if (p.brings) main.append(el('div', 'cm-row-line muted sm', p.brings));
        card.append(main);
        // Uninstall belongs only to Helmian-shelf installs: the
        // route's authority is the cloud install record, and it
        // would honestly 404 for a bridge plugin — the bridge's
        // plugins are the bridge's to remove, so they get no
        // button here.
        if (p.source === 'helmian-plugin' && p.name) {
          const side = el('div', 'cm-row-side');
          side.append(actionButton('Uninstall', async () => {
            await call('/api/admin/plugins/uninstall', { name: p.name });
            say(`${p.name} was uninstalled.`);
            await refresh();
          }));
          card.append(side);
        }
        frag.append(card);
      }
      if (model.unavailableLine) frag.append(el('p', 'muted sm', model.unavailableLine));
      frag.append(pluginCatalogSection(model));
    } catch (error) { frag.append(el('p', 'muted sm', error?.message || 'Plugins did not load.')); }
    return frag;
  }

  async function refresh() {
    const myRefresh = ++refreshSeq;
    const seatChanged = Boolean(state.loaded && state.renderedSeat && state.seat && state.renderedSeat !== state.seat);
    if (!state.loaded) root.replaceChildren(note, loadingLine());
    else if (seatChanged) {
      // Seat switch (addition, 2026-11-09): the previous seat's cards
      // must not sit on screen while the new seat's read is in flight
      // (the live walk measured a ~2s stale list). Paint the header
      // and the loading line NOW, before the awaits below.
      // Expansion resets on the same beat (dedupe finish, ~18:00):
      // the open set clears, so the incoming seat's rows start
      // collapsed — and the per-(seat, entry) keys (openKeyFor)
      // keep one seat's open rows from ever rendering on another.
      state.open.clear();
      root.replaceChildren(note, header(), loadingLine());
    }
    // Parallel reads (speed fix 1, 2026-11-09): on the Connectors
    // tab the rows read fires NOW, beside the seats read — the
    // seat is already known client-side (the landing marker or the
    // remembered seat) before either answer lands, so neither read
    // waits on the other. On a seat switch the seats read is the
    // cached list inside loadSeats (a no-op), so the switch fires
    // exactly this one read; a post-action refresh likewise. If
    // the seats read settles a DIFFERENT seat (a stale marker
    // names a seat that no longer stands), the branch below
    // re-reads for the settled seat, and the early flight's late
    // answer is discarded by loadRows' own seat guard.
    const rowsFlight = state.tab === 'connectors' && state.seat ? startRowsFlight() : null;
    try {
      await loadSeats();
      // Mount and seat-change renders (dedupe finish, 2026-11-09
      // ~18:00): once the seats are known, paint the header with
      // the loading line BEFORE the tab's reads land, so a first
      // list render is always the current seat's own — on the
      // menu→Manage landing the previous seat's list showed for a
      // beat because the mount path never painted early.
      if ((!state.loaded || seatChanged) && myRefresh === refreshSeq) root.replaceChildren(note, header(), loadingLine());
      const head = header();
      let body = null;
      if (state.tab === 'connectors') {
        if (rowsFlight && rowsFlight.seat === state.seat) {
          const landed = await rowsFlight.settled;
          if (!landed.ok) throw landed.error;
        } else await loadRows();
        body = await connectorsTab();
      }
      else if (state.tab === 'skills') body = await skillsTab();
      else body = await pluginsTab();
      // A newer refresh started while this pass read: its reads
      // are the fresher ones, so this pass never paints (P2 fix).
      if (myRefresh !== refreshSeq) return;
      loadAttempts = 0;
      state.loaded = true;
      state.renderedSeat = state.seat;
      root.replaceChildren(note, head);
      if (body) root.append(body);
    } catch (error) {
      // A superseded pass fails quietly: the newer pass owns the
      // surface and will paint (or report) its own outcome.
      if (myRefresh !== refreshSeq) return;
      // First-load retry (2026-11-10): a single failed load used to
      // paint the terminal "did not load" error and stop, and the
      // owner walk hit exactly that — one transient failure of the
      // library read left the Connectors tab on a red
      // membership-required line until a full view re-entry. While
      // the surface has never loaded, retry the load a bounded
      // number of times first (the loading line stays up; no error
      // paints). Post-load refreshes keep the long-standing
      // behaviour: their failures report through say() below and
      // never wipe the rendered surface.
      if (!state.loaded && loadAttempts < loadRetryDelays.length) {
        const delay = loadRetryDelays[loadAttempts];
        loadAttempts += 1;
        await new Promise((resolve) => setTimeout(resolve, delay));
        // A newer pass started during the wait owns the surface now.
        if (myRefresh !== refreshSeq) return;
        return refresh();
      }
      if (!state.loaded) {
        root.replaceChildren(note, el('p', 'cm-loading muted sm', 'The connector library did not load — leave this view and come back to try again.'));
      }
      say(error?.message || 'The connector library did not load.', true);
    }
  }

  return { refresh, state };
}

// app.js entry point: builds the surface into the box and loads it.
// The seat marker the composer panel's Manage row leaves behind
// (sessionStorage) picks the opening tab's seat, once; with no fresh
// marker, the remembered seat (localStorage, written by the surface
// itself whenever a seat settles) picks it instead, so the seat
// survives navigation and re-mounts the way the tab choice does.
export async function mountConnectorManage(box, { api, el, role = '' } = {}) {
  let initialSeat = null;
  try {
    initialSeat = sessionStorage.getItem(MANAGE_SEAT_STORAGE_KEY);
    if (initialSeat) sessionStorage.removeItem(MANAGE_SEAT_STORAGE_KEY);
    if (!initialSeat) initialSeat = localStorage.getItem(MANAGE_SEAT_MEMORY_KEY);
  } catch { initialSeat = null; }
  const surface = renderConnectorManage(box, { api, el, role, initialSeat });
  await surface.refresh();
  return surface;
}
