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
//     is the one row for the name), and the mirrors left over group
//     under one "On <seat>'s own side" section whose head says the
//     mirror note ONCE — they are managed in the vendor's own
//     garden; connecting them there connects nothing here.
//     Resting rows are compact (name, one line, state, one Manage
//     button); a row's working controls live in its expanded state.
//   Skills — the seat's skills, from the EXISTING skills read.
//   Plugins — the workspace's plugins, from the EXISTING plugins
//     read. (No new semantics on either tab in this bite.)
//
// Pure model first (rowControls), then the DOM renderer — the model
// is unit-tested like connector-panel.mjs's.

import { LIBRARY_SEATS } from './connector-panel.mjs';

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

// The Connectors tab's row plan (Troy, 2026-11-09 ~17:36): ONE
// primary row per connector name per seat. A vendor mirror whose
// name a Helmian-brokered entry on the same seat already carries
// does not appear at all — the brokered entry is the row for that
// name (the live page showed two GitHub cards for one seat: the
// brokered connection and its vendor mirror). Mirrors left over
// group under one section whose head carries the mirror note once
// (mirrorNote is a single string for the seat, however many mirror
// rows stand under it). Names compare trimmed and case-insensitively;
// row order otherwise follows the read.
function connectorNameKey(row) {
  return String(row?.name ?? row?.entryId ?? '').trim().toLowerCase();
}

export function planConnectorRows(rows, seatDisplayName = '') {
  const list = Array.isArray(rows) ? rows : [];
  const brokeredNames = new Set(
    list.filter((r) => r && typeof r === 'object' && r.brokerMode !== 'vendor').map(connectorNameKey).filter(Boolean),
  );
  const primary = [];
  const mirrors = [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    if (row.brokerMode === 'vendor') {
      if (!brokeredNames.has(connectorNameKey(row))) mirrors.push(row);
    } else {
      primary.push(row);
    }
  }
  return Object.freeze({
    primary: Object.freeze(primary),
    mirrors: Object.freeze(mirrors),
    mirrorTitle: mirrors.length ? mirrorGroupTitle(seatDisplayName) : null,
    mirrorNote: mirrors.length ? MIRROR_NOTE : null,
  });
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

// The plugins read's shape, normalized for the face (fix B). The
// route answers { plugins, unavailable } — `unavailable` carries
// every plugin that failed to load. The face must say so: the empty
// line stands only when the read is truly empty (no plugins AND
// none unavailable); a list with failures behind it names the count
// instead of reading as "none installed".
export function pluginsListModel(body) {
  const plugins = Array.isArray(body?.plugins) ? body.plugins : (Array.isArray(body?.items) ? body.items : []);
  const unavailableCount = Array.isArray(body?.unavailable) ? body.unavailable.length : 0;
  return Object.freeze({
    plugins: Object.freeze(plugins),
    unavailableCount,
    unavailableLine: pluginsUnavailableLine(unavailableCount),
    emptyLine: !plugins.length && !unavailableCount ? NO_PLUGINS_LINE : null,
  });
}

// ---------------------------------------------------------------------
// The renderer. `api` is app.js's api() (throws on non-2xx with the
// server's error message where present), `el` its element helper.
export function renderConnectorManage(box, { api, el, role = '', initialSeat = null } = {}) {
  const state = { seat: initialSeat, tab: 'connectors', seats: [], rows: [], note: '', busy: false, loaded: false, renderedSeat: null, toolAccess: new Map(), open: new Set() };
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
    const body = await api('/api/admin/connector-library/seats');
    state.seats = Array.isArray(body?.seats) ? body.seats : [];
    if (!state.seat || !state.seats.some((s) => s.seatId === state.seat)) {
      state.seat = state.seats[0]?.seatId ?? null;
    }
    // The settled seat is written down (localStorage, the way the
    // Integrations tab choice is) so it survives re-mounts.
    try { if (state.seat) localStorage.setItem(MANAGE_SEAT_MEMORY_KEY, state.seat); } catch {}
  }

  async function loadRows() {
    if (!state.seat) { state.rows = []; return; }
    const body = await api(`/api/admin/connector-library?seat=${encodeURIComponent(state.seat)}`);
    state.rows = Array.isArray(body?.rows) ? body.rows : [];
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
    const open = state.open.has(row.entryId);
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
      if (open) state.open.delete(row.entryId); else state.open.add(row.entryId);
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
        if (out?.status === 'consent' && out.authorizeUrl) {
          say(`${row.name} opens its sign-in page — approve it there and the connection lands back here.`);
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
        card.append(main);
        frag.append(card);
      }
      if (model.unavailableLine) frag.append(el('p', 'muted sm', model.unavailableLine));
    } catch (error) { frag.append(el('p', 'muted sm', error?.message || 'Plugins did not load.')); }
    return frag;
  }

  async function refresh() {
    if (!state.loaded) root.replaceChildren(note, loadingLine());
    else if (state.renderedSeat && state.seat && state.renderedSeat !== state.seat) {
      // Seat switch (addition, 2026-11-09): the previous seat's cards
      // must not sit on screen while the new seat's read is in flight
      // (the live walk measured a ~2s stale list). Paint the header
      // and the loading line NOW, before the awaits below.
      root.replaceChildren(note, header(), loadingLine());
    }
    try {
      await loadSeats();
      const head = header();
      let body = null;
      if (state.tab === 'connectors') { await loadRows(); body = await connectorsTab(); }
      else if (state.tab === 'skills') body = await skillsTab();
      else body = await pluginsTab();
      state.loaded = true;
      state.renderedSeat = state.seat;
      root.replaceChildren(note, head);
      if (body) root.append(body);
    } catch (error) {
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
