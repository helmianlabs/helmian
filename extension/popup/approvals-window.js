// The approvals window: the careful surface for PC approvals (approvals
// pop-up build, Bite 5).
//
// The toolbar pop-up is the quick road; this window is the one that can
// be read properly. It stays open while Troy clicks elsewhere, shows the
// whole of each ask (who is asking, the reason, when it was asked, how
// long is left, counting down), and decides through the same worker
// messages the pop-up uses, so the client, the decide path and its
// refresh-confirmation rule are shared, never duplicated. This page
// holds no state of its own beyond what is on screen, keeps no list
// anywhere, and closing it decides nothing: anything not decided stays
// waiting, and the next open re-reads the list from the server.
//
// Approve is a two-step tap here, as the plan sets: the first tap turns
// the block into a confirmation naming what will be approved and that
// the decision is recorded with Troy's name; only Confirm sends it.
// Deny is one tap, the safe direction, as on the web page. There is no
// approve-all and no bulk action of any kind. A decision reads as done
// only when the refreshed view the worker returns no longer carries
// the item; a failure shows one plain line and leaves the item waiting.
//
// Plain script, no bundler, no dependency, everything written with
// textContent, never raw HTML: the same habits as popup.js.

const $ = (id) => document.getElementById(id);

function ask(type, payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, ...(payload || {}) }, (response) => {
        void chrome.runtime.lastError;
        resolve(response || { ok: false, error: 'the background worker did not answer' });
      });
    } catch (error) {
      resolve({ ok: false, error: error.message });
    }
  });
}

