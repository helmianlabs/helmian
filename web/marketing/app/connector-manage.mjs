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
//     turn-off, and the add-custom form. Mirror (vendor-brokered)
//     rows stay view-only with one plain line: they are managed in
//     the vendor's own garden; connecting them there does not
//     connect them here.
//   Skills — the seat's skills, from the EXISTING skills read.
//   Plugins — the workspace's plugins, from the EXISTING plugins
//     read. (No new semantics on either tab in this bite.)
//
// Pure model first (rowControls), then the DOM renderer — the model
// is unit-tested like connector-panel.mjs's.

import { LIBRARY_SEATS } from './connector-panel.mjs';

export const MANAGE_SEAT_STORAGE_KEY = 'helmian.manageSeat';
export const CONNECTOR_POSTURES = Object.freeze(['ask', 'read', 'low-risk', 'all']);
export const POSTURE_LINES = Object.freeze({
  ask: 'Ask me before every use',
  read: 'Reading is fine; ask before changes',
  'low-risk': 'Low-risk work is fine; ask before anything bigger',
  all: 'Use it without asking',
});
export const MIRROR_LINE = 'This connector lives in the vendor\u2019s own product — Helmian only mirrors what that account reports. It is managed there, and connecting it there does not connect it here.';

export function seatName(seatId) {
  return LIBRARY_SEATS.find((s) => s.seatId === seatId)?.name ?? String(seatId ?? '');
}

// What controls a library row carries on this surface. Owner acts
// (turn-off, remove custom) are offered only to owner/admin roles —
// the write route enforces the same gate server-side.
export function rowControls(row, { role = '' } = {}) {
  const owner = ['owner', 'admin'].includes(String(role).toLowerCase());
  if (!row || typeof row !== 'object') return { mode: 'none' };
  if (row.brokerMode === 'vendor') return { mode: 'mirror', note: MIRROR_LINE };
  if (row.state === 'disabled-by-owner') return { mode: 'disabled', canEnable: owner };
  if (row.state === 'connected') {
    return {
      mode: 'connected',
      posture: row.stateDetail?.posture ?? 'ask',
      accountIdentity: row.accountIdentity ?? null,
      canDisconnect: true,
      canDisable: owner,
      canRemove: owner && row.kind === 'custom',
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

// ---------------------------------------------------------------------
// The renderer. `api` is app.js's api() (throws on non-2xx with the
// server's error message where present), `el` its element helper.
export function renderConnectorManage(box, { api, el, role = '', initialSeat = null } = {}) {
  const state = { seat: initialSeat, tab: 'connectors', seats: [], rows: [], note: '', busy: false };
  box.replaceChildren();
  const root = el('div', 'cm-root');
  const note = el('p', 'cm-note muted sm');
  note.hidden = true;
  root.append(note);
  box.append(root);

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

  function connectorRow(row) {
    const ctl = rowControls(row, { role });
    const card = el('article', 'cm-row');
    const main = el('div', 'cm-row-main');
    main.append(el('div', 'cm-row-name', row.name ?? row.entryId));
    if (row.oneLiner) main.append(el('div', 'cm-row-line muted sm', row.oneLiner));
    const meta = [row.vendorLabel, row.trustLabel ? `${row.trustLabel} connector` : null].filter(Boolean).join(' · ');
    if (meta) main.append(el('div', 'cm-row-meta muted sm', meta));
    card.append(main);
    const side = el('div', 'cm-row-side');
    side.append(el('span', `cm-state ${row.state}`, STATE_TEXT[row.state] ?? row.state));
    if (ctl.mode === 'mirror') {
      card.append(el('p', 'cm-mirror-note muted sm', ctl.note));
      return card;
    }
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
          showKeyForm(card, row, out);
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
    card.append(side);
    return card;
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

  function showKeyForm(card, row, connectOut) {
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
    card.append(form);
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
    for (const row of state.rows) frag.append(connectorRow(row));
    if (!state.rows.length && state.seats.length) frag.append(el('p', 'muted sm', 'This seat\u2019s library is empty.'));
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
      const plugins = Array.isArray(body?.plugins) ? body.plugins : (Array.isArray(body?.items) ? body.items : []);
      if (!plugins.length) frag.append(el('p', 'muted sm', 'No plugins are installed in this workspace.'));
      for (const p of plugins) {
        const card = el('article', 'cm-row');
        const main = el('div', 'cm-row-main');
        main.append(el('div', 'cm-row-name', p.name ?? p.id ?? 'Plugin'));
        if (p.description) main.append(el('div', 'cm-row-line muted sm', p.description));
        card.append(main);
        frag.append(card);
      }
    } catch (error) { frag.append(el('p', 'muted sm', error?.message || 'Plugins did not load.')); }
    return frag;
  }

  async function refresh() {
    try {
      await loadSeats();
      const head = header();
      root.replaceChildren(note, head);
      if (state.tab === 'connectors') { await loadRows(); root.append(await connectorsTab()); }
      else if (state.tab === 'skills') root.append(await skillsTab());
      else root.append(await pluginsTab());
    } catch (error) {
      say(error?.message || 'The connector library did not load.', true);
    }
  }

  return { refresh, state };
}

// app.js entry point: builds the surface into the box and loads it.
// The seat marker the composer panel's Manage row leaves behind
// (sessionStorage) picks the opening tab's seat, once.
export async function mountConnectorManage(box, { api, el, role = '' } = {}) {
  let initialSeat = null;
  try {
    initialSeat = sessionStorage.getItem(MANAGE_SEAT_STORAGE_KEY);
    if (initialSeat) sessionStorage.removeItem(MANAGE_SEAT_STORAGE_KEY);
  } catch { initialSeat = null; }
  const surface = renderConnectorManage(box, { api, el, role, initialSeat });
  await surface.refresh();
  return surface;
}
