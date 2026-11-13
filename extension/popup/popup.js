// The toolbar popup: what has been flagged, and how to get it out.
//
// It is the only place a user can read the ledger, so it has three jobs and no
// others — show the counts, export the file, clear the log. It never edits an
// entry: a record you can quietly amend is not a record.
//
// Plain script, no bundler, no dependency. Chrome loads this file as written.

const $ = (id) => document.getElementById(id);

function ask(type) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type }, (response) => {
        void chrome.runtime.lastError;
        resolve(response || { ok: false, error: 'the background worker did not answer' });
      });
    } catch (error) {
      resolve({ ok: false, error: error.message });
    }
  });
}

function fmt(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/** Escapes nothing — everything goes in via textContent, never innerHTML. */
function row(entry) {
  const li = document.createElement('li');
  li.className = entry.kind === 'unsourced-claim' ? 'entry note' : 'entry danger';

  const head = document.createElement('div');
  head.className = 'entry-head';

  const kind = document.createElement('span');
  kind.className = 'kind';
  kind.textContent = entry.kind === 'unsourced-claim' ? 'UNSOURCED CLAIM' : 'DESTRUCTIVE';
  head.appendChild(kind);

  const when = document.createElement('span');
  when.className = 'when';
  when.textContent = `${fmt(entry.timestamp)} · ${entry.site || 'unknown site'}`;
  head.appendChild(when);
  li.appendChild(head);

  const text = document.createElement('code');
  text.className = 'entry-text';
  text.textContent = entry.text || '';
  li.appendChild(text);

  const matched = document.createElement('div');
  matched.className = 'matched';
  matched.textContent = entry.matched ? `matched: ${entry.matched}` : '';
  li.appendChild(matched);

  // Says so when the context could not be captured, rather than showing a blank
  // that reads as "nothing was asked".
  const ctx = document.createElement('div');
  ctx.className = 'ctx';
  ctx.textContent = entry.contextCaptured
    ? `you asked: ${entry.query || '(the prompt was not on the page)'}`
    : 'the surrounding conversation could not be captured for this one';
  li.appendChild(ctx);

  return li;
}

async function refresh() {
  const health = await ask('helmion:guard-status');
  const status = health.ok ? health.status : {};
  const protection = status && status.protection;
  const claims = status && status.claims;

  $('protectionDot').className = `status-dot ${protection || 'unknown'}`;
  $('claimsDot').className = `status-dot ${claims || 'unknown'}`;
  $('protectionStatus').textContent = protection === 'active'
    ? 'Active on the most recently checked page.'
    : protection === 'limited'
      ? 'Active in compatibility mode.'
      : protection === 'needs-attention'
        ? 'Needs attention; checks may be incomplete.'
        : 'Open or reload a supported AI page to check.';
  $('claimsStatus').textContent = claims === 'active'
    ? 'Active on the most recently checked page.'
    : claims === 'limited'
      ? 'Active in compatibility mode.'
      : claims === 'unavailable'
        ? 'Temporarily unavailable.'
        : 'Open or reload a supported AI page to check.';
  $('statusHelp').textContent = protection === 'needs-attention'
    ? 'Reload the page. If this status remains, do not rely on Guard for that page.'
    : '';

  const stats = await ask('helmion:ledger-stats');
  if (!stats.ok) {
    $('range').textContent = `Could not read the log: ${stats.error}`;
    return;
  }

  $('statTotal').textContent = stats.stats.total;
  $('statDestructive').textContent = stats.stats.destructive;
  $('statUnsourced').textContent = stats.stats.unsourced;
  $('statFlags').textContent = stats.stats.flags ?? 0;
  $('range').textContent = stats.stats.total
    ? `${fmt(stats.stats.oldest)} → ${fmt(stats.stats.newest)} · ${stats.stats.sites.length} site(s) · cap ${stats.stats.limit}`
    : '';

  const held = await ask('helmion:ledger');
  const list = $('entries');
  list.textContent = '';
  const entries = (held.ok ? held.entries : []).slice(-25).reverse();
  entries.forEach((entry) => list.appendChild(row(entry)));
  $('empty').hidden = entries.length > 0;
}

$('exportBtn').addEventListener('click', async () => {
  const result = await ask('helmion:ledger-export');
  if (!result.ok) {
    $('range').textContent = `Export failed: ${result.error}`;
    return;
  }
  // A blob URL and an anchor. No "downloads" permission is needed for this, so
  // the extension keeps its single-permission promise.
  const blob = new Blob([JSON.stringify(result.bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `helmion-guard-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

// Clearing is destructive and takes two clicks. The same reasoning as masking a
// dangerous code block: one deliberate confirmation before something is gone.
$('clearBtn').addEventListener('click', () => { $('confirm').hidden = false; });
$('cancelClear').addEventListener('click', () => { $('confirm').hidden = true; });
$('confirmClear').addEventListener('click', async () => {
  await ask('helmion:ledger-clear');
  $('confirm').hidden = true;
  refresh();
});

// OPT-IN cloud upload settings. Off by default; the background worker only
// uploads when this is enabled AND a device token is set. See
// background/upload.js — this UI needs Troy's manual browser testing.
function askWithPayload(type, payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, ...payload }, (response) => {
        void chrome.runtime.lastError;
        resolve(response || { ok: false, error: 'the background worker did not answer' });
      });
    } catch (error) {
      resolve({ ok: false, error: error.message });
    }
  });
}

async function refreshUploadSettings() {
  const result = await askWithPayload('helmion:guard-upload-settings', { settings: {} });
  if (result.ok && result.settings) {
    $('uploadEnabled').checked = result.settings.enabled === true;
    $('uploadStatus').textContent = result.settings.enabled
      ? (result.settings.hasToken ? 'Upload enabled. New findings will be sent to your Helmian cloud.' : 'Upload enabled, but no device token is set — nothing will be sent.')
      : 'Upload is off. Findings stay on this machine.';
  }
}

$('uploadSave').addEventListener('click', async () => {
  const result = await askWithPayload('helmion:guard-upload-settings', {
    settings: { enabled: $('uploadEnabled').checked, deviceToken: $('uploadToken').value },
  });
  if (!result.ok) { $('uploadStatus').textContent = `Settings not saved: ${result.error}`; return; }
  $('uploadToken').value = '';
  await refreshUploadSettings();
});

$('uploadNow').addEventListener('click', async () => {
  $('uploadStatus').textContent = 'Uploading…';
  const result = await ask('helmion:guard-upload');
  if (!result.ok) { $('uploadStatus').textContent = `Upload failed: ${result.error}`; return; }
  if (result.skipped) { $('uploadStatus').textContent = result.skipped === 'not-enabled' ? 'Upload is off — enable it above first.' : 'No device token set — save one above first.'; return; }
  $('uploadStatus').textContent = result.uploaded
    ? `Uploaded ${result.uploaded} finding${result.uploaded === 1 ? '' : 's'}${result.remaining ? `, ${result.remaining} remaining` : ''}.`
    : 'Nothing new to upload.';
});

refresh();
refreshUploadSettings();

// ─── Executive Guard and Flags settings (opt-in, off by default) ────────────
//
// Both need a host permission for the URL the user typed. It is requested
// here, inside the click, because Chrome and Firefox only grant optional
// permissions from a user gesture. Nothing is requested at install.
// NEEDS A REAL-BROWSER CHECK: the permission prompt and pairing flow are
// tested only through the worker in Node, not clicked in Chrome/Firefox/Edge.

function originFor(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return null;
  }
}

function requestOrigin(value) {
  const origin = originFor(value);
  if (!origin) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      if (!chrome.permissions || typeof chrome.permissions.request !== 'function') { resolve(false); return; }
      const result = chrome.permissions.request({ origins: [origin] }, (granted) => {
        void chrome.runtime.lastError;
        resolve(Boolean(granted));
      });
      if (result && typeof result.then === 'function') result.then((g) => resolve(Boolean(g)), () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

async function refreshExecutiveSettings() {
  const result = await askWithPayload('helmion:executive-settings', { settings: {} });
  if (!result.ok || !result.settings) return;
  const s = result.settings;
  $('execEnabled').checked = s.enabled === true;
  $('execUrl').value = s.serverUrl || '';
  $('execStatus').textContent = !s.enabled
    ? 'Off. Guard decides on this computer.'
    : !s.paired
      ? 'On, but not paired yet. Decisions stay local until pairing succeeds.'
      : `On and paired. Server key id ${s.keyId} (compare it with the id your server printed).`;
}

$('execSave').addEventListener('click', async () => {
  const url = $('execUrl').value.trim();
  if ($('execEnabled').checked && url) {
    const granted = await requestOrigin(url);
    if (!granted) { $('execStatus').textContent = 'Permission to reach that server was not granted, so nothing was saved.'; return; }
  }
  const saved = await askWithPayload('helmion:executive-settings', {
    settings: { enabled: $('execEnabled').checked, serverUrl: url, deviceToken: $('execToken').value || undefined },
  });
  if (!saved.ok) { $('execStatus').textContent = `Not saved: ${saved.error}`; return; }
  $('execToken').value = '';
  if ($('execEnabled').checked && url) {
    const pair = await ask('helmion:executive-pair');
    if (!pair.ok) { $('execStatus').textContent = `Saved, but pairing failed: ${pair.error}`; return; }
  }
  await refreshExecutiveSettings();
});

async function refreshFlagsSettings() {
  const result = await askWithPayload('helmion:flags-settings', { settings: {} });
  if (!result.ok || !result.settings) return null;
  const s = result.settings;
  $('flagsEnabled').checked = s.enabled === true;
  $('flagsUrl').value = s.baseUrl || '';
  $('flagsScan').checked = s.scanBeforeSend === true;
  $('flagsBudget').value = String(s.dailyBudget || 100);
  $('flagsKey').placeholder = s.hasKey ? 'Key saved (paste a new one to replace it)' : 'smk_… (shown once on your dashboard)';
  let text;
  if (!s.enabled) text = 'Off. Flags are shown and logged on this computer only.';
  else if (!s.baseUrl || !s.hasKey) text = 'On, but the server URL or API key is missing, so nothing is sent.';
  else if (s.keyRejected) text = 'The Flags server refused the API key (wrong, revoked, or missing a scope). Paste a new key.';
  else if (s.pausedUntil) text = `The Flags account hit its daily call limit. Paused until ${new Date(s.pausedUntil).toLocaleString()}.`;
  else text = `On. ${s.callsToday} of ${s.dailyBudget} calls used today.`;
  if (s.queued) text += ` ${s.queued} waiting to be sent.`;
  if (s.lastError && s.enabled && !s.keyRejected && !s.pausedUntil) text += ` Last problem: ${s.lastError}`;
  $('flagsStatus').textContent = text;
  return s;
}

function renderAlerts(result) {
  const list = $('flagsAlerts');
  list.replaceChildren();
  if (!result || !result.ok && !result.alerts) { $('flagsAlertsStatus').textContent = 'Could not check.'; return; }
  const alerts = result.alerts || [];
  for (const a of alerts) {
    // textContent only: alert text comes from the server.
    const li = document.createElement('li');
    li.className = `alert sev-${a.severity}`;
    const head = document.createElement('strong');
    head.textContent = `${a.severity.toUpperCase()} · ${a.category}${a.source_ai ? ` · ${a.source_ai}` : ''}`;
    const reason = document.createElement('div');
    reason.textContent = a.reason;
    li.append(head, reason);
    if (a.excerpt) { const ex = document.createElement('div'); ex.className = 'muted'; ex.textContent = a.excerpt; li.append(ex); }
    const when = document.createElement('div'); when.className = 'muted';
    when.textContent = a.created_at ? new Date(a.created_at).toLocaleString() : '';
    li.append(when);
    list.append(li);
  }
  const skipped = {
    'not-enabled': 'Reporting is off.', 'no-url': 'No server URL set.', 'no-key': 'No API key set.',
    'key-rejected': 'The API key was refused.', 'daily-limit': 'Paused: daily call limit.', budget: 'Daily call budget used up.',
  }[result.skipped];
  $('flagsAlertsStatus').textContent = skipped
    || (alerts.length ? `${result.unseen || 0} new. Last checked ${result.polledAt ? new Date(result.polledAt).toLocaleTimeString() : 'never'}.` : 'No high or critical flags.');
}

async function refreshAlerts(force) {
  const result = await askWithPayload('helmion:flags-alerts', { options: { force } });
  renderAlerts(result);
  // Opening the popup counts as seeing them.
  if (result && result.ok && result.unseen) askWithPayload('helmion:flags-alerts', { options: { markSeen: true } });
}

$('flagsSave').addEventListener('click', async () => {
  const url = $('flagsUrl').value.trim();
  if ($('flagsEnabled').checked && url) {
    const granted = await requestOrigin(url);
    if (!granted) { $('flagsStatus').textContent = 'Permission to reach that URL was not granted, so nothing was saved.'; return; }
  }
  const budget = $('flagsBudget').value.trim();
  const saved = await askWithPayload('helmion:flags-settings', {
    settings: {
      enabled: $('flagsEnabled').checked,
      baseUrl: url,
      apiKey: $('flagsKey').value || undefined,
      scanBeforeSend: $('flagsScan').checked,
      dailyBudget: budget ? Number(budget) : undefined,
    },
  });
  // The key field is cleared whatever happened; it is never shown again.
  $('flagsKey').value = '';
  if (!saved.ok) { $('flagsStatus').textContent = `Not saved: ${saved.error}`; return; }
  await refreshFlagsSettings();
});

$('flagsRefresh').addEventListener('click', () => refreshAlerts(true));

refreshExecutiveSettings();
refreshFlagsSettings().then((s) => { if (s && s.enabled) refreshAlerts(false); });


// ─── Scribe approvals pop-up ────────────────────────────────────────────────
// The list and the decisions belong to the door (connect.helmian.cloud); this
// only renders what the worker reports and sends back the one tap. The
// passphrase is read from the field, handed to the worker in one message and
// cleared from the field immediately — it is never stored anywhere.
function requestDoorPermission() {
  return new Promise((resolve) => {
    try {
      if (!chrome.permissions || typeof chrome.permissions.request !== 'function') { resolve(true); return; }
      const r = chrome.permissions.request({ origins: ['https://connect.helmian.cloud/*'] }, (g) => { void chrome.runtime.lastError; resolve(Boolean(g)); });
      if (r && typeof r.then === 'function') r.then((g) => resolve(Boolean(g)), () => resolve(false));
    } catch { resolve(false); }
  });
}

function approvalRow(item) {
  const li = document.createElement('li');
  li.className = 'alert approval-row';

  const sum = document.createElement('div');
  sum.className = 'approval-sum';
  sum.textContent = item.summary || 'Action';
  li.appendChild(sum);

  if (item.meta) {
    const meta = document.createElement('div');
    meta.className = 'matched';
    meta.textContent = item.meta;
    li.appendChild(meta);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  const approve = document.createElement('button');
  approve.type = 'button';
  approve.textContent = 'Approve';
  approve.addEventListener('click', () => decideFromPopup(item.id, 'approve', [approve, deny]));
  const deny = document.createElement('button');
  deny.type = 'button';
  deny.textContent = 'Deny';
  deny.addEventListener('click', () => decideFromPopup(item.id, 'deny', [approve, deny]));
  actions.appendChild(approve);
  actions.appendChild(deny);
  li.appendChild(actions);
  return li;
}

function renderApprovals(r) {
  const status = $('approvalsStatus');
  const list = $('approvalsList');
  list.textContent = '';
  if (!r || !r.ok && !r.view) {
    $('approvalsSignIn').hidden = false;
    status.textContent = (r && r.error) || 'Approvals could not be loaded.';
    return;
  }
  const view = r.view || {};
  if (view.session !== 'in') {
    $('approvalsSignIn').hidden = false;
    status.textContent = view.lastError || 'Sign in to see what is waiting for your decision.';
    return;
  }
  $('approvalsSignIn').hidden = true;
  for (const item of view.items || []) list.appendChild(approvalRow(item));
  if (r.error) status.textContent = r.error;
  else if (view.state === 'unavailable') status.textContent = view.lastError || 'Approvals are unavailable right now. Please try again.';
  else if (view.flash) status.textContent = view.flash;
  else if ((view.items || []).length === 0) status.textContent = 'Nothing is waiting for a decision.';
  else status.textContent = `${view.count} waiting for your decision.`;
}

async function decideFromPopup(id, verdict, buttons) {
  for (const b of buttons) b.disabled = true;
  const r = await askWithPayload('helmion:approvals-decide', { id, verdict });
  renderApprovals(r);
}

async function refreshApprovals(force) {
  renderApprovals(await askWithPayload('helmion:approvals-view', { options: { force: force === true } }));
}

$('approvalsSignInBtn').addEventListener('click', async () => {
  const field = $('approvalsPassphrase');
  const passphrase = field.value;
  if (!passphrase) { $('approvalsStatus').textContent = 'Type your Scribe passphrase first.'; return; }
  if (!await requestDoorPermission()) { $('approvalsStatus').textContent = 'Permission to reach the approvals door was not granted, so sign-in did not happen.'; return; }
  field.value = '';
  $('approvalsStatus').textContent = 'Signing in…';
  renderApprovals(await askWithPayload('helmion:approvals-signin', { passphrase }));
});
$('approvalsPassphrase').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('approvalsSignInBtn').click(); });

refreshApprovals(false);

// ─── PC approvals pop-up ────────────────────────────────────────────────────
// The Helmian app's own approvals: actions an AI asked the Executive Guard
// to run on this PC, decided through Helmian's proxy by the worker
// (background/pc-approvals-client.js). This section only renders what the
// worker reports and sends back the one tap, the same habit as the Scribe
// section above — but the two lists are separate in everything: a different
// server, different state, a different sign-in. This road rides on the
// browser's own Helmian session; the extension holds no credential for it,
// and when the session is missing the sign-in happens on the website, never
// here. A decision reads as done only when the refreshed list the worker
// returns no longer carries the item; a failed decision shows one plain
// line and leaves the item waiting. Closing this pop-up decides nothing,
// and a decision already sent belongs to the worker, not this page.

function pcExpiryText(expiresAt) {
  if (!expiresAt) return '';
  const ms = Date.parse(expiresAt) - Date.now();
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

function pcApprovalRow(item) {
  const li = document.createElement('li');
  li.className = 'alert approval-row';

  const sum = document.createElement('div');
  sum.className = 'approval-sum';
  sum.textContent = item.summary || 'Action';
  li.appendChild(sum);

  const metaParts = [];
  if (item.tool) metaParts.push(item.tool);
  if (item.site) metaParts.push(item.site);
  const left = pcExpiryText(item.expiresAt);
  if (left) metaParts.push(left);
  if (metaParts.length) {
    const meta = document.createElement('div');
    meta.className = 'matched';
    meta.textContent = metaParts.join(' · ');
    li.appendChild(meta);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  const approve = document.createElement('button');
  approve.type = 'button';
  approve.textContent = 'Approve';
  approve.addEventListener('click', () => decidePcFromPopup(item.id, 'approve', [approve, deny]));
  const deny = document.createElement('button');
  deny.type = 'button';
  deny.textContent = 'Deny';
  deny.addEventListener('click', () => decidePcFromPopup(item.id, 'deny', [approve, deny]));
  actions.appendChild(approve);
  actions.appendChild(deny);
  li.appendChild(actions);
  return li;
}

function renderPcApprovals(r) {
  const status = $('pcApprovalsStatus');
  const list = $('pcApprovalsList');
  list.textContent = '';
  if (!r || (!r.ok && !r.view)) {
    $('pcSignInBtn').hidden = true;
    status.textContent = (r && r.error) || 'PC approvals could not be loaded.';
    return;
  }
  const view = r.view || {};
  const items = view.items || [];
  $('pcSignInBtn').hidden = view.state !== 'signed-out';
  if (view.state !== 'signed-out') {
    for (const item of items) list.appendChild(pcApprovalRow(item));
  }
  if (r.error) { status.textContent = r.error; return; }
  if (view.state === 'signed-out') {
    status.textContent = view.lastError || 'Please sign in to Helmian.';
  } else if (view.state === 'not-owner') {
    status.textContent = view.lastError || "PC actions are approved by the PC owner's account.";
  } else if (view.state === 'unavailable') {
    // A stale list is labelled with the time OF the list, never shown as
    // current — the same wording the approvals window is planned to use.
    const when = view.updatedAt ? new Date(view.updatedAt).toLocaleTimeString() : '';
    const staleLine = when ? `Showing the last list from ${when}.` : 'Showing the last list.';
    status.textContent = view.lastError ? `${staleLine} ${view.lastError}` : staleLine;
  } else if (items.length === 0) {
    status.textContent = 'Nothing is waiting for a decision.';
  } else {
    status.textContent = `${view.count} waiting for your decision.`;
  }
}

async function decidePcFromPopup(id, verdict, buttons) {
  for (const b of buttons) b.disabled = true;
  const r = await askWithPayload('helmion:pc-approvals-decide', { id, verdict });
  renderPcApprovals(r);
}

async function refreshPcApprovals(force) {
  renderPcApprovals(await askWithPayload('helmion:pc-approvals-view', { options: { force: force === true } }));
}

$('pcSignInBtn').addEventListener('click', () => {
  try {
    chrome.tabs.create({ url: 'https://helmian.cloud/app#approvals' });
  } catch { /* the status line above already says what to do */ }
});

refreshPcApprovals(false);

// ─── Scribe door-knock ──────────────────────────────────────────────────────
function requestNotifications() {
  return new Promise((resolve) => {
    try {
      if (!chrome.permissions || typeof chrome.permissions.request !== 'function') { resolve(false); return; }
      const r = chrome.permissions.request({ permissions: ['notifications'] }, (g) => { void chrome.runtime.lastError; resolve(Boolean(g)); });
      if (r && typeof r.then === 'function') r.then((g) => resolve(Boolean(g)), () => resolve(false));
    } catch { resolve(false); }
  });
}
const SCRIBE_STATE_TEXT = {
  'not-installed': 'Mailbox not set up yet on the Scribe server. Guard will check again in 15 minutes.',
  'feature-off': 'Not deployed yet: the Scribe server answered 404 for the unread-mail address. Guard checks again in 15 minutes.',
  reconnect: 'Scribe did not accept the token. Reconnect Scribe by pasting a new one.',
};
async function loadScribe() {
  const r = await askWithPayload('helmion:scribe-settings', { settings: {} });
  if (!r || !r.ok) return;
  const s = r.settings;
  $('scribeEnabled').checked = s.enabled === true;
  $('scribeUrl').value = s.baseUrl || '';
  $('scribeMailboxes').value = (s.mailboxes || []).join(', ');
  $('scribeLegacy').checked = s.includeLegacy === true;
  $('scribeNotify').checked = s.notify === true;
  $('scribeBadge').checked = s.showBadge === true;
  if ($('scribeUnreadPath')) $('scribeUnreadPath').value = s.unreadPath || '/mailbox/unread';
  $('scribeAuth').textContent = s.signedIn ? 'Signed in (read-only).' : (s.hasToken ? 'Using a pasted token (fallback).' : 'Not signed in.');
  $('scribeToken').placeholder = s.hasToken ? 'Token saved (paste a new one to replace it)' : 'MAILBOX_STATUS_TOKEN or smk_… (mailbox.read)';
  renderInbox(await askWithPayload('helmion:scribe-inbox', { options: {} }));
}
function renderInbox(r) {
  const list = $('scribeInbox');
  list.textContent = '';
  if (!r || !r.ok) return;
  if (SCRIBE_STATE_TEXT[r.serverState]) { $('scribeStatus').textContent = SCRIBE_STATE_TEXT[r.serverState]; }
  else if (r.offline) { $('scribeStatus').textContent = 'Offline. Guard will check again when you are back online.'; }
  else { $('scribeStatus').textContent = `${r.unread || 0} unread.`; }
  for (const m of r.mailboxes || []) {
    const li = document.createElement('li');
    const head = document.createElement('div');
    const note = m.state === 'bad-name' ? ' (Scribe does not know this mailbox name)' : m.state === 'error' ? ' (last check failed, retrying)' : '';
    head.textContent = `${m.mailbox}: ${m.unread} unread${m.legacyCount != null ? ` · ${m.legacyCount} legacy` : ''}${note}`;
    li.append(head);
    for (const x of m.recent || []) {
      const row = document.createElement('div');
      row.className = 'muted';
      row.textContent = `${x.priority === 'high' || x.priority === 'urgent' ? '! ' : ''}${x.from}: ${x.subject}`;
      li.append(row);
    }
    if (m.site && m.unread) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = `Open ${m.mailbox} to read`;
      b.addEventListener('click', () => askWithPayload('helmion:scribe-nudge', { mailbox: m.mailbox }));
      li.append(b);
    }
    list.append(li);
  }
}
$('scribeSave').addEventListener('click', async () => {
  const url = $('scribeUrl').value.trim();
  if ($('scribeEnabled').checked && url) {
    const granted = await requestOrigin(url);
    if (!granted) { $('scribeStatus').textContent = 'Permission to reach that URL was not granted, so nothing was saved.'; return; }
    if ($('scribeNotify').checked) await requestNotifications();
  }
  const saved = await askWithPayload('helmion:scribe-settings', { settings: {
    enabled: $('scribeEnabled').checked, baseUrl: url, token: $('scribeToken').value || undefined,
    mailboxes: $('scribeMailboxes').value, includeLegacy: $('scribeLegacy').checked, notify: $('scribeNotify').checked, showBadge: $('scribeBadge').checked, ...($('scribeUnreadPath') ? { unreadPath: $('scribeUnreadPath').value } : {}),
  } });
  $('scribeToken').value = '';
  $('scribeStatus').textContent = saved && saved.ok ? 'Saved.' : `Not saved: ${saved && saved.error}`;
});
$('scribeRefresh').addEventListener('click', async () => renderInbox(await askWithPayload('helmion:scribe-inbox', { options: { force: true } })));
loadScribe();

// ─── Scribe sign-in (OAuth, no pasted key) ─────────────────────────────────
// ONE permissions.request in the click (a second await would lose the user
// gesture in Chrome): the Scribe origin plus, on Chrome/Edge, the optional
// 'identity' permission. On Firefox 'identity' is an install-time permission.
function requestSignInPermissions(url) {
  const origin = originFor(url);
  if (!origin) return Promise.resolve(false);
  const firefox = Boolean(globalThis.browser && globalThis.browser.runtime);
  const want = firefox ? { origins: [origin] } : { permissions: ['identity'], origins: [origin] };
  return new Promise((resolve) => {
    try {
      if (!chrome.permissions || typeof chrome.permissions.request !== 'function') { resolve(false); return; }
      const result = chrome.permissions.request(want, (g) => { void chrome.runtime.lastError; resolve(Boolean(g)); });
      if (result && typeof result.then === 'function') result.then((g) => resolve(Boolean(g)), () => resolve(false));
    } catch { resolve(false); }
  });
}
$('scribeSignIn').addEventListener('click', async () => {
  const url = $('scribeUrl').value.trim();
  if (!url) { $('scribeAuth').textContent = 'Enter and save the Scribe URL first.'; return; }
  const granted = await requestSignInPermissions(url);
  if (!granted) { $('scribeAuth').textContent = 'Sign-in needs permission to reach Scribe and to open its sign-in window.'; return; }
  await askWithPayload('helmion:scribe-settings', { settings: { baseUrl: url } });
  $('scribeAuth').textContent = 'Opening the Scribe sign-in window…';
  const r = await askWithPayload('helmion:scribe-signin', { action: 'signin' });
  $('scribeAuth').textContent = r && r.ok ? 'Signed in (read-only).' : `Not signed in: ${r && r.error}`;
});
$('scribeSignOut').addEventListener('click', async () => {
  await askWithPayload('helmion:scribe-signin', { action: 'signout' });
  $('scribeAuth').textContent = 'Signed out.';
});

// ─── Auto-nudge ────────────────────────────────────────────────────────────
const NUDGE_SITES = ['chatgpt.com', 'claude.ai', 'grok.com', 'gemini.google.com'];
function renderNudge(r) {
  if (!r || !r.ok) { $('nudgeStatus').textContent = `Could not load: ${r && r.error}`; return; }
  const s = r.settings;
  $('nudgeEnabled').checked = s.enabled; $('nudgeKilled').checked = s.killed;
  for (const site of NUDGE_SITES) $(`nudgeSite-${site}`).checked = s.sites[site] === true;
  $('nudgeIdle').value = s.idleMinutes; $('nudgeCap').value = s.dailyCapPerSite;
  const list = $('nudgeLog'); list.textContent = '';
  for (const row of r.log || []) {
    const li = document.createElement('li');
    li.textContent = `${row.at.slice(0, 16).replace('T', ' ')} ${row.site} → ${row.mailbox}: ${row.outcome}${row.reason && row.reason !== row.outcome ? ` (${row.reason})` : ''}`;
    list.appendChild(li);
  }
}
async function loadNudge() { renderNudge(await askWithPayload('helmion:nudge-settings', { settings: {} })); }
$('nudgeSave').addEventListener('click', async () => {
  const sites = {};
  for (const site of NUDGE_SITES) sites[site] = $(`nudgeSite-${site}`).checked;
  const r = await askWithPayload('helmion:nudge-settings', { settings: {
    enabled: $('nudgeEnabled').checked, killed: $('nudgeKilled').checked, sites,
    idleMinutes: Number($('nudgeIdle').value), dailyCapPerSite: Number($('nudgeCap').value),
  } });
  renderNudge(r);
  if (r && r.ok) $('nudgeStatus').textContent = 'Saved.';
});
loadNudge();