// The countdown reads the expiry on the item itself, never a lifetime
// this page invents; the shape is the pop-up's own ("expires in 2h 14m").
function expiresInText(expiresAt, now) {
  if (!expiresAt) return '';
  const ms = Date.parse(expiresAt) - now;
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return 'expired';
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'expires in under a minute';
  if (mins < 60) return `expires in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  if (hours < 24) return rest ? `expires in ${hours}h ${rest}m` : `expires in ${hours}h`;
  const days = Math.floor(hours / 24);
  const dayRest = hours % 24;
  return dayRest ? `expires in ${days}d ${dayRest}h` : `expires in ${days}d`;
}

function isExpired(item, now) {
  if (!item || !item.expiresAt) return false;
  const ms = Date.parse(item.expiresAt) - now;
  return !Number.isNaN(ms) && ms <= 0;
}

function askedText(createdAt) {
  if (!createdAt) return '';
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return '';
  return `Asked ${d.toLocaleString()}`;
}

function listTimeText(updatedAt) {
  if (!updatedAt) return '';
  const d = new Date(updatedAt);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString();
}

let currentView = null;
let confirmingId = null;
let outcomeLine = '';
const liveRows = new Map(); // id -> { item, countdownEl, actionsEl }

function paintRowActions(item) {
  const row = liveRows.get(item.id);
  if (!row) return;
  const actions = row.actionsEl;
  actions.textContent = '';

  if (isExpired(item, Date.now())) {
    const note = document.createElement('span');
    note.className = 'muted';
    note.textContent = 'This request has expired.';
    actions.appendChild(note);
    return;
  }

  if (confirmingId === item.id) {
    const box = document.createElement('div');
    box.className = 'approve-confirm';
    const line = document.createElement('div');
    line.textContent = `You are about to approve "${item.summary || 'Action'}". This is recorded with your name.`;
    box.appendChild(line);
    const taps = document.createElement('div');
    taps.className = 'actions';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.textContent = 'Confirm approve';
    confirm.addEventListener('click', () => decideFromWindow(item.id, 'approve', [confirm, cancel]));
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => { confirmingId = null; paintRowActions(item); });
    taps.appendChild(confirm);
    taps.appendChild(cancel);
    box.appendChild(taps);
    actions.appendChild(box);
    return;
  }

  const approve = document.createElement('button');
  approve.type = 'button';
  approve.textContent = 'Approve';
  approve.addEventListener('click', () => { confirmingId = item.id; paintRowActions(item); });
  const deny = document.createElement('button');
  deny.type = 'button';
  deny.textContent = 'Deny';
  deny.addEventListener('click', () => decideFromWindow(item.id, 'deny', [approve, deny]));
  actions.appendChild(approve);
  actions.appendChild(deny);
}

function windowRow(item) {
  const li = document.createElement('li');
  li.className = 'alert approval-row';

  const sum = document.createElement('div');
  sum.className = 'approval-sum';
  sum.textContent = item.summary || 'Action';
  li.appendChild(sum);

  // Who is asking: the tool and the site, where the server provides
  // them. (The client's view drops the device id on purpose; see
  // background/pc-approvals-client.js.)
  const who = [];
  if (item.tool) who.push(item.tool);
  if (item.site) who.push(item.site);
  if (who.length) {
    const meta = document.createElement('div');
    meta.className = 'matched';
    meta.textContent = who.join(' · ');
    li.appendChild(meta);
  }

  if (item.reason) {
    const reason = document.createElement('div');
    reason.className = 'ctx';
    reason.textContent = item.reason;
    li.appendChild(reason);
  }

  const asked = askedText(item.createdAt);
  if (asked) {
    const meta = document.createElement('div');
    meta.className = 'matched';
    meta.textContent = asked;
    li.appendChild(meta);
  }

  const countdown = document.createElement('div');
  countdown.className = 'matched countdown';
  li.appendChild(countdown);

  const actions = document.createElement('div');
  actions.className = 'actions';
  li.appendChild(actions);

  liveRows.set(item.id, { item, countdownEl: countdown, actionsEl: actions });
  paintRowActions(item);
  return li;
}

function renderWindow(r) {
  const status = $('windowStatus');
  const banner = $('windowBanner');
  const list = $('windowList');
  const count = $('windowCount');
  const updated = $('windowUpdated');
  list.textContent = '';
  liveRows.clear();

  if (!r || (!r.ok && !r.view)) {
    $('windowSignInBtn').hidden = true;
    banner.hidden = true;
    banner.textContent = '';
    count.textContent = '';
    updated.textContent = '';
    status.textContent = (r && r.error) || 'PC approvals could not be loaded.';
    currentView = null;
    return;
  }

  const view = r.view || {};
  currentView = view;
  const items = view.items || [];
  const when = listTimeText(view.updatedAt);

  count.textContent = view.state === 'signed-out' || view.state === 'not-owner'
    ? ''
    : items.length === 0
      ? 'Nothing waiting for your decision'
      : `${view.count} waiting for your decision`;
  updated.textContent = when ? `Last updated ${when}.` : '';

  // A stale list is labelled with the time OF the list, in the plan's
  // words, never presented as current.
  if (view.stale) {
    banner.hidden = false;
    const staleLine = when ? `Showing the last list from ${when}.` : 'Showing the last list.';
    banner.textContent = view.lastError ? `${staleLine} ${view.lastError}` : `${staleLine} Guard has not answered since.`;
  } else {
    banner.hidden = true;
    banner.textContent = '';
  }

  $('windowSignInBtn').hidden = view.state !== 'signed-out';
  if (view.state !== 'signed-out') {
    for (const item of items) list.appendChild(windowRow(item));
  }

  if (r.error) { status.textContent = r.error; tickCountdowns(); return; }
  if (outcomeLine) { status.textContent = outcomeLine; tickCountdowns(); return; }
  if (view.state === 'signed-out') {
    status.textContent = view.lastError || 'Please sign in to Helmian.';
  } else if (view.state === 'not-owner') {
    status.textContent = view.lastError || "PC actions are approved by the PC owner's account.";
  } else if (view.state === 'unavailable') {
    status.textContent = '';
  } else if (items.length === 0) {
    status.textContent = 'Nothing is waiting for a decision.';
  } else {
    status.textContent = '';
  }
  tickCountdowns();
}

async function decideFromWindow(id, verdict, buttons) {
  for (const b of buttons || []) b.disabled = true;
  confirmingId = null;
  const r = await ask('helmion:pc-approvals-decide', { id, verdict });
  outcomeLine = r && r.ok
    ? (verdict === 'approve' ? 'Approved. The AI can run it once.' : 'Denied. Nothing ran.')
    : '';
  renderWindow(r);
}

async function refreshWindow(force) {
  outcomeLine = '';
  renderWindow(await ask('helmion:pc-approvals-view', { options: { force: force === true } }));
}

// The countdown tick: once a second, in place, from each item's own
// expiresAt. The moment an item passes its expiry on screen it is
// marked expired and its buttons go away; the window never attempts a
// decision on it (the worker's decide path stays the authority, and its
// expired/already-decided answers stand if a tap raced the tick).
function tickCountdowns() {
  const now = Date.now();
  for (const row of liveRows.values()) {
    const { item, countdownEl } = row;
    if (!item.expiresAt) { countdownEl.textContent = ''; continue; }
    if (isExpired(item, now)) {
      if (countdownEl.textContent !== 'Expired') {
        countdownEl.textContent = 'Expired';
        if (confirmingId === item.id) confirmingId = null;
        paintRowActions(item);
      }
    } else {
      countdownEl.textContent = expiresInText(item.expiresAt, now);
    }
  }
}

$('windowSignInBtn').addEventListener('click', () => {
  try {
    chrome.tabs.create({ url: 'https://helmian.cloud/app#approvals' });
  } catch { /* the status line above already says what to do */ }
});

setInterval(tickCountdowns, 1000);
setInterval(() => { refreshWindow(false); }, 30000);
refreshWindow(true);
